# Anthropic API Bridge

将任意 **OpenAI 兼容的 `/chat/completions` 网关** 转接为 **Anthropic Messages API**，让 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 可以通过第三方 LLM 网关工作。

**零外部依赖**，纯 Node.js（`node:http` + `node:crypto`），单文件部署。

## 为什么需要这个？

Claude Code 只能对接 Anthropic 格式的 API（`/v1/messages`）。如果你的 LLM 网关提供的是 OpenAI 兼容格式（`/v1/chat/completions`），就需要这个桥接层做协议转换。

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/YOUR_USER/anthropic-bridge.git
cd anthropic-bridge

# 2. 配置
cp .env.example .env
# 编辑 .env，填入你的网关地址和 API Key

# 3. 启动
./start.sh
```

## 配置 Claude Code

在 `~/.claude/settings.json` 中添加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8083",
    "ANTHROPIC_API_KEY": "sk-bridge-local",
    "ANTHROPIC_MODEL": "claude-opus-4-6"
  }
}
```

然后直接运行 `claude` 即可。

## 模型映射

内置了完整的 Anthropic 模型目录（MODEL_CATALOG），自动映射 Claude Code 请求的各种模型名到你的上游模型。支持通过 `MODEL_MAP` 环境变量自定义覆盖：

```
MODEL_MAP=claude-sonnet-4-6=your-sonnet,claude-opus-4-6=your-opus
```

## 支持的端点

| 端点 | 说明 |
|---|---|
| `POST /v1/messages` | Anthropic Messages API（支持真流式 SSE） |
| `GET /v1/models` | 模型列表（含 max_input_tokens / max_output_tokens） |
| `GET /v1/models/:id` | 单模型查询 |
| `GET /health` | 健康检查 |
| `HEAD /` | 连通性检查 |

## 支持的特性

- **真流式 SSE**：上游 OpenAI SSE → 实时转译为 Anthropic SSE，逐 token 输出
- Anthropic `system` prompt（字符串和 block 数组格式）
- `tool_use` / `tool_result` 完整映射（含流式 tool_calls）
- 图片转发（base64 和 URL 格式）
- `x-api-key` 和 `Authorization: Bearer` 双认证
- 带时间戳的结构化日志

## 后台运行（macOS launchd，推荐）

仓库里已提供模板文件 `com.anthropic-bridge.plist.example`，快速部署：

```bash
# 1. 复制模板
cp com.anthropic-bridge.plist.example ~/Library/LaunchAgents/com.anthropic-bridge.plist

# 2. 编辑，替换所有 /PATH/TO/ 和 API 配置
vim ~/Library/LaunchAgents/com.anthropic-bridge.plist

# 3. 创建日志目录
mkdir -p logs

# 4. 加载服务（立即启动 + 开机自启）
launchctl load ~/Library/LaunchAgents/com.anthropic-bridge.plist

# 验证
curl http://127.0.0.1:8083/health
```

管理命令：

```bash
launchctl start com.anthropic-bridge    # 启动
launchctl stop com.anthropic-bridge     # 停止
launchctl list | grep anthropic          # 查看状态
tail -f logs/bridge.stdout.log           # 查看日志

# 修改 plist 后需要先卸载再重新加载
launchctl unload ~/Library/LaunchAgents/com.anthropic-bridge.plist
launchctl load ~/Library/LaunchAgents/com.anthropic-bridge.plist
```

## 文件说明

| 文件 | 说明 |
|---|---|
| `server.mjs` | 桥接服务（单文件，零依赖） |
| `.env.example` | 环境变量配置模板 |
| `com.anthropic-bridge.plist.example` | macOS launchd 服务配置模板 |
| `start.sh` | 一键启动脚本（开发用） |
| `package.json` | Node.js 项目描述 |

## License

MIT

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
# 或
node server.mjs
```

## 配置 Claude Code

在 `~/.claude/settings.json` 中添加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8082",
    "ANTHROPIC_API_KEY": "sk-bridge-local"
  }
}
```

或者在 `~/.zshrc` 中：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
export ANTHROPIC_API_KEY="sk-bridge-local"
```

然后直接运行 `claude` 即可。

## 模型映射

Claude Code 发来的 Anthropic 模型名会通过 `MODEL_MAP` 映射到你的上游模型名。

在 `.env` 中配置：

```
DEFAULT_MODEL=your-default-model
MODEL_MAP=claude-sonnet-4-6=your-sonnet,claude-opus-4-6=your-opus
```

也可以直接在 `server.mjs` 的 `buildModelMap()` 函数中硬编码映射。

## 支持的端点

| 端点 | 说明 |
|---|---|
| `POST /v1/messages` | Anthropic Messages API（支持 `stream: true/false`） |
| `GET /v1/models` | 模型列表 |
| `GET /v1/models/:id` | 单模型查询 |
| `GET /health` | 健康检查 |
| `HEAD /` | 连通性检查 |

## 支持的特性

- Anthropic `system` prompt（字符串和 block 数组格式）
- `tool_use` / `tool_result` 完整映射（Claude Code 的工具调用）
- 流式 SSE 响应（`stream: true`）
- `x-api-key` 和 `Authorization: Bearer` 双认证
- URL 查询参数兼容（如 `?beta=true`）

## 文件说明

| 文件 | 说明 |
|---|---|
| `server.mjs` | 桥接服务（单文件，零依赖） |
| `.env.example` | 配置模板 |
| `start.sh` | 一键启动脚本 |
| `package.json` | Node.js 项目描述 |

## 后台运行

```bash
nohup ./start.sh &
# 或
nohup node server.mjs &
```

## License

MIT

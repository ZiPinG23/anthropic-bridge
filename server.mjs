import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
const BRIDGE_API_KEYS = (process.env.BRIDGE_API_KEYS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const COMPANY_BASE_URL = process.env.COMPANY_BASE_URL ?? "";
const COMPANY_CHAT_PATH = process.env.COMPANY_CHAT_PATH ?? "/v1/chat/completions";
const COMPANY_API_KEY = process.env.COMPANY_API_KEY ?? "";
const COMPANY_AUTH_HEADER = process.env.COMPANY_AUTH_HEADER ?? "Authorization";
const COMPANY_AUTH_PREFIX = process.env.COMPANY_AUTH_PREFIX ?? "Bearer ";
const COMPANY_EXTRA_HEADERS = process.env.COMPANY_EXTRA_HEADERS ?? "";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "default-model";

const MODEL_MAP = buildModelMap(process.env.MODEL_MAP ?? "");

function buildModelMap(raw) {
  const map = {
    // Add your model mappings here:
    // "claude-sonnet-4-6": "your-upstream-sonnet-model",
    // "claude-opus-4-6": "your-upstream-opus-model",
  };
  if (!raw.trim()) return map;
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && v) map[k] = v;
  }
  return map;
}

function resolveModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;
  if (MODEL_MAP[requestedModel]) return MODEL_MAP[requestedModel];
  const sonnetModel = Object.values(MODEL_MAP).find((_, i) => Object.keys(MODEL_MAP)[i]?.includes("sonnet"));
  const opusModel = Object.values(MODEL_MAP).find((_, i) => Object.keys(MODEL_MAP)[i]?.includes("opus"));
  if (/sonnet/i.test(requestedModel) && sonnetModel) return sonnetModel;
  if (/opus/i.test(requestedModel) && opusModel) return opusModel;
  if (/haiku/i.test(requestedModel) && sonnetModel) return sonnetModel;
  return DEFAULT_MODEL;
}

const MODELS = Object.keys(MODEL_MAP);

if (!COMPANY_BASE_URL) {
  console.error("Missing COMPANY_BASE_URL");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    console.log(`[req] ${req.method} ${pathname}`);
    setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/v1/models" && req.method === "GET") {
      if (!checkBridgeKey(req, res)) return;
      sendJson(res, 200, {
        data: MODELS.map((id) => ({
          id,
          type: "model",
          display_name: id,
          created_at: "2026-01-01T00:00:00Z",
        })),
        first_id: MODELS[0] ?? null,
        has_more: false,
        last_id: MODELS[MODELS.length - 1] ?? null,
      });
      return;

    }

    if (pathname.startsWith("/v1/models/") && req.method === "GET") {
      if (!checkBridgeKey(req, res)) return;
      const modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
      sendJson(res, 200, {
        type: "model",
        id: modelId,
        display_name: modelId,
        created_at: "2026-01-01T00:00:00Z",
      });
      return;
    }

    if (pathname === "/v1/messages" && req.method === "POST") {
      if (!checkBridgeKey(req, res)) return;
      const body = await readJsonBody(req);
      await handleMessages(body, res);
      return;
    }

    console.log(`[404] unhandled: ${req.method} ${req.url}`);
    sendJson(res, 404, { error: { type: "not_found_error", message: "Not found" } });
  } catch (err) {
    console.error(`[err] ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, {
      error: {
        type: "api_error",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
});

server.listen(PORT, () => {
  console.log(`Anthropic bridge listening at http://127.0.0.1:${PORT}`);
});

async function handleMessages(anthropicReq, res) {
  const upstreamReq = mapAnthropicToCompany(anthropicReq);
  const upstreamResp = await callCompany(upstreamReq);
  const anthropicResp = mapCompanyToAnthropic(upstreamResp, anthropicReq.model);

  if (anthropicReq.stream) {
    streamAnthropicMessage(res, anthropicResp);
    return;
  }

  sendJson(res, 200, anthropicResp);
}

function mapAnthropicToCompany(input) {
  const messages = [];

  if (typeof input.system === "string" && input.system.trim()) {
    messages.push({ role: "system", content: input.system });
  } else if (Array.isArray(input.system)) {
    const text = input.system
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    if (text.trim()) messages.push({ role: "system", content: text });
  }

  for (const m of input.messages ?? []) {
    const role = m.role;
    if (!["user", "assistant"].includes(role)) continue;

    if (typeof m.content === "string") {
      messages.push({ role, content: m.content });
      continue;
    }

    if (!Array.isArray(m.content)) continue;

    if (role === "assistant") {
      const textParts = [];
      const toolCalls = [];

      for (const block of m.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
        if (block?.type === "tool_use") {
          toolCalls.push({
            id: block.id ?? `call_${randomUUID()}`,
            type: "function",
            function: {
              name: block.name ?? "tool",
              arguments: typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input ?? {}),
            },
          });
        }
      }

      const msg = { role: "assistant", content: textParts.join("\n") || null };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }

    // role === "user": may contain text and/or tool_result blocks
    const textParts = [];
    const toolResults = [];

    for (const block of m.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
      if (block?.type === "tool_result") {
        let content;
        if (typeof block.content === "string") {
          content = block.content;
        } else if (Array.isArray(block.content)) {
          content = block.content
            .filter((b) => b?.type === "text")
            .map((b) => b.text)
            .join("\n") || JSON.stringify(block.content);
        } else {
          content = JSON.stringify(block.content ?? "");
        }
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          content,
        });
      }
    }

    // Tool results must come right after the assistant tool_calls message
    for (const tr of toolResults) messages.push(tr);
    if (textParts.length > 0) {
      messages.push({ role: "user", content: textParts.join("\n") });
    }
  }

  const mappedModel = resolveModel(input.model);
  console.log(`[bridge] model: ${input.model} -> ${mappedModel}`);

  const out = {
    model: mappedModel,
    messages,
    stream: false,
  };

  if (typeof input.max_tokens === "number") out.max_tokens = input.max_tokens;
  if (typeof input.temperature === "number") out.temperature = input.temperature;
  if (typeof input.top_p === "number") out.top_p = input.top_p;
  if (typeof input.stop_sequences !== "undefined") out.stop = input.stop_sequences;

  if (Array.isArray(input.tools)) {
    out.tools = input.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  if (input.tool_choice) {
    if (input.tool_choice.type === "auto") out.tool_choice = "auto";
    if (input.tool_choice.type === "any") out.tool_choice = "required";
    if (input.tool_choice.type === "tool") {
      out.tool_choice = {
        type: "function",
        function: { name: input.tool_choice.name },
      };
    }
  }

  return out;
}

function mapCompanyToAnthropic(upstream, requestedModel) {
  const choice = upstream?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { raw: tc?.function?.arguments ?? "" };
      }
      content.push({
        type: "tool_use",
        id: tc.id ?? `toolu_${randomUUID()}`,
        name: tc?.function?.name ?? "tool",
        input,
      });
    }
  }

  const stopReason = content.some((c) => c.type === "tool_use")
    ? "tool_use"
    : mapStopReason(choice.finish_reason);

  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: upstream.model ?? requestedModel ?? "bridge-model",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: upstream?.usage?.prompt_tokens ?? 0,
      output_tokens: upstream?.usage?.completion_tokens ?? 0,
    },
  };
}

function mapStopReason(v) {
  if (v === "stop") return "end_turn";
  if (v === "length") return "max_tokens";
  if (v === "tool_calls") return "tool_use";
  return "end_turn";
}

async function callCompany(body) {
  const url = `${COMPANY_BASE_URL.replace(/\/+$/, "")}${COMPANY_CHAT_PATH}`;
  const headers = {
    "Content-Type": "application/json",
    ...parseExtraHeaders(COMPANY_EXTRA_HEADERS),
  };

  if (COMPANY_API_KEY) {
    headers[COMPANY_AUTH_HEADER] = `${COMPANY_AUTH_PREFIX}${COMPANY_API_KEY}`;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(
      `Upstream error ${resp.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`
    );
  }

  return data;
}

function streamAnthropicMessage(res, message) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  sse(res, "message_start", {
    type: "message_start",
    message: { ...message, content: [] },
  });

  for (let i = 0; i < message.content.length; i += 1) {
    const block = message.content[i];
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: i,
      content_block: block,
    });

    if (block.type === "text") {
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "text_delta", text: block.text },
      });
    } else if (block.type === "tool_use") {
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {}),
        },
      });
    }

    sse(res, "content_block_stop", {
      type: "content_block_stop",
      index: i,
    });
  }

  sse(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: message.usage.output_tokens ?? 0,
    },
  });

  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function checkBridgeKey(req, res) {
  if (BRIDGE_API_KEYS.length === 0) return true;

  const xApiKey = req.headers["x-api-key"];
  if (xApiKey && BRIDGE_API_KEYS.includes(String(xApiKey))) return true;

  const authHeader = req.headers["authorization"] ?? "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (bearerToken && BRIDGE_API_KEYS.includes(bearerToken)) return true;

  sendJson(res, 401, {
    error: {
      type: "authentication_error",
      message: "Invalid x-api-key or Authorization header",
    },
  });
  return false;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type,x-api-key,anthropic-version,anthropic-beta,authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseExtraHeaders(raw) {
  const headers = {};
  if (!raw.trim()) return headers;

  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) headers[k] = v;
  }
  return headers;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

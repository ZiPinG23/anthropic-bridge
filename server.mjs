import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

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

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "Claude-sonnet-4.6";

const MODEL_CATALOG = [
  {
    id: "claude-opus-4-20250514",
    display_name: "Claude Opus 4",
    created_at: "2025-05-14T00:00:00Z",
    max_input_tokens: 1048576,
    max_output_tokens: 32768,
    upstream: "Claude-opus-4.6-global",
  },
  {
    id: "claude-opus-4-6",
    display_name: "Claude Opus 4.6",
    created_at: "2025-05-14T00:00:00Z",
    max_input_tokens: 1048576,
    max_output_tokens: 32768,
    upstream: "Claude-opus-4.6-global",
  },
  {
    id: "claude-sonnet-4-20250514",
    display_name: "Claude Sonnet 4",
    created_at: "2025-05-14T00:00:00Z",
    max_input_tokens: 204800,
    max_output_tokens: 16384,
    upstream: "Claude-sonnet-4.6",
  },
  {
    id: "claude-sonnet-4-6",
    display_name: "Claude Sonnet 4.6",
    created_at: "2025-05-14T00:00:00Z",
    max_input_tokens: 204800,
    max_output_tokens: 16384,
    upstream: "Claude-sonnet-4.6",
  },
  {
    id: "claude-3-7-sonnet-20250219",
    display_name: "Claude 3.7 Sonnet",
    created_at: "2025-02-19T00:00:00Z",
    max_input_tokens: 204800,
    max_output_tokens: 16384,
    upstream: "Claude-sonnet-4.6",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    display_name: "Claude 3.5 Sonnet",
    created_at: "2024-10-22T00:00:00Z",
    max_input_tokens: 204800,
    max_output_tokens: 8192,
    upstream: "Claude-sonnet-4.6",
  },
  {
    id: "claude-3-5-sonnet-latest",
    display_name: "Claude 3.5 Sonnet (Latest)",
    created_at: "2024-10-22T00:00:00Z",
    max_input_tokens: 204800,
    max_output_tokens: 8192,
    upstream: "Claude-sonnet-4.6",
  },
  {
    id: "claude-3-opus-20240229",
    display_name: "Claude 3 Opus",
    created_at: "2024-02-29T00:00:00Z",
    max_input_tokens: 204800,
    max_output_tokens: 4096,
    upstream: "Claude-opus-4.6-global",
  },
  {
    id: "claude-3-5-haiku-20241022",
    display_name: "Claude 3.5 Haiku",
    created_at: "2024-10-22T00:00:00Z",
    max_input_tokens: 204800,
    max_output_tokens: 8192,
    upstream: "Claude-sonnet-4.6",
  },
];

function applyCustomModelMap(raw) {
  if (!raw.trim()) return;
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (!k || !v) continue;
    const existing = MODEL_CATALOG.find((m) => m.id === k);
    if (existing) {
      existing.upstream = v;
    } else {
      MODEL_CATALOG.push({
        id: k,
        display_name: k,
        created_at: "2026-01-01T00:00:00Z",
        max_input_tokens: /opus/i.test(k) ? 1048576 : 204800,
        max_output_tokens: /opus/i.test(k) ? 32768 : 16384,
        upstream: v,
      });
    }
  }
}
applyCustomModelMap(process.env.MODEL_MAP ?? "");

const MODEL_MAP = Object.fromEntries(MODEL_CATALOG.map((m) => [m.id, m.upstream]));
const MODEL_INFO = Object.fromEntries(MODEL_CATALOG.map((m) => [m.id, m]));

function resolveModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;
  if (MODEL_MAP[requestedModel]) return MODEL_MAP[requestedModel];
  if (/sonnet/i.test(requestedModel)) return MODEL_MAP["claude-sonnet-4-20250514"];
  if (/opus/i.test(requestedModel)) return MODEL_MAP["claude-opus-4-20250514"];
  if (/haiku/i.test(requestedModel)) return MODEL_MAP["claude-sonnet-4-20250514"];
  return DEFAULT_MODEL;
}

const MODELS = MODEL_CATALOG.map((m) => m.id);

if (!COMPANY_BASE_URL) {
  console.error("Missing COMPANY_BASE_URL");
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    console.log(`[${ts()}] ${req.method} ${pathname}`);
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
        data: MODEL_CATALOG.map(formatModelObject),
        first_id: MODELS[0] ?? null,
        has_more: false,
        last_id: MODELS[MODELS.length - 1] ?? null,
      });
      return;
    }

    if (pathname.startsWith("/v1/models/") && req.method === "GET") {
      if (!checkBridgeKey(req, res)) return;
      const modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
      const info = MODEL_INFO[modelId];
      if (info) {
        sendJson(res, 200, formatModelObject(info));
      } else {
        sendJson(res, 200, formatModelObject({
          id: modelId,
          display_name: modelId,
          created_at: "2026-01-01T00:00:00Z",
          max_input_tokens: 204800,
          max_output_tokens: 16384,
        }));
      }
      return;
    }

    if (pathname === "/v1/messages" && req.method === "POST") {
      if (!checkBridgeKey(req, res)) return;
      const body = await readJsonBody(req);
      await handleMessages(body, res);
      return;
    }

    console.log(`[${ts()}] 404 ${req.method} ${req.url}`);
    sendJson(res, 404, { error: { type: "not_found_error", message: "Not found" } });
  } catch (err) {
    console.error(`[${ts()}] ERR ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, {
      error: {
        type: "api_error",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
});

server.listen(PORT, () => {
  console.log(`[${ts()}] Anthropic bridge listening at http://127.0.0.1:${PORT}`);
});

function formatModelObject(m) {
  return {
    id: m.id,
    type: "model",
    display_name: m.display_name ?? m.id,
    created_at: m.created_at ?? "2026-01-01T00:00:00Z",
    max_input_tokens: m.max_input_tokens ?? 204800,
    max_output_tokens: m.max_output_tokens ?? 16384,
  };
}

async function handleMessages(anthropicReq, res) {
  const upstreamReq = mapAnthropicToCompany(anthropicReq);

  if (anthropicReq.stream) {
    await handleStreamingMessages(upstreamReq, anthropicReq.model, res);
    return;
  }

  const upstreamResp = await callCompany(upstreamReq);
  const anthropicResp = mapCompanyToAnthropic(upstreamResp, anthropicReq.model);
  sendJson(res, 200, anthropicResp);
}

async function handleStreamingMessages(upstreamReq, requestedModel, res) {
  const upstreamResp = await callCompanyStream(upstreamReq);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const msgId = `msg_${randomUUID()}`;
  let sentMessageStart = false;
  let currentBlockIndex = -1;       // index of the current content block being streamed
  let currentBlockType = null;      // "text" or "tool_use"
  let inputTokens = 0;
  let outputTokens = 0;
  let upstreamModel = requestedModel ?? "bridge-model";
  let stopReason = "end_turn";

  // Track active tool_call blocks by their tool_call index in the OpenAI response
  // Maps OpenAI tool_call index → our content block index
  const toolCallBlockMap = new Map();

  function emitMessageStart() {
    if (sentMessageStart) return;
    sentMessageStart = true;
    sse(res, "message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: upstreamModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
  }

  function startTextBlock() {
    currentBlockIndex += 1;
    currentBlockType = "text";
    sse(res, "content_block_start", {
      type: "content_block_start",
      index: currentBlockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  function closeCurrentBlock() {
    if (currentBlockIndex < 0) return;
    sse(res, "content_block_stop", {
      type: "content_block_stop",
      index: currentBlockIndex,
    });
  }

  function finishStream() {
    // Close any open block
    if (currentBlockType !== null) {
      closeCurrentBlock();
      currentBlockType = null;
    }
    // Close any open tool_use blocks
    for (const blockIdx of toolCallBlockMap.values()) {
      if (blockIdx !== currentBlockIndex) {
        // already closed above if it was current
      }
    }

    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  }

  // Parse the SSE stream from the upstream OpenAI-compatible response
  const reader = upstreamResp.body;
  let buffer = "";

  try {
    for await (const chunk of reader) {
      buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

      // Process all complete lines in the buffer
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        // Handle data: prefix
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();

        if (payload === "[DONE]") {
          finishStream();
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          console.error(`[${ts()}] failed to parse SSE chunk: ${payload.slice(0, 200)}`);
          continue;
        }

        // Extract model name from first chunk
        if (parsed.model) upstreamModel = parsed.model;

        // Extract usage if present
        if (parsed.usage) {
          if (parsed.usage.prompt_tokens) inputTokens = parsed.usage.prompt_tokens;
          if (parsed.usage.completion_tokens) outputTokens = parsed.usage.completion_tokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        const finishReason = choice.finish_reason;

        // Ensure message_start is sent on the very first chunk
        emitMessageStart();

        // Handle text content delta
        if (typeof delta.content === "string" && delta.content.length > 0) {
          // If no text block is open yet, start one
          if (currentBlockType !== "text") {
            if (currentBlockType !== null) closeCurrentBlock();
            startTextBlock();
          }

          sse(res, "content_block_delta", {
            type: "content_block_delta",
            index: currentBlockIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        // Handle tool_calls delta
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const tcIndex = tc.index ?? 0;

            if (!toolCallBlockMap.has(tcIndex)) {
              // New tool call — close any open text block first
              if (currentBlockType === "text") {
                closeCurrentBlock();
                currentBlockType = null;
              }

              currentBlockIndex += 1;
              const blockIdx = currentBlockIndex;
              toolCallBlockMap.set(tcIndex, blockIdx);
              currentBlockType = "tool_use";

              sse(res, "content_block_start", {
                type: "content_block_start",
                index: blockIdx,
                content_block: {
                  type: "tool_use",
                  id: tc.id ?? `toolu_${randomUUID()}`,
                  name: tc.function?.name ?? "tool",
                  input: {},
                },
              });
            }

            // Stream arguments as input_json_delta
            const argsFragment = tc.function?.arguments;
            if (typeof argsFragment === "string" && argsFragment.length > 0) {
              const blockIdx = toolCallBlockMap.get(tcIndex);
              sse(res, "content_block_delta", {
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "input_json_delta", partial_json: argsFragment },
              });
            }
          }
        }

        // Handle finish_reason
        if (finishReason) {
          stopReason = mapStopReason(finishReason);

          // Close all open tool_use blocks
          if (toolCallBlockMap.size > 0) {
            for (const blockIdx of toolCallBlockMap.values()) {
              sse(res, "content_block_stop", {
                type: "content_block_stop",
                index: blockIdx,
              });
            }
            currentBlockType = null;
            // Don't double-close in finishStream
            toolCallBlockMap.clear();
          }

          if (stopReason === "tool_use" || finishReason === "stop") {
            // finishStream will close the text block if needed
          }
        }
      }
    }

    // If we exited the loop without seeing [DONE], still clean up
    if (!res.writableEnded) {
      emitMessageStart();
      finishStream();
    }
  } catch (err) {
    console.error(`[${ts()}] streaming error: ${err.message}`);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { type: "api_error", message: err.message },
      });
    } else if (!res.writableEnded) {
      // Try to cleanly end the SSE stream
      try {
        finishStream();
      } catch {
        res.end();
      }
    }
  }
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

    // role === "user": may contain text, image, and/or tool_result blocks
    const userParts = [];
    const toolResults = [];
    const trailingImageParts = [];

    for (const block of m.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        userParts.push({ type: "text", text: block.text });
        continue;
      }
      if (block?.type === "image") {
        const url = anthropicImageToUrl(block.source);
        if (url) userParts.push({ type: "image_url", image_url: { url } });
        continue;
      }
      if (block?.type === "tool_result") {
        const { textContent, images } = extractToolResultContent(block.content);
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          content: textContent,
        });
        for (const url of images) {
          trailingImageParts.push({ type: "image_url", image_url: { url } });
        }
      }
    }

    // Tool results must come right after the assistant tool_calls message
    for (const tr of toolResults) messages.push(tr);

    // Tool results carrying images: surface them as a follow-up user message,
    // since OpenAI's `tool` role requires a string content.
    if (trailingImageParts.length > 0) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "[tool returned image(s) above]" },
          ...trailingImageParts,
        ],
      });
    }

    if (userParts.length > 0) {
      const onlyText = userParts.every((p) => p.type === "text");
      if (onlyText) {
        messages.push({
          role: "user",
          content: userParts.map((p) => p.text).join("\n"),
        });
      } else {
        messages.push({ role: "user", content: userParts });
      }
    }
  }

  const mappedModel = resolveModel(input.model);
  const imageCount = countImageBlocks({ messages });
  console.log(
    `[${ts()}] ${input.model} -> ${mappedModel} | stream=${!!input.stream} | msgs=${messages.length}${imageCount > 0 ? ` | imgs=${imageCount}` : ""}`
  );

  const out = {
    model: mappedModel,
    messages,
    stream: !!input.stream,
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

function anthropicImageToUrl(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64") {
    const media = source.media_type || "image/png";
    const data = source.data;
    if (!data || typeof data !== "string") return null;
    return `data:${media};base64,${data}`;
  }
  if (source.type === "url" && typeof source.url === "string") {
    return source.url;
  }
  return null;
}

function countImageBlocks(body) {
  let n = 0;
  for (const m of body?.messages ?? []) {
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === "image_url") n += 1;
      }
    }
  }
  return n;
}

function extractToolResultContent(raw) {
  const images = [];
  if (typeof raw === "string") {
    return { textContent: raw, images };
  }
  if (!Array.isArray(raw)) {
    return { textContent: JSON.stringify(raw ?? ""), images };
  }
  const textParts = [];
  for (const b of raw) {
    if (b?.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (b?.type === "image") {
      const url = anthropicImageToUrl(b.source);
      if (url) {
        images.push(url);
        textParts.push("[image]");
      }
    }
  }
  const textContent = textParts.length > 0 ? textParts.join("\n") : JSON.stringify(raw);
  return { textContent, images };
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

  const serialized = JSON.stringify(body);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: serialized,
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

async function callCompanyStream(body) {
  const url = `${COMPANY_BASE_URL.replace(/\/+$/, "")}${COMPANY_CHAT_PATH}`;
  const headers = {
    "Content-Type": "application/json",
    ...parseExtraHeaders(COMPANY_EXTRA_HEADERS),
  };

  if (COMPANY_API_KEY) {
    headers[COMPANY_AUTH_HEADER] = `${COMPANY_AUTH_PREFIX}${COMPANY_API_KEY}`;
  }

  const serialized = JSON.stringify(body);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: serialized,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Upstream error ${resp.status}: ${text}`);
  }

  return resp;
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

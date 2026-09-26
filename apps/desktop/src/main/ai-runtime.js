// AI runtime for the desktop main process. It builds pi-ai providers from the
// renderer's per-request config and exposes stateless streaming plus a
// connection test. The renderer keeps owning chat history and UI; this module
// only maps model events to the reader's delta contract and normalizes
// failures into `qiaomuReaderReason` codes the UI already understands.

import { contentText, createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const PI_API = "openai-completions";
const DEFAULT_MAX_TOKENS = 2400;
const CONNECTION_TEST_MAX_TOKENS = 16;
const PROBE_MAX_TOKENS = 16;
const PROBE_TOOL_MAX_TOKENS = 64;
const PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 45_000;
// pi requires a non-empty client key; keyless local servers ignore the header.
const KEYLESS_PLACEHOLDER = "not-required";

// A trivial function tool used only to see whether an endpoint accepts the
// `tools` parameter and actually answers with a tool call.
const PROBE_TOOL = {
  name: "probe_number",
  description: "Return the number given by the user. Call this tool exactly once.",
  parameters: {
    type: "object",
    properties: { n: { type: "number", description: "The number from the user message." } },
    required: ["n"],
    additionalProperties: false,
  },
};

export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isLocalEndpoint(base) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(String(base || ""));
}

export function buildPiModel(config, options = {}) {
  const connectionTest = options.connectionTest === true;
  const model = {
    id: String(config.model || ""),
    name: String(config.model || ""),
    api: PI_API,
    provider: String(config.id || ""),
    baseUrl: normalizeBaseUrl(config.base),
    // Thinking-capable providers keep the capability flag even when the user
    // turned thinking off: the per-request `reasoning: "off"` then maps to an
    // explicit "thinking disabled" field (DeepSeek otherwise defaults to on).
    reasoning: config.supportsThinking === true,
    // pi drops image parts when the model does not declare image input, so a
    // capability probe must declare it to really test the endpoint. Normal
    // requests follow the detected/declared capability.
    input: options.imageInput === true || config.vision === true ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(config.contextWindow) || 128_000,
    maxTokens: connectionTest ? CONNECTION_TEST_MAX_TOKENS : Number(config.maxTokens) || DEFAULT_MAX_TOKENS,
  };
  // Local OpenAI-compatible servers (Ollama, llama.cpp, LM Studio, mocks) often
  // omit finish_reason; infer the stop reason instead of failing the stream.
  const compat = { ...(isLocalEndpoint(config.base) ? { supportsFinishReason: false } : {}), ...(config.compat || {}) };
  if (Object.keys(compat).length) model.compat = compat;
  return model;
}

export function buildPiProvider(config, options = {}) {
  const key = String(config.key || "");
  const name = String(config.name || config.id || "AI");
  return createProvider({
    id: String(config.id || ""),
    name,
    baseUrl: normalizeBaseUrl(config.base),
    // Every provider declares auth; keyless local servers resolve without a key.
    auth: {
      apiKey: {
        name,
        resolve: async () => ({ auth: { apiKey: key || KEYLESS_PLACEHOLDER } }),
      },
    },
    models: [buildPiModel(config, options)],
    api: openAICompletionsApi(),
  });
}

export function classifyPiFailure(error, config = {}) {
  const text = String(error?.errorMessage || error?.message || error || "");
  if (/abort/i.test(text)) return "cancelled";
  if (/\b401\b|unauthoriz|invalid api key|authentication|api key/i.test(text)) return "auth";
  if (/\b403\b|forbidden/i.test(text)) return "forbidden";
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) return "limit";
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(text)) return "timeout";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(text)) {
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(String(config.base || "")) ? "local" : "http";
  }
  return "http";
}

// Capability probes need a sharper signal than the generic classifier: a
// rejected image or tools array is a capability fact, not a request failure.
export function classifyCapabilityFailure(kind, error) {
  const text = String(error?.errorMessage || error?.message || error || "");
  if (kind === "image" && /image|vision|multimodal|图片|图像/i.test(text)) return "novision";
  if (kind === "tools" && /tool|function.?call|工具/i.test(text)) return "notools";
  if (/tool|function.?call/i.test(text)) return "notools";
  return classifyPiFailure(error);
}

// User turns may carry text or image parts; pi expects the block form when a
// message mixes both.
function messageContent(value) {
  if (!Array.isArray(value)) return String(value ?? "");
  const blocks = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "image" && item.data && item.mimeType) {
      blocks.push({ type: "image", data: String(item.data), mimeType: String(item.mimeType) });
    } else if (item.type === "text" || typeof item.text === "string") {
      blocks.push({ type: "text", text: String(item.text || "") });
    }
  }
  return blocks.length ? blocks : "";
}

function toolCallBlocks(calls) {
  return (Array.isArray(calls) ? calls : []).map((call) => ({
    type: "toolCall",
    id: String(call?.id || ""),
    name: String(call?.name || ""),
    arguments: call?.arguments && typeof call.arguments === "object" ? call.arguments : {},
  })).filter((call) => call.id && call.name);
}

// pi takes the system prompt on the context, not as a message in the list.
// Assistant turns must be full AssistantMessage shapes: `streamSimple` walks
// the history for token estimation and expects content blocks plus usage.
// Tool results are their own message kind; the model sees them in order.
export function toPiContext(messages, config, options = {}) {
  const systemParts = [];
  const list = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === "assistant" ? "assistant"
      : message?.role === "system" ? "system"
        : message?.role === "tool" || message?.role === "toolResult" ? "toolResult" : "user";
    const content = String(message?.content ?? "");
    if (role === "system") {
      if (content.trim()) systemParts.push(content);
      continue;
    }
    const timestamp = Number(message?.timestamp) || Date.now();
    if (role === "toolResult") {
      const blocks = messageContent(message?.content);
      list.push({
        role: "toolResult",
        toolCallId: String(message?.toolCallId || ""),
        toolName: String(message?.toolName || ""),
        content: Array.isArray(blocks) ? blocks : [{ type: "text", text: blocks }],
        isError: message?.isError === true,
        timestamp,
      });
      continue;
    }
    if (role === "assistant") {
      const blocks = content ? [{ type: "text", text: content }] : [];
      blocks.push(...toolCallBlocks(message?.toolCalls));
      list.push({
        role: "assistant",
        content: blocks,
        api: PI_API,
        provider: String(config.id || ""),
        model: String(config.model || ""),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: message?.stopReason === "toolUse" ? "toolUse" : "stop",
        timestamp,
      });
      continue;
    }
    list.push({ role, content: messageContent(message?.content), timestamp });
  }
  const systemPrompt = systemParts.join("\n\n");
  const context = systemPrompt ? { systemPrompt, messages: list } : { messages: list };
  const tools = Array.isArray(options.tools) ? options.tools.filter((tool) => tool?.name && tool?.description) : [];
  if (tools.length) context.tools = tools;
  return context;
}

export function createAiRuntime({ modelsFor } = {}) {
  const controllers = new Map();
  // The per-call options reach the model builder: a capability probe must
  // declare image input on the model or pi downgrades the image to a text
  // placeholder and the probe would "pass" without testing anything.
  const buildModels = modelsFor || ((config, options) => {
    const models = createModels();
    models.setProvider(buildPiProvider(config, options));
    return models;
  });

  function modelFor(config, options) {
    const models = buildModels(config, options);
    return { models, model: models.getModel(String(config.id || ""), String(config.model || "")) };
  }

  async function stream(payload, emit = () => {}) {
    const { requestId, config, messages, options = {} } = payload || {};
    const { models, model } = modelFor(config);
    if (!model) return { ok: false, reason: "notconfigured", message: "AI model is not configured" };
    const controller = new AbortController();
    controllers.set(requestId, controller);
    let answer = "";
    let reasoning = "";
    let received = false;
    let stopReason = "stop";
    const toolCalls = [];
    const push = (delta) => {
      received = true;
      emit({ requestId, type: "delta", answer, reasoningText: reasoning, ...delta });
    };
    try {
      const streamed = models.streamSimple(model, toPiContext(messages, config, { tools: options.tools }), {
        signal: controller.signal,
        apiKey: String(config.key || "") || undefined,
        temperature: 0.2,
        maxTokens: options.connectionTest ? CONNECTION_TEST_MAX_TOKENS : Number(config.maxTokens) || DEFAULT_MAX_TOKENS,
        // Only providers that declare thinking support receive a reasoning
        // level; local models that reject thinking keep working with "off".
        reasoning: config.thinking === true && config.supportsThinking === true && !options.connectionTest ? "medium" : "off",
        sessionId: options.sessionKey || undefined,
        timeoutMs: Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
      });
      for await (const event of streamed) {
        if (event.type === "text_delta") {
          answer += event.delta;
          push({ content: event.delta });
        } else if (event.type === "thinking_delta") {
          reasoning += event.delta;
          push({ reasoning: event.delta });
        } else if (event.type === "toolcall_end" && event.toolCall) {
          toolCalls.push(event.toolCall);
          push({ toolCall: event.toolCall });
        } else if (event.type === "done") {
          if (event.reason) stopReason = event.reason;
        } else if (event.type === "error") {
          const reason = event.reason === "aborted" || controller.signal.aborted
            ? "cancelled"
            : classifyPiFailure(event.error, config);
          return { ok: false, reason, message: event.error?.errorMessage || "", received, toolCalls };
        }
      }
      // A turn may be tool calls only: that is a complete, successful answer.
      if (!answer.trim() && !toolCalls.length) {
        return { ok: false, reason: reasoning.trim() ? "emptyanswer" : "empty", received };
      }
      return { ok: true, answer: answer.trim(), toolCalls, stopReason: toolCalls.length ? "toolUse" : stopReason };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, reason: "cancelled", received, toolCalls };
      return { ok: false, reason: classifyPiFailure(error, config), message: String(error?.message || error), received, toolCalls };
    } finally {
      controllers.delete(requestId);
    }
  }

  function abort(requestId) {
    const controller = controllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async function test(config) {
    const { models, model } = modelFor(config, { connectionTest: true });
    if (!model) return { ok: false, reason: "notconfigured", message: "AI model is not configured" };
    const started = Date.now();
    try {
      const message = await models.completeSimple(model, {
        messages: [{ role: "user", content: "请只回答：连接成功", timestamp: Date.now() }],
      }, {
        apiKey: String(config.key || "") || undefined,
        temperature: 0.2,
        maxTokens: CONNECTION_TEST_MAX_TOKENS,
        reasoning: "off",
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (message?.stopReason === "error" || message?.stopReason === "aborted") {
        return {
          ok: false,
          reason: classifyPiFailure({ errorMessage: message.errorMessage }, config),
          message: message.errorMessage || "",
        };
      }
      return { ok: true, answer: contentText(message?.content || []).trim(), latency: Date.now() - started };
    } catch (error) {
      return { ok: false, reason: classifyPiFailure(error, config), message: String(error?.message || error) };
    }
  }

  // Capability probe: send the smallest possible request that exercises the
  // feature and report what the endpoint did. "ok" plus a plausible answer is
  // the only proof of support; a rejection reports the distinct reason.
  async function probe(payload = {}) {
    const { config = {}, kind = "image", image = null, expected = "", prompt = "" } = payload || {};
    const { models, model } = modelFor(config, { imageInput: kind === "image" });
    if (!model) return { ok: false, kind, reason: "notconfigured", message: "AI model is not configured" };
    if (kind === "image" && (!image?.data || !image?.mimeType)) {
      return { ok: false, kind, reason: "payload", message: "missing probe image" };
    }
    const started = Date.now();
    const options = {
      apiKey: String(config.key || "") || undefined,
      temperature: 0,
      // A tool call plus its JSON arguments needs a little more room than a
      // digited answer; a truncated call would look like "no tool support".
      maxTokens: kind === "tools" ? PROBE_TOOL_MAX_TOKENS : PROBE_MAX_TOKENS,
      reasoning: "off",
      timeoutMs: PROBE_TIMEOUT_MS,
    };
    const attempt = async (toolChoice) => {
      try {
        const userContent = kind === "image"
          ? [
            { type: "text", text: prompt || "只回答图中的数字，不要解释。" },
            { type: "image", data: String(image.data), mimeType: String(image.mimeType) },
          ]
          : prompt || `必须调用 probe_number 工具，参数 n 填 ${expected || "7"}，不要直接回答。`;
        const context = {
          messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
          ...(kind === "tools" ? { tools: [PROBE_TOOL] } : {}),
        };
        const message = await models.completeSimple(model, context, toolChoice ? { ...options, toolChoice } : options);
        if (message?.stopReason === "error" || message?.stopReason === "aborted") {
          return {
            ok: false,
            kind,
            reason: classifyCapabilityFailure(kind, { errorMessage: message.errorMessage }),
            message: message.errorMessage || "",
          };
        }
        const call = (Array.isArray(message?.content) ? message.content : [])
          .find((block) => block?.type === "toolCall" && String(block.name || ""));
        return {
          ok: true,
          kind,
          answer: contentText(message?.content || []).trim(),
          toolCalled: Boolean(call),
          toolName: call?.name || "",
          toolArguments: call?.arguments ?? null,
          latency: Date.now() - started,
        };
      } catch (error) {
        return { ok: false, kind, reason: classifyCapabilityFailure(kind, error), message: String(error?.message || error) };
      }
    };
    if (kind !== "tools") return attempt(undefined);
    // Under "auto" a model may answer from memory instead of calling the tool,
    // which would look like "unknown". Force the call first; an endpoint that
    // rejects the forced choice gets one plain retry so the verdict stays fair.
    const forced = await attempt("required");
    // "tool_choice is not supported" is about the forced choice, not about
    // tools, so it must not end as a false "not supported" verdict.
    if (forced.ok || (forced.reason === "notools" && !/tool_choice/i.test(forced.message || ""))) return forced;
    return attempt(undefined);
  }

  return { stream, abort, test, probe };
}

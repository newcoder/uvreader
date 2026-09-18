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
const DEFAULT_TIMEOUT_MS = 45_000;
// pi requires a non-empty client key; keyless local servers ignore the header.
const KEYLESS_PLACEHOLDER = "not-required";

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
    input: ["text"],
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

export function buildPiProvider(config) {
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
    models: [buildPiModel(config)],
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

// pi takes the system prompt on the context, not as a message in the list.
// Assistant turns must be full AssistantMessage shapes: `streamSimple` walks
// the history for token estimation and expects content blocks plus usage.
export function toPiContext(messages, config) {
  const systemParts = [];
  const list = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user";
    const content = String(message?.content ?? "");
    if (role === "system") {
      if (content.trim()) systemParts.push(content);
      continue;
    }
    const timestamp = Number(message?.timestamp) || Date.now();
    if (role === "assistant") {
      list.push({
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: PI_API,
        provider: String(config.id || ""),
        model: String(config.model || ""),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "stop",
        timestamp,
      });
      continue;
    }
    list.push({ role, content, timestamp });
  }
  const systemPrompt = systemParts.join("\n\n");
  return systemPrompt ? { systemPrompt, messages: list } : { messages: list };
}

export function createAiRuntime({ modelsFor } = {}) {
  const controllers = new Map();
  const buildModels = modelsFor || ((config) => {
    const models = createModels();
    models.setProvider(buildPiProvider(config));
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
    const push = (delta) => {
      received = true;
      emit({ requestId, type: "delta", answer, reasoningText: reasoning, ...delta });
    };
    try {
      const streamed = models.streamSimple(model, toPiContext(messages, config), {
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
        } else if (event.type === "error") {
          const reason = event.reason === "aborted" || controller.signal.aborted
            ? "cancelled"
            : classifyPiFailure(event.error, config);
          return { ok: false, reason, message: event.error?.errorMessage || "", received };
        }
      }
      if (!answer.trim()) return { ok: false, reason: reasoning.trim() ? "emptyanswer" : "empty", received };
      return { ok: true, answer: answer.trim() };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, reason: "cancelled", received };
      return { ok: false, reason: classifyPiFailure(error, config), message: String(error?.message || error), received };
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

  return { stream, abort, test };
}

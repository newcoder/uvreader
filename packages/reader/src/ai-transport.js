// aiExplainStream / aiExplain live here so the AI transport stays host-agnostic.
import { buildAiRequestBody, buildAiRequestOptions, classifyAiHttpStatus } from "./ai-providers.js";
import { createOpenAiSseParser } from "./ai-stream.js";
import { runCliAi } from "./ai-cli.js";

export function createAiTransport({
  Platform, requestUrl, aiHttpError, aiConfig, aiMessages, aiRequestWithTimeout,
}) {
  async function aiExplainStream(cfg, messages, options) {
  const body = buildAiRequestBody(cfg.id, cfg.model, messages, {
    ...options,
    stream: true,
    thinkingEnabled: cfg.thinking,
  });
  const req = buildAiRequestOptions(cfg.base, cfg.key, body);
  const controller = new AbortController();
  let timedOut = false;
  let timeout = null;
  const abortFromCaller = () => controller.abort();
  const armTimeout = () => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 45000);
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  armTimeout();
  const decoder = new TextDecoder("utf-8");
  let answer = "";
  let reasoning = "";
  let received = false;
  const parser = createOpenAiSseParser((delta) => {
    received = true;
    armTimeout();
    reasoning += delta.reasoning;
    answer += delta.content;
    if (typeof options.onDelta === "function") {
      options.onDelta({ ...delta, answer, reasoningText: reasoning });
    }
  });
  let reader = null;
  try {
    const response = await window.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    if (!response.ok) throw aiHttpError(response.status, cfg.provider);
    if (!response.body || typeof response.body.getReader !== "function") {
      const err = new Error("stream unavailable");
      err.qiaomuReaderStreamUnavailable = true;
      throw err;
    }
    reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimeout();
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
  } catch (e) {
    if (timedOut) {
      const err = new Error("AI request timed out");
      err.qiaomuReaderReason = "timeout";
      if (received) err.qiaomuReaderReceived = true;
      throw err;
    }
    if (received) e.qiaomuReaderReceived = true;
    throw e;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
    try { reader?.releaseLock(); } catch { /* already released */ }
  }
  if (!answer.trim()) {
    const err = new Error(reasoning ? "reasoning without answer" : "empty");
    err.qiaomuReaderReason = reasoning ? "emptyanswer" : "empty";
    throw err;
  }
  return answer.trim();
}

  async function aiExplain(text, plugin, turns, book, options = {}) {
  const settings = plugin.settings;
  const cfg = aiConfig(plugin);
  if (!cfg.provider || (cfg.transport !== "cli" && (!cfg.base || !cfg.model))) {
    const err = new Error("AI is not configured");
    err.qiaomuReaderReason = "notconfigured";
    throw err;
  }
  const messages = aiMessages(text, settings, turns, book);
  if (cfg.transport === "cli") {
    if (!Platform.isDesktopApp) {
      const err = new Error("CLI AI is desktop-only");
      err.qiaomuReaderReason = "desktop";
      throw err;
    }
    const result = await runCliAi(cfg.id, {
      messages,
      model: cfg.model,
      effort: cfg.effort,
      binaryPath: cfg.cliPath,
      acpPath: cfg.acpPath,
      sessionKey: options.sessionKey || (options.connectionTest ? "connection-test" : ""),
      signal: options.signal,
      onDelta: options.onDelta,
    });
    return result.answer;
  }
  if (cfg.needsKey && !cfg.key) {
    const err = new Error("no api key");
    err.qiaomuReaderReason = "nokey";
    throw err;
  }
  if (typeof options.onDelta === "function" && typeof window.fetch === "function") {
    try {
      return await aiExplainStream(cfg, messages, options);
    } catch (e) {
      if (options.signal?.aborted || e?.name === "AbortError") {
        const err = new Error("AI request cancelled");
        err.qiaomuReaderReason = "cancelled";
        throw err;
      }
      // Browser streaming may be unavailable for a custom endpoint because of
      // CORS. Fall back only before any token arrived, so a request is never
      // repeated after the model has started answering.
      if (e?.qiaomuReaderReason || e?.qiaomuReaderReceived) throw e;
    }
  }
  const body = buildAiRequestBody(cfg.id, cfg.model, messages, {
    ...options,
    thinkingEnabled: cfg.thinking,
  });
  const res = await aiRequestWithTimeout(
    requestUrl(buildAiRequestOptions(cfg.base, cfg.key, body)),
    options.signal,
  );
  if (options.signal && options.signal.aborted) {
    const err = new Error("AI request cancelled");
    err.qiaomuReaderReason = "cancelled";
    throw err;
  }
  const httpReason = classifyAiHttpStatus(res.status);
  if (httpReason) throw aiHttpError(res.status, cfg.provider);
  const data = res.json;
  const message = data?.choices?.[0]?.message || {};
  const reasoning = String(message.reasoning_content || message.reasoning || "");
  const out = String(message.content || "").trim();
  if (typeof options.onDelta === "function" && (reasoning || out)) {
    options.onDelta({ content: out, reasoning, answer: out, reasoningText: reasoning });
  }
  if (!out) {
    const err = new Error(reasoning ? "reasoning without answer" : "empty");
    err.qiaomuReaderReason = reasoning ? "emptyanswer" : "empty";
    throw err;
  }
  return out;
}

  return { aiExplainStream, aiExplain };
}

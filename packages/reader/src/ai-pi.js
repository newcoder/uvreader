// Renderer-side adapter for the desktop AI runtime. The heavy lifting (pi-ai
// providers, credentials, streaming) lives in the Electron main process; this
// module keeps the reader's existing `aiExplain` contract so the chat UI does
// not change: same delta shape, same cancellation and failure reasons.

function reasonError(reason, message, extra = {}) {
  const error = new Error(message || reason);
  error.qiaomuReaderReason = reason;
  Object.assign(error, extra);
  return error;
}

export function createPiTransport({ bridge, aiConfig, aiMessages }) {
  if (!bridge || typeof bridge.stream !== "function") {
    const unavailable = async () => {
      throw reasonError("desktop", "The desktop AI runtime is unavailable");
    };
    return { aiExplain: unavailable, aiExplainStream: unavailable };
  }

  let nextRequest = 1;

  async function aiExplain(text, plugin, turns, book, options = {}) {
    const cfg = aiConfig(plugin);
    if (!cfg.provider) throw reasonError("notconfigured", "AI is not configured");
    if (cfg.needsKey && !cfg.key) throw reasonError("nokey", "no api key");
    if (!cfg.base || !cfg.model) throw reasonError("notconfigured", "AI is not configured");
    if (options.signal?.aborted) throw reasonError("cancelled", "AI request cancelled");

    const messages = aiMessages(text, plugin.settings, turns, book);
    const requestId = `ai-${Date.now()}-${nextRequest++}`;
    const onAbort = () => { void bridge.abort(requestId); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await bridge.stream({
        requestId,
        config: {
          id: cfg.id,
          name: cfg.provider?.label || cfg.id,
          base: cfg.base,
          model: cfg.model,
          thinking: cfg.thinking === true,
          supportsThinking: cfg.provider?.supportsThinking === true,
          compat: cfg.provider?.compat || null,
          key: cfg.key || "",
          needsKey: cfg.needsKey === true,
        },
        messages,
        options: {
          sessionKey: options.sessionKey || "",
          connectionTest: options.connectionTest === true,
        },
      }, (delta) => {
        if (typeof options.onDelta !== "function") return;
        options.onDelta({
          content: delta.content || "",
          reasoning: delta.reasoning || "",
          answer: delta.answer || "",
          reasoningText: delta.reasoningText || "",
        });
      });
      if (result?.ok) return result.answer;
      throw reasonError(result?.reason || "http", result?.message || "AI request failed", {
        qiaomuReaderReceived: result?.received === true,
      });
    } catch (error) {
      if (options.signal?.aborted) throw reasonError("cancelled", "AI request cancelled");
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  // One-shot translation for the selection chip: a strict prompt, no chat
  // history, so the answer is the translation itself.
  const TRANSLATE_SYSTEM = [
    "你是一名翻译引擎。把用户给出的文本翻译成目标语言，只输出译文。",
    "不要解释、不要加引号、不要重复原文；保留原文的段落结构；专有名词使用通行译法。",
  ].join("\n");

  async function aiTranslate(text, plugin, options = {}) {
    const cfg = aiConfig(plugin);
    if (!cfg.provider) throw reasonError("notconfigured", "AI is not configured");
    if (cfg.needsKey && !cfg.key) throw reasonError("nokey", "no api key");
    if (!cfg.base || !cfg.model) throw reasonError("notconfigured", "AI is not configured");
    if (options.signal?.aborted) throw reasonError("cancelled", "AI request cancelled");

    const messages = [
      { role: "system", content: `${TRANSLATE_SYSTEM}\n目标语言：${options.target || "简体中文"}。` },
      { role: "user", content: String(text || "") },
    ];
    const requestId = `ai-translate-${Date.now()}-${nextRequest++}`;
    const onAbort = () => { void bridge.abort(requestId); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await bridge.stream({
        requestId,
        config: {
          id: cfg.id,
          name: cfg.provider?.label || cfg.id,
          base: cfg.base,
          model: cfg.model,
          thinking: false,
          supportsThinking: cfg.provider?.supportsThinking === true,
          compat: cfg.provider?.compat || null,
          key: cfg.key || "",
          needsKey: cfg.needsKey === true,
        },
        messages,
        options: { sessionKey: "", connectionTest: false },
      }, (delta) => {
        if (typeof options.onDelta === "function") options.onDelta(delta.answer || delta.content || "");
      });
      if (result?.ok) return String(result.answer || "").trim();
      throw reasonError(result?.reason || "http", result?.message || "AI request failed", {
        qiaomuReaderReceived: result?.received === true,
      });
    } catch (error) {
      if (options.signal?.aborted) throw reasonError("cancelled", "AI request cancelled");
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  return { aiExplain, aiExplainStream: aiExplain, aiTranslate };
}

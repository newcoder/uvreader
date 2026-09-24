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
    return { aiExplain: unavailable, aiExplainStream: unavailable, aiExplainStep: unavailable, aiProbe: unavailable };
  }

  let nextRequest = 1;

  // Per-request runtime config shared by chat, translation and probes.
  function runtimeConfig(cfg, options = {}) {
    return {
      id: cfg.id,
      name: cfg.provider?.label || cfg.id,
      base: cfg.base,
      model: cfg.model,
      thinking: options.thinking !== undefined ? options.thinking === true : cfg.thinking === true,
      supportsThinking: cfg.provider?.supportsThinking === true,
      compat: cfg.provider?.compat || null,
      key: cfg.key || "",
      needsKey: cfg.needsKey === true,
      vision: options.vision === true,
    };
  }

  // One model round: the text plus whatever tool calls the model asked for.
  // The loop and the tools live in the reader; this only carries them.
  async function aiExplainStep(text, plugin, turns, book, options = {}) {
    const cfg = aiConfig(plugin);
    if (!cfg.provider) throw reasonError("notconfigured", "AI is not configured");
    if (cfg.needsKey && !cfg.key) throw reasonError("nokey", "no api key");
    if (!cfg.base || !cfg.model) throw reasonError("notconfigured", "AI is not configured");
    if (options.signal?.aborted) throw reasonError("cancelled", "AI request cancelled");

    const messages = aiMessages(text, plugin.settings, turns, book);
    const requestId = `ai-${Date.now()}-${nextRequest++}`;
    const onAbort = () => { void bridge.abort(requestId); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const seenToolCalls = [];
    try {
      const result = await bridge.stream({
        requestId,
        config: runtimeConfig(cfg, options),
        messages,
        options: {
          sessionKey: options.sessionKey || "",
          connectionTest: options.connectionTest === true,
          ...(Array.isArray(options.tools) && options.tools.length ? { tools: options.tools } : {}),
        },
      }, (delta) => {
        if (delta.toolCall) seenToolCalls.push(delta.toolCall);
        if (typeof options.onDelta !== "function") return;
        options.onDelta({
          content: delta.content || "",
          reasoning: delta.reasoning || "",
          answer: delta.answer || "",
          reasoningText: delta.reasoningText || "",
        });
      });
      if (result?.ok) {
        const toolCalls = Array.isArray(result.toolCalls) && result.toolCalls.length ? result.toolCalls : seenToolCalls;
        return {
          answer: String(result.answer || ""),
          toolCalls,
          stopReason: result.stopReason || (toolCalls.length ? "toolUse" : "stop"),
        };
      }
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

  // Text-only callers keep the old contract.
  async function aiExplain(text, plugin, turns, book, options = {}) {
    const step = await aiExplainStep(text, plugin, turns, book, options);
    return step.answer;
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
        config: runtimeConfig(cfg, { thinking: false }),
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

  // Capability probe: one minimal request that exercises the feature. The
  // caller interprets the answer; this never guesses on its own.
  async function aiProbe(kind, plugin, options = {}) {
    const cfg = aiConfig(plugin);
    if (!cfg.provider) throw reasonError("notconfigured", "AI is not configured");
    if (cfg.needsKey && !cfg.key) throw reasonError("nokey", "no api key");
    if (!cfg.base || !cfg.model) throw reasonError("notconfigured", "AI is not configured");
    if (typeof bridge.probe !== "function") throw reasonError("desktop", "The desktop AI runtime is unavailable");
    return bridge.probe({
      config: runtimeConfig(cfg),
      kind,
      image: options.image || null,
      expected: options.expected || "",
    });
  }

  return { aiExplain, aiExplainStream: aiExplain, aiExplainStep, aiTranslate, aiProbe };
}

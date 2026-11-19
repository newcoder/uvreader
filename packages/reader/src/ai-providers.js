// Provider metadata lives outside the settings UI so endpoints, model aliases
// and help links can be reviewed and updated without touching reader logic.
export const AI_PROVIDER_CATEGORIES = [
  { id: "cli", label: "local-cli-accounts-no-api-key" },
  { id: "china", label: "chinese-model-providers" },
  { id: "aggregator", label: "model-aggregators" },
  { id: "international", label: "international-providers" },
  { id: "local", label: "local-models" },
  { id: "advanced", label: "advanced-2" },
];

export const AI_PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    category: "china",
    needsKey: true,
    base: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    description: "official-deepseek-api-recommended-for-chinese-reading",
    recommended: true,
    supportsThinking: true,
    // DeepSeek defaults to thinking on. Without this compat pi omits the field
    // entirely, so the "thinking off" setting had no effect.
    compat: { thinkingFormat: "deepseek" },
  },
  kimi: {
    label: "Kimi（Moonshot）",
    category: "china",
    needsKey: true,
    base: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
    models: ["kimi-k2.6"],
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    description: "official-moonshot-kimi-api",
    recommended: true,
  },
  qwen: {
    label: "qwen-alibaba-model-studio",
    category: "china",
    needsKey: true,
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    apiKeyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    description: "alibaba-model-studio-s-openai-compatible-api",
    recommended: true,
  },
  zhipu: {
    label: "zhipu-glm",
    category: "china",
    needsKey: true,
    base: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.3",
    models: ["glm-5.3"],
    apiKeyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    description: "official-zhipu-ai-open-platform-api",
  },
  "opencode-go": {
    label: "OpenCode Go",
    category: "aggregator",
    needsKey: true,
    base: "https://opencode.ai/inference/go/openai/v1",
    model: "deepseek-v4.1-flash",
    models: [
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "kimi-k3.1-pro",
      "glm-5.3-flash",
      "qwen3.8-flash",
      "claude-haiku-5-5",
      "gpt-6-luna",
      "gemini-4-argon",
      "grok-4.7",
    ],
    apiKeyUrl: "https://opencode.ai/console",
    description: "opencode-go-description",
    supportsThinking: true,
    // OpenCode Go accepts reasoning_effort; "none" is the explicit off state.
    // The app only asks for medium, so map it to the provider's high tier.
    thinkingLevelMap: { off: "none", low: "low", medium: "high", high: "max" },
  },
  openrouter: {
    label: "OpenRouter",
    category: "aggregator",
    needsKey: true,
    base: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    models: ["deepseek/deepseek-chat", "openai/gpt-4.1-mini", "google/gemini-2.5-flash"],
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    description: "an-international-multi-model-aggregation-service",
  },
  openai: {
    label: "OpenAI",
    category: "international",
    needsKey: true,
    base: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    models: ["gpt-4.1-mini", "gpt-4.1"],
    apiKeyUrl: "https://platform.openai.com/api-keys",
    description: "official-openai-api",
  },
  gemini: {
    label: "Gemini",
    category: "international",
    needsKey: true,
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    models: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-4-argon"],
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    description: "gemini-description",
  },
  ollama: {
    label: "Ollama",
    category: "local",
    needsKey: false,
    base: "http://localhost:11434/v1",
    model: "qwen3:8b",
    models: ["qwen3:8b", "qwen3:4b", "deepseek-r1:8b"],
    description: "run-models-locally-on-port-11434-by-default",
    local: true,
  },
  lmstudio: {
    label: "LM Studio",
    category: "local",
    needsKey: false,
    base: "http://localhost:1234/v1",
    model: "",
    models: [],
    description: "run-models-locally-on-port-1234-by-default",
    local: true,
  },
  custom: {
    label: "custom-openai-compatible-api",
    category: "advanced",
    needsKey: false,
    base: "",
    model: "",
    models: [],
    description: "enter-your-base-url-model-name-and-optional-api-key",
  },
};

// Presets removed from the picker. Existing users are moved to "custom" with
// the same endpoint and model so an update does not silently break AI setup.
export const RETIRED_AI_PROVIDERS = {
  siliconflow: { base: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3-8B" },
  doubao: { base: "https://ark.cn-beijing.volces.com/api/v3", model: "" },
  minimax: { base: "https://api.minimax.cn/v1", model: "MiniMax-M3" },
};

export function migrateRetiredAiProvider(settings) {
  if (!settings || typeof settings !== "object") return false;
  const retired = RETIRED_AI_PROVIDERS[settings.aiProvider];
  if (!retired) return false;
  const oldId = settings.aiProvider;
  settings.aiBases = { ...(settings.aiBases || {}) };
  settings.aiModels = { ...(settings.aiModels || {}) };
  settings.aiSecrets = { ...(settings.aiSecrets || {}) };
  settings.aiThinking = { ...(settings.aiThinking || {}) };
  settings.aiCapabilities = { ...(settings.aiCapabilities || {}) };
  // Keep an existing custom endpoint untouched; otherwise carry the retired
  // preset over so its URL, model and key reference continue to work.
  if (!settings.aiBases.custom) {
    settings.aiBases.custom = settings.aiBases[oldId] || retired.base;
  }
  if (!settings.aiModels.custom) {
    const model = settings.aiModels[oldId] || retired.model;
    if (model) settings.aiModels.custom = model;
  }
  if (!settings.aiSecrets.custom && settings.aiSecrets[oldId]) {
    settings.aiSecrets.custom = settings.aiSecrets[oldId];
  }
  delete settings.aiBases[oldId];
  delete settings.aiModels[oldId];
  delete settings.aiSecrets[oldId];
  delete settings.aiThinking[oldId];
  delete settings.aiCapabilities[oldId];
  settings.aiProvider = "custom";
  settings.aiEnabled = false;
  settings.aiNeedsVerification = true;
  return true;
}

export function aiProviderFor(id) {
  return AI_PROVIDERS[id] || null;
}

export function normalizeAiBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// DeepSeek Search always uses a DeepSeek key. Prefer a dedicated search secret,
// then a DeepSeek provider key even when the active chat service is another
// provider (OpenCode Go, Kimi, etc.). Never borrow another provider's key.
export function resolveDeepseekSearchKey(settings = {}, readSecret = () => "") {
  const secret = (id) => {
    const key = String(id || "").trim();
    return key ? String(readSecret(key) || "").trim() : "";
  };
  const explicit = secret(settings.aiWebSearchSecret);
  if (explicit) return explicit;
  const providerSecret = secret(settings.aiSecrets?.deepseek);
  if (providerSecret) return providerSecret;
  if (settings.aiProvider === "deepseek") {
    const legacy = secret(settings.aiSecret);
    if (legacy) return legacy;
    return String(settings.aiKey || "").trim();
  }
  return "";
}

export function classifyAiHttpStatus(status) {
  if (status >= 200 && status < 300) return "";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "limit";
  return "http";
}

export function buildAiRequestBody(providerId, model, messages, options = {}) {
  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: options.connectionTest ? 512 : 2400,
  };
  if (options.stream) body.stream = true;
  // A connection check needs one short answer. In real reading conversations
  // DeepSeek may return reasoning_content, which the UI shows separately.
  if (providerId === "deepseek") {
    body.thinking = {
      type: options.connectionTest || options.thinkingEnabled === false
        ? "disabled"
        : "enabled",
    };
  }
  return body;
}

export function buildAiRequestOptions(base, key, body) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return {
    url: `${base}/chat/completions`,
    method: "POST",
    headers,
    throw: false,
    body: JSON.stringify(body),
  };
}

// The workshop's task defaults live here, not at each entry point. The reader
// AI and the workshop UI both feed the same main-process runners, so passing
// different settings or dropping provider flags changes output quality for the
// same task. Keep the payload shape in one place.
export function docvortexTaskSettings(settings = {}) {
  return {
    docvortexPath: String(settings.docvortexPath || ""),
    docvortexPython: String(settings.docvortexPython || settings.ocrPython || ""),
  };
}

export function formulaTaskSettings(settings = {}) {
  return {
    ...docvortexTaskSettings(settings),
    ocrSidecarDir: String(settings.ocrSidecarDir || ""),
    ocrSidecarExe: String(settings.ocrSidecarExe || ""),
    ocrPython: String(settings.ocrPython || ""),
    mineruToken: String(settings.mineruToken || ""),
    mineruModel: String(settings.mineruModel || ""),
    mineruLocalUrl: String(settings.mineruLocalUrl || ""),
    mineruLocalExe: String(settings.mineruLocalExe || ""),
    mineruLocalAutoStart: settings.mineruLocalAutoStart !== false,
    engineUrl: String(settings.engineUrl || ""),
    engineToken: String(settings.engineToken || ""),
  };
}

// aiConfig() is the reader's internal config. Task runners need the provider's
// thinking/compatibility flags too; without them reasoning is silently off.
export function taskAiConfig(config = {}) {
  if (!config?.provider) return null;
  return {
    id: config.id,
    name: config.provider?.label || config.id,
    base: config.base,
    model: config.model,
    thinking: config.thinking === true,
    supportsThinking: config.provider?.supportsThinking === true,
    compat: config.provider?.compat || null,
    key: config.key || "",
    needsKey: config.needsKey === true,
  };
}

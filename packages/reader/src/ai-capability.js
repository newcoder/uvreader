// Model capability detection. OpenAI-compatible endpoints differ in whether
// they accept image parts and a tools array: some reject the request, some
// accept it, some silently answer without seeing the image. The reader probes
// once per provider/base/model and remembers what the endpoint proved, so the
// attach entry and the tool loop only claim what actually works.
export const CAPABILITY_KINDS = ["image", "tools"];

export function capabilityKey(config) {
  return `${config?.id || ""}|${config?.base || ""}|${config?.model || ""}`;
}

function capabilityState(value) {
  return value === "yes" || value === "no" || value === "unknown" ? value : "";
}

export function normalizeAiCapabilities(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (!key || !entry || typeof entry !== "object") continue;
    const clean = {};
    for (const kind of CAPABILITY_KINDS) {
      const state = capabilityState(entry[kind]?.state);
      if (state) clean[kind] = { state, at: Number(entry[kind].at) || 0 };
    }
    if (Object.keys(clean).length) out[String(key).slice(0, 300)] = clean;
  }
  return out;
}

export function capabilityOf(settings, config, kind) {
  return normalizeAiCapabilities(settings?.aiCapabilities)[capabilityKey(config)]?.[kind] || null;
}

// The advanced override wins over any detection result.
export function capabilityMode(settings, kind) {
  const mode = settings?.[kind === "image" ? "aiVisionMode" : "aiToolsMode"];
  return mode === "yes" || mode === "no" ? mode : "auto";
}

export function effectiveCapability(settings, config, kind) {
  const mode = capabilityMode(settings, kind);
  if (mode !== "auto") return { state: mode, source: "manual", at: 0 };
  const found = capabilityOf(settings, config, kind);
  return found ? { state: found.state, source: "probe", at: found.at } : { state: "unknown", source: "none", at: 0 };
}

export function rememberCapability(settings, config, kind, state, at = Date.now()) {
  if (!CAPABILITY_KINDS.includes(kind) || !capabilityState(state)) return;
  const key = capabilityKey(config);
  if (!key.trim() || key === "||") return;
  settings.aiCapabilities = normalizeAiCapabilities(settings.aiCapabilities);
  settings.aiCapabilities[key] = { ...(settings.aiCapabilities[key] || {}), [kind]: { state, at } };
  // Cap the map so switching models for a long time cannot grow settings forever.
  const entries = Object.entries(settings.aiCapabilities);
  if (entries.length > 40) {
    const latest = (entry) => Math.max(...CAPABILITY_KINDS.map((name) => entry[1]?.[name]?.at || 0));
    settings.aiCapabilities = Object.fromEntries(entries.sort((a, b) => latest(b) - latest(a)).slice(0, 40));
  }
}

function digitsOnly(value) {
  return String(value ?? "")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfe_e0))
    .replace(/[^\d]/g, "");
}

// A model that truly sees the image answers the digit; a wrong or refused
// answer is not proof of support, so it stays "unknown" instead of lying.
export function interpretImageProbe(result, expected) {
  if (!result?.ok) return result?.reason === "novision" ? "no" : "unknown";
  const want = digitsOnly(expected);
  if (!want) return "unknown";
  return digitsOnly(result.answer).includes(want) ? "yes" : "unknown";
}

// The tools probe asks for a tool call with a specific number; only a call
// carrying that number counts, a plain text answer stays "unknown".
export function interpretToolsProbe(result, expected) {
  if (!result?.ok) return result?.reason === "notools" ? "no" : "unknown";
  if (!result.toolCalled) return "unknown";
  const want = digitsOnly(expected);
  if (!want) return "yes";
  const args = result.toolArguments && typeof result.toolArguments === "object" ? result.toolArguments : {};
  const values = [args.n, args.number, ...Object.values(args)];
  return values.some((value) => digitsOnly(value) === want) ? "yes" : "unknown";
}

// A tiny canvas-drawn digit: nothing here proves "vision" by itself, but the
// digit is random so a model cannot pass by guessing.
export function makeProbeImage(win = globalThis, random = Math.random) {
  const digits = String(Math.floor(Number(random()) * 10) || 0);
  const doc = win?.document;
  if (!doc?.createElement) return null;
  const canvas = doc.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111111";
  ctx.font = "600 48px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(digits, 64, 34);
  const data = String(canvas.toDataURL("image/png")).split(",")[1] || "";
  if (!data) return null;
  return { digits, image: { data, mimeType: "image/png" } };
}

export function capabilityStateLabel(translate, state) {
  if (state === "yes") return translate("capability-supported");
  if (state === "no") return translate("capability-not-supported");
  if (state === "unknown") return translate("capability-unclear");
  return translate("capability-unchecked");
}

// The state plus, when useful, how to act on it.
export function capabilityStateHint(translate, capability) {
  if (!capability || capability.state === "yes") return "";
  if (capability.state === "no") return "";
  return translate(capability.source === "none" ? "capability-unchecked-hint" : "capability-unclear-hint");
}

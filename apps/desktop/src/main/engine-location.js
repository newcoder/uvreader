import path from "node:path";

// MSIX packages run with filesystem virtualization: writes under %LOCALAPPDATA%
// are redirected into Packages/<family>/LocalCache/Local. A child process
// (our bundled Python) does not inherit that redirection, so the engine must
// live at the real package path before we spawn it.
export function packageFamilyNameFromExecutable(execPath = "") {
  const normalized = String(execPath || "").replace(/\//g, "\\");
  const match = /(?:^|\\)([^\\]+)_\d+\.\d+\.\d+\.\d+_[^\\]+__([a-z0-9]+)(?:\\|$)/i.exec(normalized);
  return match ? `${match[1]}_${match[2]}` : "";
}

export function resolveEngineRoot({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  execPath = process.execPath,
  override = "",
  fallbackRoot = "",
} = {}) {
  const forced = String(override || "").trim();
  if (forced) return forced;
  if (platform !== "win32" || !localAppData) return fallbackRoot;
  const family = packageFamilyNameFromExecutable(execPath);
  if (family) {
    return path.join(localAppData, "Packages", family, "LocalState", "UVReader", "engine");
  }
  return path.join(localAppData, "UVReader", "engine");
}

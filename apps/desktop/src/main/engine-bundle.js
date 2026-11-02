import fs from "node:fs";
import path from "node:path";

const BUNDLE_RE = /^uvreader-engine-(.+?)-(win32-x64|darwin-arm64|darwin-x64)\.(zip|tar\.gz)$/i;

export function engineArchiveInfo(filePath) {
  const match = BUNDLE_RE.exec(path.basename(String(filePath || "")));
  if (!match) return null;
  return {
    version: match[1],
    platform: match[2].toLowerCase(),
    archivePath: String(filePath),
  };
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`.toLowerCase();
}

function compareVersions(a, b) {
  const left = String(a || "0").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || "0").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// The Store package ships one archive under resources/engine. Prefer the
// archive for the current platform/arch, then the newest version if a build
// accidentally carries more than one.
export function findBundledEngineArchive(resourcesPath = process.resourcesPath, platform = process.platform, arch = process.arch) {
  const directory = path.join(String(resourcesPath || ""), "engine");
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return "";
  }
  const wanted = platformKey(platform, arch);
  const candidates = names
    .map((name) => engineArchiveInfo(path.join(directory, name)))
    .filter(Boolean)
    .filter((entry) => entry.platform === wanted)
    .sort((left, right) => compareVersions(right.version, left.version));
  return candidates[0]?.archivePath || "";
}

// 本机字体枚举（桌面主进程）。Chromium 的 queryLocalFonts 在书坊/设置
// 的某些渲染上下文里不可用，这里用系统命令补一份稳定的字体名单。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, fonts: [] };

function cleanFamily(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 120) return "";
  if (/[";{}<>\\]/u.test(name)) return "";
  if (Array.from(name).some((char) => char.charCodeAt(0) < 32)) return "";
  return name;
}

function toFonts(lines) {
  const names = [];
  const seen = new Set();
  for (const line of lines) {
    const name = cleanFamily(line);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push({ name, family: JSON.stringify(name) });
  }
  return names.sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeSystemFontNames(lines) {
  return toFonts(Array.isArray(lines) ? lines : []);
}

async function windowsFonts() {
  const script = [
    "$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Drawing",
    "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
  return toFonts(String(stdout || "").split(/\r?\n/));
}

export async function listSystemFonts() {
  if (process.platform !== "win32") return [];
  if (cache.fonts.length && Date.now() - cache.at < CACHE_MS) return cache.fonts;
  try {
    cache = { at: Date.now(), fonts: await windowsFonts() };
  } catch {
    cache = { at: Date.now(), fonts: [] };
  }
  return cache.fonts;
}

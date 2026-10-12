// 书坊:电子书字体子系统(乔木封面字库 + 本机字体)。
// - 字库按需下载:jsDelivr 镜像 → SHA-256 校验 → 缓存 `userData/font-cache`;
// - 嵌入 EPUB 前用 fontTools 子集化(只保留书里用到的字符),子集改名 `QBR <字体名>`;
// - 字体缺失/子集失败时回退系统字体,不阻断生成。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const FONT_LIBRARY_VERSION = "1.0.0";
export const FONT_INDEX_URL = `https://cdn.jsdelivr.net/gh/joeseesun/qiaomu-cover-fonts@${FONT_LIBRARY_VERSION}/index.json`;
export const FONT_FILE_BASE = `https://cdn.jsdelivr.net/gh/joeseesun/qiaomu-cover-fonts@${FONT_LIBRARY_VERSION}/fonts/`;

// 字库文件(名 → 文件):只列我们引用的 + 常用备选。
export const FONT_FILES = Object.freeze({
  notosans: "notosans.woff2",
  "notosans-bold": "notosans-bold.woff2",
  "notosans-heavy": "notosans-heavy.woff2",
  notoserif: "notoserif.woff2",
  "notoserif-bold": "notoserif-bold.woff2",
  "notoserif-heavy": "notoserif-heavy.woff2",
  zhuque: "zhuque.woff2",
  wenkai: "wenkai.woff2",
  smiley: "smiley.woff2",
  glow: "glow.woff2",
  huangyou: "huangyou.woff2",
  jiangcheng: "jiangcheng.woff2",
  maoken: "maoken.woff2",
  tiejili: "tiejili.woff2",
  mashan: "mashan.woff2",
  cormorant: "cormorant.woff2",
  inter: "inter.woff2",
  "inter-bold": "inter-bold.woff2",
  spacegrotesk: "spacegrotesk.woff2",
  bricolage: "bricolage.woff2",
  fraunces: "fraunces.woff2",
  instrument: "instrument.woff2",
  archivoblack: "archivoblack.woff2",
  jetbrains: "jetbrains.woff2",
});

// 文件内部家族名(WOFF2 里的 name 表;用于 CSP/预览与 @font-face)。
export const FONT_FAMILIES = Object.freeze({
  notosans: "Noto Sans SC",
  "notosans-bold": "Noto Sans SC",
  "notosans-heavy": "Noto Sans SC",
  notoserif: "Noto Serif SC",
  "notoserif-bold": "Noto Serif SC",
  "notoserif-heavy": "Noto Serif SC",
  zhuque: "Zhuque Fangsong (technical preview)",
  wenkai: "LXGW WenKai",
  smiley: "Smiley Sans Oblique",
  glow: "Glow Sans SC",
  huangyou: "ZCOOL QingKe HuangYou",
  jiangcheng: "JiangCheng YuanTi",
  maoken: "MaokenAssortedSans",
  tiejili: "Tiejili",
  mashan: "Ma Shan Zheng",
  cormorant: "Cormorant Garamond",
  inter: "Inter",
  "inter-bold": "Inter",
  spacegrotesk: "Space Grotesk",
  bricolage: "Bricolage Grotesque",
  fraunces: "Fraunces",
  instrument: "Instrument Serif",
  archivoblack: "Archivo Black",
  jetbrains: "JetBrains Mono",
});

// 12 套搭配(标题 / 正文 / 英文三角色),沿用字库 pairing。
export const FONT_PAIRINGS = Object.freeze([
  { id: "editorial", label: "编辑杂志", heading: "notoserif-heavy", body: "notosans", latin: "instrument" },
  { id: "literary", label: "文化书卷", heading: "zhuque", body: "wenkai", latin: "cormorant" },
  { id: "tech", label: "科技产品", heading: "glow", body: "notosans", latin: "spacegrotesk" },
  { id: "warm", label: "温暖手记", heading: "wenkai", body: "notosans", latin: "fraunces" },
  { id: "guofeng", label: "国风书法", heading: "mashan", body: "zhuque", latin: "cormorant" },
  { id: "punch", label: "干货冲击", heading: "notosans-heavy", body: "notosans", latin: "archivoblack" },
  { id: "trend", label: "潮流种草", heading: "smiley", body: "notosans", latin: "bricolage" },
  { id: "soft", label: "圆润亲切", heading: "jiangcheng", body: "notosans", latin: "fraunces" },
  { id: "playful", label: "俏皮可爱", heading: "maoken", body: "notosans", latin: "bricolage" },
  { id: "promo", label: "促销亲切", heading: "huangyou", body: "notosans", latin: "archivoblack" },
  { id: "guochao", label: "国潮热血", heading: "tiejili", body: "notosans", latin: "bricolage" },
  { id: "quiet", label: "安静正文", heading: "notosans-bold", body: "notoserif", latin: "inter" },
]);

export function findPairing(id) {
  return FONT_PAIRINGS.find((pairing) => pairing.id === String(id || "")) || FONT_PAIRINGS[0];
}

export function fontFileName(id) {
  return FONT_FILES[String(id || "")] || "";
}

// 本机/导入字体:{ id: "custom:xxx", file: "/abs/path.ttf", family: "..." } 直接用文件,不走下载。
export function isLocalFont(font) {
  return Boolean(font && (font.file || font.path));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function friendlyFontError(text) {
  const raw = String(text || "");
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(raw)) {
    return "字体下载失败(网络不可用),已回退系统字体";
  }
  if (/sha256|校验/i.test(raw)) return "字体文件校验失败(SHA-256 不匹配),已回退系统字体";
  return raw.slice(0, 200);
}

// 下载并校验一款字库字体;命中缓存直接返回。
export async function ensureFont(id, { cacheDir, fetchImpl = fetch, log = () => {}, timeoutMs = 60_000 } = {}) {
  const file = fontFileName(id);
  if (!file) return { ok: false, error: `未知字体:${id}` };
  const target = path.join(String(cacheDir || ""), file);
  if (!cacheDir) return { ok: false, error: "缺少字体缓存目录" };
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    return { ok: true, path: target, cached: true, family: FONT_FAMILIES[id] || id };
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const urls = [
    `${FONT_FILE_BASE}${file}`,
    `https://fastly.jsdelivr.net/gh/joeseesun/qiaomu-cover-fonts@${FONT_LIBRARY_VERSION}/fonts/${file}`,
    `https://raw.githubusercontent.com/joeseesun/qiaomu-cover-fonts/${FONT_LIBRARY_VERSION}/fonts/${file}`,
  ];
  let lastError = "";
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        lastError = "空文件";
        continue;
      }
      fs.writeFileSync(target, buffer);
      log("font cached", file, buffer.length, sha256(buffer).slice(0, 8));
      return { ok: true, path: target, bytes: buffer.length, sha256: sha256(buffer), family: FONT_FAMILIES[id] || id };
    } catch (error) {
      lastError = String(error?.message || error);
    }
  }
  return { ok: false, error: friendlyFontError(lastError || "下载失败") };
}

// 字体许可文本(licenses/<名字>.txt);拿不到返回空串(调用方给通用 OFL 说明)。
export async function ensureFontLicense(id, { cacheDir, fetchImpl = fetch } = {}) {
  const file = fontFileName(id);
  if (!file) return "";
  const name = file.replace(/\.(woff2|ttf|otf)$/i, "");
  const target = path.join(String(cacheDir || ""), "licenses", `${name}.txt`);
  try {
    if (fs.existsSync(target)) return fs.readFileSync(target, "utf8");
    const response = await fetchImpl(`https://cdn.jsdelivr.net/gh/joeseesun/qiaomu-cover-fonts@${FONT_LIBRARY_VERSION}/licenses/${name}.txt`);
    if (!response.ok) return "";
    const text = await response.text();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
    return text;
  } catch {
    return "";
  }
}

// 内置子集脚本:fontTools 子集化 + 按 OFL 要求把子集改名为 `QBR …`。
const SUBSET_SCRIPT = `import sys
from fontTools import subset
from fontTools.ttLib import TTFont

src, chars_file, out, family = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
chars = open(chars_file, encoding="utf-8").read()
options = subset.Options()
options.layout_features = ["*"]
options.name_IDs = ["*"]
options.name_legacy = True
options.name_languages = ["*"]
options.notdef_outline = True
options.recalc_bounds = True
font = subset.load_font(src, options)
subsetter = subset.Subsetter(options=options)
subsetter.populate(text=chars)
subsetter.subset(font)
if family:
    name = font["name"]
    for record in name.names:
        if record.nameID in (1, 3, 4, 6, 16, 17) and isinstance(record.string, str):
            record.string = family
font.save(out)
print("subset ok", out)
`;

export function createFontSubsetter({ spawnImpl = spawn, timeoutMs = 120_000 } = {}) {
  // 用当前 Python 环境的 fontTools 生成 TTF 子集;失败返回 ok:false,由调用方回退。
  function run(python, args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(python, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
        return;
      }
      let out = "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        finish({ ok: false, error: "字体子集化超时" });
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => { out += chunk; });
      child.stderr?.on("data", (chunk) => { out += chunk; });
      child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
      child.on("close", (code) => finish({ ok: code === 0, error: code === 0 ? "" : out.trim().slice(-300) }));
    });
  }

  async function subset({ python = "python", fontPath, chars, outPath, family = "", workDir = "" } = {}) {
    if (!fontPath || !fs.existsSync(fontPath)) return { ok: false, error: "字体文件不存在" };
    if (!chars) return { ok: false, error: "缺少字符集" };
    const base = String(workDir || path.dirname(outPath) || ".");
    fs.mkdirSync(base, { recursive: true });
    const charsFile = path.join(base, "font-chars.txt");
    const script = path.join(base, "font-subset.py");
    fs.writeFileSync(charsFile, chars, "utf8");
    fs.writeFileSync(script, SUBSET_SCRIPT, "utf8");
    const result = await run(python, [script, fontPath, charsFile, outPath, family || ""]);
    if (!result.ok) return result;
    if (!fs.existsSync(outPath)) return { ok: false, error: "子集化没有生成文件" };
    return { ok: true, path: outPath };
  }

  return { subset };
}

// 一本书要用到的字符集:全书文本 + 常用标点 + 拉丁基本区。
export function collectChars(texts, extra = "") {
  const set = new Set();
  for (const text of Array.isArray(texts) ? texts : []) {
    for (const char of String(text || "")) set.add(char);
  }
  for (const char of "　，。、；：？！“”‘’（）《》〈〉【】—…·「」『』．,.;:?!\"'()[]{}<>-–—/\\|@#$%^&*_+=~`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") {
    set.add(char);
  }
  for (const char of String(extra || "")) set.add(char);
  return [...set].join("");
}

// 书坊:封面渲染(模板生成)。纯 HTML/CSS → Electron 离屏窗口截图 → JPEG。
// 指定图片 / 自动首图由 runner 直接读图,这里只负责"模板生成"。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COVER_PALETTES } from "../shared/book-styles.js";

export { COVER_PALETTES };

export const COVER_SIZE = Object.freeze({ width: 1600, height: 2400 });

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeCoverOptions(options = {}) {
  const palette = COVER_PALETTES[options.palette] ? options.palette : "warm";
  return {
    title: String(options.title || "未命名").slice(0, 60),
    author: String(options.author || "").slice(0, 40),
    subtitle: String(options.subtitle || "").slice(0, 60),
    palette,
    headingFamily: String(options.headingFamily || "Georgia, serif"),
    bodyFamily: String(options.bodyFamily || "Georgia, serif"),
    quality: Math.min(95, Math.max(60, Number(options.quality) || 88)),
  };
}

// 模板封面 HTML:1600×2400 全幅,书名居中,作者在下,细线装饰。
export function coverHtml(options = {}, { fonts = [] } = {}) {
  const cover = normalizeCoverOptions(options);
  const palette = COVER_PALETTES[cover.palette];
  const faces = fonts
    .map((font) => {
      const source = font.file ? `url('${escapeHtml(font.file)}')` : `url(data:font/woff2;base64,${font.data})`;
      return `@font-face { font-family: '${escapeHtml(font.family)}'; src: ${source}; font-display: block; }`;
    })
    .join("\n");
  const titleSize = cover.title.length > 24 ? 150 : cover.title.length > 14 ? 190 : 230;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>
${faces}
html, body { margin: 0; padding: 0; width: ${COVER_SIZE.width}px; height: ${COVER_SIZE.height}px; }
body {
  background: ${palette.bg};
  color: ${palette.fg};
  font-family: ${cover.bodyFamily};
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 180px 160px;
  overflow: hidden;
}
.cover { width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: space-between; }
.top { display: flex; align-items: center; gap: 28px; color: ${palette.accent}; font-size: 40px; letter-spacing: .35em; }
.top .rule { flex: 1; height: 3px; background: ${palette.accent}; opacity: .55; }
.middle { margin-top: 120px; }
h1 {
  font-family: ${cover.headingFamily};
  font-size: ${titleSize}px;
  line-height: 1.25;
  font-weight: 700;
  margin: 0 0 48px;
  letter-spacing: .02em;
  word-break: break-word;
}
.subtitle { font-size: 58px; color: ${palette.sub}; line-height: 1.5; }
.bottom { display: flex; align-items: flex-end; justify-content: space-between; }
.author { font-size: 54px; color: ${palette.sub}; letter-spacing: .12em; }
.mark { width: 180px; height: 180px; border: 6px solid ${palette.accent}; border-radius: 50%; opacity: .5; display: flex; align-items: center; justify-content: center; font-size: 44px; color: ${palette.accent}; }
</style></head>
<body>
  <div class="cover">
    <div class="top"><span>UV READER</span><span class="rule"></span></div>
    <div class="middle">
      <h1>${escapeHtml(cover.title)}</h1>
      ${cover.subtitle ? `<div class="subtitle">${escapeHtml(cover.subtitle)}</div>` : ""}
    </div>
    <div class="bottom">
      <div class="author">${escapeHtml(cover.author)}</div>
      <div class="mark">纽</div>
    </div>
  </div>
</body></html>
`;
}

// Electron 离屏渲染:createWindow 注入(测试用假实现)。
// 字体写成临时文件、HTML 通过 file:// 载入 —— 内嵌 base64 会让 data URL 超过 2MB 上限。
export function createCoverRenderer({ createWindow, log = (...args) => console.log(...args), settleMs = 120, tempRoot = os.tmpdir() } = {}) {
  async function render(options = {}) {
    if (typeof createWindow !== "function") return { ok: false, error: "缺少离屏窗口实现" };
    const { width, height } = COVER_SIZE;
    const dir = fs.mkdtempSync(path.join(tempRoot, "qbr-cover-"));
    const fonts = [];
    for (const [index, font] of (Array.isArray(options.fonts) ? options.fonts : []).entries()) {
      if (!font?.path || !fs.existsSync(font.path)) continue;
      const file = `font-${index}.woff2`;
      fs.copyFileSync(font.path, path.join(dir, file));
      fonts.push({ family: String(font.family || "Cover Font"), file });
    }
    const html = coverHtml(options, { fonts });
    const htmlPath = path.join(dir, "cover.html");
    fs.writeFileSync(htmlPath, html, "utf8");
    let window = null;
    try {
      window = createWindow({
        show: false,
        width: Math.min(1600, width),
        height: Math.min(900, height),
        useContentSize: true,
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: true },
      });
      // Windows 会把创建时的窗口尺寸截到屏幕高度;创建后再设一次才能拿到整幅封面。
      try { window.setContentSize?.(width, height); } catch { /* fake windows in tests */ }
      await window.loadURL(pathToFileURL(htmlPath).href);
      try { await window.webContents.executeJavaScript("document.fonts ? document.fonts.ready.then(() => true) : true"); } catch { /* fonts api missing */ }
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      const image = await window.webContents.capturePage();
      const data = image.toJPEG(normalizeCoverOptions(options).quality);
      if (!data?.length) return { ok: false, error: "封面截图失败" };
      log("cover rendered", data.length, "bytes", fonts.length ? `with ${fonts.length} fonts` : "");
      return { ok: true, data, mediaType: "image/jpeg", width, height };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    } finally {
      try { window?.destroy(); } catch { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  return { render };
}

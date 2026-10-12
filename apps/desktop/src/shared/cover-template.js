// 模板封面(主进程与渲染层共用):纯 HTML/CSS,渲染层用它做面板预览,
// 主进程用 Electron 离屏窗口把它截成 1600×2400 的 JPEG。
import { COVER_PALETTES } from "./book-styles.js";

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

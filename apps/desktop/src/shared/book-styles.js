// 电子书样式(主进程与渲染层共用):单栏流式 CSS,预览与成品共用同一份。
export const BOOK_STYLE_DEFAULTS = Object.freeze({
  fontSize: 17,
  lineHeight: 1.75,
  margin: 5,
  indent: 2,
  spacing: 0,
  align: "justify",
  theme: "follow",
  headingAlign: "left",
  bodyFont: "Georgia, 'Songti SC', serif",
  headingFont: "",
  latinFont: "",
  codeFont: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
});

// 主题:follow 不写颜色(交给阅读器);其余给出纸色/墨色。
export const BOOK_THEMES = Object.freeze({
  follow: { bg: "", fg: "", rule: "", label: "跟随阅读主题" },
  paper: { bg: "#ffffff", fg: "#1f1f1f", rule: "#e2e2e2", label: "纸白" },
  warm: { bg: "#faf6ef", fg: "#3a3228", rule: "#e8dfd2", label: "暖纸" },
  celadon: { bg: "#f4f7f4", fg: "#26312b", rule: "#dde6dd", label: "青瓷" },
  night: { bg: "#1b1b1f", fg: "#d6d3cd", rule: "#3a3a40", label: "夜间" },
});

export function normalizeBookStyles(styles = {}) {
  const merged = { ...BOOK_STYLE_DEFAULTS, ...(styles || {}) };
  merged.fontSize = Math.min(28, Math.max(12, Number(merged.fontSize) || BOOK_STYLE_DEFAULTS.fontSize));
  merged.lineHeight = Math.min(2.4, Math.max(1.2, Number(merged.lineHeight) || BOOK_STYLE_DEFAULTS.lineHeight));
  merged.margin = Math.min(12, Math.max(0, Number(merged.margin) ?? BOOK_STYLE_DEFAULTS.margin));
  merged.indent = Math.min(4, Math.max(0, Number(merged.indent) ?? BOOK_STYLE_DEFAULTS.indent));
  merged.spacing = Math.min(2, Math.max(0, Number(merged.spacing) || 0));
  merged.align = merged.align === "left" ? "left" : "justify";
  merged.headingAlign = merged.headingAlign === "center" ? "center" : "left";
  merged.theme = BOOK_THEMES[merged.theme] ? merged.theme : "follow";
  return merged;
}

export function renderBookCss(styles = {}, { fontFaces = [] } = {}) {
  const s = normalizeBookStyles(styles);
  const theme = BOOK_THEMES[s.theme];
  const faces = fontFaces
    .map((face) => `@font-face { font-family: '${face.family}'; src: url('${face.src}'); font-style: normal; font-weight: ${face.weight || 400}; font-display: swap; }`)
    .join("\n");
  const colorBlock = theme.bg
    ? `html, body { background: ${theme.bg}; color: ${theme.fg}; }\nhr { border-top-color: ${theme.rule}; }\n`
    : "";
  const headingFont = s.headingFont ? `${s.headingFont}, ` : "";
  const bodyFont = s.latinFont ? `${s.bodyFont}, ${s.latinFont}` : s.bodyFont;
  return `${faces ? `${faces}\n` : ""}/* 单栏流式排版:不写死宽度,交给阅读器分栏/分页 */
html { -webkit-text-size-adjust: 100%; }
${colorBlock}body {
  font-family: ${bodyFont};
  font-size: ${s.fontSize}px;
  line-height: ${s.lineHeight};
  margin: ${s.margin}%;
  text-align: ${s.align};
  word-wrap: break-word;
  -webkit-hyphens: none;
  hyphens: none;
}
p { margin: 0 0 ${s.spacing}em; text-indent: ${s.indent}em; }
h1 + p, h2 + p, h3 + p, h4 + p, hr + p, blockquote + p, figure + p, pre + p { text-indent: 0; }
h1, h2, h3, h4 { font-family: ${headingFont}inherit; line-height: 1.3; margin: 1.4em 0 .7em; text-align: ${s.headingAlign}; text-indent: 0; page-break-after: avoid; }
h1 { font-size: 1.6em; margin-top: 0; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; } h4 { font-size: 1em; }
blockquote { margin: 1em 0; padding: .2em 0 .2em 1em; border-left: 3px solid currentColor; opacity: .85; }
blockquote p { text-indent: 0; }
pre { font-family: ${s.codeFont}; font-size: .9em; line-height: 1.5; padding: .7em .9em; overflow-x: auto; border: 1px solid rgba(128,128,128,.25); border-radius: 4px; white-space: pre-wrap; }
code { font-family: ${s.codeFont}; font-size: .92em; }
pre code { font-size: 1em; }
img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
figure { margin: 1em 0; text-align: center; }
figcaption { font-size: .85em; opacity: .75; }
hr { border: 0; border-top: 1px solid rgba(128,128,128,.4); margin: 1.6em 0; }
a { color: inherit; text-decoration: underline; }
table { border-collapse: collapse; margin: 1em 0; font-size: .95em; }
th, td { border: 1px solid rgba(128,128,128,.35); padding: .3em .6em; }
`;
}

import { importedFontFamily, importedReaderFonts } from "./reader-fonts.js";

// Accept font names/stacks, never arbitrary CSS. Canonical quoting also keeps
// this value safe when used inside the reader's generated stylesheet.
export function normalizeCustomFontFamily(value) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) return "";
  if (source.length > 500 || /[;{}<>\\]/u.test(source) || Array.from(source).some((char) => char.charCodeAt(0) < 32)) return null;
  const names = [];
  const token = /\s*(?:"([^"\n]+)"|'([^'\n]+)'|([\p{L}\p{N}_ .-]+))\s*(,|$)/uy;
  let offset = 0;
  while (offset < source.length) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) return null;
    const name = (match[1] ?? match[2] ?? match[3]).trim();
    if (!name || name.includes('"')) return null;
    const generic = match[3] && /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i.test(name);
    names.push(generic ? name.toLowerCase() : `"${name}"`);
    offset = token.lastIndex;
    if (match[4] && offset === source.length) return null;
  }
  return names.join(", ");
}

export function resolveReaderFont(settings, fonts) {
  if (settings.fontFamily === "custom") {
    if (settings.customFontId) {
      const font = importedReaderFonts(settings).find((item) => item.id === settings.customFontId);
      return font ? `"${importedFontFamily(font.id)}", serif` : fonts.georgia;
    }
    return normalizeCustomFontFamily(settings.customFontFamily) || fonts.georgia;
  }
  return fonts[settings.fontFamily] || fonts.georgia;
}

export function readerTextCss(settings, theme, fontFamily, host) {
  const hostStyle = host?.ownerDocument.defaultView?.getComputedStyle(host);
  const color = (value, fallback) => {
    const variable = /^var\((--[\w-]+)\)$/.exec(value);
    return variable ? hostStyle?.getPropertyValue(variable[1]).trim() || fallback : value;
  };
  // Obsidian variables do not cross the iframe document boundary.
  const background = color(theme.bg, "#ffffff");
  const foreground = color(theme.text, "#222222");
  const size = Math.max(12, Math.min(48, Number(settings.fontSize) || 18));
  const lineHeight = Math.max(1.2, Math.min(2.5, Number(settings.lineHeight) || 1.8));
  const align = ["left", "justify", "center", "right"].includes(settings.textAlign) ? settings.textAlign : "left";
  // MOBI paragraphs may carry align="justify" or their own text styles.
  // Set the selected typography on prose blocks, while retaining heading
  // sizes, emphasis, code fonts, and image geometry from the book.
  return `html{--theme-bg-color:${background};background:${background}!important}`
    + `body{background:${background}!important;color:${foreground}!important;}`
    + `body,body p,body li,body blockquote,body dd,body dt{font-family:${fontFamily}!important;`
    + `font-size:${size}px!important;line-height:${lineHeight}!important;text-align:${align}!important;}`;
}

// Reparent the existing controls so their listeners and keyboard behaviour are
// retained. Only the arrows leave the auto-hiding toolbar in always-on mode.
export function syncPageButtons(view) {
  const elements = view._pageButtons;
  if (!elements) return;
  const { root, toolbar, previous, next } = elements;
  const always = view.plugin.settings.pageButtonsVisibility === "always";
  root.classList.toggle("qiaomu-reader-page-buttons-always", always);
  previous.classList.toggle("qiaomu-reader-page-edge-prev", always);
  next.classList.toggle("qiaomu-reader-page-edge-next", always);
  for (const button of [previous, next]) button.classList.toggle("qiaomu-reader-page-edge", always);
  if (always) {
    if (previous.parentElement !== root) root.append(previous, next);
  } else if (previous.parentElement !== toolbar) {
    toolbar.insertBefore(previous, toolbar.querySelector(".qiaomu-reader-bot-center") || toolbar.firstChild);
    toolbar.append(next);
  }
}

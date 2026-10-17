// 书坊文档互转(DocVortex)的输入/输出格式表(主进程与渲染层共用)。
// DocVortex 支持 20 种输入、7 种输出;这里只列书坊会暴露的部分。
import { BOOK_EXTENSIONS } from "./books.js";

export const DOCVORTEX_INPUTS = [
  "pdf", "doc", "docx", "rtf", "ppt", "pptx", "xls", "xlsx", "csv", "tsv",
  "odt", "ods", "odp", "epub", "html", "htm", "shtml", "mhtml", "mht", "ofd",
];

// 纯文本类源(Markdown / txt):书坊直接按文本读;DocVortex 0.5.16 的原生输入里没有它们,
// 直接给 .md / .txt 会报 `Unsupported native input format: markdown|txt` —— 格式转换与
// 内容提取会先渲染成 HTML 再交给它(main/docvortex.js 的 textSourceBridge)。
export const TEXT_SOURCE_EXTENSIONS = Object.freeze(["md", "markdown", "txt"]);

export function textSourceKind(source) {
  const ext = String(source || "").split(".").pop()?.toLowerCase() || "";
  if (!TEXT_SOURCE_EXTENSIONS.includes(ext)) return "";
  return ext === "txt" ? "text" : "markdown";
}

// 书坊「打开本地文件…」对话框的过滤集合:电子书 + Office/ODF/OFD/HTML + 纯文本 + 图片。
// 各工具只处理自己支持的子集,这里保证默认过滤器能看见常见文档(而不是要用户切到"所有文件")。
export const WORKSHOP_PICK_EXTENSIONS = Object.freeze([...new Set([
  ...BOOK_EXTENSIONS,
  ...DOCVORTEX_INPUTS,
  ...TEXT_SOURCE_EXTENSIONS,
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "jp2",
])]);

export const DOCVORTEX_FORMATS = [
  { id: "markdown", label: "Markdown", ext: "md" },
  { id: "html", label: "HTML", ext: "html" },
  { id: "latex", label: "LaTeX", ext: "tex" },
  { id: "docx", label: "DOCX", ext: "docx" },
  { id: "pdf", label: "PDF", ext: "pdf" },
  // 电子书产物(EPUB/MOBI/AZW3/CBZ…)统一归「电子书制作」;JSON(结构化)归「内容提取」。
  // 格式转换只做"文档产物"的保持型转换。
];

export function docvortexFormatExt(target) {
  const found = DOCVORTEX_FORMATS.find((format) => format.id === String(target || ""));
  return found ? found.ext : String(target || "out").replace(/^\./, "");
}

// 电子书产物统一归「电子书制作」:互转目标 + 图片打包目标。
export const EBOOK_TARGETS = [
  { id: "azw3", label: "AZW3(Kindle 主流)", ext: "azw3" },
  { id: "mobi", label: "MOBI(旧 Kindle)", ext: "mobi" },
];

export const IMAGE_BOOK_TARGETS = [
  { id: "cbz", label: "CBZ(漫画 / 相册)", ext: "cbz" },
  { id: "epub", label: "EPUB(先打包再转)", ext: "epub" },
];

export function ebookTargetExt(target, list = EBOOK_TARGETS) {
  const found = list.find((entry) => entry.id === String(target || ""));
  return found ? found.ext : String(target || "out").replace(/^\./, "");
}

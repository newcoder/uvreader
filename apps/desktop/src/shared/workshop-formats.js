// 书坊文档互转(DocVortex)的输入/输出格式表(主进程与渲染层共用)。
// DocVortex 支持 20 种输入、7 种输出;这里只列书坊会暴露的部分。
export const DOCVORTEX_INPUTS = [
  "pdf", "doc", "docx", "rtf", "ppt", "pptx", "xls", "xlsx", "csv", "tsv",
  "odt", "ods", "odp", "epub", "html", "htm", "shtml", "mhtml", "mht", "ofd",
];

export const DOCVORTEX_FORMATS = [
  { id: "markdown", label: "Markdown", ext: "md" },
  { id: "html", label: "HTML", ext: "html" },
  { id: "latex", label: "LaTeX", ext: "tex" },
  { id: "docx", label: "DOCX", ext: "docx" },
  { id: "epub", label: "EPUB", ext: "epub" },
  { id: "pdf", label: "PDF", ext: "pdf" },
  // JSON(结构化)归「内容提取」:格式转换只做内容+版式的保持型转换。
];

export function docvortexFormatExt(target) {
  const found = DOCVORTEX_FORMATS.find((format) => format.id === String(target || ""));
  return found ? found.ext : String(target || "out").replace(/^\./, "");
}

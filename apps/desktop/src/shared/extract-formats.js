// 内容提取的输入与模式(主进程与渲染层共用)。
import { DOCVORTEX_INPUTS } from "./workshop-formats.js";

export const IMAGE_INPUTS = Object.freeze(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "jp2"]);

export const EXTRACT_MODES = Object.freeze([
  { id: "auto", label: "自动(有 MinerU 用 MinerU,否则文本 / 扫描视觉)" },
  { id: "mineru", label: "MinerU 云端(公式 LaTeX、表格 HTML)" },
  { id: "text", label: "文本型 PDF(本地取文本,不跑 OCR;无公式)" },
  { id: "vision", label: "扫描视觉(整页图一次调用)" },
]);

export function extractionKind(source) {
  const ext = String(source || "").split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf") return "pdf";
  if (IMAGE_INPUTS.includes(ext)) return "image";
  if (DOCVORTEX_INPUTS.includes(ext)) return "document";
  return "";
}

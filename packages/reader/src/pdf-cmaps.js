import { EMBEDDED_PDF_CMAPS } from "./pdf-cmaps-data.js";
import { EMBEDDED_PDF_WASM } from "./pdf-wasm-data.js";

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class EmbeddedPdfBinaryDataFactory {
  async fetch({ kind, filename }) {
    // pdf.js asks for CMaps and, since v6, for the wasm decoders (jbig2,
    // openjpeg, qcms, quickjs) through the same channel; both are embedded so
    // scanned pages keep rendering offline.
    const source = kind === "cMapUrl" ? EMBEDDED_PDF_CMAPS : kind === "wasmUrl" ? EMBEDDED_PDF_WASM : null;
    if (!source) throw new Error(`Unsupported embedded PDF resource kind: ${kind}`);
    const encoded = source[filename];
    if (!encoded) throw new Error(`Embedded PDF resource is unavailable: ${filename}`);
    return decodeBase64(encoded);
  }
}

export const PDF_CMAP_OPTIONS = Object.freeze({
  cMapUrl: "qiaomu-cmaps:///",
  cMapPacked: true,
  useWorkerFetch: false,
  BinaryDataFactory: EmbeddedPdfBinaryDataFactory,
});

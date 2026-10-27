// Image → PDF helpers shared by content extraction and format conversion.
// Kept in its own module so the DocVortex converter does not have to import
// the extraction runner (which imports DocVortex helpers back).
import { spawn } from "node:child_process";

export const IMAGE_TO_PDF_SCRIPT = `import sys
from PIL import Image
im = Image.open(sys.argv[1])
if im.mode != "RGB":
    im = im.convert("RGB")
im.save(sys.argv[2], "PDF")
`;

// Multiple images → one PDF: one page per image, 150 dpi for physical size.
export const IMAGES_TO_PDF_SCRIPT = `import sys
from PIL import Image
out = sys.argv[1]
pages = []
for path in sys.argv[2:]:
    im = Image.open(path)
    if im.mode != "RGB":
        im = im.convert("RGB")
    im.info["dpi"] = (150, 150)
    pages.append(im)
if not pages:
    raise SystemExit("no images to pack")
pages[0].save(out, "PDF", save_all=True, append_images=pages[1:], dpi=(150, 150), resolution=150.0)
`;

export function docvortexPython(settings = {}) {
  return String(settings.docvortexPython || settings.ocrPython || "").trim() || "python";
}

function runImageCommand(command, args, { signal, timeoutMs = 60_000, log = () => {}, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* gone */ }
      finish({ ok: false, cancelled: true, error: "任务已取消" });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      finish({ ok: false, error: `图片转 PDF 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    child.on("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
    child.on("close", (code) => {
      if (code !== 0) log("image → pdf failed", code, out.trim().slice(-200));
      finish({
        ok: code === 0,
        error: code === 0 ? "" : (out.trim().split("\n").filter(Boolean).pop() || `退出码 ${code}`),
      });
    });
  });
}

export function imageToPdf(source, outPath, { python = "python", signal, log = () => {}, spawnImpl = spawn } = {}) {
  return runImageCommand(python, ["-c", IMAGE_TO_PDF_SCRIPT, source, outPath], {
    signal,
    timeoutMs: 60_000,
    log,
    spawnImpl,
  });
}

export function imagesToPdf(images, outPath, { python = "python", signal, log = () => {}, spawnImpl = spawn } = {}) {
  return runImageCommand(python, ["-c", IMAGES_TO_PDF_SCRIPT, outPath, ...images.map((file) => String(file))], {
    signal,
    timeoutMs: 120_000,
    log,
    spawnImpl,
  });
}

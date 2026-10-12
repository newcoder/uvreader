// 书坊:封面渲染(模板生成)。纯 HTML/CSS → Electron 离屏窗口截图 → JPEG。
// 指定图片 / 自动首图由 runner 直接读图,这里只负责"模板生成"。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COVER_SIZE, coverHtml, normalizeCoverOptions } from "../shared/cover-template.js";

export { COVER_SIZE, coverHtml, normalizeCoverOptions };
export { COVER_PALETTES } from "../shared/book-styles.js";

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

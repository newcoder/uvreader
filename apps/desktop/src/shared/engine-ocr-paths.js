// 书坊引擎升级后，设置里可能还留着上一版引擎的 pdf_tool / Python 路径。
// 这些路径由应用自己写入，不属于用户手填配置；只要仍然指向旧引擎，就应该
// 跟着当前安装的引擎走，否则升级后会报「这个目录里没有 pdf_tool」。
const MANAGED_ENGINE_PATH = /(?:^|[\\/])(?:UVReader|UV Reader|uvreader-desktop|qiaomu-reader-desktop)[\\/]engine[\\/][^\\/]+[\\/]/i;

export function isManagedEngineOcrPath(value) {
  const text = String(value || "").trim();
  return Boolean(text) && MANAGED_ENGINE_PATH.test(text);
}

function samePath(left, right) {
  return String(left || "").replace(/\\/g, "/").toLowerCase()
    === String(right || "").replace(/\\/g, "/").toLowerCase();
}

// 返回需要写入 settings 的字段；null 表示保留用户当前配置。
// 用户手填的目录 / 程序仍然优先，应用只替换自己以前写入的旧引擎路径。
export function engineOcrPathUpdate(settings = {}, state = {}) {
  const dir = String(state?.ocrSidecarDir || "").trim();
  const python = String(state?.ocrPython || "").trim();
  if (!dir || !python) return null;
  const currentDir = String(settings?.ocrSidecarDir || "").trim();
  const currentPython = String(settings?.ocrPython || "").trim();
  const currentExe = String(settings?.ocrSidecarExe || "").trim();
  if (currentExe && !isManagedEngineOcrPath(currentExe)) return null;
  if (currentDir && !isManagedEngineOcrPath(currentDir)) return null;
  if (currentPython && currentPython !== "python" && !isManagedEngineOcrPath(currentPython)) return null;
  if (!currentExe && samePath(currentDir, dir) && samePath(currentPython, python)) return null;
  return { ocrSidecarDir: dir, ocrPython: python, ocrSidecarExe: "" };
}

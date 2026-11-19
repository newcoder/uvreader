// 空间内产物路径。空间目录约定为：
//   <library>/Spaces/<空间名>/books/<源文件>
// 产物按类型放到同级目录（quizzes/translations/...）。
// 纯字符串函数，阅读器核心与主进程都可以使用。

const SPACE_SOURCE = /^((?:.*?\/)?Spaces\/[^/]+)\/books\/[^/]+$/i;

export const SPACE_OUTPUT_DIRS = Object.freeze({
  notes: "notes",
  reading: "reading",
  translations: "translations",
  extracts: "extracts",
  quizzes: "quizzes",
  polish: "polish",
  exports: "exports",
});

function slash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function safeBase(value) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "文件";
}

function stamp(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function spaceRootForSource(sourcePath) {
  const match = SPACE_SOURCE.exec(slash(sourcePath));
  return match ? match[1] : "";
}

export function spaceCategoryDir(sourcePath, category) {
  const root = spaceRootForSource(sourcePath);
  if (!root) return "";
  const folder = SPACE_OUTPUT_DIRS[category] || String(category || "").replace(/[\\/]+/g, "-").trim();
  return folder ? `${root}/${folder}` : root;
}

// Space quiz pages belong to the reader's quiz view. Absolute output paths
// are already inside the space; category/relativePath come from the scanner.
export function isQuizOutput(output) {
  const name = String(output?.name || output?.path || "");
  const extension = name.split(".").pop()?.toLowerCase() || "";
  if (extension !== "html" && extension !== "htm") return false;
  if (String(output?.category || "").toLowerCase() === "quizzes") return true;
  return /^quizzes\//i.test(slash(output?.relativePath || ""));
}

export function spaceOutputPath(sourcePath, category, extension, options = {}) {
  const root = spaceRootForSource(sourcePath);
  if (!root) return "";
  const source = slash(sourcePath);
  const sourceName = source.split("/").pop() || "文件";
  const dot = sourceName.lastIndexOf(".");
  const sourceBase = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  const ext = String(extension || "out").replace(/^\.+/, "") || "out";
  const base = safeBase(options.base || sourceBase);
  const suffix = String(options.suffix || "");
  const dir = spaceCategoryDir(sourcePath, category);
  if (!dir) return "";
  const target = `${dir}/${base}${suffix}.${ext}`;
  if (typeof options.exists !== "function" || !options.exists(target)) return target;
  const first = `${dir}/${base}${suffix} - ${stamp(options.now)}.${ext}`;
  if (!options.exists(first)) return first;
  for (let index = 2; ; index += 1) {
    const next = `${dir}/${base}${suffix} - ${stamp(options.now)}-${index}.${ext}`;
    if (!options.exists(next)) return next;
  }
}

export function spaceVaultRelative(sourcePath, vaultRoot) {
  const source = slash(sourcePath);
  const root = slash(vaultRoot).replace(/\/+$/, "");
  return root && source.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? source.slice(root.length + 1)
    : source;
}

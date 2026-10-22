// 书坊「选择书库文件」的过滤:只看当前书库根目录,不再列出书库外的
// 测试文件、提取中间产物或旧文档。
//
// 书库根目录:
// 1. 设置里的 booksFolder(用户明确指定);
// 2. 否则如果存在 Books/,以 Books/ 为当前书库(下载、示例书库都在这里);
// 3. 否则退回 vault 根目录,但只列根目录文件(不递归到 notes/、assets/ 等)。
export function libraryRoot(files, booksFolder = "") {
  const configured = String(booksFolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (configured) return configured;
  const list = Array.isArray(files) ? files : [];
  return list.some((file) => String(file?.path || "").replace(/\\/g, "/").startsWith("Books/")) ? "Books" : "";
}

export function filterLibraryFiles(files, {
  booksFolder = "",
  extensions = [],
  isLibraryBook = null,
} = {}) {
  const list = Array.isArray(files) ? files : [];
  const root = libraryRoot(list, booksFolder);
  const wanted = new Set((Array.isArray(extensions) ? extensions : []).map((ext) => String(ext || "").toLowerCase()));
  return list.filter((file) => {
    const raw = String(file?.path || "").replace(/\\/g, "/");
    if (!raw) return false;
    if (isLibraryBook && isLibraryBook(file) === false) return false;
    const ext = String(file?.extension || raw.split(".").pop() || "").toLowerCase();
    if (wanted.size && !wanted.has(ext)) return false;
    // PDF 文字层 sidecar 是生成物,不是书库书籍。
    if (/\.uvtext\.pdf$/i.test(raw)) return false;
    if (root) return raw.startsWith(`${root}/`);
    return !raw.includes("/");
  });
}

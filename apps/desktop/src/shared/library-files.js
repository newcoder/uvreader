// 书坊「选择书库文件」的过滤:只列书库里的书籍,不再列出
// 书库外的测试文件、提取中间产物或旧文档。
//
// 如果设置里明确填了 booksFolder,只在该目录(含子目录)里找;
// 否则和书库界面一样,在整个 vault 里找书籍格式。notes/、images/、assets/
// 等目录里的非书籍文件由扩展名过滤掉。
import { IMAGE_BOOK_EXTENSIONS } from "../../../../packages/reader/src/image-book.js";

// The ebook builder can consume these library-book formats. FB2/MOBI/AZW3/CBZ
// remain reader formats; Office/Markdown/TXT are local-file sources.
export const BOOK_BUILDER_SOURCE_EXTENSIONS = Object.freeze([
  "epub",
  "pdf",
  ...IMAGE_BOOK_EXTENSIONS,
]);

export function libraryRoot(_files, booksFolder = "") {
  return String(booksFolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
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
    // 与书库界面使用同一套可见性判定:书库里能看到的书,书坊列表也要有。
    return root ? raw.startsWith(`${root}/`) : true;
  });
}

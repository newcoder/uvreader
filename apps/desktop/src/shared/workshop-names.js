// 书坊产物命名(主进程与渲染层共用):可搜索 PDF 用 `.uvtext` 后缀,紧贴扩展名。
// 导出可以重复执行:输出固定在源文件旁,同名直接覆盖(不再自动加序号)。
export const UVTEXT_SUFFIX = ".uvtext";

export function uvtextPath(sourcePath) {
  const normalized = String(sourcePath || "").replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash) : "";
  const name = normalized.slice(slash + 1) || "book.pdf";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : ".pdf";
  const target = `${base}${UVTEXT_SUFFIX}${ext}`;
  return dir ? `${dir}/${target}` : target;
}

// 文档互转产物:目标扩展名(报告.docx → 报告.md)。扩展名变了就不加后缀,
// 直接换扩展名;扩展名不变(如 PDF→PDF)时用序号区分,避免覆盖源文件。
export function convertPath(sourcePath, ext, exists = () => false, baseName = "") {
  const targetExt = String(ext || "out").replace(/^\./, "") || "out";
  const normalized = String(sourcePath || "").replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash) : "";
  const name = normalized.slice(slash + 1) || "book";
  const dot = name.lastIndexOf(".");
  const base = String(baseName || "").trim() || (dot > 0 ? name.slice(0, dot) : name);
  const join = (candidate) => (dir ? `${dir}/${candidate}` : candidate);
  let candidate = join(`${base}.${targetExt}`);
  let index = 1;
  while (exists(candidate)) candidate = join(`${base} (${index++}).${targetExt}`);
  return candidate;
}

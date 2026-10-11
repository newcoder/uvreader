// 书坊产物命名(主进程与渲染层共用):可搜索 PDF 用 `.uvtext` 后缀,
// 同名的自动加序号(报告 (1).uvtext.pdf),后缀始终紧贴扩展名。
export const UVTEXT_SUFFIX = ".uvtext";

export function uvtextPath(sourcePath, exists = () => false) {
  const normalized = String(sourcePath || "").replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dir = slash >= 0 ? normalized.slice(0, slash) : "";
  const name = normalized.slice(slash + 1) || "book.pdf";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : ".pdf";
  const join = (candidate) => (dir ? `${dir}/${candidate}` : candidate);
  let candidate = join(`${base}${UVTEXT_SUFFIX}${ext}`);
  let index = 1;
  while (exists(candidate)) candidate = join(`${base} (${index++})${UVTEXT_SUFFIX}${ext}`);
  return candidate;
}

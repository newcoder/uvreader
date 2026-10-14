// 目录(章节)编辑:纯函数,渲染层与主进程共用。
// 章节形如 { title, text }(text 为原始文字;最终 HTML 由 text-book.js 渲染)。

export function normalizeChapters(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((chapter) => ({ title: String(chapter?.title || "").trim(), text: String(chapter?.text || "") }))
    .filter((chapter) => chapter.title || chapter.text.trim());
}

export function renameChapter(chapters, index, title) {
  const next = normalizeChapters(chapters);
  if (!next[index]) return next;
  next[index] = { ...next[index], title: String(title || "").trim() || next[index].title };
  return next;
}

// 与下一章合并(保留当前章标题,文字按空行相接)。
export function mergeChapters(chapters, index) {
  const next = normalizeChapters(chapters);
  if (index < 0 || index + 1 >= next.length) return next;
  const first = next[index];
  const second = next[index + 1];
  next[index] = { title: first.title || second.title, text: `${first.text.trimEnd()}\n\n${second.text.trimStart()}` };
  next.splice(index + 1, 1);
  return next;
}

// 从段落边界(最接近中点)拆成两章;第二章标题默认加「（下）」。
export function splitChapter(chapters, index) {
  const next = normalizeChapters(chapters);
  const chapter = next[index];
  if (!chapter || !chapter.text.trim()) return next;
  const paragraphs = chapter.text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length < 2) return next;
  const total = paragraphs.reduce((sum, part) => sum + part.length, 0);
  let acc = 0;
  let cut = 1;
  for (let i = 0; i < paragraphs.length - 1; i += 1) {
    acc += paragraphs[i].length;
    if (acc >= total / 2) {
      cut = i + 1;
      break;
    }
  }
  const head = paragraphs.slice(0, cut).join("\n\n");
  const tail = paragraphs.slice(cut).join("\n\n");
  const baseTitle = chapter.title || "未命名";
  next.splice(index, 1,
    { title: baseTitle, text: head },
    { title: `${baseTitle}（下）`, text: tail });
  return next;
}

export function moveChapter(chapters, index, delta) {
  const next = normalizeChapters(chapters);
  const target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  const [chapter] = next.splice(index, 1);
  next.splice(target, 0, chapter);
  return next;
}

// 删掉一章(面板里遇到页眉/扉页这类不该成章的,直接删;最后一章不允许删空)。
export function removeChapter(chapters, index) {
  const next = normalizeChapters(chapters);
  if (next.length <= 1 || index < 0 || index >= next.length) return next;
  next.splice(index, 1);
  return next;
}

export function chapterStats(chapters) {
  const list = normalizeChapters(chapters);
  return { chapters: list.length, chars: list.reduce((sum, chapter) => sum + chapter.text.length, 0) };
}

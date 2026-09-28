// Read-only tools the AI may call while answering: current position, outline,
// page text, search and saved highlights. The reader supplies a small state
// object, so this module holds only the schemas, the argument handling and the
// model-facing formatting — no host APIs.
export const AI_TOOL_LIMITS = Object.freeze({
  readPages: 3,
  resultChars: 4_000,
  outline: 80,
  highlights: 20,
  searchHits: 8,
});

export const AI_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "get_reading_position",
    description: "获取读者当前的阅读位置：页码、章节和阅读进度。回答“我们现在看到哪里”这类问题时先调用它。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_book_outline",
    description: "获取整本书的目录：章节标题，PDF 还会给出页码。用于了解全书结构或定位相关章节。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_page_image",
    description: "把指定页渲染成图片后交给视觉模型阅读。适合公式、图表、扫描页，或文字层是乱码的页面。参数 page（页码，从 1 开始）。",
    parameters: {
      type: "object",
      properties: { page: { type: "number", description: "页码，从 1 开始。" } },
      required: ["page"],
      additionalProperties: false,
    },
  },
  {
    name: "read_pages",
    description: "读取指定页码的正文文字（最多 3 页）。只适用于有文字层的页面；扫描页和乱码页会自动附上页面图片（如果模型支持图片）。",
    parameters: {
      type: "object",
      properties: {
        start: { type: "number", description: "起始页码，从 1 开始。" },
        count: { type: "number", description: "读取页数，默认 1，最多 3。" },
      },
      required: ["start"],
      additionalProperties: false,
    },
  },
  {
    name: "search_book",
    description: "在全书范围内检索关键词（简体与繁体等同），返回命中位置和上下文。用它回答“书中哪里提到……”这类问题。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，至少 2 个字符或 1 个汉字。" },
        limit: { type: "number", description: "最多返回条数，默认 6，最多 8。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_highlights",
    description: "列出读者保存的划线（含页码或章节、片段与批注）。用于回顾读者关注过的内容。",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "最多返回条数，默认 12，最多 20。" } },
      additionalProperties: false,
    },
  },
  {
    name: "search_books_online",
    description: "在已启用的书籍来源（Project Gutenberg、Standard Ebooks、Internet Archive、Open Library、Z-Library 等）中搜索可下载的书。返回标题、作者、来源、格式和大小；要下载时把结果里的完整标题交给 download_book。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "书名或作者。" },
        limit: { type: "number", description: "最多返回条数，默认 8，最多 12。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "download_book",
    description: "把一本书下载到本地书库并在完成后通知读者。用 search_books_online 给出的完整标题（可加作者）最稳妥；下载在后台进行，成功后书会出现在书库页。只有读者明确想下载时才调用。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "要下载的书名，最好来自 search_books_online 的结果。" },
        author: { type: "string", description: "可选，作者，用于在有多个同名版本时挑选。" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "toc_scan",
    description: "扫描当前 PDF 的目录情况：已有大纲条目数、可能包含目录的页（带评分与理由）。只读。用于回答“目录为什么不能跳转/不完整”。读者要求制作/更新目录导航时，扫描之后应继续调用 toc_build 生成草稿（缺页码时先问读者）。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "toc_build",
    description: "根据目录页生成/更新本书的导航目录草稿（不会立即生效）。参数可缺省：pages（目录页，如 \"6-7\"）、offset（印刷页→PDF 页偏移）、mode（merge 默认 / replace）。生成后必须把预览复述给读者并等待确认，切勿自行调用 toc_apply。",
    parameters: {
      type: "object",
      properties: {
        pages: { type: "string", description: "目录页范围，如 \"6\" 或 \"6-7\"；缺省时自动扫描。" },
        offset: { type: "number", description: "印刷页码到 PDF 页码的偏移；缺省时自动推断。" },
        mode: { type: "string", enum: ["merge", "replace"], description: "merge 保留原有条目并补充，replace 整体替换。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "toc_apply",
    description: "把 toc_build 的草稿正式应用为导航目录；仅在读者明确确认后调用。args.undo=true 时撤销生成结果、恢复原有目录。",
    parameters: {
      type: "object",
      properties: { undo: { type: "boolean", description: "撤销上一次应用的生成目录。" } },
      additionalProperties: false,
    },
  },
]);

// Text layers can be formula soup or half-broken scans. Handing that to the
// model as if it were prose wastes the turn; say what it is instead.
export function pageTextQuality(text) {
  const value = String(text || "").trim();
  if (!value) return "empty";
  if (value.length < 40) return "short";
  // Prose keeps long readable runs and long lines; a broken text layer (formula
  // soup, scan artefacts) is short fragments stacked one per line.
  const runs = value.match(/[\p{Script=Han}A-Za-z0-9]{2,}/gu) || [];
  const inRuns = runs.reduce((sum, run) => sum + run.length, 0);
  const lines = value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const averageLine = value.length / Math.max(1, lines.length);
  return inRuns / value.length >= 0.55 && averageLine >= 12 ? "ok" : "noise";
}

function boundedNumber(value, fallback, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function createAiTools({ state = {}, maxChars = AI_TOOL_LIMITS.resultChars } = {}) {
  const clamp = (text) => {
    const value = String(text ?? "").trim();
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  };
  const handlers = {
    get_reading_position() {
      const position = state.position?.();
      if (!position) return "暂时无法确定阅读位置。";
      const rows = [`当前：${position.label || "未定位"}`];
      if (position.page) rows.push(`页码：第 ${position.page} 页${state.pageCount ? ` / 共 ${state.pageCount} 页` : ""}`);
      if (Number.isFinite(position.percent)) rows.push(`进度：${Math.round(position.percent * 100)}%`);
      return rows.join("\n");
    },
    get_book_outline() {
      const outline = (state.outline?.() || []).slice(0, AI_TOOL_LIMITS.outline);
      if (!outline.length) return "这本书没有可用的目录。";
      return outline.map((item, index) => `${index + 1}. ${item.label}${item.page ? `（第 ${item.page} 页）` : ""}`).join("\n");
    },
    async read_pages(args = {}) {
      const start = boundedNumber(args.start, 1, 1, Math.max(1, Number(state.pageCount) || 1));
      const count = boundedNumber(args.count, 1, 1, AI_TOOL_LIMITS.readPages);
      const pages = state.readPages?.(start, count);
      if (Array.isArray(pages) && pages.length) {
        const qualityOf = (entry) => pageTextQuality(String(entry.text || "").trim());
        // Short pages are fine (a title page, a section end); only empty or
        // broken text layers need the picture.
        const broken = pages.find((entry) => ["empty", "noise"].includes(qualityOf(entry)));
        // A formula soup or a scan is not readable text: hand the page itself
        // over when the model can actually see it.
        const images = [];
        if (broken && state.canSeeImages) {
          const image = await state.renderPageImage?.(broken.page);
          if (image?.data) images.push({ ...image, page: broken.page });
        }
        const attachedPage = images.length ? images[0].page : 0;
        const text = pages.map((entry) => {
          const quality = qualityOf(entry);
          if (quality !== "noise" && quality !== "empty") return `【第 ${entry.page} 页】\n${String(entry.text).trim()}`;
          if (quality === "empty") {
            return `【第 ${entry.page} 页】\n（此页没有可提取的文字，可能是扫描图片${attachedPage === entry.page ? "；已附上页面图片" : "；可以让读者发页面截图"}）`;
          }
          return `【第 ${entry.page} 页】\n（此页文字层质量较差，内容可能不完整——公式、图表或扫描页${attachedPage === entry.page ? "；已附上页面图片" : "；必要时让读者发页面截图"}）\n${String(entry.text || "").trim()}`;
        }).join("\n\n");
        return { text, images };
      }
      const current = state.readCurrent?.();
      if (current) return `【${current.label || "当前章节"}】\n${current.text || "（当前章节没有可提取的文字）"}`;
      return "这个格式暂不支持按页读取文字。";
    },
    async search_book(args = {}) {
      const query = String(args.query ?? "").trim();
      if (!query) return "请提供检索关键词。";
      const limit = boundedNumber(args.limit, 6, 1, AI_TOOL_LIMITS.searchHits);
      // The EPUB engine searches section by section, so a hit list may arrive
      // as a promise; PDF blocks answer synchronously.
      const hits = await state.search?.(query, limit);
      if (hits === null || hits === undefined) return "这个格式暂不支持全书检索；可以改用 read_pages 读取当前页或当前章节。";
      if (!hits.length) return `没有找到「${query}」。`;
      return hits.map((hit, index) => {
        const where = hit.label || (hit.page ? `第 ${hit.page} 页` : "位置未知");
        return `${index + 1}. ${where}：${String(hit.snippet || "").trim()}`;
      }).join("\n");
    },
    async read_page_image(args = {}) {
      if (!state.canSeeImages) return "当前模型不支持图片：可以让读者发页面截图，或换一个支持图片的模型。";
      const page = boundedNumber(args.page, 1, 1, Math.max(1, Number(state.pageCount) || 1));
      const image = await state.renderPageImage?.(page);
      if (!image?.data) return `无法把第 ${page} 页渲染成图片（此格式或页面不支持，可以让读者用截图）。`;
      return { text: `【第 ${page} 页图片】`, images: [{ ...image, page }] };
    },
    list_highlights(args = {}) {
      const limit = boundedNumber(args.limit, 12, 1, AI_TOOL_LIMITS.highlights);
      const items = (state.highlights?.() || []).slice(0, limit);
      if (!items.length) return "读者还没有保存划线。";
      return items.map((item, index) => {
        const where = item.label ? `[${item.label}] ` : "";
        const comment = item.comment ? `（批注：${item.comment}）` : "";
        return `${index + 1}. ${where}${item.text}${comment}`;
      }).join("\n");
    },
    async search_books_online(args = {}) {
      const query = String(args.query ?? "").trim();
      if (!query) return "请提供书名或作者。";
      if (typeof state.searchBooks !== "function") return "当前环境不支持网络搜书（需要桌面版并启用书籍来源）。";
      const limit = boundedNumber(args.limit, 8, 1, 12);
      const report = await state.searchBooks(query);
      const results = (report?.results || []).filter((item) => item.downloadable && !item.needsSession).slice(0, limit);
      const errors = (report?.errors || []).map((item) => item.name || item.source).filter(Boolean);
      if (!results.length) {
        const suffix = errors.length ? `（这些来源失败：${errors.join("、")}）` : "";
        return `没有找到可下载的「${query}」${suffix}。`;
      }
      const rows = results.map((item, index) => {
        const bits = [item.author, item.sourceName, item.format ? String(item.format).toUpperCase() : "", item.size, item.year].filter(Boolean);
        return `${index + 1}. ${item.title}${bits.length ? ` — ${bits.join("｜")}` : ""}`;
      });
      if (errors.length) rows.push(`（这些来源失败：${errors.join("、")}）`);
      return rows.join("\n");
    },
    async download_book(args = {}) {
      const title = String(args.title ?? "").trim();
      if (!title) return "请提供书名。";
      if (typeof state.downloadBook !== "function") return "当前环境不支持下载（需要桌面版并启用书籍来源）。";
      const author = String(args.author ?? "").trim();
      const wanted = (value) => String(value || "").toLowerCase();
      const report = await state.searchBooks(title);
      const candidates = (report?.results || []).filter((item) => item.downloadable && !item.needsSession);
      const result = candidates.find((item) => wanted(item.title) === wanted(title) && (!author || wanted(item.author).includes(wanted(author))))
        || candidates.find((item) => wanted(item.title).includes(wanted(title)))
        || candidates[0];
      if (!result) return `没有找到可下载的「${title}」；可以先用 search_books_online 看看有哪些版本。`;
      const outcome = await state.downloadBook(result);
      if (outcome?.ok) return `已下载并加入书库：${outcome.name || result.title}（来源：${result.sourceName || result.source}）。可以告诉读者在书库页打开。`;
      return `下载「${title}」失败：${outcome?.error || "未知原因"}。`;
    },
    toc_scan() {
      if (typeof state.tocScan !== "function") return "当前环境不支持目录扫描（需要在 PDF 阅读视图里）。";
      return state.tocScan() || "没有扫描结果。";
    },
    async toc_build(args = {}) {
      if (typeof state.tocBuild !== "function") return "当前环境不支持生成目录（需要在 PDF 阅读视图里）。";
      const report = await state.tocBuild({
        pages: String(args.pages ?? ""),
        offset: args.offset,
        mode: args.mode === "replace" ? "replace" : "merge",
      });
      return report?.preview || "没有生成目录草稿。";
    },
    toc_apply(args = {}) {
      if (typeof state.tocApply !== "function") return "当前环境不支持应用目录（需要在 PDF 阅读视图里）。";
      return state.tocApply({ undo: args.undo === true })?.summary || "没有可应用的目录草稿。";
    },
  };

  return {
    // The image tool is only offered when the model can actually see images.
    definitions: AI_TOOL_DEFINITIONS
      .filter((tool) => tool.name !== "read_page_image" || state.canSeeImages === true)
      .map(({ name, description, parameters }) => ({ name, description, parameters })),
    async run(name, args) {
      const handler = handlers[String(name || "")];
      if (!handler) {
        const text = `未知工具：${name}`;
        return { text, blocks: [{ type: "text", text }], isError: true };
      }
      try {
        const raw = await handler(args || {});
        const value = typeof raw === "string" ? { text: raw } : (raw || {});
        const text = clamp(value.text);
        const images = (value.images || []).filter((image) => image?.data && image?.mimeType);
        const blocks = [{ type: "text", text }];
        for (const image of images) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
        return { text, blocks, images, isError: value.isError === true };
      } catch (error) {
        const text = `工具执行失败：${String(error?.message || error)}`;
        return { text, blocks: [{ type: "text", text }], isError: true };
      }
    },
  };
}

// User-facing outcomes the workshop can produce. Keep implementation names
// (DocVortex, OCR, pdf_tool, …) out of this module: the AI sidebar, the
// capability picker and notifications all speak in terms of what the reader
// gets, not which backend runs.
import { IMAGE_INPUTS } from "./extract-formats.js";

// Images of worksheets/exam pages are valid sources for every text outcome:
// extraction and the AI answer page OCR them, while conversion wraps them in a
// temporary PDF for the document pipeline. TIFF/JP2 remain workshop-only
// inputs because the reader itself cannot render them.
const IMAGE_FORMATS = [...IMAGE_INPUTS];
const BOOK_SOURCE_FORMATS = ["epub", "pdf", "docx", "md", "txt"];

export const WORKSHOP_CAPABILITY_GROUPS = Object.freeze([
  { id: "reading", label: "阅读增强" },
  { id: "study", label: "学习" },
  { id: "documents", label: "内容整理" },
  { id: "books", label: "电子书" },
]);

export const WORKSHOP_CAPABILITIES = Object.freeze([
  {
    id: "make-searchable",
    group: "reading",
    title: "让文档支持全文搜索",
    summary: "像普通电子书一样搜索、选中和复制正文。",
    cue: "文档里搜不到字、选不中正文时",
    prompt: "我想让文档支持全文搜索。",
    tool: "ocr",
    ocrMode: "cache",
    formats: ["pdf"],
    order: 10,
    featured: true,
    primary: true,
  },
  {
    id: "searchable-copy",
    group: "reading",
    title: "另存一份可搜索副本",
    summary: "保留原文档，生成一份可以搜索的新 PDF。",
    cue: "想把可搜索的文件单独保存下来时",
    prompt: "我想把文档另存一份可搜索副本。",
    tool: "ocr",
    ocrMode: "export",
    formats: ["pdf"],
    order: 20,
  },
  {
    id: "navigation-toc",
    group: "reading",
    title: "制作导航目录",
    summary: "把目录页变成可以点击跳转的章节导航。",
    cue: "目录不完整或不能跳转时",
    action: "ai-prompt",
    prompt: "帮我制作这个文档的导航目录。",
    formats: ["pdf", "epub", "azw3"],
    order: 30,
    primary: true,
  },
  {
    id: "export-navigation-epub",
    group: "reading",
    title: "导出带导航副本",
    summary: "EPUB / AZW3 另存一份带目录的副本，原书保持不变。",
    cue: "需要在其它阅读器里使用目录时",
    action: "export-toc",
    prompt: "帮我导出带导航的副本。",
    formats: ["epub", "azw3"],
    order: 40,
    primary: true,
  },
  {
    id: "exam-answer-page",
    group: "study",
    title: "把文档做成可作答的答题页",
    summary: "用 AI 识别题目和选项，生成可作答、交卷后自动判分的页面。",
    cue: "手里有 PDF 文档，想要在线作答时",
    prompt: "我想把这份文档做成可作答的答题页。",
    tool: "convert",
    convertFormat: "quiz-ai",
    formats: ["pdf", ...IMAGE_FORMATS],
    order: 10,
    featured: true,
    primary: true,
  },
  {
    id: "questions-and-answers",
    group: "study",
    title: "整理文档里的题目和答案",
    summary: "把题目、选项、答案和解析整理成可继续使用的题库。",
    cue: "想把文档内容整理出来，或做自己的题库时",
    prompt: "我想整理这份文档里的题目和答案。",
    tool: "extract",
    formats: ["pdf", ...IMAGE_FORMATS],
    order: 20,
  },
  {
    id: "extract-text",
    group: "documents",
    title: "把文档正文导出成可编辑文本",
    summary: "得到一份方便整理、搜索或继续提问的正文文本。",
    cue: "想把文档里的内容拿出来修改或继续使用时",
    prompt: "我想把这个文档的正文导出成可编辑文本。",
    tool: "extract",
    formats: ["pdf", "epub", "docx", "html", "md", "txt", ...IMAGE_FORMATS],
    order: 10,
    featured: true,
    primary: true,
  },
  {
    id: "convert-word",
    group: "documents",
    title: "把文档转成 Word",
    summary: "生成一份 Word 文档，保留原文档不动。",
    cue: "需要在 Word 里继续编辑时",
    prompt: "我想把这个文档转成 Word。",
    tool: "convert",
    convertFormat: "docx",
    formats: ["pdf", "epub", "docx", ...IMAGE_FORMATS],
    order: 20,
    primary: true,
  },
  {
    id: "convert-markdown",
    group: "documents",
    title: "把文档转成 Markdown",
    summary: "导出成 Markdown 文本，适合继续编辑、整理或交给其他工具。",
    cue: "需要纯文本继续整理或发布时",
    prompt: "我想把这个文档转成 Markdown。",
    tool: "convert",
    convertFormat: "markdown",
    formats: ["pdf", "epub", "docx", ...IMAGE_FORMATS],
    order: 25,
    primary: true,
  },
  {
    id: "convert-pdf",
    group: "documents",
    title: "把文档转成 PDF",
    summary: "生成一份方便分享和打印的 PDF 副本。",
    cue: "需要固定版式、方便分享时",
    prompt: "我想把这个文档转成 PDF。",
    tool: "convert",
    convertFormat: "pdf",
    formats: ["epub", "docx", ...IMAGE_FORMATS],
    order: 30,
    primary: true,
  },
  {
    id: "make-ebook",
    group: "books",
    title: "制作电子书",
    summary: "整理目录、封面和排版，生成一本可以带走的 EPUB。",
    cue: "有文档或资料，想做成电子书时",
    prompt: "我想把这个文档制作成电子书。",
    tool: "book",
    formats: [...BOOK_SOURCE_FORMATS, ...IMAGE_FORMATS],
    order: 10,
    primary: true,
  },
  {
    id: "translate-ebook",
    group: "books",
    title: "翻译整本电子书",
    summary: "自动识别中文、英文或德文，生成只含译文的 EPUB；原书保持不变。",
    cue: "想把整本书换一种语言阅读时",
    prompt: "我想把这本书翻译成另一种语言，生成只含译文的电子书。",
    tool: "book",
    bookMode: "translated",
    formats: BOOK_SOURCE_FORMATS,
    order: 30,
    featured: true,
    primary: true,
  },
  {
    id: "bilingual-ebook",
    group: "books",
    title: "生成双语对照电子书",
    summary: "原文和译文上下对照；EPUB 保留原排版、目录和换行。",
    cue: "想对照原文和译文阅读时",
    prompt: "我想把这本书做成上下对照的双语电子书。",
    tool: "book",
    bookMode: "stacked",
    formats: BOOK_SOURCE_FORMATS,
    order: 40,
    featured: true,
    primary: true,
  },
  {
    id: "bilingual-ebook-side",
    group: "books",
    title: "生成左右双语对照",
    summary: "原文和译文左右并排；窄屏阅读器会自动回退为上下布局。",
    cue: "屏幕够宽，想并排对照时",
    prompt: "我想把这本书做成左右对照的双语电子书。",
    tool: "book",
    bookMode: "side",
    formats: BOOK_SOURCE_FORMATS,
    order: 50,
  },
  {
    id: "classical-modern",
    group: "books",
    title: "生成文白对照电子书",
    summary: "把文言文翻译成现代中文，原文和译文上下对照。",
    cue: "读文言文，需要白话对照时",
    prompt: "我想把这篇文言文做成文白对照电子书。",
    tool: "book",
    bookMode: "stacked",
    bookClassical: true,
    formats: BOOK_SOURCE_FORMATS,
    order: 60,
    featured: true,
    primary: true,
  },
  {
    id: "script-simplified",
    group: "books",
    title: "转换为简体中文",
    summary: "把繁体中文转为简体；EPUB 保留原排版、目录、图片和换行。",
    cue: "拿到繁体书，想以简体阅读时",
    prompt: "我想把这本书转换成简体中文，保留原排版。",
    tool: "book",
    bookMode: "script",
    bookScript: "s",
    formats: BOOK_SOURCE_FORMATS,
    order: 70,
  },
  {
    id: "script-traditional",
    group: "books",
    title: "转换为繁体中文",
    summary: "把简体中文转为繁体；EPUB 保留原排版、目录、图片和换行。",
    cue: "想输出繁体版时",
    prompt: "我想把这本书转换成繁体中文，保留原排版。",
    tool: "book",
    bookMode: "script",
    bookScript: "t",
    formats: BOOK_SOURCE_FORMATS,
    order: 80,
  },
  {
    id: "convert-kindle",
    group: "books",
    title: "把文档转换成 Kindle 格式",
    summary: "生成适合 Kindle 阅读的电子书文件。",
    cue: "准备在 Kindle 上接着读时",
    prompt: "我想把这个文档转换成 Kindle 格式。",
    tool: "book",
    formats: ["epub"],
    order: 20,
    primary: true,
  },
]);

export function workshopCapability(id) {
  return WORKSHOP_CAPABILITIES.find((capability) => capability.id === String(id || "")) || null;
}

function pdfTextAvailability(readerView = null) {
  const pages = Array.isArray(readerView?._pdfLazy?._pageText) ? readerView._pdfLazy._pageText : [];
  const total = Number(readerView?.pager?.total) || pages.length || Number(readerView?.pdfDocumentContext?.pageCount) || 0;
  const textPages = pages.filter((value) => String(value || "").trim()).length;
  const contextText = String(readerView?.pdfDocumentContext?.text || "").trim();
  return {
    ready: Boolean(contextText) || (total > 0 && textPages >= total),
    working: Boolean(readerView?._ocrJob),
  };
}

function navAvailability(readerView = null) {
  return Array.isArray(readerView?.tocItems) && readerView.tocItems.length > 0;
}

function capabilityHidden(capability, readerView, textState) {
  if (!readerView) return capability.id === "export-navigation-epub";
  if (capability.id === "make-searchable" || capability.id === "searchable-copy") {
    return textState.ready || textState.working;
  }
  if (capability.id === "navigation-toc") return navAvailability(readerView);
  if (capability.id === "export-navigation-epub") {
    const extension = String(readerView?.file?.extension || "").toLowerCase();
    const items = Array.isArray(readerView?.tocItems) ? readerView.tocItems : [];
    return !((extension === "epub" || extension === "azw3")
      && items.some((item) => item && (item.sectionId || item.href || item.cfi)));
  }
  return false;
}

export function workshopCapabilitiesFor({ extension = "", readerView = null } = {}) {
  const ext = String(extension || "").replace(/^\./, "").toLowerCase();
  const textState = pdfTextAvailability(readerView);
  const imageSource = IMAGE_INPUTS.includes(ext);
  return WORKSHOP_CAPABILITIES
    .map((capability) => {
      const fits = !ext || capability.formats.includes(ext);
      const hidden = !fits || capabilityHidden(capability, readerView, textState);
      return {
        ...capability,
        // PDF still needs the printed-page range before it can build; EPUB
        // locates headings and CFIs itself, so it asks only for the outcome.
        prompt: ext === "pdf" && capability.id === "navigation-toc"
          ? "帮我制作这个文档的导航目录。先问我目录页是哪几页，以及印刷页码到 PDF 页码是否有偏移。"
          : capability.prompt,
        hidden,
        // For a photographed worksheet, Markdown is the useful text outcome;
        // EPUB creation remains available under 更多/书坊 but should not lead
        // the image document-tools list.
        recommended: fits && !hidden && Boolean(ext) && capability.formats.includes(ext)
          && !(imageSource && capability.id === "make-ebook"),
      };
    })
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.order - b.order);
}

export function groupWorkshopCapabilities(capabilities = []) {
  return WORKSHOP_CAPABILITY_GROUPS
    .map((group) => ({
      ...group,
      items: capabilities.filter((capability) => capability.group === group.id),
    }))
    .filter((group) => group.items.length);
}

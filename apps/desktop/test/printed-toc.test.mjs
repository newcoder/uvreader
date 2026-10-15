import assert from "node:assert/strict";
import test from "node:test";

import { buildNavPlan, chapterNumber, chapterStartPages, estimatePageOffset, fillPageGaps, interpolatePage, isPrintedTocChapter, lastPdfPageOf, lastPrintedPageOf, looksLikeTocEntry, normalizeNavLevels, parsePrintedTocEntries, printedPageOf, stripPageMarkers, stripPrintedToc, stripTocBlock, tocRatio } from "../src/shared/printed-toc.js";
import { chaptersToNavItems } from "../src/main/workshop-epub.js";
import { outlineToTocEntries } from "../src/main/pdf-outline.js";

const tocText = [
  "第 1 章 光学简史 …… 1",
  "1.1 开场白 …… 11",
  "1.2 初始时期 …… 11",
  "第 2 章 波动 …… 12",
  "2.1 一维波 …… 12",
  "2.1.1 微分波动方程 …… 15",
].join("\n");

test("looksLikeTocEntry recognises leaders and trailing page numbers", () => {
  assert.equal(looksLikeTocEntry("第 1 章 光学简史 …… 1"), true);
  assert.equal(looksLikeTocEntry("1.1 开场白 .... 11"), true);
  assert.equal(looksLikeTocEntry("Contents 12"), true);
  assert.equal(looksLikeTocEntry("从（5.5）式出发，证明：当 $l_o$ 近似稍作改进时得到（5.46）式"), false, "正文句子不算");
  assert.equal(looksLikeTocEntry("## 目录"), false, "标题行不算条目");
  assert.equal(looksLikeTocEntry("| $s_o=2f$ | 倒像 |"), false, "表格行不算");
  assert.equal(looksLikeTocEntry(""), false);
});

test("tocRatio measures how much of a chapter looks like a listing", () => {
  assert.equal(tocRatio(tocText), 1);
  assert.ok(tocRatio("这是一段正文。\n还有一句。") === 0);
});

test("a 目录 chapter with leaders is a printed toc", () => {
  assert.equal(isPrintedTocChapter({ title: "目录", text: tocText }), true);
  assert.equal(isPrintedTocChapter({ title: "Contents", text: tocText }, { frontMatter: true }), true);
  assert.equal(isPrintedTocChapter({ title: "第 1 章", text: "正文。\n另一段。" }), false);
});

test("a title-less listing only counts in the front matter", () => {
  assert.equal(isPrintedTocChapter({ title: "无题", text: tocText }, { frontMatter: true }), true);
  assert.equal(isPrintedTocChapter({ title: "无题", text: tocText }, { frontMatter: false }), false, "正文里的编号列表不能当目录");
});

test("stripPrintedToc drops the toc chapter and keeps the rest", () => {
  const chapters = [
    { title: "目录", text: tocText },
    { title: "第 1 章", text: "开头。" },
    { title: "第 2 章", text: "结尾。" },
  ];
  const result = stripPrintedToc(chapters);
  assert.equal(result.dropped, 1);
  assert.equal(result.chapters.length, 2);
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ["第 1 章", "第 2 章"]);
  assert.equal(result.removedLines, 6);
});

test("stripTocBlock only removes entries after the heading", () => {
  const text = ["前言：写这本书的缘由。", "", "## 目录", "", tocText, "", "正文从这里开始。", "6.31 见习题 12"].join("\n");
  const result = stripTocBlock(text);
  assert.ok(result.removed >= 7, `标题与条目都要去掉(${result.removed})`);
  assert.ok(!result.text.includes("……"), "条目不再留着");
  assert.match(result.text, /前言：写这本书的缘由。/);
  assert.match(result.text, /正文从这里开始。/);
  assert.match(result.text, /6\.31 见习题 12/, "没有「目录」标题时一行不动");
});

test("stripPrintedToc can be switched off and never empties the book", () => {
  const chapters = [{ title: "目录", text: tocText }];
  assert.equal(stripPrintedToc(chapters, { enabled: false }).dropped, 0);
  assert.equal(stripPrintedToc(chapters).chapters.length, 1, "全掉光时还原");
  assert.equal(stripPrintedToc(chapters).dropped, 0);
});

test("parsePrintedTocEntries keeps labels and infers levels", () => {
  const text = [
    "第 1 章 光学简史 …… 1",
    "1.1 开场白 ……… 11",
    "1.1.1 微分波动方程 …… 15",
    "§ 2 关于公理化的一般评论 …… 9",
    "形式主义的数学基础 …… 43",
  ].join("\n");
  const entries = parsePrintedTocEntries(text);
  assert.deepEqual(entries.map((entry) => entry.label), [
    "第 1 章 光学简史", "1.1 开场白", "1.1.1 微分波动方程", "§ 2 关于公理化的一般评论", "形式主义的数学基础",
  ]);
  assert.deepEqual(entries.map((entry) => entry.level), [1, 2, 3, 2, 1], "无编号的条目按 1 级(宁可平铺,不猜层级)");
  assert.deepEqual(entries.map((entry) => entry.page), [1, 11, 15, 9, 43]);
});

test("buildNavPlan matches in order, drops what it cannot find, keeps the ends", () => {
  const chapters = [
    { title: "译者序" },
    { title: "第一章 光学简史" },
    { title: "1.1 开场白" },
    { title: "1.2 初始时期" },
    { title: "第二章 波动" },
    { title: "注释" },
  ];
  const tocEntries = parsePrintedTocEntries([
    "第一章 光学简史 …… 1",
    "1.1 开场白 …… 11",
    "找不到的一节 …… 20",
    "第二章 波动 …… 12",
  ].join("\n"));
  const plan = buildNavPlan({ chapters, tocEntries });
  assert.equal(plan.matched, 3);
  assert.deepEqual(plan.dropped, ["找不到的一节"]);
  assert.deepEqual(plan.items.map((item) => item.title), ["译者序", "第一章 光学简史", "1.1 开场白", "第二章 波动", "注释"], "两端的前言/附录保留,匹配不上的中间条目丢弃");
  assert.equal(plan.items.find((item) => item.title === "1.1 开场白").level, 2);
});

test("normalizeNavLevels never jumps more than one level", () => {
  const items = normalizeNavLevels([
    { title: "a", level: 3 },
    { title: "b", level: 3 },
    { title: "c", level: 1 },
  ]);
  assert.deepEqual(items.map((item) => item.level), [1, 2, 1]);
});

test("buildNavPlan returns null when too little matches", () => {
  const plan = buildNavPlan({ chapters: [{ title: "甲" }, { title: "乙" }], tocEntries: parsePrintedTocEntries("丙 …… 3") });
  assert.equal(plan, null, "匹配太少时交回按标题分章");
});

test("printedPageOf reads the printed page from the anchor", () => {
  assert.equal(printedPageOf("<!--page:16 printed:7-->\n正文"), 7);
  assert.equal(printedPageOf("<!--page:16-->\n正文"), 0, "没有印刷页码就是 0");
  assert.equal(printedPageOf("正文"), 0);
});

test("a page hint rescues an entry whose title OCR mangled", () => {
  const chapters = [
    { title: "第一章 光学简史" },
    { title: "1.1 开场白" },
    { title: "第二章 波动" },
  ];
  const pages = [1, 11, 12];
  const tocEntries = [
    { label: "第一章 光学简史", key: "光学简史", page: 1, level: 1 },
    { label: "1.1 开 场 白", key: "开场白", page: 11, level: 2 },
    { label: "第二章 波动", key: "波动", page: 12, level: 1 },
  ];
  const withoutHint = buildNavPlan({ chapters, tocEntries });
  const withHint = buildNavPlan({ chapters, tocEntries, pages });
  assert.ok(withHint, "有页码提示时能出计划");
  assert.equal(withHint.matched, 3, "标题被 OCR 弄花也能靠页码命中");
  assert.equal(withoutHint.matched <= withHint.matched, true);
});

test("cover-ish chapters never lead the nav", () => {
  const chapters = [
    { title: "" },
    { title: "(第五版)" },
    { title: "Optics Fifth Edition" },
    { title: "译者序" },
    { title: "第一章 光学简史" },
    { title: "第二章 波动" },
  ];
  const tocEntries = parsePrintedTocEntries(["第一章 光学简史 …… 1", "第二章 波动 …… 12"].join("\n"));
  const plan = buildNavPlan({ chapters, tocEntries });
  assert.deepEqual(plan.items.map((item) => item.title), ["Optics Fifth Edition", "译者序", "第一章 光学简史", "第二章 波动"]);
  assert.ok(!plan.items.some((item) => /^[（(]/.test(item.title)), "括号版次条目不进导航");
  assert.ok(!plan.items.some((item) => !item.title), "无标题章节也不进导航");
});

test("a chapter is used by at most one entry", () => {
  const chapters = [{ title: "第一章 起点" }, { title: "第二章 终点" }];
  const tocEntries = [
    { label: "第一章 起点", key: "起点", page: 0, level: 1 },
    { label: "第一章 起点(重复条)", key: "起点重复条", page: 0, level: 1 },
    { label: "第二章 终点", key: "终点", page: 0, level: 1 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries });
  const used = plan.items.map((item) => item.chapterIndex);
  assert.equal(new Set(used).size, used.length, "同一章不会出现在两条导航里");
  assert.equal(plan.matched, 2);
  assert.deepEqual(plan.dropped, ["第一章 起点(重复条)"]);
});

test("pageFirst lets an exact PDF page claim a chapter whose title was split", () => {
  // 上游把「第4章 电磁学」拆成了「第」;大纲页码是精确的 PDF 页 → 以页码认领。
  const chapters = [{ title: "第" }, { title: "4.1 静电场" }, { title: "第5章 光学" }];
  const pages = [40, 41, 52];
  const tocEntries = [
    { label: "第4章 电磁学", key: "电磁学", page: 40, level: 1 },
    { label: "第5章 光学", key: "光学", page: 52, level: 1 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries, pages, pageTolerance: 2, pageFirst: true });
  assert.equal(plan.matched, 2);
  assert.equal(plan.items[0].chapterIndex, 0, "页码命中被拆坏的标题章");
});

test("fillPageGaps interpolates between known anchors", () => {
  assert.deepEqual(fillPageGaps([0, 0, 0]), [0, 0, 0], "全未知时保持原样");
  assert.deepEqual(fillPageGaps([5]), [5]);
});

test("outlineToTocEntries keeps the PDF's own levels", () => {
  const entries = outlineToTocEntries([
    { level: 1, title: "第1章 光学简史", page: 17 },
    { level: 2, title: "1.1 开场白", page: 17 },
    { level: 3, title: "1.1.1 细节", page: 18 },
    { level: 1, title: "   ", page: 20 },
  ]);
  assert.deepEqual(entries.map((entry) => [entry.label, entry.page, entry.level]), [
    ["第1章 光学简史", 17, 1],
    ["1.1 开场白", 17, 2],
    ["1.1.1 细节", 18, 3],
  ]);
  assert.equal(entries[0].key, "光学简史");
});

test("page markers in the outline are not a table of contents", () => {
  // 《安妮·卡森诗选》的书签:作品名 + 每 20 页一个「001/020/…」页码书签。
  const entries = [
    { label: "封面", page: 1, level: 1 },
    { label: "红的自传", page: 2, level: 1 },
    { label: "001", page: 2, level: 2 },
    { label: "020", page: 21, level: 2 },
    { label: "040", page: 41, level: 2 },
    { label: "丈夫之美", page: 226, level: 1 },
    { label: "001", page: 226, level: 2 },
    { label: "020", page: 245, level: 2 },
    { label: "040", page: 265, level: 2 },
  ];
  const stripped = stripPageMarkers(entries);
  assert.equal(stripped.ruler, true, "标尺占多数 → 整份大纲不是目录");
  assert.deepEqual(stripped.entries.map((entry) => entry.label), ["封面", "红的自传", "丈夫之美"]);
  assert.equal(stripped.dropped, 6);
  // 真正的大纲(标题+页码)不受影响:数字只要不是页码标尺就不动。
  const real = stripPageMarkers([
    { label: "第一章 光学简史", page: 17, level: 1 },
    { label: "1.1 开场白", page: 17, level: 2 },
    { label: "第二章 波动", page: 29, level: 1 },
  ]);
  assert.equal(real.ruler, false);
  assert.equal(real.dropped, 0);
  assert.equal(real.entries.length, 3);
});

test("front-matter entries with no chapter land at the front, not mid-book", () => {
  // 实测《数学在科学和社会中的作用》:这本书的提取没有页锚点,「版权/前言/目录」在正文里
  // 也没有对应标题,于是按「全书相对位置」扑到了第一篇论文的中间(版权 → 1.导引公理)。
  // 它们的页码在所有能对上的条目之前 → 属于前置页,应该落在书首。
  const chapters = [
    { title: "译者序" },
    { title: "集合论的一种公理化" },
    { title: "I. 公理系统" },
    { title: "§1 基本原则" },
    { title: "形式主义的数学基础" },
    { title: "经济学家" },
  ];
  const pages = [0, 0, 0, 0, 0, 0]; // 这本书没有页锚点:章节页码全 0
  const tocEntries = [
    { label: "封面", key: "封面", page: 1, level: 1 },
    { label: "书名", key: "书名", page: 2, level: 1 },
    { label: "版权", key: "版权", page: 3, level: 1 },
    { label: "前言", key: "前言", page: 4, level: 1 },
    { label: "目录", key: "目录", page: 16, level: 1 },
    { label: "集合论的一种公理化", key: "集合论的一种公理化", page: 17, level: 1 },
    { label: "形式主义的数学基础", key: "形式主义的数学基础", page: 59, level: 1 },
    { label: "经济学家", key: "经济学家", page: 68, level: 1 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries, pages, pageTolerance: 2, pageFirst: true, orderFallback: true });
  const target = (label) => plan.items.find((item) => item.title === label)?.chapterIndex;
  assert.equal(target("集合论的一种公理化"), 1);
  assert.equal(target("形式主义的数学基础"), 4, "正文有同名标题 → 精确命中");
  assert.equal(target("经济学家"), 5);
  // 前置页条目:都落在书首的空章上(≤ 第一篇论文那一章),不会扑到论文中间。
  for (const label of ["封面", "书名", "版权", "前言", "目录"]) {
    assert.ok(target(label) <= 1, `${label} 落在书首(实际 ${target(label)})`);
  }
});

test("chaptersToNavItems keeps the heading hierarchy and anchors the outline titles", () => {
  const chapters = [
    { title: "红的自传", level: 2, text: "正文" },
    { title: "I 革律翁", level: 2, text: "正文" },
    { title: "红肉：斯特西克洛斯改变了什么？", level: 1, text: "正文" },
    { title: "附录A", level: 2, text: "正文" },
  ];
  const items = chaptersToNavItems(chapters, {
    anchors: [{ label: "红的自传", page: 2, level: 1 }, { label: "丈夫之美", page: 226, level: 1 }],
    pages: [2, 5, 10, 400],
  });
  // 「红的自传」正文有同名标题 → 提为 1 级;「丈夫之美」正文没有 → 按页码相对位置
  // (226 在 2..400 里约 56%)落到第 3 章之前,同样是 1 级;h1/h2 层级原样保留。
  assert.deepEqual(items.map((item) => `${item.title}@${item.level}`), [
    "红的自传@1", "I 革律翁@2", "红肉：斯特西克洛斯改变了什么？@1", "丈夫之美@1", "附录A@2",
  ]);
  assert.equal(items.find((item) => item.title === "丈夫之美").file, "chapter-003.xhtml", "没有同名标题的作品名按页码相对位置落位");
});

test("chapterStartPages takes the page the chapter starts on", () => {
  // 页锚点写在页首、标题在本页中间:本章第一个锚点常是起始页的下一页(实测差 1~3 页)。
  const chapters = [
    { text: "封面\n<!--page:1-->\n...\n<!--page:9-->\n序的尾巴" },
    { text: "目录页\n<!--page:10-->\n...\n<!--page:17-->" },
    { text: "1.1 开场白\n正文\n<!--page:18-->" },
  ];
  assert.deepEqual(chapterStartPages(chapters), [1, 9, 17], "章首页 = 上一章最后一个锚点");
  assert.deepEqual(chapterStartPages(chapters, { of: lastPdfPageOf, lastOf: lastPdfPageOf }), [9, 9, 17], "换成「最后一个锚点」也自洽");
  assert.deepEqual(chapterStartPages(chapters, { of: printedPageOf, lastOf: lastPrintedPageOf }), [0, 0, 0], "这批锚点没有印刷页码");
  assert.equal(lastPdfPageOf(chapters[1].text), 17);
  assert.equal(lastPrintedPageOf("<!--page:6 printed:4-->a<!--page:7 printed:5-->"), 5);
});

test("stripPrintedToc reports which chapters it kept", () => {
  const chapters = [
    { title: "目录", text: "第一章 …… 1\n第二章 …… 9" },
    { title: "第一章", text: "正文" },
  ];
  const kept = stripPrintedToc(chapters);
  assert.deepEqual([...kept.keptIndexes], [1], "目录章的原始下标要能对上页码表");
  assert.equal(kept.dropped, 1);
  const off = stripPrintedToc(chapters, { enabled: false });
  assert.deepEqual([...off.keptIndexes], [0, 1]);
  assert.equal(off.dropped, 0);
});

test("chapterNumber reads the chapter number of a heading", () => {
  assert.equal(chapterNumber("第 1 章"), 1);
  assert.equal(chapterNumber("第1章 光学简史"), 1);
  assert.equal(chapterNumber("第十三章 现代光学"), 13);
  assert.equal(chapterNumber("第二十一章 波动"), 21);
  assert.equal(chapterNumber("1.2 初始时期"), 0);
  assert.equal(chapterNumber("第 2 节 空间频率"), 0, "节不算章");
});

test("an exact title keeps its chapter even when a page hit wants it", () => {
  // 实测《光学》:「第1章 光学简史」(页 17)靠页码抢了「1.2 初始时期」那一章,
  // 后面的条目跟着整片顺移(用户看到的跳歪)。现在标题/编号对得上的先钉死。
  const chapters = [
    { title: "第 1 章" }, // 正文标题被上游拆得只剩编号,标题键是空的
    { title: "1.1 开场白" },
    { title: "1.2 初始时期" },
    { title: "1.3 十七世纪以来" },
  ];
  const pages = [17, 17, 17, 20];
  const tocEntries = [
    { label: "第1章 光学简史", key: "光学简史", page: 17, level: 1 },
    { label: "1.1 开场白", key: "开场白", page: 17, level: 2 },
    { label: "1.2 初始时期", key: "初始时期", page: 17, level: 2 },
    { label: "1.3 十七世纪以来", key: "十七世纪以来", page: 19, level: 2 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries, pages, pageTolerance: 2, pageFirst: true });
  const target = (label) => plan.items.find((item) => item.title === label)?.chapterIndex;
  assert.equal(target("第1章 光学简史"), 0, "按「第 N 章」编号认领拆坏的章节标题");
  assert.equal(target("1.1 开场白"), 1);
  assert.equal(target("1.2 初始时期"), 2, "页码命中也不能抢走标题对得上的章");
  assert.equal(target("1.3 十七世纪以来"), 3);
  assert.equal(plan.dropped.length, 0);
});

test("interpolatePage and estimatePageOffset read relative positions", () => {
  const entries = [
    { page: 10 }, { page: 0 }, { page: 20 }, { page: 30 },
  ];
  assert.equal(interpolatePage(entries, 1, 0, 2), 15, "两个锚点之间按位置插值");
  assert.equal(interpolatePage(entries, 1, -1, -1), 0, "没有锚点时用条目自己的页码");
  assert.equal(Math.round(interpolatePage(entries, 2, 0, 3)), 23, "锚点已知时以插值为准(相对位置)");
  assert.equal(interpolatePage(entries, 2, 0, 3) === 20, false, "不再直接采信条目自己的绝对页码");
  const list = [{ key: "一", page: 12 }, { key: "二", page: 22 }];
  const toc = [{ key: "一", page: 10 }, { key: "二", page: 20 }];
  assert.equal(estimatePageOffset(list, toc, [{ entry: 0, chapter: 0 }, { entry: 1, chapter: 1 }]), 2, "章节页码 − 目录页码");
  assert.equal(estimatePageOffset(list, toc, []), 0);
});

test("an entry with a missing or bogus page lands by relative position", () => {
  // 原书页码整体偏 2 页(章节 page = 目录 page + 2),顺序是对的;没有页码 / 页码是错的
  // 条目应该按相邻锚点插值落在两段之间,而不是被塞到书的别处。
  const chapters = [{ title: "第一章" }, { title: "第二章" }, { title: "第三章" }, { title: "第四章" }];
  const pages = [12, 22, 32, 42];
  const tocEntries = [
    { label: "第一章", key: "第一章", page: 10, level: 1 },
    { label: "第二章", key: "第二章", page: 20, level: 1 },
    { label: "补遗", key: "补遗", page: 0, level: 1 },
    { label: "附录", key: "附录", page: 25, level: 1 }, // 页码写错了(实际在两章之间)
    { label: "第四章", key: "第四章", page: 40, level: 1 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries, pages, pageTolerance: 2, pageFirst: true, orderFallback: true });
  const target = (label) => plan.items.find((item) => item.title === label)?.chapterIndex;
  assert.equal(target("第一章"), 0);
  assert.equal(target("第二章"), 1);
  assert.equal(target("第四章"), 3);
  assert.ok(target("补遗") === 2 && target("附录") === 2, `中间的条目落在间隙里(补遗 ${target("补遗")} / 附录 ${target("附录")})`);
  assert.equal(plan.matched, 5);
});

test("repeated labels spread monotonically across the chapters they name", () => {
  // 大纲里「习题」会出现十几次、页码还可能全是错的(PDF 自身的数据问题)。
  // 全局对齐按顺序把它们分给各章的「习题」,不会挤在一处、也不会顺移别的条目。
  const chapters = [
    { title: "1.1 引言" }, { title: "习题" },
    { title: "2.1 引言" }, { title: "习题" },
    { title: "3.1 引言" }, { title: "习题" },
  ];
  const pages = [10, 20, 30, 40, 50, 60];
  const tocEntries = [
    { label: "1.1 引言", key: "引言", page: 10, level: 2 },
    { label: "习题", key: "习题", page: 58, level: 2 },
    { label: "2.1 引言", key: "引言", page: 30, level: 2 },
    { label: "习题", key: "习题", page: 58, level: 2 },
    { label: "3.1 引言", key: "引言", page: 50, level: 2 },
    { label: "习题", key: "习题", page: 58, level: 2 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries, pages, pageTolerance: 2, pageFirst: true, orderFallback: true });
  assert.deepEqual(plan.items.map((item) => `${item.title}@${item.chapterIndex}`), [
    "1.1 引言@0", "习题@1", "2.1 引言@2", "习题@3", "3.1 引言@4", "习题@5",
  ]);
  assert.equal(plan.matched, 6);
});

test("a chapter title claims its chapter, and falls back to its first section", () => {
  // 正文里没有「第7章」这一章(上游吃掉了标题)时,章级条目应落在它第一节上。
  const chapters = [{ title: "7.1 引言" }, { title: "7.2 方法" }];
  const pages = [420, 425];
  const tocEntries = [
    { label: "第7章 某某", key: "某某", page: 420, level: 1 },
    { label: "7.1 引言", key: "引言", page: 420, level: 2 },
    { label: "7.2 方法", key: "方法", page: 425, level: 2 },
  ];
  const plan = buildNavPlan({ chapters, tocEntries, pages, pageTolerance: 2, pageFirst: true, orderFallback: true });
  const target = (label) => plan.items.find((item) => item.title === label)?.chapterIndex;
  assert.equal(target("7.1 引言"), 0);
  assert.equal(target("第7章 某某"), 0, "章级条目落到它第一节那一章");
  assert.equal(plan.matched, 3);
});

test("orderFallback anchors every entry near its own place in the book", () => {
  // 「游标之后第一个」的兜底会把整片尾部条目推空(实测《光学》丢了第11章/第13章/习题),
  // 现在改成按相对位置认领:第 k 条目录 ≈ 第 k/n×章数 章。
  const chapters = Array.from({ length: 40 }, (_, index) => ({ title: `Sect ${index + 1}` }));
  const tocEntries = parsePrintedTocEntries(
    Array.from({ length: 20 }, (_, index) => `找不到的条目 ${index + 1} 号 …… 9`).join("\n"),
  );
  assert.equal(tocEntries.length, 20);
  const plan = buildNavPlan({ chapters, tocEntries, orderFallback: true });
  assert.equal(plan.matched, 20);
  assert.deepEqual(plan.dropped, [], "兜底认领之后不该再丢条目");
  const indexes = plan.items.map((item) => item.chapterIndex);
  assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, "认领顺序与目录顺序一致");
  assert.equal(indexes[0], 0, "第一条落在书首");
  assert.equal(indexes[indexes.length - 1], 39, "最后一条落在书尾");
  assert.equal(plan.items.length, 20, "中间章节不会被当成前后附章灌进导航");
});

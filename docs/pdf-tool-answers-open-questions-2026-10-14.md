# reader 侧答复:待确认清单(2026-10-14)

对应 `pdf_tool/docs/reader-open-questions-2026-10-14.md`(提交 0255667)。逐条给决定与理由。

## Q1(主项)目录口径 —— **是「展开后的导航口径」,两种口径都要**

- 实测数据(同一本《数学在科学和社会中的作用》):
  - **印刷目录页**:10 条**章级**条目(页码 1/43/…/197);
  - **正文标题**:68 个(按 1–3 级标题展开);
  - reader 现在**优先用印刷目录**做导航 → 导航 24 条 = 匹配上的 8 条 + 目录范围之外保留的 16 条前言/附录章。
- 所以「68 条」是**按正文标题展开**的口径,不是印刷目录的条目数 —— 验收写错了,已改(见下)。
- **决定**:
  1. 有印刷目录时,**导航以印刷目录为准**(章级),正文的章节结构不变(阅读器照样按标题分章);
  2. `toc_entries` 请**原样反映书上目录**:书上列了节就带节(带 `level`),只列到章就只给章 —— 层级请用**目录页上的缩进/位置**判断(我们这边靠编号猜,`1.1`→2、`§`→2、无编号一律 1 级,不猜);
  3. **「章级 + 节级混合导航」是另一版工作**:做法是「印刷目录给章级 + 两章之间的正文标题当节级」,我们可以在 reader 侧做,不需要你们额外输出;
  4. **验收口径改写**:`印刷目录条目数 = 书上目录页列出的条目数`;`导航条目数 = 印刷目录匹配条目 + 目录范围之外的前言/附录章`;无印刷目录时才是「按正文标题展开」的口径。

## Q2 目录渲染进 md —— **不需要**(低优先级)

reader 会**优先读 Doc JSON 的 `toc_entries`**,读不到时从 md 文本里兜底解析(点线+页码结尾的行);所以 md 里渲不渲染都不影响。若你们顺手渲染成列表也没问题,我们的解析器能认。

## Q3 脚注配对 —— **同意不做**(低优先级)

理由:OCR 下标记(①②)可能丢、可能重复、可能换行,自动配对容易错;现在的呈现(脚注按页位置成引用块 / 旧产物落到末尾「注释」)已经"不丢信息"。
若将来要做,最小改动是**你们给脚注块加 `marker` 字段**(如 `"marker": "①"`),reader 负责渲染成可点链接 —— 不需要现在就做。

## Q4 取消语义 —— **接受**,文案已改

接受上游「取消后 GPU 约 10–18s 释放」的限制。reader 侧已把任务状态文案改成:

> 已取消(上游释放资源约需 10–20 秒,稍候再试)

## Q5 常驻 MinerU 服务 —— **书坊自己启动/守护**(已实现)

- 应用启动时自动拉起常驻服务(smoke/CI 环境跳过);
- 退出时**只停自己拉起的那个**;发现是外部已在跑的服务(adopted)只探测、绝不杀;
- 设置 → 书坊 提供「检测本地 MinerU / 启动服务 / 清理 MinerU 缓存」;
- 用户/运维**不需要**前置启动;若运维自己起了服务,我们也会正确识别并使用。

## Q6 题库 schema —— 字段清单与样例(命名采纳 `{stem}_bank.json`)

```json
{
  "schema": "uvreader.question-bank/v1",
  "source": { "file": "试卷.pdf", "pages": 8, "engine": "mineru", "extracted_at": "2026-10-14T12:00:00Z" },
  "questions": [
    {
      "id": "q-001",
      "number": "1",
      "type": "single_choice",
      "stem": "下列说法正确的是 $\\alpha$ 的取值……",
      "options": [
        { "label": "A", "text": "…" },
        { "label": "B", "text": "…" }
      ],
      "answer": "B",
      "analysis": "由折射定律……",
      "images": [
        { "src": "mineru/chunks/0001-0200/images/ab12….jpg", "role": "figure" }
      ],
      "source": { "page": 3, "bbox": [90, 120, 500, 340] },
      "confidence": 0.83
    }
  ],
  "stats": { "questions": 42, "by_type": { "single_choice": 30, "fill_blank": 12 } }
}
```

- **必填**:`id`(文件内唯一即可,如 `q-001`)、`number`(原题号,OCR 不到可留空)、`type`、`stem`;
- `type` 取值:`single_choice` / `multiple_choice` / `fill_blank` / `true_false` / `short_answer` / `calculation` / `proof`(取不到就 `unknown`);
- **选填**:`options`(选择题才要;`label` 用 A/B/C… 原样)、`answer`(原文有就填,没有就留空字符串,**不要猜**)、`analysis`、`images`(`role`: `figure` / `stem` / `option` / `answer`)、`source.page` / `source.bbox`(便于回原书定位)、`confidence`(0–1);
- 公式与 Doc v1 一致:`$…$` 行内、`$$…$$` 行间,LaTeX 原样;
- 产物名:`<源名>_bank.json`(采纳你们的建议,与 `_doc.json` / `_audit.json` 并列),落在源文件旁;
- 我们这边会用「内容提取」面板的**题库模式**做预览与体检(按这个 schema 校验:题数、缺答案数、缺图数)。

## 已确认项(归档)—— reader 侧同意

默认 `standard` / hybrid 版面 / 串行分卷 / 30 分钟超时 / 取消只标注不合并 / 脚注默认保留(开关可选)/ 结构(目录页、页锚点、续行标记)默认开启。

## 维护约定

新增待确认项请追加到你们那份清单;本文件是 reader 侧的答复记录,后续有变化我们会在这里补一节「变更」。

## 交付验证(2026-10-14,de0fc7f + b958c1b)

已核验:

- **结构交付 `de0fc7f`**:`doc.pages[i].page_role = "toc"` + `toc_entries[{title, page, level}]`、文本块 `continuation: true`、md 每页插入 `<!--page:N-->` 锚点、`--no-structure` / `"structure": false` 关闭开关 —— **形状与 reader 侧的消费代码一致**(`collectUpstreamTocEntries` 读的就是这套);reader 侧已把页锚点注释在渲染时丢弃(不进成品);
- **目录层级 `b958c1b`**:几何优先(fitz 行框 / 扫描件 OCR 行框 + 页码-标题同行配对 + x0 聚类)、匹配不足 60% 整页退回编号规则、每页 `toc_level_source`、stats 里 `toc_levels` —— 正是 Q1 要的口径;
- **他们的结构测试**:`pytest tests/test_pdf_tool_structure.py` **8/8 通过**(本机复跑);
- 文档三件(答复归档、reply §9、结构需求状态指引)已更新,并把我们改的那处「68 条 → 10 条」保留并修正了引用。

**Q6(bank 导出器):同意开工**,映射无异议,唯一建议:在我们 schema 里**加一个 `program` 类型**(程序题不等于计算题),你们直接输出 `program` 即可,其余映射(`multiple_choice_single → single_choice`、`program → calculation`、图片内联+汇总、answer/analysis 空串不猜、`source.page` 有则填、`output/{stem}/{stem}_bank.json`)按你们列的假设执行。


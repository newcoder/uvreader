# 题库 / 答题页(设计稿)

目标:试卷 PDF/DOCX(扫描件、已作答的都算)→ 结构化题库 → 答题页(与批注页同布局)→ 提交 → AI 判题 + 解析 → 错题本。入口在**阅读视图**里,由 AI 对话或按钮触发,不离开当前文档。

## 1. 数据契约(不另造)

**题库**:`uvreader.question-bank/v1` —— 与 pdf_tool 的 `model/bank.py` 对齐(2026-10-14 与 reader 定的那份):

```
{ schema: "uvreader.question-bank/v1",
  source: { file, pages, engine, extracted_at },
  questions: [{ id, number,
                type: single_choice|multiple_choice|true_false|fill_blank|short_answer|program|calculation|proof|unknown,
                stem, options: [{ label, text }], answer, analysis,
                images: [{ src, role: stem|option|figure }], source: { page } }],
  stats: { questions, by_type } }
```

**作答**:单独一份 `uvreader.quiz-attempt/v1`(同一契约风格):

```
{ schema, bank: { file, schema }, startedAt, submittedAt,
  answers: { q1: "B", q2: "ABD", q3: "对", q4: "后进先出", q5: "……" },
  grading: { q1: { verdict: right|wrong|partial, score, comment } },
  stats: { answered, right, wrong, partial } }
```

**错题本**:由 attempts 派生(同一题保留多次作答历史;错题 = 最近一次的 verdict ≠ right)。不单独存一份"错题文件",避免三份数据打架。

## 1.1 答案不能泄题(硬规则)

原文可能**自带答案与解析**(实测试卷:37 题全带 `参考答案` + `标准答案` + `试题解析`)。规则:

- 题库 JSON(`_questions.json`)**保留**答案与解析 —— 判题时要用;
- **答题页只拿白名单视图**:`questionForAnswering()` / `bankForAnswering()`(共享模块,单测覆盖)—— 只给 `id / number / type / stem / options / images`,**连 `answer` / `analysis` 字段都不存在**。用白名单而不是"删字段":以后题库加新字段,也不会不小心把答案带进界面;
- **作答数据(attempt)只存用户作答**,不存答案;判题、解析在后台读完整 bank;
- **原始文档不改**:卷子末尾的「参考答案」是原文的一部分,阅读时能看到,不在阅读器里隐藏;要藏的是**答题页**(以及它引用的数据)。

## 2. 提取:规则为主,AI 只兜底

- **规则解析**(确定性,已实现 `apps/desktop/src/shared/question-bank.js`):题号(`1.`/`1、`/`第 1 题`)、选项(含同一行并排 `A. … B. …`)、行内 `答案:`/`解析:` 与卷末「参考答案」区、小节题型(`一、多项选择题`)、填空下划线、判断题、图片按 role 归位。认不全就**少给题 + 出 warning**,不猜答案、不编解析。
- **AI 兜底**(后续):只把规则认不出的题交给模型补漏;产出仍是 bank/v1,先过 `validateBank` 再落盘。
- **pdf_tool 已有的**:`extract_questions.py`(PDF/照片/DOCX → `_questions.json` + `_audit.json`)与 `prompts/question_schema.json`。它的抽取走**自己的 DeepSeek 通道**(`--via api|browser`),不适合本应用的多模型配置 —— 所以**不直接调用它**,只对齐它的 schema 与提示词。
- **产物**(与 pdf_tool 命名一致):`<stem>_questions.json`(bank/v1)+ `<stem>_questions.md`(可读版)+ `_audit.json`(warnings)。

## 3. 流程

1. 阅读视图打开试卷(PDF/DOCX;扫描件先走文字层 / OCR)。
2. 入口:AI 对话里「我想做这张卷子」→ tool `extract_questions`(v1 先给按钮/命令,AI tool 调用随后接);或书坊「数据提取 → 题库」。
3. 后台:提取(引擎优先、失败回退本机)→ 规则解析 → bank/v1 → 校验 → 落盘;题数与警报告知用户。
4. 打开答题页(与批注页同布局:右侧面板与文档并排),按题型渲染控件(单选 / 多选 / 判断 / 填空 / 简答)。
5. 提交 → attempt 落盘 → 判题:选择题/判断题**确定性判**,主观题 **AI 判 + 可手改** → 展示解析。
6. 错题本 +「再练一遍」。

## 4. AI 的三个作用点

- **提取兜底**:规则认不出的题;
- **判题**:主观题给 `verdict/score/comment`,依据 = 题干 + 参考答案 + 解析 + 用户作答;
- **解析 / 追问**:沿用伴读的 AI 运行时与凭据,不新增配置。

## 5. 界面

- 答题页复用**批注页的布局与状态**(同一套右侧面板组件),不新开窗口;
- 题目列表 + 当前题 + 答题卡(未答 / 已答 / 错题);
- 提交前提示未答题数;判题后逐题显示对错、得分与解析。

## 6. 阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **Q1 提取** | 规则解析器 ✅(5 项单测)· 题库 runner ✅(`_questions.json` + `_questions.md` + `_audit.json`)· 数据提取页「同时生成题库」✅ | 基本完成;家具开关等 pdf_tool |
| **Q2 答题页** | bank 渲染 + 本地暂存 + 提交(先不判) | 第一版完成:阅读视图侧栏「答题」,只吃白名单视图,作答存 reading store 的 `quiz`;选择/判断已做确定性判题 |
| **Q3 判题/解析** | 确定性判选择/判断 + AI 判主观 + 解析展示 | 确定性判题已并入 Q2;AI 判主观 + 解析展示待做 |
| **Q4 错题本** | 按题聚合 +「再练一遍」+ AI 讲解 | 待开始 |

**附带**:数据提取页要加「去除水印 / 页眉页脚」开关 —— pdf_tool 的家具清理目前**写死常开**(`pipeline.py` 里 `filter_blocks` 无条件调用),已作为正式需求提给 pdf_tool:`docs/pdf-tool-request-furniture-toggle-2026-10-20.md`(建议 `--keep-furniture`,默认行为不变)。在它支持之前,页面上只写说明,不做假开关。

# pdf_tool P1 抽取验证报告（test-docs）

- 日期：2026-09-26
- 对象：`pdf_tool/ingest/` + `pdf_tool/extract_questions.py`（P1：PDF / 照片 / DOCX → 题目 JSON + 审计）
- 命令：`python pdf_tool/extract_questions.py --input pdf_tool/test-docs`（整目录 17 份，199s，DeepSeek API）
- 产物：`pdf_tool/output/{stem}/{stem}_questions.json` + `{stem}_audit.json`；批量报告 `output/_p1_report.json`

## 1. 完整性核对（声明题数 vs 抽出题数）

| 文件 | 模式 | 抽出 | 卷面声明 | 答案覆盖 | 审计 |
|---|---|---|---|---|---|
| 202503C语言三级.docx | text(docx) | 5 | **5 ✓** | 0/5（源卷标准答案为空） | ok |
| 202503C语言二级.docx | text(docx) | 5 | **5 ✓** | 0/5（源卷为空） | ok |
| 202503C语言六级.docx | text(docx) | 4 | **4 ✓** | 0/4（源卷为空） | ok |
| 202503python 一级.docx | text(docx) | 37 | **37 ✓** | **37/37** | ok |
| 202503python 三级.docx | text(docx) | 38 | **38 ✓** | **38/38** | ok |
| 202503python 四级.docx | text(docx) | 38 | **38 ✓** | **38/38** | ok |
| 202503python 五级.docx | text(docx) | 38 | **38 ✓** | **38/38** | ok |
| CSP2019.pdf（扫描 9p） | vision | 43 | 历史基线 43 ✓ | 0/43（卷面无答案） | ok |
| CSP2020.pdf（扫描 10p） | vision | 42 | 历史基线 42 ✓ | 0/42 | ok |
| ctest.pdf（扫描 5p） | vision | 20 | 历史 box 基线 20 ✓ | 19/20 | ok |
| testpdf2.pdf（扫描 14p） | vision | 25 | 历史基线 25 ✓ | 25/25 | ok |
| exam1.jpg（照片 1 页） | vision | 13 | 图中可见 13 | 1/13（图中无答案区） | ok |
| CSP2021.pdf（文本 12p） | text | 43 | 历史基线 43 ✓ | 0/43 | ok |
| testpdf.pdf（文本 8p） | text | 44 | 历史基线 44 ✓ | 0/44 | ok |
| noip1.pdf（文本 9p） | text | 28 | 历史 box 基线 28 ✓ | 0/28 | ok |
| PythonTest.pdf（文本 11p） | text | 27 | 旧 box 25（+2 为子问拆分） | 25/27 | ok |
| aitest.pdf（文本 2p） | text | 4 | 历史基线 4 ✓ | 0/4 | ok |

说明：PDF 的「共N题」best-effort 正则只命中单节口径（如 CSP2021 只数到单选题 15），故以历史抽取基线为准；DOCX 的声明题数取自卷面「题数：NN」，全部吻合。

## 2. 逐元素质量（审计不变量，全部通过）

- 每图恰好挂载一次：`figure_counts` 无异常（如 python 一级 7 张图各引用 1 次）；
- 选项/空位：选择题选项 ≥2；填空 `blank_positions` 与 `____` 一致；
- 空题：0（所有文件）；
- 页覆盖/失败页：视觉模式均无缺页；DOCX 无页概念（`check_page_coverage=False`）。

## 3. 判题关键字段（本轮补强）

- `sample_input_output`：编程题「样例输入/样例输出」逐字落盘（C 语言三级 5/5 题有样例）；
- `metadata`：`source_id / time_limit / memory_limit` 原样落盘（如 `20250308-3-01 / 1000 / 65536`）；
- `answer / explanation`：Python 卷 100% 覆盖；C 语言卷源文档本身没有答案（如实为 0，不编造）；
- 图片：DOCX 内嵌图按原位置内联 `[IMG_n]` 锚点，资产落 `assets/imgs/`，抽取后 `![插图n]` 位置正确。

## 4. 通道与入口

| 输入 | 通道 | 说明 |
|---|---|---|
| PDF 文本型 | `text`（本地文本 + 文本模型，无图片 token） | 页码/页眉页脚/跨页代码按既有流水线处理 |
| PDF 扫描型 | `vision`（逐页读图）或 `--via browser`（box 协议，免 API 费） | 每页画框归属图 |
| 照片 | EXIF 旋转 + 包成单页 PDF → `vision` | 建议拍摄规范；多张照片即多页 |
| DOCX | `text(docx)`：python-docx → blocks（标题/正文/表格/代码/内嵌图）→ 文本抽取 | `HTML Preformatted`/等宽字体识别为代码；OMML 公式暂按纯文本 |

## 5. 已知边界

- **照片答案少**：exam1.jpg 仅一页局部且无答案区，`answer 1/13` 属正常；来源没有答案时不编造（线上判题需另配答案文件或人工/AI 补录，AI 补录须人审）。
- **C 语言等级卷无答案**：源文档「标准答案：」为空（已逐段核对），如需判题须使用配套答案文件。
- **PythonTest 27 vs 旧 box 25**：本轮按「子问逐条拆分」硬规则输出，多出的 2 条是阅读程序题的子问；完整率以 27 为准。
- **CSP2021/noip1 的「共N题」**：卷面各节单独计数，正则会命中单节口径，非缺题。

## 6. 复现

```powershell
python pdf_tool/extract_questions.py --input pdf_tool/test-docs --force   # 全量重跑
python pdf_tool/extract_questions.py --input "pdf_tool/test-docs/202503python 一级.docx"  # 单文件
```

## 7. 预览（自包含 HTML，全部内容可见）

- 索引：`pdf_tool/output/_previews.html`（17 份测试文档）
- 单份：`pdf_tool/output/{stem}/{stem}_viewer.html`
- 内容：题干/选项/答案/解析 + 样例输入输出 + 输入输出说明 + 参考代码 + 评分标准 +
  编号/时间/内存限制 + 填空形态；图片以 base64 内联。

预览修复记录（2026-09-26）：

- 原 viewer 只内联 `*.jpg`，DOCX 产出的资产是 **PNG** → 图片断链（本次反馈的问题）；
  现支持 `jpg/jpeg/png/webp/gif/bmp`；
- 原 viewer 未渲染新增判题字段（`sample_input_output` / `metadata` / 输入输出说明 /
  参考代码 / 评分标准 / 填空形态）→ 现已全部渲染；
- 新增单测 `test_viewer_inlines_png_assets_and_renders_new_fields` 防回归。

## 8. 反馈修复记录（第二轮，2026-09-26）

| 反馈 | 根因 | 修复（通用，不限测试文档） | 验证 |
|---|---|---|---|
| 江苏物理卷（testpdf2）预览里「插图16/18」显示 base64 | 两图位于 Markdown **表格行尾**；viewer 的 `renderTables` 用 `slice(1,-1)` 同时砍掉行尾的 `)`，图片正则失配 → 当文本转义显示 | viewer 是**所有格式共用**的产物渲染器：行首去 `|`；行尾**仅当以 `|` 结尾**时才去 | playwright 回归：表格行尾图片渲染为 `<img>`、正文不含 base64；另确认 `render/md.py` 表格来自结构化 headers/rows，无同类问题；预览全部重生成 |
| CSP-J1 2021 背景水印「山西」进入正文 | 水印是 **opacity=0.1、倾斜 30°、100pt** 的背景字（`get_texttrace` 实测）；dict 行流把它与正文聚成同一视觉行，跨页重复行规则失效 | 新增共享模块 `core/watermark.py`（**所有通道共用**）：① `page_lines`（text/doc 模式，任意 PDF）：水印以**文本+字号双匹配自身**剔除 —— 只按位置会误删与水印重叠的正文（实测曾误删 239 处）；② `render_pages`（vision/box 页图）与 `stage2_local`（版面检测图）渲染前**安全遮罩**（框内有正文/图片时自动跳过）；③ `ocr/backends` 过滤 OCR 行（可搜索文字层，出生 PDF）；④ prompt 硬规则兜底（扫描件水印在像素里，模型侧忽略） | 文本源：「山西」0 次，且此前误删的「考生注意事项/试题纸共有/答题纸」全部恢复；CSP2021 重跑 43 题、审计 ok；单测覆盖"水印下的正文必须保留""独立水印才可遮罩" |
| 页眉页脚文字/图片不得进正文 | 文本通道已有跨页重复行剔除；但页面装饰**图片**只有"贴顶 logo"过滤，缺页脚与其它形态 | ① `_is_furniture_box`（过小 / 贴顶且矮小 / 贴底且很矮 <8% 页高）同时用于扫描件（`stage2_local`）与**出生 PDF 图片抽取**（`stage2_layout`，新增）；② prompt 增加"页眉页脚图片不得引用框号"（vision 通道） | 单测覆盖页眉/页脚/过小/正文大图/贴底高图五类；全量测试通过 |
| viewer 下标与填空互相吞字 | `renderBlank` 把**所有**下划线当填空（`ΔE_p` → 空白 + p）；下标 `X_p` 未渲染 | `renderBlank` 只替换**连续 ≥4 个**下划线；`inlineMd` 把 `X_p`/`X_{测}`/`x^2` 渲染为 `<sub>/<sup>`（带前后不邻接保护） | playwright 回归：`ΔE_p-ΔE_k、W_f=W_测/2、填____` 的下标= `["p","k","f","测"]`、填空= 1 个框 |

涉及文件：`core/watermark.py`（新）、`render/viewer.py`、`extract/doc_mode.py`、
`extract/vision_extract.py`、`assets/crops.py`、`ocr/backends.py`、
`prompts/text_extract.md`、`prompts/vision_extract.md`；新增测试
`tests/test_pdf_tool_furniture.py`、`tests/test_pdf_tool_viewer_render.py`（浏览器回归）。

> 注：MinerU 通道的文字来自云端结果（`ocr/sources.lines_from_layout` 读 `layout.json`，
> 其 `discarded_blocks` 已剔除页眉页脚），本地无法遮罩扫描图里的像素水印，靠 MinerU
> 侧处理；`--mode mineru` 的水印/页眉问题需在该通道单独评估。

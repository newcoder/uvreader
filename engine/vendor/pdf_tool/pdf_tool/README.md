# pdf_tool — PDF 试卷 → 题库题目

把 PDF 试卷（文本型或扫描型）自动转为结构化题目 JSON，供在线答题系统建库。
同一套「本地版面框编号 + 模型引用」协议也支持**通用文档抽取**（`--mode doc`）：把任意 PDF
（论文/教材/报告/扫描件）按阅读顺序转成 blocks，再导出 Markdown / HTML。

## 流水线

```
PDF ──► 版面解析（扫描件走 PaddleOCR 在线 doc_parsing；文本型走 fitz 行流）
    ──► 图片裁剪资产（IMG_nnn_pPP.jpg + rect2x 页面坐标）
    ──► 逐页渲染（zoom=2）→ vision 模型逐页读图抽题 + 红框标号做图归属
    ──► 占位替换 / 分类合并 / 兜底挂载 → 题目 JSON
```

- 抽取（题目切分、题型识别、填空定位、图归属）默认由 **vision 路径**完成：整页渲染后交
  DeepSeek 视觉模型逐页读图，页面资产里的图用红框标号，模型在题面写 `[[box:n]]` 占位；
- 图片资产仍由 PaddleOCR（在线，每日免费额度）/ PyMuPDF 裁剪，vision 只消费它们；
- 图片在题目文本中以 `![插图n](assets/imgs/IMG_nnn_pPP.jpg)` 呈现，资产文件在输出目录下；
- 组装后另产出旁挂体检报告 `{stem}_audit.json`（缺页/失败页、每大题题号重复、空题、每图恰好
  一次），`ok=false` 时逐条告警；审计不改题目 JSON 的结构与目录布局。

## 用法

`--pdf` 为必填参数。

```bash
# 全流程（vision 抽取，需 DEEPSEEK_API_KEY）
python pdf_tool/pdf_to_questions.py --pdf <path-to.pdf> --token <AI_STUDIO_TOKEN>

# 断点续跑：只重跑组装（不渲染、不调用 API）
python pdf_tool/pdf_to_questions.py --pdf <path-to.pdf> --only 4

# 复用中间产物重跑抽取：重新渲染页面并逐页调用付费 API
python pdf_tool/pdf_to_questions.py --pdf <path-to.pdf> --only 3,4

# 输出
#   pdf_tool/output/{stem}/{stem}_questions.json
#   pdf_tool/output/{stem}/{stem}_audit.json      # 确定性体检报告
#   pdf_tool/output/{stem}/assets/imgs/IMG_nnn_pPP.jpg
# 中间产物（可复用）：temp_output/qb_work/{stem}/

# 通用文档抽取（box 协议；标题/正文/表格/代码/图片，按阅读顺序）
python pdf_tool/pdf_to_questions.py --pdf <path-to.pdf> --mode doc
#   pdf_tool/output/{stem}/{stem}_doc.json（+ {stem}_doc_audit.json）

# 免 API 费：用 deepseek_tool 驱动真实浏览器（需已登录 deepseek.com；
# 与 API 同一套管线，仅视觉调用通道不同）
python pdf_tool/pdf_to_questions.py --pdf <path-to.pdf> --mode doc --via browser
#   --browser-timeout 1800  单次等待上限秒（0=自动：90s/页，600~3600）
#   --browser-retries 2     失败重试次数（会话异常自动重建浏览器会话）
#   上传预算 45MB，超出自动降质/缩放；实测 20 页数学书 4.2MB/173s/1 次调用
#   实测限制：站点接受多图（multiple）与 ~26MB 单文件；超大文档建议先摘取部分页

# 两遍式大文档转换（本地筛查 → 文本转写 → 只对候选页 box 挂图，均支持断点续跑）
#   API 通道：纯文字页走本地文本（无图片 token），只有含图/矢量图的页做 box 挂图
python pdf_tool/pdf_to_questions.py --pdf <path-to.pdf> --mode doc --via api --pdf-chunks 1
#   --doc-chars 30000   文本块字符数（默认 16000；30K 可用，个别块截断时自动二分/本地原文兜底）
#   --no-triage         关闭候选页筛查（默认开启，纯文字页跳过 box）
#   --split-force       重跑已完成分卷/文本块/图批次（默认跳过，支持断点续跑）
#   浏览器通道：每卷整份 PDF 直传 + 每卷新会话
python pdf_tool/pdf_to_questions.py --pdf <path-to.pdf> --mode doc --via browser --pdf-chunks 40
# 实测（math-deep 前 500 页，API 两遍式）：27 文本块 + 5 图批次 ≈ 32 次调用，
#   30-45 分钟，¥7-13（含重试），1896 blocks / 66 图；单次调用 ≈ 30K 字符文本（约 12-20 页）

# MinerU 云端解析（推荐用于公式/表格密集的大文档：content_list → blocks，~1s/页）
python pdf_tool/pdf_to_questions.py --pdf <path-to.pdf> --mode mineru --mineru-model vlm
#   token：--mineru-token 或环境变量 MINERU_TOKEN（https://mineru.net/apiManage）
#   --mineru-max-pages 200  单文件页数上限；**超过自动分卷解析并合并**（页号平移、图片路径重写、
#                           公式/图表按卷裁剪；分卷缓存断点续跑，--split-force 可强制重跑）
#   产物：output/{stem}/{stem}_doc.json（blocks）+ mineru/（full.md / images / content_list /
#         equations/（公式裁剪图）/ figs.json（原图 bbox，供重排 PDF 按原行并排））
#   实测：14 页 6-14s；100 页数学书 98s；201 页=2 卷自动合并；公式为 LaTeX（equation 块）、
#         表格 HTML→行列、图片带 caption、页眉页脚页码自动跳过
#   限制：单文件 ≤200MB / ≤200 页（超页数由分卷解决）；免费高优额度 1000 页/日（超量降优先级）
#   分卷时额外合并输出 out/mineru/layout.json：各卷 layout.json 的页号按偏移平移合并，
#   缺页补空页保持页对齐（阅读端/文字层 hybrid 直接可用整本 layout.json；单卷也统一该命名）
#   提示：blocks JSON（{stem}_doc.json）与整本 layout.json 均可作文字层 hybrid 的文本源：
#         ocr_layer_pdf.py --source hybrid --layout output/{stem}/{stem}_doc.json
#   _doc.json 的 source.pages = 源 PDF 页数（缺块的页保留为空页，便于页数核对与 hybrid 对齐）

# 题目抽取（P1）：PDF / 照片 / DOCX → 结构化题目 JSON + 审计
python pdf_tool/extract_questions.py --input pdf_tool/test-docs/xxx.docx
python pdf_tool/extract_questions.py --input pdf_tool/test-docs          # 整目录批量
#   PDF：文本型→text；扫描件→vision；--via browser 走 box 协议（网页会话，免 API 费）
#   照片：EXIF 旋转 + 包成单页 PDF → vision
#   DOCX：段落/表格/内嵌图/代码块（HTML Preformatted）→ 文本抽取；答案/解析/样例/编号/限制
#   产物：output/{stem}/{stem}_questions.json + _audit.json；批量报告 output/_p1_report.json
#   验证（test-docs 17 份，199s）：DOCX 声明题数全部吻合（5/5/4/37/38/38/38），python 卷答案 100%；
#   PDF 与历史抽取一致（CSP2019 43 / CSP2020 42 / testpdf 44 / testpdf2 25）；审计全 ok
#   报告：pdf_tool/test-docs-verification-P1.md

# blocks JSON → Markdown / HTML（图片路径自动改写为相对输出文件）
python pdf_tool/blocks_to_md.py --json pdf_tool/output/{stem}/{stem}_doc.json --out out.md
python pdf_tool/blocks_to_md.py --json pdf_tool/output/{stem}/{stem}_doc.json --out out.html
#   --base <prefix> 手动指定图片前缀；--format md|html 覆盖扩展名推断

# blocks JSON → 重排文字版 PDF（真文字可选中/搜索 + 原扫描插图按原尺寸嵌入）
python pdf_tool/blocks_to_pdf.py --json pdf_tool/output/{stem}/{stem}_doc.json --out out.pdf
#   --crop-zoom 2.0   裁剪倍率（还原原图显示尺寸：像素/zoom，默认 2.0）
#   --img-scale 1.2   图片整体放大/缩小；--margin/--font-size 版式微调

# 扫描版 PDF → 可搜索双层 PDF（原扫描页像素级不变，叠加不可见文字层，可选中/搜索/复制）
python pdf_tool/ocr_layer_pdf.py --pdf scan.pdf --out scan_searchable.pdf
#   --ocr rapid|windows  rapid=RapidOCR/ONNX（默认 PP-OCRv6，质量优先、有置信度）；
#                        windows=Windows OCR（极速，无置信度）
#   --pages 1-100 --workers 6 --intra-op 2 --min-score 0.5 --dpi 200 --force
#   实测（100 页密集文本，8 进程）：rapid 479s / windows 25.5s；2204 页预估 ~3h / ~10min
#   像素零差异（150dpi 渲染对比）；字体子集化仅 +5% 体积；页级缓存断点续跑；
#   已有文字层的页自动跳过（原生文本 PDF 不会被叠加重复文字）

# 阅读器（Electron/桌面端）sidecar：行分隔 JSON-RPC over stdio
python -m pdf_tool.reader
#   逐页懒加载: doc.open → ocr.page（页级缓存，命中毫秒级）→ content.items 直接喂 pdf.js 文本层
#   批量: convert.start mode=cache（只填缓存，与懒加载共用）/ mode=export（另存可搜索 PDF）
#   其他: ocr.prefetch / search.query（已缓存页全文检索）/ convert.status|cancel / cache.stats|clear
#   items.transform 为 PDF 用户空间（pdf.js 约定），页 /Rotate 与缩放无需重算
#   完整协议与 pdf.js 集成示例见 pdf_tool/reader/README.md（给阅读器开发者）

# PDF → Doc：规范文档模型 v1（json/md/html + 分元素审计）
python pdf_tool/pdf_to_doc.py --pdf x.pdf --mode auto
#   auto: 有 MinerU token 优先进程 mineru，文本型走 text，扫描件走 vision
#   --mode blocks --blocks output/{stem}/{stem}_doc.json   # 离线：读已有抽取产物
#   --pages 1-50 --formats json,md,html --out-dir output/{stem}/convert
#   RPC（阅读器）: doc.convert 整本任务；convert.page 单页预览（blocks/mineru/text/vision）
#   产物: {stem}_doc.json（Doc v1）/ _doc.md / _doc.html / _audit.json
#   审计: 表格行列一致/合并、空代码、公式 LaTeX、图片文件存在、ID 唯一、空页

# 位置 + 公式最优：hybrid = rapid 行级框 + 文本源（块内序列对齐，位置不降级）
python pdf_tool/ocr_layer_pdf.py --pdf scan.pdf --out scan_searchable.pdf \
    --source hybrid --layout pdf_tool/output/{stem}/mineru/layout.json
#   --layout 自动识别三种文本源：MinerU layout.json / vision_results.json / blocks JSON
#   （无 MinerU 产物时可用 --mode vision 的 vision_results.json，或 box/doc 的 blocks JSON）
#   公式 LaTeX→Unicode 进层（v₀、m/s²）；--source mineru 则只用 MinerU 文本
#   （hybrid 后端 bbox 只到段落，纯 mineru 源位置精度不如 hybrid）
#   字体：宋体 + 数学字体按字形逐段插入（下标不再写成 NUL）
#   依赖：pip install rapidocr onnxruntime opencv-python（或 rapidocr_onnxruntime 旧版）
```

依赖：vision 抽取需 `DEEPSEEK_API_KEY` 与 `openai`、PyMuPDF、Pillow；扫描件另需
`paddleocr>=3.7.0`（在线解析 CLI）。
AI Studio Access Token 获取：https://aistudio.baidu.com/account/accessToken

## 定制

- vision 抽取规则（图归属协议、页末材料交接、字段规范）：`prompts/vision_extract.md`
- 输出 Schema：`prompts/question_schema.json`
- box 协议（考题）：`prompts/exam_extract.md` + `prompts/exam_extract_box.md`
- box 协议（通用文档）：`prompts/doc_extract_box.md`（`--mode doc`）

## 已知边界

- 图归属由模型读整页版面临近判定，双栏等复杂版面仍建议人工抽查校正；
- 试卷未附答案时 `answer` 等字段为 null，需人工工作台补录；
- 扫描噪声在抽取规则中要求模型按语义纠正，仍建议对输出做人工复核后入库。

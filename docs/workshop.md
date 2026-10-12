# 书坊页面设计(文档处理 · 格式转换 · 电子书制作)

> 状态:**实施中**——W0-1(导航与页面骨架)已实现;其余任务见 `docs/workshop-implementation.md`。可交互预览:`docs/workshop-preview.html`(浏览器打开,左栏切换、工具面板、任务队列都可点)。

## 1. 定位

书坊是阅读器的「制作」区:把阅读器已有的解析能力(OCR 文字层、PDF 结构化提取)延伸成「做」——文档处理、格式转换、电子书制作。

- 输入来自**书库**;本地文件拖入/打开**就地处理(不导入书库)**,产物落在源文件旁。不单独建「书坊目录」:书库就是唯一入口与出口,派生文件用**文件名后缀**区分(见 §7),避免目录分裂导致搜索/标签/备份割裂。
- 产物默认落**书库**,支持「另存为 / 导出到…」;生成后可直接在阅读器打开。
- 分工:pdf_tool 负责 **PDF 处理与 OCR**(文字层、结构化提取、水印/页眉页脚);**DocVortex** 负责**文档格式转换**(Office/ODF/HTML/EPUB/OFD 等);**Calibre / EbookLib** 负责 **EPUB 制作与 Kindle 格式**;在线提取复用伴读的 AI 配置与密钥(行为保持现状)。

## 2. 导航与入口

- 顶部导航新增「书坊」:`悦空间 | 书库 | 书坊 … 设置`(阅读模式下导航隐藏,行为不变)。
- 快捷入口:书库书卡右键「在书坊中处理…」;阅读器 OCR 完成条「导出可搜索 PDF」跳书坊任务区。

## 2.1 页面命名与 Logo

| 页面 | 中文 | 英文 Title | Logo(线稿,与现有图标同风格) |
| --- | --- | --- | --- |
| 主页 | **悦空间** | Reading Space | 打开的书 + 星光(「悦」) |
| 书库 | **书库** | So Cool | 三本书(沿用现有 library 图标) |
| 书坊 | **书坊** | So Fun | 打开的书 + 魔杖星光(制作/Fun) |
| 设置 | 设置 | Settings | 滑杆(现有 sliders 图标) |

- **导航栏**:图标 + 中文名(悦空间 / 书库 / 书坊 / 设置)。
- **页面头部**:双语标题——中文主标题 + 英文小字(大写、弱化色),如「书坊 SO FUN」。
- **备选 Logo**(`docs/page-logos.html` 可打开对比图,含 18/24/32/64px 四档):
  - 悦空间备选:扶手椅(阅读角,小尺寸最清晰);
  - 书库备选:书架(更像「库」,18px 偏密);
  - 书坊备选:书 + 锤子(工坊感,小尺寸像「书 + 笔」)。
- **图标实现**:24×24 线稿、1.8px 圆头描边;导航改用内联 SVG(新增 workshop 图标),其余按钮保持 CSS mask 光栅方案。

## 3. 信息架构(左栏分组)

| 分组 | 工具 | 后端 |
| --- | --- | --- |
| 文字层与可搜索 PDF | 生成文字层 / 导出可搜索 PDF | pdf_tool reader sidecar |
| 格式转换 | 保持内容与版式的互转(输出**文档**):Office/ODF/HTML/EPUB/OFD → md/html/docx/pdf/latex;图片 → PDF | DocVortex + pdf_tool |
| 内容提取 | 只取内容、可丢版式:PDF / DOCX / 图片 → Markdown / HTML / 结构化 JSON | pdf_tool(高保真)+ DocVortex |
| 电子书制作 | 新建电子书(向导):元数据/章节/封面/样式 → **EPUB / AZW3 / MOBI / CBZ**(电子书产物统一在此) | Calibre `ebook-convert`(备选 EbookLib)+ 打包 |
| 发送 | 发送到 Kindle(邮件,EPUB 直发) | 主进程 SMTP(nodemailer) |
| 任务 | 任务队列与历史 | 主进程任务执行器 |

## 4. 布局

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 书坊                                                       任务 ● 2 运行中    │
├──────────────┬───────────────────────────────────────────────────────────────┤
│ 文字层        │  文字层与可搜索 PDF                                            │
│ 格式转换      │  把扫描 PDF 变成可搜索、可划线的文本;不改原件。                 │
│ 内容提取      │  ┌─────────────────────────────────────────────────────────┐  │
│ 电子书制作    │  │ 选择文件(书库)…   或拖入 / 打开本地文件(就地处理)         │  │
│ ──────────   │  └─────────────────────────────────────────────────────────┘  │
│ 发送到 Kindle │  处理方式  ○ 生成文字层(阅读器直接可用)                        │
│ 任务          │            ● 导出可搜索 PDF 副本 → 书名.uvtext.pdf            │
│              │  输出位置  源文件旁(同名覆盖)       ▸ 更多选项                │
│              │                                      [开始处理]              │
│              │  ── 最近 ──────────────────────────────────────────────────   │
│              │  扫描件测试.pdf   文字层已生成 · 2/2 页 · 3s    [打开] [在书库]  │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

- 左栏可折叠(窄窗口 <900px 默认收起,抽屉覆盖);记忆到 `settings.workshopNavCollapsed`。
- 右侧工作区:标题 + 一句话说明 + 输入区 + 选项(关键项默认可见,其余折叠)+ 主按钮 + 「最近」。
- 底部任务条常驻:运行中任务进度,点击展开队列;无任务时隐藏。

## 5. 工具设计

### 5.1 文字层与可搜索 PDF

- **输入**:书库文件多选 / 拖入 / 打开本地文件(就地处理,不导入;产物落在源文件旁)。
- **处理方式**:
  - 生成文字层:写入阅读器缓存,打开书即可搜索/划线(最快,不改文件);
  - 导出可搜索 PDF:在**源文件旁**生成 `<源名>.uvtext.pdf`(保留原页,插入不可见文字层);同名直接覆盖,可重复导出。
- **更多选项**:OCR DPI(默认 200)、混合模式(MinerU 文字源)。
- **结果**:`n/n 页`、耗时、缓存命中;操作「打开」「在书库中显示」。
- 复用 `pdfOcr.probe/start/openSession`(workers=1、文本页跳过、失败页统计已就绪)。

### 5.2 内容提取(PDF → Doc)

- **定位**:只保**内容**,可丢版式(页/栏/字体位置);**结构化 JSON(含 schema 模板:题库等)与纯图片提字**都在这里。
- **已实现(2026-10-12)**:PDF 走 pdf_tool(`pdf_to_doc.py`:自动 / MinerU / 文本 / 扫描视觉);Office / ODF / OFD / HTML / EPUB / **图片**走 DocVortex。产物按 §7 落在源文件旁:PDF 为 `<源名>.md|.html|.json|.audit.json` + `<源名>.assets/`(pdf_tool 的 `_doc`/`mineru` 命名在 runner 里改名并改写资产引用),其余为 `<源名>.md|.html|.json`。面板:预设矩阵、PDF 模式选择、检测提取链路、最近任务、**结果预览**(Markdown 开头 1500 字 + 体检摘要)。**题库 schema 模板待接**。
- **输入**:PDF(文本/扫描)、DOCX、**图片(纯图提字)**。
- **模式**:自动 / 文本 / 扫描视觉 / MinerU(高级)/ **模板抽取(题库等 schema)**;在线模式沿用现有行为(不加额外确认)。
- **输出**:Markdown / HTML / **JSON(Doc v1 / 模板 schema)** / 图片资产;命名见 §7(扩展名变化不加后缀)。
- **结果预览**(提取完成后):右侧预览卡片渲染 Markdown/HTML(标题/图片/表格/公式原样呈现);可切换 Markdown / HTML / JSON(结构树:页-块-类型计数);显示**体检报告**(缺页/空块/图片重复/失败页);操作「打开产物」「在书库中显示」。
- **AI 清理**(可选,默认关闭):修 OCR 错字、合并断行、补漏标题;作为后处理步骤进队列,可撤销、可对比。

### 5.3 格式转换(DocVortex)

- **输入(20 种)**:PDF、DOC/DOCX/RTF、PPT/PPTX、XLS/XLSX/CSV/TSV、ODT/ODS/ODP、EPUB、HTML、MHTML、OFD。
- **输出(7 种)**:Markdown、HTML、LaTeX、DOCX、EPUB、PDF、结构化 JSON。
- **用法**:`docvortex convert <源> --format <目标> -o <产物>`;`--parse-mode auto|txt|ocr`(PDF)、`--pages`、`--pdf-layout`;一次解析可多格式导出(Bundle)。
- **预设(只留本工具的两张卡)**:文档互转(DocVortex)、图片 → PDF;**所有电子书产物(EPUB/MOBI/AZW3/CBZ)归「电子书制作」**;提取类预设归「内容提取」。
- **分工(2026-10-12 定调,详见实施计划)**:按保守程度分四层——**文字层**(最保守,原文件不变)> **格式转换**(内容+版式基本不变)> **内容提取**(只要内容、可丢版式;**JSON/结构化与 schema 模板在此**)> **电子书制作**(内容 + 新加的样式/版式/字体/封面/目录,支持 **txt** 输入)。本工具只做保持内容与版式的转换(DocVortex 矩阵 + Calibre 的 EPUB→AZW3/MOBI + 图片→PDF/CBZ),**目标格式不含 JSON**;预设卡片点按后路由/预填到对应工具,不重复实现。
- **公式优先(可选,见 §8.1)**:扫描件公式多时,先经 pdf_tool(MinerU)提取 LaTeX,再转 HTML(`<script type="math/tex">`)交 DocVortex 生成 DOCX/EPUB —— 输出为真 OMML/MathML 公式。
- **正文误判还原(2026-10-12,两栏论文实测)**:pdf_tool / MinerU 偶尔把**正文段落判成代码块**——`1.DUL+paper.pdf`(7 页 79 块)里有 2 个 `code` 块其实是正文,转换出的 HTML 因此把段落显示成 `<pre>`(两个 `<pre class="language-latex">`,里面还留着未转换的 `$…$`)。`formula-html.js` 的 `codeBlockHtml()` 现在按**内容**判断:去掉 `$…$` 后没有代码 / LaTeX 特征、有句子与足够词数就按段落渲染——硬换行并回一段(`for\n10 min` → `for 10 min`)、被断开的数字粘回(`61.\n91` → `61.91`)、段内公式照常转 `<script type="math/tex">`;真代码块保持 `<pre><code>`。内容提取的 `.md` 产物同样把这类无语言围栏拆回段落(`adoptPdfToolOutputs` → `unwrapProseFences`)。实测同一份论文:HTML 里 `data-block-type="code"` 2 → 0、段落 37 → 39、公式 73 → 89,标题 / 图片 / 字数不变。
- **caption 还原(2026-10-12,同一篇实测)**:这类误判块还带一个坑——MinerU 把**正文前半段放进了块的 `caption` 字段**(不是题注),而 MinerU 自己的 `.md` / `.html` 写作器都把 caption 丢掉,于是段落缺少开头(`In the experiments, the silicon wafer capped with a 4-μm thick SiO2 layer…` 整句不见了,输出直接从 `30 s to promote the adhesion…` 开始)。修法:渲染 `code` 块时把 **caption 与 content 合并**成一个段落(真代码块则把 caption 作为说明段放在 `<pre>` 之前),`image` 块的 caption 输出为 `<figcaption>`(DocVortex 转成 `image_caption`),`adoptPdfToolOutputs` 在拆「假代码块」**之前**先用 Doc JSON 把 caption 补回 `.md` 围栏内(这样向导 / 预览读的 `.md` 也完整)。实测同一份论文:段落仍 39、公式 89 → 91、字数 +827,两段开头都回来了。
- **文字层互补(2026-10-12,论文实测)**:MinerU 偶尔丢字/丢符号(实测:`at the speed of 3000 rpm for` 少了 `3000 rpm for`、`1 × 2 Y-branch` 少了 `×`、caption 被当成题注丢弃),而 PDF 自带文字层是逐字精确的(缺点是没有 LaTeX 公式、还混着页眉/水印)。新增 `main/text-layer.js`(PyMuPDF `page.get_text()`,结果写 UTF-8 文件——控制台编码会破坏 `ﬁ` 之类连字)+ `main/text-merge.js`,在「公式优先」链路里做**互补合并**:
  - **先去水印/页眉页脚**:按行统计,重复页数达到「页数 × 30%(至少 3 页)」的行视为页眉/页脚/水印删掉(只重复两三次的多半是正文里的公式或句子,保留);实测 `1.DUL+paper.pdf` 只删了 3 行(期刊页眉、IEEE 下载戳、running title),正文一行未动;107 页的物理教材因此不会误删正文公式。
  - **正文用文字层**:用「压缩键」(NFKC 展开连字、去空格/连字符/符号、小写;短键还要求词边界,避免 `30` 命中 `3000`)对齐;长段落按 ~8 词分块、对不上再二分;块与块之间的间隙正是 MinerU 丢掉的词,逐字补回。
  - **公式用 MinerU 的 LaTeX**:对齐出的公式位置照旧写 `<script type="math/tex">`;公式字形(如 `65 °C`)被跳过、换成 LaTeX,不重复;两边冲突时按「谁覆盖谁」择优,任一段对不上就整段回退 MinerU 原文(不猜、不造)。
  - **接入点**:`formula-convert`(格式转换的公式优先)在生成 HTML 前合并;`book-build`(电子书制作)提取 PDF 时用合并稿成书;`内容提取`(PDF)的 `.md` 产物也改写成这份合并稿(图片引用照 §7 改写为 `<源名>.assets/`),`.json` 仍是 MinerU 原始结构化记录。
  - 实测 `1.DUL+paper.pdf`:补回 `3000 rpm for`、`×`、`designed`(断词)、公式后的句号;79 块里正文块合并 35/39(4 个回退,回退块本身正文完好),14 个行间公式 + 40 个行内公式一个没丢;成品 HTML 段落 39、公式 91、图片 24 与纯 MinerU 版一致。
  - **多文件实测(2026-10-12,pdf_tool `test-docs` 的 6 份 PDF)**:R-D Background(9 页,合并 28/回退 5)、Plan and Methodology(7 页,50/1)、Q202607194(2 页,7/4)、DUL 论文(7 页,44/4,净补 +175 键字符)、kinetic theory 教材(**107 页**,649/95,净补 +81,**852 个行间 + 1045 个行内公式全保留**)、TI+DMD(11 页)在测。所有文件**"缩短"计数为 0**(没有任何正文块比 MinerU 更短 = 没丢字);回退块审计显示剩余缺口基本是页眉/版权脚注/公式字形/连字拆词,不是正文。

### 5.4 电子书制作(向导 + 实时预览,主输出 EPUB)

**布局**:左侧向导步骤,右侧**实时预览**(章节样张/封面/目录随步骤切换)。样式改动只重渲染预览(毫秒级),「生成」时才真正构建 EPUB。

**面板预设(计划中,2026-10-12 起不在向导面板重复展示)**:PDF → 干净电子书;Markdown / HTML → EPUB;txt → EPUB;Office / OFD → EPUB;**EPUB → AZW3 / MOBI**;图片 → CBZ / EPUB——源已全部接入后,这些都在「电子书制作」向导里直接完成(非文本源由向导内部自动提取/转换)。**所有电子书产物统一在这里。**

**源已全部接入(2026-10-12)**:书稿选择接受 **txt / Markdown / PDF / Office(docx/pptx/xlsx…)/ ODF / OFD / HTML / EPUB / 图片**;**非文本源在生成时由向导内部自动提取**(PDF 走 pdf_tool,其余走 DocVortex,中间产物放 `userData` 缓存,用户无感),提取出的 Markdown 按 1–3 级标题分章。

**已实现(2026-10-12)**:
- 「**电子书互转(EPUB → AZW3 / MOBI)**」(Calibre `ebook-convert`,检测 + 路径设置 + 检测按钮)与「**图片 → CBZ / EPUB**」(CBZ 自己打包:自然排序、同名序号;EPUB 由 CBZ 经 Calibre 转);产物落在源文件旁。
- **EPUB 构建器 + 字体子系统(W1-2)**:txt / Markdown → 章节(识别「第X章/回/卷」等标题,无标题按长度分块;Markdown 渲染标题/列表/引用/代码/图片/链接/强调)→ 单栏流式 CSS(主题/字号/行距/边距/缩进/对齐/标题/引用/代码/图片)→ EPUB 3(mimetype 存储、container、OPF 元数据、nav + NCX、封面页、版权/字体许可页)。字体:**乔木封面字库按需下载**(jsDelivr 镜像 → 缓存 `userData/font-cache`)+ **子集化嵌入**(Python fontTools 子集化;需 fontTools 与 brotli 读 WOFF2,缺失时先回退嵌原文件、再回退系统字体),子集改名 `QBR <字体名>`,OFL 文本随包。实测:朱雀 2.5MB WOFF2 → **22KB 子集**,整本 EPUB 27.8KB,阅读器可直接打开。
- **向导 UI(W1-3,已实现 2026-10-12)**:「快速成书」面板 = 书稿选择(txt / Markdown,书库或本地)→ 书名/作者 → 字体搭配(12 套)+ 字号/行距/边距/主题(高级:缩进/段距/对齐/标题)→ **iframe(blob)实时预览**(手机/桌面宽度,与成品共用同一份 CSS;选中书稿后显示其开头)→ 生成 EPUB(走任务队列);样式持久化在本地。
- **封面(已实现 2026-10-12)**:三选一——**模板生成**(1600×2400 离屏渲染,配色 暖纸/纸白/青瓷/夜墨,标题/副标题/作者,嵌入所选搭配字体)、**指定图片**(nativeImage 统一转 JPEG)、**自动**(Markdown 首图,缺图回退模板);**面板内 176×264 缩略图实时预览**(同一份 `coverHtml`,系统近似字体)。PDF/Office/图片源随后续阶段接入。
- **目录编辑(已实现 2026-10-12)**:选中书库书稿后自动分章并列出(序号 / 标题输入框 / 字数),可**改名、合并(与下一章)、拆分(段落中点)、上下排序**;编辑后的章节列表随 `book-build` 一起提交(runner 优先使用面板目录)。本地文件在生成时自动识别目录。
- **面板重排 + 成品质量修复(2026-10-12,用户反馈)**:面板改成**一条主流程 + 更多工具**——主流程是向导四步(① 内容 → ② 目录 → ③ 书名与封面 → ④ 排版样式 → 生成 EPUB),右侧全程预览;「EPUB → AZW3 / MOBI」「图片 → CBZ / EPUB」「Calibre 设置(折叠)」收进「更多工具」;向导上方的预设矩阵撤掉(任何受支持的输入都直接在向导里成书)。同时修掉三类成品问题:
  - **图片**:章节 HTML 引用的本地图片(`mineru/images/*.jpg` 这类提取产物)按提取目录解析后**嵌入 EPUB**(`images/image-N.*`;缺失或不支持的格式丢弃并记日志),成品不再出现破图;支持 png / jpg / jpeg / gif / svg。
  - **公式**:正文里的 `$…$` / `$$…$$` / `\(…\)` / `\[…\]` 收集去重后用 Python `latex2mathml` 一次转成 **MathML**(行间公式标 `display="block"`),失败时保留原 LaTeX 文本、不阻断出书;实测用户论文 34 条公式全部转换(章节里 37 处 `<math>`,0 处遗留 `$…$`)。
  - **假代码块**:MinerU 偶尔把正文段落包进没有语言标记的围栏(段里的公式因此不渲染),`shared/markdown-fix.js` 的 `unwrapProseFences()` 把这类「像正文」的围栏拆回段落(真代码块保留);向导读 Markdown 源、内容提取的向导路径与预览都先过这一层。
  - **预览不乱码**:预览只把 txt / md 当文本读(Markdown 渲染后显示);非文本源优先读同目录「内容提取」产物 `<源名>.md` 并标明来源,没有就显示示例文字 + 「生成时自动提取」提示——二进制文件不再按文本读。
- **图片提取(2026-10-12 修复)**:DocVortex 的 `convert` 只收文档(直接给图片会报 `Unsupported native input format: jpeg/png`,加 `--parse-mode ocr` 也不行),图片改为**先用 Pillow 合成单页 PDF** 再走它的本地 OCR(`--parse-mode ocr`,临时 PDF 跑完删除);内容提取面板与向导的图片源都走这条路。
1. **内容源**:书库里的书 / **PDF、Office 文档(docx/pptx/xlsx…)** / **txt 纯文本** / Markdown / HTML / 图片文件夹 / 已提取的 Doc。**定位**:提供内容 + 加样式(原版式不保留);**PDF/Office 等非文本源由向导内部自动先做提取/转换(内容提取、DocVortex),中间环节用户无感**——向导里只呈现「内容预览 → 样式/封面/目录 → 生成」。
2. **元数据与封面**:书名/作者/语言/丛书/标签(「AI 推断」从正文补全);封面三选一——① **指定图片**(书库/本地);② **自动**(书内首图或首页渲染);③ **模板生成**(标题+作者+副标题,可选配色/纹理/首图,输出 1600×2400);「AI 封面文案」给标题/副标题/系列;封面预览实时可见。
3. **章节**:按标题自动分章(1–3 级可选);可改名/合并/拆分/排序,显示字数;「**AI 建议分章**」在标题缺失时推断结构;右侧预览目录(nav/NCX)。
4. **样式**:字体(内置字体 + 系统)、字号、行距、段首缩进、页边距、标题风格、对齐、主题(跟随阅读主题 / 纸白 / 暖纸 / 青瓷 / 夜间)、代码块与引用样式;默认值可用,高级折叠;右侧样张实时更新,可切换**手机/平板/桌面**宽度与明暗。

**字体与排版(2026-10-12 定调)**:
- **版式**:单栏流式(EPUB reflow),不做固定版式;新章起新页,图片居中自适应;标题层级由 CSS 控制(不写死字号)。预览与成品共用同一份 CSS。
- **字体来源**:[乔木封面字库](https://github.com/joeseesun/qiaomu-cover-fonts)(34 款 SIL OFL,中文 19 / 英文 15;WOFF2 子集共 30.7MB;`index.json` 带字节数与 SHA-256)+ 系统字体 + 阅读器已导入字体(`importedFonts`)。**按需下载**:首次选用某款时从 jsDelivr 镜像下载并校验 SHA-256,缓存到 `userData/font-cache`,之后离线可用;不预装、不静默下载整库。
- **字体搭配**(12 套,标题 / 正文 / 英文三角色):沿用字库的 pairing(`editorial` 编辑杂志、`literary` 文化书卷、`tech` 科技产品、`warm` 温暖手记、`guofeng` 国风书法 等);默认给最稳的一套(正文思源宋体 + 标题思源黑体 Bold + 英文 Inter),用户可换。
- **EPUB 嵌字**:选中的标题/正文/英文字体**子集化后嵌入**(`pyftsubset`,本机 fontTools 4.56 可用;DocVortex 同款依赖):
  - 只保留书中实际用到的字符 + 常用标点 → 正文字体通常几百 KB;
  - 输出 **TTF**(兼容性最好;WOFF2 只被部分阅读器支持);
  - **命名与许可**:子集字体重命名为 `QBR <字体名>`(与现有阅读子集 `QBR Zhuque Fangsong` 一致,满足 OFL Reserved Font Name);EPUB 内附 `fonts/OFL-*.txt` 并在版权页注明;
  - **排除不可子集的字体**(抖音美好体等 no-modify)只用于封面渲染,不进 EPUB;
  - 字体缺失/下载失败时回退系统 serif/sans,不阻断生成。
- **样式设置**(默认即可用,高级折叠):
  - 顶层:字体搭配 / 字号(默认 17px)/ 行距(1.75)/ 边距(5%)/ 主题(跟随阅读主题、纸白、暖纸、青瓷、夜间)
  - 高级:段首缩进(默认 2em)与段间距、对齐(两端/左;默认两端)、标题风格(字号比、居中、留白)、引用样式、代码块(等宽 JetBrains Mono + 底色)、图片(居中、最大宽度)、章节起始(新页/连续)
  - 中文排版细节(标点挤压、避头尾)交给阅读器,不写复杂 CSS;缩进只用 `text-indent`。
- **后续(不在本阶段)**:阅读器的字体列表也可接入同一字库(现在只内置朱雀仿宋子集);导入字体与「用户自行安装」的说明见 `fonts/README.md`。
5. **生成**:EPUB(主输出);可选同时导出 Markdown/HTML;可再转 AZW3/MOBI(Calibre);生成后可直接「发送到 Kindle」。

**LLM 辅助任务**(全部可选、可撤销,复用伴读 AI 配置):AI 清理(OCR/断行/漏标题)、AI 分章建议、AI 元数据推断、AI 封面文案;进任务队列显示进度,失败不影响手动流程。

**批量**:多本排队,共享元数据与样式模板。

### 5.5 任务队列

- 统一任务模型:`{id, 类型, 输入, 状态(排队/运行/完成/失败/取消), 进度, 产物, 错误}`。
- 交互:底部任务条(运行中 + 最近 3 条);展开列表(最近 20 条);取消、失败重试、完成 toast;历史落盘(不自动续跑)。

### 5.6 发送到 Kindle(邮件,EPUB 直发,不需要转 AZW3)

**可行性**:Amazon「Send to Kindle」邮件通道**原生支持 EPUB**(官方支持列表:PDF/DOC/DOCX/TXT/RTF/HTM/HTML/PNG/GIF/JPG/JPEG/BMP/**EPUB**),无需转换 Kindle 格式。所以只要配置一个发件邮箱即可。

**Amazon 侧前置条件(设置页给出引导)**:

- 在 `管理我的内容和设备 → 首选项 → 个人文档设置` 找到 **Send to Kindle 邮箱**(`xxx@kindle.com`);
- 把发件邮箱加入**已批准的个人文档电子邮件列表**(最多 15 个);
- 限制:单封邮件**最多 25 个附件、总计 ≤ 50 MB**(超出可打 ZIP,Amazon 会自动解压;>50MB 时应用自动打包);附件为受支持格式即可;投递最长尝试 60 天。

**应用内设计**:

- 入口:书坊 →「发送到 Kindle」;书库书卡右键「发送到 Kindle…」;电子书制作完成后可一键发送。
- 面板:选择文件(书库/本地,就地处理)→ 收件 Kindle 地址(可多个,逗号分隔)→ 显示 SMTP 配置状态(未配置则「去设置」)→「发送」;结果进任务队列,显示 Amazon 受理状态。
- 设置(设置 → 发送到 Kindle):SMTP 服务器、端口(465 SSL / 587 STARTTLS)、用户名(完整邮箱)、**授权码/应用专用密码**(非登录密码,如 QQ/163 授权码、Gmail 应用密码)、发件人显示名、默认 Kindle 地址;「测试连接」(SMTP `verify`,不发信)与「发送测试文件」。
- 密码用桌面壳的 **safeStorage/SecretStorage** 保存(与 AI 密钥同一机制),不落明文设置。
- 失败处理:把 SMTP 错误翻译成可读提示(认证失败/授权码、连接被拒、大小超限、附件格式不支持);提示检查「已批准发件人列表」。

**实现**:主进程 `apps/desktop/src/main/kindle-send.js` + `nodemailer`(纯 JS,Electron 主进程可用);IPC `qbr:kindle:{verify,send}`;复用任务队列与 toast;非桌面宿主不提供(桌面壳专有)。

**两条路都保留**:① **邮件直发 EPUB**(推荐,最省事,本功能);② **EPUB → AZW3/MOBI**(Calibre,给 USB 拷贝、其它阅读器或离线场景)。直发不依赖 Calibre,转换功能也照常提供。

## 6. 技术架构

- **页面**:`views.js` 新增 `createWorkshopView`(视图 `qbr-workshop`)+ 导航路由 `workshop`;窄窗口抽屉沿用书库方案。
- **主进程**:`apps/desktop/src/main/workshop.js` 任务执行器 + IPC `qbr:workshop:*`(start/cancel/list/状态事件);产物写库内目录(沿用 `resolveOcrOutput` 的库内校验);发送到 Kindle 用 `apps/desktop/src/main/kindle-send.js`(nodemailer,SMTP)。
- **后端解析(与 OCR 设置同规则:exe 优先 → Python 目录 → 环境变量)**:
  - `pdf_tool.reader`(sidecar JSON-RPC):文字层、可搜索 PDF、`doc.convert`;
  - `docvortex`(CLI/Python SDK):文档互转;`pip install docvortex`(MIT);
  - **Calibre(CLI 形式,外置进程)**:`ebook-convert` / `ebook-meta`,main 进程 spawn;检测顺序=设置自定义路径 → 常见安装位置(`C:\Program Files\Calibre2\ebook-convert.exe`、macOS `calibre.app/Contents/MacOS/`、PATH)→ 未找到给出下载引导;常用参数 `--title/--authors/--cover/--language/--publisher/--series/--tags`、`--chapter "//h:h2"`、`--toc-threshold`、`--extra-css`、`--base-font-size`;EPUB→AZW3/MOBI 同命令换扩展名。体积大且 GPL-3,**不随包分发**;未安装时 EPUB 用 **EbookLib** 兜底构建(备选,AGPL,需评估);
  - 备选 `EbookLib`(纯 Python):需要完全内置的 EPUB 构建时使用。
- **预览渲染**:壳内 iframe 渲染章节 HTML,内嵌**与 EPUB 相同的 CSS**(样式控件改动即时重渲染);Markdown 预览复用现有 sanitize/render 管线;EPUB 仅在「生成」时构建,预览不落盘。
- **LLM 任务**:走现有 AI 桥(与伴读同一供应商/密钥),不新增设置项;任务进队列,可取消/重试。
- **AI 复用**:在线提取/视觉模式复用伴读的 AI 供应商配置与密钥(不新增设置项)。
- **输出**:默认落书库(文字层导出=源文件旁、同名覆盖);中间产物(缓存/工作文件)放应用目录,不入库。

## 7. 文件名约定(不加标签,用名字区分)

**规则**:输出扩展名与源文件**相同**时才加语义后缀(否则无法区分);**扩展名变了就不加后缀**,直接换成新扩展名(同名冲突用序号)。

| 场景 | 命名 | 例 |
| --- | --- | --- |
| 文字层(扩展名不变:pdf→pdf) | `<源名>.uvtext.pdf`(源文件旁,同名覆盖) | `扫描件测试.uvtext.pdf` |
| 格式转换(扩展名变化) | `<源名>.<目标扩展名>` | `报告.docx` → `报告.md` / `报告.epub` |
| 格式转换(扩展名不变,如 pdf→pdf) | `<源名> (n).<扩展名>`(序号,不覆盖源文件) | `报告.pdf` → `报告 (1).pdf` |
| 内容提取(扩展名变化) | `<源名>.md` / `<源名>.html` / `<源名>.json` | `报告.pdf` → `报告.md` / `报告.json` |
| 提取的图片资产 | `<源名>.assets/` | `报告.assets/` |
| 体检报告 | `<源名>.audit.json` | `报告.audit.json` |
| 制作的电子书 | 元数据书名 | `萤窗小语.epub` |

## 8. 工具调研结论(2026-10-11)

| 工具 | 许可 | 角色 | 状态 |
| --- | --- | --- | --- |
| pdf_tool(现有) | 本仓库 | PDF 深处理:文字层/可搜索 PDF、结构化提取(表格/代码/公式)、水印/页眉页脚 | 已有 |
| **DocVortex 0.5.16** | MIT | 文档互转:20 入 / 7 出,Office/ODF/HTML/MHTML/OFD/EPUB,本地 CPU OCR,一次解析多格式导出(Bundle),Rust 加速 | **已安装**;实测 DOCX→md/epub、PDF→md/epub 可用 |
| **Calibre ebook-convert** | GPL-3 | 外置 CLI(9.15.0 实测):`ebook-convert`/`ebook-meta`;EPUB→AZW3/MOBI/PDF;HTML/MD/DOCX→EPUB(`--title/--authors/--cover/--language/--chapter "//h:h2"/--toc-threshold/--extra-css`) | **本机已装**;实测 EPUB→AZW3 通过 |
| EbookLib 0.20 | AGPL-3 | 纯 Python 构建 EPUB(元数据/封面/章节/样式),可内置 | 备选(许可需评估) |
| pandoc | GPL-2 | md→epub3 等 | 未安装,暂不采用 |

DocVortex 实测备注:输出 EPUB 结构合法(mimetype/container/OPF/nav + 图片资产),但**元数据默认 `DocVortex Document`、正文为单文件、DOCX 的标题/表格结构映射较弱**;因此 EPUB 制作走 Calibre(元数据/分章/封面可控),DocVortex 主攻格式互转。

### 8.1 公式链路实测(MinerU → DocVortex,2026-10-11)

**结论**:pdf_tool 的公式质量来自 **MinerU**(`--source mineru/hybrid`;本地 rapidocr 无公式模型),其 LaTeX 已含上下标与分式;DocVortex 的公式**渲染**管线完整(LaTeX→MathML→OMML 写 DOCX、EPUB 输出 MathML、PDF 用 ziamath 画矢量),缺的只是**扫描件的公式识别**。两者可用 HTML 桥接,**不需要改 DocVortex**。

- pdf_tool 侧证据:`output/testpdf2/mineru/full.md`(扫描件)含 `$v = v_{0} + at$`、`$\frac{U_1}{U_2} = \frac{n_1}{n_2}$`、`$2\mathrm{m}/{\mathrm{s}}^{2}$`、`$\frac{mv_0^2\sin^2\theta}{qE}$`;`render/viewer.py` 把 `X_p`/`x^2` 渲染为 `<sub>/<sup>`;双层 PDF 的文字层用 `latex_to_text` 转 Unicode(只为可搜索)。
- DocVortex 侧:扫描件 OCR 路径把 `display_formula` 当**截图**保留、行内公式走 PP-OCRv6 纯文本(上下标被拉平);原生 PDF 路径有公式检测(按字形几何,`analyzers/native/pdf/formulas.py` + `inline/scripts.py`);HTML/XHTML 输入识别 MathML、`<script type="math/tex">`、`data-tex` 等(`content/markup/formula.py`);DOCX 输出为真 OMML 公式(`render/_internal/docx/math.py`)。注意 0.5.16 的 Markdown/txt 输入**实际不支持**(`Unsupported native input format: txt`)。
- **实测桥**(`%TEMP%\dv-math-html`):LaTeX 包在 `<script type="math/tex">`(行内)/`<script type="math/tex; mode=display">`(行间)的 HTML → `docvortex convert --format docx`:7×`m:oMath`、3×`m:sSub`、2×`m:sSup`、2×`m:f`;`--format epub` 输出 MathML(`msub`)。MathML(经 latex2mathml,docvortex 自带依赖)同样可行。
- **实施 A(不改 DocVortex,已实现 2026-10-11)**:书坊「文档互转」增加**解析方式 = 公式优先(MinerU 云端,PDF)**;链路 = pdf_tool(`pdf_to_doc.py --mode mineru --formats json`)→ Doc v1 JSON → 带公式标记的 HTML → DocVortex → DOCX/EPUB/PDF。桥放在本仓(`apps/desktop/src/main/formula-html.js` 纯函数 + `workshop-formula.js` runner),pdf_tool 保持不动;每个源文件一个稳定缓存目录(重复转换复用 MinerU 产物),任务标签随阶段推进(MinerU 云端解析 → 生成公式 HTML → DocVortex 转换)。实测:14 页扫描件 → DOCX **197 个 OMML 公式(96 下标 / 52 上标)**;e2e `workshop-formula` 默认跳过(计费云服务),`QBR_E2E_MINERU=1` 才跑。**凭据来源**:面板「MinerU 凭据」→ 进程环境 `MINERU_API_KEY`/`MINERU_TOKEN` → Windows 注册表(用户/机器级,免重启;变量设好后应用没重启也能用);凭据经子进程环境传入 pdf_tool,不出现在命令行。
- **实施 B(上游/分支,终局;备忘见 `docs/docvortex-formula-upstream.md`)**:给 DocVortex 的 OCR 路径加**公式识别模型**(PP-FormulaNet / UniMERNet ONNX,与现有 PP-DocLayoutV2 / PP-OCRv6 同族),把 `display_formula` 截图与行内公式区域变成 LaTeX;顺带支持外部文本源(MinerU layout.json / vision 结果)与 Markdown 输入。优势:离线、无配额、单工具一条命令、文件不出本机;代价:改第三方包(PR/分支)、行内公式检测工作量大、模型质量上限仍不如 MinerU 的 VLM。当前**决定:采用 A,B 仅作备忘**(触发条件见备忘 §6)。
- **A-local(本地 MinerU,由 pdf_tool 侧实现)**:离线版 A——pdf_tool 增加 `--mineru-source auto|cloud|local`(本地 `mineru` CLI / `mineru-api` HTTP / OpenAI 兼容端点),档位 basic/standard/advanced,**输出契约不变**(同构 Doc JSON → 书坊桥与 DocVortex 零改动)。需求已交给 pdf_tool:`pdf_tool/docs/reader-request-mineru-local-2026-10-11.md`(接口建议、验收、硬件参考、书坊后续:解析方式加「公式优先(MinerU 本地)」)。本机可行:RTX 4060 Laptop 8GB 单并发,2–6s/页;模型 `MinerU2.5-Pro-2605-1.2B`(2026/06;Apache-2.0 系许可)。
- 顺带发现(pdf_tool 侧,未改):`render/md.py: render_html_blocks` 没有 `equation` 分支,公式块在它的 HTML 预览里被丢弃 —— 与书坊链路无关(桥不走它),但值得以后补一行。
- 不采用:把 pdf_tool 的 hybrid 双层 PDF 再喂给 DocVortex —— 文字层公式已转 Unicode、字形几何是合成的,原生路径还原不出上下标结构。

## 9. 文案与 i18n

新增约 40 个 key(`nav-workshop`、`workshop-*`、`tool-*`、`status-*`、`audit-*` 等),9 语言同步,沿用 `npm run check:i18n`。

## 10. 分期

- **P0**:页面 + 导航;文字层 / 可搜索 PDF(批量,`.uvtext.pdf`);PDF → Markdown/HTML(pdf_tool);文档互转(DocVortex:docx/ppt/odt/html/epub/mhtml/ofd → md/html/docx/pdf);任务队列。
- **P1**:电子书制作向导(**实时预览 + 样式 + 封面 + 目录**;Calibre → EPUB);**发送到 Kindle**(SMTP + 设置 + 右键/书坊入口);**EPUB → AZW3/MOBI**(Calibre,与直发并存);PDF → EPUB(先提取再制作);图片 → PDF/CBZ;DOCX → EPUB。
- **P2**:**LLM 辅助**(AI 清理 / AI 分章建议 / AI 元数据 / AI 封面文案);批量制作与元数据/样式模板;Markdown → EPUB;EPUB → Markdown;EbookLib 内置构建(可选);题目抽取(后续)。

## 11. 非目标

- 不做 EPUB 内容编辑器(只做制作/转换,不改正文);
- 不做在线发布/云存储,不引入账号;
- Obsidian 插件端不提供书坊(桌面壳专有);
- 书坊不做阅读:产物一键跳阅读器。

## 12. 已确认决策

1. 输出默认**书库**;文字层导出固定**源文件旁、同名覆盖**(2026-10-12 调整,不再提供另存为);其余产物可「另存为 / 导出到…」;用户可打开书籍目录。
2. **不加标签**,用文件名后缀区分(§7);文字层 PDF 用 `.uvtext.pdf`。
3. EPUB 渲染**不进 pdf_tool**;pdf_tool 专注 PDF/OCR;EPUB 走 Calibre(备选 EbookLib)。
4. 在线提取(消耗 AI 额度)**保持现状**,不加额外确认。
5. 本地文件打开**就地处理,不导入书库**,产物落在源文件旁(2026-10-12 调整);**不单独建书坊目录**(理由见 §1)。
6. 电子书主输出 **EPUB**;特定需求经 Calibre 转 AZW3/MOBI 等主流格式。
7. 文档格式转换采用 **DocVortex**(已安装,能力见 §8)。
8. **发送到 Kindle**:走 Amazon 邮件通道,EPUB **直发**;应用内配置 SMTP(授权码/应用密码走 safeStorage)与 Kindle 地址,含「测试连接」与失败提示;Amazon 侧需把发件邮箱加入「已批准的个人文档电子邮件列表」,单封 ≤25 附件 / ≤50MB(超出自动 ZIP)。
9. **EPUB → AZW3/MOBI 转换同时保留**(Calibre,USB 拷贝/离线/其它阅读器场景),与「发送到 Kindle」并存,不做二选一。
10. **预览与样式**:向导右侧**实时预览**(壳内 iframe + 与 EPUB 相同的 CSS),样式/封面/目录改动即时可见;EPUB 只在「生成」时构建。提取结果同样提供 Markdown/HTML/JSON 预览与结构树。
11. **LLM 辅助**:AI 清理(OCR/断行/漏标题)、AI 分章建议、AI 元数据推断、AI 封面文案等复杂任务,复用现有 AI 配置;全部可选、可撤销、失败不阻塞手动流程。
12. **Calibre 集成形式**:外置 **CLI 进程**(`ebook-convert`/`ebook-meta`),检测顺序=自定义路径 → 常见安装位置 → PATH,未找到给下载引导;体积大且 GPL-3 不随包分发,未安装时用 **EbookLib** 兜底构建 EPUB。

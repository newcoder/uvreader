# 书坊页面设计(文档处理 · 格式转换 · 电子书制作)

> 状态:**实施中**——W0-1(导航与页面骨架)已实现;其余任务见 `docs/workshop-implementation.md`。可交互预览:`docs/workshop-preview.html`(浏览器打开,左栏切换、工具面板、任务队列都可点)。
>
> **2026-10-18 变更(减法)**:「发送到 Kindle」整条链路**已移除**(SMTP 配置繁琐、使用率低);「电子书制作」的**实时预览**与**字体嵌入**已移除(预览实际没人看;字体改由阅读器自带,成品更小、少一层下载/子集依赖)。下文涉及这两处的内容按"已移除"读。

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
| 格式转换 | 保持内容与版式的互转(输出**文档**):Office/ODF/HTML/EPUB/OFD → md/html/docx/pdf/latex;Markdown / 纯文本(先渲染成 HTML 桥,见 §8.1;→ docx 时再把 DocVortex 的字面编号换成真 Word 列表);图片 → PDF | DocVortex + pdf_tool |
| 内容提取 | 只取内容、可丢版式:PDF / DOCX / 图片 / Markdown / 纯文本 → Markdown / HTML / 结构化 JSON | pdf_tool(高保真)+ DocVortex |
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

### 5.2 内容提取

- **定位**:只保**内容**,可丢版式(页/栏/字体位置);**结构化 JSON(含 schema 模板:题库等)与纯图片提字**都在这里。页面标题就是「内容提取 EXTRACT」(2026-10-12 按反馈去掉「PDF → Doc」的字样与预设矩阵:提取产物固定是 `<源名>.md / .html / .json`,输入决定走哪条链路,选预设没有实际效果)。
- **已实现(2026-10-12)**:PDF 走 pdf_tool(`pdf_to_doc.py`:自动 / MinerU / 文本 / 扫描视觉);Office / ODF / OFD / HTML / EPUB / **图片**走 DocVortex。产物按 §7 落在源文件旁:PDF 为 `<源名>.md|.html|.json|.audit.json` + `<源名>.assets/`(pdf_tool 的 `_doc`/`mineru` 命名在 runner 里改名并改写资产引用),其余为 `<源名>.md|.html|.json`。面板:PDF 模式选择、检测提取链路、最近任务、**结果预览**(Markdown 开头 1500 字 + 体检摘要)。**题库 schema 模板待接**。**产物复用(2026-10-12)**:同一份源 + 同一模式 / 模型再点「开始提取」时,直接复用已有产物(应用缓存里的标记记着源的大小 / 修改时间 / 模式 / 模型),只重跑很快的文字层互补 —— MinerU 云端排队实测 2 页 25 秒、7 页最长 20 分钟、107 页 73 秒,波动与页数无关,所以重跑不再等云端;换模式或改动了源文件才重新解析。
- **文本型 PDF 改为本地确定性提取(2026-10-12,用户反馈)**:此前「文本型」走 pdf_tool 的模型链路(分块 → 文本模型),跨页边界上的代码块会被拆散,而且不做页眉页脚 / 水印清理。新增 `main/pdf-text.js`:PyMuPDF 取结构化行(字体 / 字号 / 位置)→ 去掉跨页重复行、页码样式行、旋转水印 → 按字号判标题、按等宽字体判代码、按行距分块 → **跨页代码块续成一块**、跨页断句段落接回、断词合并(`de-` + `signed` → `designed`),中文行拼接不加空格 → 输出与其它链路同构的 Doc v1(产物仍是 §7 的 `<源名>.md / .html / .json / .audit.json`)。这条路径**完全本地**:不需要 pdf_tool checkout、不跑 OCR、不需要模型凭据;代价是没有 LaTeX 公式(公式仍走 MinerU 路线)。实测:自造「代码块跨页 + 页眉 + 页码」的 2 页 PDF → 代码块合成一块(换行缩进原样)、页眉页码全部去掉。
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
- **公式优先(可选,见 §8.1)**:扫描件公式多时,先经 pdf_tool(MinerU)提取 LaTeX,再转 HTML(`<script type="math/tex">`)交 DocVortex 生成 DOCX/EPUB —— 输出为真 OMML/MathML 公式。**结果按源文件缓存复用**(缓存目录里已有 Doc JSON 且比 PDF 新 → 跳过云端解析;换目标格式、重跑、电子书重试都走缓存,`refresh` 才重新解析):MinerU 云端排队波动很大(实测 7 页论文 20 分 49 秒、107 页教材 73 秒),而文字层校正 + 合并 + 出稿的本地耗时只有 ~0.2 秒/9 页。
- **解析方式四选一(2026-10-13 新增第 4 项)**:PDF 输入时——
  1. **本地解析(DocVortex,通用)**:它自己分类(文本型 → `txt`,乱码/扫描 → `ocr`);
  2. **文本型(本地 fitz)**:新增链路 `text-convert` = `pdf-text.js` 的确定性提取(先清页眉页脚 / 页码 / 水印,跨页代码块合并,图区裁成图片)→ 桥接 HTML → DocVortex 转任意目标格式。**不需要 pdf_tool / 凭据 / OCR**,秒级;没有 LaTeX 公式;
  3. **公式优先(MinerU 云端)**:真 LaTeX 公式,慢且计费;
  4. **公式优先(本地 MinerU 服务)**:同一个公式链路,但解析交给本机 `mineru-kit api-server`(**不出网、免凭据**)。面板「转换设置 → 本地 MinerU 服务」填地址(如 `http://127.0.0.1:8123`,存 `settings.mineruLocalUrl`),启动一次:`mineru-kit api-server --host 127.0.0.1 --port 8123 --tier standard --upload-dir <临时目录>`(务必给 `--upload-dir`,否则 blobs 落在启动目录)。
  面板里带「怎么选」提示:有公式的论文 / 教材 → 公式优先;试卷 / 公文 / 讲义 → 文本型;Office / HTML / EPUB → 本地解析。
- **pdf_tool 2026-10-13 更新(本地常驻服务 + 家具自动清理,已实测)**:交付说明 `pdf_tool/docs/reader-update-2026-10-13.md`;书坊侧的接入点:
  - **路由优先级(重要)**:`auto` = `MINERU_LOCAL_URL` > 云端 token > 本地 CLI。即机器上同时有 `MINERU_API_KEY` 时,**配了本地地址就走本地**;要强制云端用 `--mineru-source cloud`。书坊把设置里的地址以 `MINERU_LOCAL_URL` 传进子进程(公式优先 / 内容提取 / 向导都传,地址不进命令行),显式选了「公式优先(本地)」时还会加 `--mineru-source local`(本地不可用会报错,不静默换云端)。**先探测再传**:地址(配置的 / 继承的)先打一次 `/v1/health`,健康才交给 pdf_tool,不健康就**显式传空**并退回 CLI —— 否则进程里继承来的死地址会让 pdf_tool 硬连报「未能连接本地」。**两条本地方案都要把「本地 MinerU 程序」一并交出去**(`MINERU_LOCAL_CMD`):pdf_tool 的 helper 要靠它同目录的 python 进 MinerU venv,只给服务地址会报 `No module named 'mineru'`;服务没起来时它也正好是 CLI 的入口。另外给 pdf_tool 的 Python 进程设 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`,它的中文报错到书坊里不再是乱码。实测(真实 pdf_tool + 本地 MinerU,`CSP2021.pdf`,force):**服务在跑 → ok 13s**;**停掉服务 → CLI → ok 13s**。
  - **实测(同机,3 页 testpdf2)**:本地 CLI 21.6s(模型冷加载一次);常驻服务**冷 11.1s / 热 5.0s**(云端那次 260.8s,且云端会把整本解析完再筛页);产物与 CLI **逐项一致**(37 blocks / heading 3 · text 26 · image 8,audit ok);`doc.convert` JSON-RPC(pages 1-3 + mineru_url)也验证通过(1.6s 完成,`convert.done` 通知带 files/stats)。
  - **家具清理默认开、无开关**(`--clean-furniture` 不存在):水印(不透明度 ≤0.35,含旋转页)、跨页重复页边行(数字归一 ≥ 半数页、上下 10% 页边带,文档 ≥3 页才统计)、页码样式行、表格/代码护栏、倾斜文字不入正文;计数在 `stats.furniture`。实测 `CSP2021.pdf`:山西 / 页，共 / CCF CSP-J **全 0 残留**,代码样例一条不少。**经过 pdf_tool 的路径无需改动直接受益**;书坊的红标预清只留「不经过 pdf_tool 的 DocVortex 直连」那条(保持不动)。
  - **页码下传**:本地后端真正只解析指定页(实测 `pages=1-3` 只跑 3 页);**middle v2 文字层**:本地产物可作为 hybrid 文字层。
  - **服务随应用启动(2026-10-13)**:应用启动时按设置**自动拉起**常驻服务(「设置 → 书坊」里的「本地 MinerU 程序」+ 服务地址;面板勾选「启动应用时自动开启」,默认开、可关),退出时**只关自己拉起的那个**(手动起的服务只探测、不接管、不杀)。找不到程序时还会**自动找几处常见位置**:`MINERU_LOCAL_CMD`、sidecar Python 的同目录、pdf_tool 目录下的 `.venv/venv`。面板里有「**检测本地 MinerU**」(如实探测 `/v1/health`,不会偷偷启动)与「**启动服务**」两个按钮 + 状态行:运行中(版本 / 由应用启动 · 已在运行)/ 启动中…(首次加载模型约 10–15 秒)/ 未运行(可点启动)/ 没找到 mineru-kit(提示填程序路径)/ 启动失败(带输出尾部原因)。**控制台日志只写 ASCII**(Windows 终端默认 GBK,中文会乱码;找不到时会打印 `tried: <路径列表>`),中文提示只出现在面板状态行里。实测(真实 `mineru-kit`):`ensure` 到健康 **5.1s**(版本 4.0.12),重复调用不重拉,`stop()` 后端口关闭、再检测为未运行;单测覆盖 adopted / 启动 / ENOENT / 早退 / 外部地址 / autoStart=false 六种路径。
  - **缓存与清理**:`formula-cache`(公式优先的 MinerU 解析复用缓存)、`mineru-service`(常驻服务的上传目录)都在 `%APPDATA%\qiaomu-reader-desktop\` 下。面板里新增「**清理 MinerU 缓存**」:一键清并报告释放量,服务在跑时跳过上传目录并如实提示(停掉服务后可再清);手工清理就是退出应用后删这两个目录。`book-cache`(提取复用标记 / 文本型工作目录)与 `ocr-cache`(扫描件文字层缓存)不属于 MinerU,需要时单独删;`~\.cache\huggingface` 这类**模型**缓存别删(删了要重新下载)。
  - **一个上游限制(实测)**:MinerU 自己的 `middle_json` 保留完整(5 段样例),但它生成的 `markdown.md` / `content_list` 会丢**跨页程序**——`CSP2021.pdf` 的 5 段代码样例在 MinerU 产物里只剩 3 段,书坊的互补合并按块对齐、**补不回整块缺失**,而「文本型」5 段全在。所以试卷 / 程序类 PDF 建议用文本型(与面板提示一致)。
- **正文误判还原(2026-10-12,两栏论文实测)**:pdf_tool / MinerU 偶尔把**正文段落判成代码块**——`1.DUL+paper.pdf`(7 页 79 块)里有 2 个 `code` 块其实是正文,转换出的 HTML 因此把段落显示成 `<pre>`(两个 `<pre class="language-latex">`,里面还留着未转换的 `$…$`)。`formula-html.js` 的 `codeBlockHtml()` 现在按**内容**判断:去掉 `$…$` 后没有代码 / LaTeX 特征、有句子与足够词数就按段落渲染——硬换行并回一段(`for\n10 min` → `for 10 min`)、被断开的数字粘回(`61.\n91` → `61.91`)、段内公式照常转 `<script type="math/tex">`;真代码块保持 `<pre><code>`。内容提取的 `.md` 产物同样把这类无语言围栏拆回段落(`adoptPdfToolOutputs` → `unwrapProseFences`)。实测同一份论文:HTML 里 `data-block-type="code"` 2 → 0、段落 37 → 39、公式 73 → 89,标题 / 图片 / 字数不变。
- **caption 还原(2026-10-12,同一篇实测)**:这类误判块还带一个坑——MinerU 把**正文前半段放进了块的 `caption` 字段**(不是题注),而 MinerU 自己的 `.md` / `.html` 写作器都把 caption 丢掉,于是段落缺少开头(`In the experiments, the silicon wafer capped with a 4-μm thick SiO2 layer…` 整句不见了,输出直接从 `30 s to promote the adhesion…` 开始)。修法:渲染 `code` 块时把 **caption 与 content 合并**成一个段落(真代码块则把 caption 作为说明段放在 `<pre>` 之前),`image` 块的 caption 输出为 `<figcaption>`(DocVortex 转成 `image_caption`),`adoptPdfToolOutputs` 在拆「假代码块」**之前**先用 Doc JSON 把 caption 补回 `.md` 围栏内(这样向导 / 预览读的 `.md` 也完整)。实测同一份论文:段落仍 39、公式 89 → 91、字数 +827,两段开头都回来了。
- **文字层互补(2026-10-12,论文实测)**:MinerU 偶尔丢字/丢符号(实测:`at the speed of 3000 rpm for` 少了 `3000 rpm for`、`1 × 2 Y-branch` 少了 `×`、caption 被当成题注丢弃),而 PDF 自带文字层是逐字精确的(缺点是没有 LaTeX 公式、还混着页眉/水印)。新增 `main/text-layer.js`(PyMuPDF `page.get_text()`,结果写 UTF-8 文件——控制台编码会破坏 `ﬁ` 之类连字)+ `main/text-merge.js`,在「公式优先」链路里做**互补合并**:
  - **先去水印/页眉页脚**:按行统计,重复页数达到「页数 × 30%(至少 3 页)」的行视为页眉/页脚/水印删掉(只重复两三次的多半是正文里的公式或句子,保留);实测 `1.DUL+paper.pdf` 只删了 3 行(期刊页眉、IEEE 下载戳、running title),正文一行未动;107 页的物理教材因此不会误删正文公式。
  - **正文用文字层**:用「压缩键」(NFKC 展开连字、去空格/连字符/符号、小写;短键还要求词边界,避免 `30` 命中 `3000`)对齐;长段落按 ~8 词分块、对不上再二分;块与块之间的间隙正是 MinerU 丢掉的词,逐字补回。
  - **公式用 MinerU 的 LaTeX**:对齐出的公式位置照旧写 `<script type="math/tex">`;公式字形(如 `65 °C`)被跳过、换成 LaTeX,不重复;两边冲突时按「谁覆盖谁」择优,任一段对不上就整段回退 MinerU 原文(不猜、不造)。
  - **接入点**:`formula-convert`(格式转换的公式优先)在生成 HTML 前合并;`book-build`(电子书制作)提取 PDF 时用合并稿成书;`内容提取`(PDF)的 `.md` 产物也改写成这份合并稿(图片引用照 §7 改写为 `<源名>.assets/`),`.json` 仍是 MinerU 原始结构化记录。
  - 实测 `1.DUL+paper.pdf`:补回 `3000 rpm for`、`×`、`designed`(断词)、公式后的句号;79 块里正文块合并 35/39(4 个回退,回退块本身正文完好),14 个行间公式 + 40 个行内公式一个没丢;成品 HTML 段落 39、公式 91、图片 24 与纯 MinerU 版一致。
  - **多文件实测(2026-10-12,pdf_tool `test-docs` 的 6 份 PDF)**:R-D Background(9 页,合并 28/回退 5)、Plan and Methodology(7 页,50/1,净补 +57)、Q202607194(2 页,7/4)、DUL 论文(7 页,44/4,净补 +175 键字符)、TI+DMD(11 页,65/98)、kinetic theory 教材(**107 页**,649/95,净补 +81,**852 个行间 + 1045 个行内公式全保留**)。所有文件**"缩短"计数为 0**(没有任何正文块比 MinerU 更短 = 没丢字);回退块审计显示剩余缺口基本是页眉/版权脚注/公式字形/连字拆词,不是正文。
- **「清家具」的分工(2026-10-12,用户定调)**:页眉 / 页脚 / 页码 / 背景水印的清理**按链路分工**:
  - **经过 pdf_tool 的 PDF 链路**(内容提取 auto/mineru/vision、电子书制作向导吃 PDF、格式转换·公式优先)→ **交给 pdf_tool 侧统一清理**,书坊不做(需求文档:`pdf_tool/docs/reader-request-pdf-furniture-2026-10-12.md`,含实测证据与规则)。**pdf_tool 已实现并验证(2026-10-12,`pdf_tool` 仓库 `73ff357`,`extract/furniture.py`,四模式统一生效)**:水印走低不透明度文字集合,跨页重复行**数字归一**后 ≥ 半数页且在上下 10% 页边带才算,页码样式行整行匹配;实测识别 `CSP2021.pdf`(页眉 12 + 页脚 12 + 水印「山西」)、`1.DUL+paper.pdf`(期刊页眉 / IEEE 下载戳 / running title,13 行)、`kinetic theory` 107 页(页码 `– N –` 106 行,**重复公式行零误判**);真实链路 `pdf_to_doc --mode mineru` 跑 `CSP2021.pdf` 18 秒,产物里页眉 / 页脚 / 水印 **0** 残留,5 处 `#include <iostream>` 代码样例全部保留。书坊侧无需改动(清理在 pdf_tool 内部)。
  - **不经过 pdf_tool 的 PDF 链路**(格式转换·本地解析 = DocVortex)→ 书坊在喂给它之前用 `createPdfCleaner` **红标擦除**(文字 / 图片 / 矢量一起擦,文件名不变放缓存目录,失败回退原文件)。实测 `CSP2021.pdf`:擦除 24 处(12 页眉 + 12 页脚),DocVortex 产物里页眉页脚出现次数 24 → **0**,正文完好。
  - **「文本型 PDF」提取**(书坊自己的 fitz 链路)→ 自己按规则**跳过**家具行,详见下条。实测 `CSP2021.pdf`:48 处家具(12 页眉 + 12 页脚 + 24 行 100pt/opacity 0.1 的「山西」水印)全部跳过,5 处代码样例与标题行保留;`kinetic theory` 107 页只剔除 106 行页码,重复公式行全部保留。
  - **非 PDF(Office / ODF / HTML / EPUB / OFD)**:DocVortex 自己会读 docx 的 header / footer 部件并按其 reading-order 规则排除(实测:带页眉的 docx → 产物里页眉 0 次、正文完整);OFD 等以内容形式绘制家具的格式暂无专门处理(按需再加)。
  - 判定规则(`pdf-text.js` 的 `furnitureMatcher`):旋转文字(水印)、**整行是低不透明度文字**(`get_texttrace()` 里 opacity ≤ 0.6 的 span:实测 CSP2021 是 100pt / 0.1 的「山西」,noip1 是 120pt / 0.5 的「江西」,横向也认)、**在上下边缘(各 8%)且跨页重复 ≥ max(2, 页数×30%)** 的行、**在上下边缘且样式像页码**(纯数字 / 罗马数字 / 「第 N 页(共 M 页)」/「N / M」/「Page N of M」,容忍全角标点)的行;正文里重复出现的代码行、正文里的独立数字行(题号)都不会误删。
- **图(2026-10-12,「文本型」新增;用户选定)**:矢量线画与内嵌图片在提取时**裁成图片**,图区内部的零散文字(如试卷里无向图的节点标签 a–e)并入图片,不再作为正文打断段落 / 代码块。判定(`PDF_TEXT_SCRIPT` 的 `figure_regions`):绘图元素按 6pt 聚成区域后要求 **≥24×24 且 ≥5 条路径**(填空下划线 / 表格线只有 1–4 条)、**不是两个方向都有贯穿线的表格**、也不是宽扁条(≥200 宽且 <30 高);内嵌图片要求 ≥64×32、占页 ≥4%、不在上下 8% 页边带、不整页(扫描页),且不与线画区重叠。线画图渲成 PNG(3×),照片类图按内嵌像素定倍率(≤2.5×)存 JPEG。**裁图前先在内存里把水印擦掉**(低不透明度文字按字符红标删除:只删这层文字,图片像素与线画都保留,pdf 不落盘),水印不会烘进裁出的图片;已经印进图片像素里的水印(翻拍 / 扫描图自带)去不掉。产物:`<源名>.assets/fig-p<页>-<序号>.png|jpg` + `.md`(.html 同理)里的图片引用,`.json` 里是 `image` 块;提取 mark 带版本号(提取器行为一变,旧产物不再复用)。实测:`CSP2021.pdf` 裁出第 14 题无向图(11 KB PNG,节点标签完整)且 `e a` / `d c b` 从正文消失、跨页代码块保持完整;`noip1.pdf` 裁出树图与两张装置图(56 KB),**水印「江西」既不在正文、也不在裁出的图里**;`kinetic theory` 107 页裁 14 张图(246 KB);`CSP2020 / CSP2019`(扫描件,整页图)0 张、报价单(`Q202607194`)表格 0 张(表格线被排除)、`math-deep-*` 公式页 0 张;R-D / Plan / DUL / TI+DMD 裁出论文里的装置照片与框图(248–1141 KB,JPEG)。
- **两处产物问题修复(2026-10-13,用户实测)**:① **资产并入**:同一份源第二次提取时 `<源名>.assets/` 已存在,原来会跳过 `mineru/` 直接让产物的 `<源名>.assets/images/<hash>.jpg` 链接指空(实测 `CSP2021` 的 MinerU 产物图是破的,而这次生成的图就压在源目录的 `mineru/` 里);现在改成**把新资产并入既有目录**(图名是内容哈希,不会互相覆盖)再清掉 `mineru/`,链接一律指向真实存在的文件。② **KaTeX 兜底**:`throwOnError: false` 不会抛错,而是把 `ParseError: KaTeX parse error: …` 当正文画出来(实测 MinerU 把试卷里的程序表达式误当公式,`\texttt { \theta }` 这种在文本模式下非法);现在解析失败就回退显示原文 `$…$`,预览与正文都不会再出现报错文本。
- **跨页代码合并(2026-10-13,用户实测)**:MinerU 按页切块,一段程序跨页时会被切成两个相邻的 md 围栏(第二段通常从行号继续,如 `22 memset…`),看起来像「没整块提取出来」。新增 `joinSplitCodeFences()`(`shared/markdown-fix.js`,提取 / 向导的 md 都过):中间**只能有空行**、两段都是**无语言标记的裸围栏**、第二段首行以行号开头,且**行号连续**(第一段末尾也带行号时要求 +1,否则不动)—— 满足才并回一段,跨三页也能接上;有文字/题目标签隔开、带 ```` ```cpp ```` 语言标记、行号不连续的一律不动。实测 `CSP2019.md`:最后一段程序的两个围栏并回一段(围栏 10 → 8)。**注意**:OCR 丢的空行(如 24/29)与第一段缺失的行号是 MinerU OCR 的损失,合并救不回来;扫描件想要行号与空行完整,可在「文字层」导出可搜索副本后再用文本型提取(前提是该文字层不是纯 OCR 单字体)。
- **转换矩阵回归(2026-10-13 进仓库,`npm run desktop:matrix`)**:DocVortex **10 源**(docx / rtf / odt / html / htm / mhtml / csv / tsv / epub / pdf)× **5 目标**(md / html / tex / docx / pdf)= 50 组,文本型 PDF × 5 目标 = 5 组,内容提取(docx、PDF 文本型、PDF MinerU)= 3 组,图片 → CBZ = 1 组,Calibre(检测 + azw3 / mobi / epub)= 4 组 —— **63 组全绿**(0 失败 0 跳过)。每组都校验「产物存在 + 含源标记」:md/html/tex 读文本、docx 读 `word/document.xml`、pdf 读文字层、epub 解包搜 xhtml、azw3/mobi 查体积(二进制)。开关:`QBR_MATRIX_MINERU=1` 追加 MinerU 提取、`QBR_MATRIX_ONLY=dv:docx->pdf,pdf-text->docx` 只跑指定组合、`QBR_MATRIX_PDF=<file>` 换样张;DocVortex / pdf_tool / Calibre 缺谁就 SKIP 谁。**不覆盖**:版式 / 图片 / 公式的保真度(那部分靠 e2e 场景与公式链路的 OMML/MathML 专项断言)。
- **格式转换全面测试(2026-10-12,15 组互转 + 命名 + 错误路径)**:docx / pdf / epub / html / csv × md / html / tex / docx / pdf 全绿(docx → 5 种目标各 2–4 秒,epub / pdf 各 1–3 秒);过程中发现并修掉两个真问题:  - **表格**:DocVortex 的 DOCX 渲染器**无法从 HTML 物化表格**(直接报 `HTML table cannot be materialized and has no image fallback`),PDF 渲染器则**静默丢掉表格内容**。新增目标感知的 `tableModeFor()`:`docx` / `pdf` 目标把表格换成 MinerU 的**表格截图**(Doc JSON 自带 `image`),`html` / `latex` 目标仍输出真 `<table>`。实测 2 页报价 PDF:改前 DOCX 报错、PDF 里搜不到表格文字;改后 DOCX 178KB(内嵌 3 张表格截图)、PDF 285KB、HTML 3 个真表格。
  - **本地文件同名覆盖**:渲染层的同名判断只查**书库**(本地文件永远判不到),会静默覆盖已有产物。新增 `main/paths.js` 的 `uniqueFile()`,接入 `docvortex-convert` / `formula-convert` / `ebook-convert` 三个 runner;实测同一份本地 PDF 连转两次 → `报价单.md` + `报价单 (1).md`,两个文件都在。
  - 顺带:Markdown 的**管道表格**现在渲染成真表格(`text-book.markdownToHtml`:缺格补空、单元格里的公式照常渲染;此前是带竖线的段落),`book-styles` 配了表格样式。
  - 已知上游限制:DOCX 里的表格只能是截图(DocVortex 渲染器限制);转换 HTML 时若同目录缺图片资源 DocVortex 会报错(资源放好即可,任务会记录错误);**DocVortex 会把含 `++` 的普通文字误判成公式裁成图片**(实测 `CSP2021.pdf` 的选项 "A. C++" 变成 `images/page_0_equation_6.jpg`),而且**它的 PDF 路径没有「图 → LaTeX」的后续识别**:公式条目虽然有 `equation_latex` 槽位,但只由 Office 原生格式(docx OMML / 旧 .doc 的 MTEF 对象)或我们桥接的 `<script type="math/tex">` 填充,它自己的说明是 "Vector-only page preserved as an image; no text recognition was performed" —— 也就是说 **DocVortex 负责「消费」LaTeX,不负责「生产」LaTeX**(生产靠 MinerU 的公式模型)。这类试卷 / 公文用「文本型」最稳(本地、不会把文字变图片);真公式用「公式优先」;**图片 → PDF** 已实现(2026-10-14,格式转换的预设卡)。

### 5.4 电子书制作(向导,主输出 EPUB)

**布局(2026-10-18)**:单列向导——① 内容 → ② 目录 → ③ 书名与封面 → ④ 排版样式 → 生成 EPUB。**右侧实时预览列已移除**(用户要求:预览没用;见 `docs/workshop-implementation.md` 的 2026-10-18 减法条目)。

**面板预设(计划中,2026-10-12 起不在向导面板重复展示)**:PDF → 干净电子书;Markdown / HTML → EPUB;txt → EPUB;Office / OFD → EPUB;**EPUB → AZW3 / MOBI**;图片 → CBZ / EPUB——源已全部接入后,这些都在「电子书制作」向导里直接完成(非文本源由向导内部自动提取/转换)。**所有电子书产物统一在这里。**

**源已全部接入(2026-10-12)**:书稿选择接受 **txt / Markdown / PDF / Office(docx/pptx/xlsx…)/ ODF / OFD / HTML / EPUB / 图片**;**非文本源在生成时由向导内部自动提取**(PDF 走 pdf_tool,其余走 DocVortex,中间产物放 `userData` 缓存,用户无感),提取出的 Markdown 按 1–3 级标题分章。

**已实现(2026-10-12)**:
- 「**电子书互转(EPUB → AZW3 / MOBI)**」(Calibre `ebook-convert`,检测 + 路径设置 + 检测按钮)与「**图片 → CBZ / EPUB**」(CBZ 自己打包:自然排序、同名序号;EPUB 由 CBZ 经 Calibre 转);产物落在源文件旁。
- **EPUB 构建器(W1-2)**:txt / Markdown → 章节(识别「第X章/回/卷」等标题,无标题按长度分块;Markdown 渲染标题/列表/引用/代码/图片/链接/强调)→ 单栏流式 CSS(缩进/段距/标题对齐 + 字号/行距/边距/对齐的默认基线)→ EPUB 3(mimetype 存储、container、OPF 元数据、nav + NCX、封面页、版权页)。**字体子系统已移除(2026-10-18)**:~~乔木封面字库按需下载 + 子集化嵌入(`pyftsubset`,OFL 随包)~~ —— 不再下载/嵌入字体(字体交给阅读器自带),实测 txt → epub 从 ~78KB 降到 55KB。
- **向导 UI(W1-3,已实现 2026-10-12;2026-10-18 收敛)**:「快速成书」面板 = 书稿选择(**txt / Markdown / PDF / Office / ODF / OFD / HTML / EPUB / 图片**,书库或本地)→ 书名/作者 → 目录编辑 → **排版三项(首行缩进 / 段间距 / 标题对齐)** → 生成 EPUB(走任务队列);样式持久化在本地。~~字体搭配 / 字号 / 行距 / 边距 / 主题 / 对齐控件、iframe 实时预览~~ 已按用户要求移除(那些项由阅读器自己的阅读设置决定)。
- **封面(已实现 2026-10-12)**:三选一——**模板生成**(1600×2400 离屏渲染,配色 暖纸/纸白/青瓷/夜墨,标题/副标题/作者)、**指定图片**(nativeImage 统一转 JPEG)、**自动**(Markdown 首图,缺图回退模板)。~~面板内 176×264 缩略图实时预览~~ 随预览列一起移除(2026-10-18)。
- **目录编辑(已实现 2026-10-12)**:选中书库书稿后自动分章并列出(序号 / 标题输入框 / 字数),可**改名、合并(与下一章)、拆分(段落中点)、上下排序**;编辑后的章节列表随 `book-build` 一起提交(runner 优先使用面板目录)。本地文件在生成时自动识别目录。
- **面板重排 + 成品质量修复(2026-10-12,用户反馈)**:面板改成**一条主流程 + 更多工具**——主流程是向导四步(① 内容 → ② 目录 → ③ 书名与封面 → ④ 排版样式 → 生成 EPUB)~~,右侧全程预览~~;「EPUB → AZW3 / MOBI」「图片 → CBZ / EPUB」「Calibre 设置(折叠)」收进「更多工具」;向导上方的预设矩阵撤掉(任何受支持的输入都直接在向导里成书)。同时修掉三类成品问题:
  - **图片**:章节 HTML 引用的本地图片(`mineru/images/*.jpg` 这类提取产物)按提取目录解析后**嵌入 EPUB**(`images/image-N.*`;缺失或不支持的格式丢弃并记日志),成品不再出现破图;支持 png / jpg / jpeg / gif / svg。
  - **公式**:正文里的 `$…$` / `$$…$$` / `\(…\)` / `\[…\]` 收集去重后用 Python `latex2mathml` 一次转成 **MathML**(行间公式标 `display="block"`),失败时保留原 LaTeX 文本、不阻断出书;实测用户论文 34 条公式全部转换(章节里 37 处 `<math>`,0 处遗留 `$…$`)。
  - **假代码块**:MinerU 偶尔把正文段落包进没有语言标记的围栏(段里的公式因此不渲染),`shared/markdown-fix.js` 的 `unwrapProseFences()` 把这类「像正文」的围栏拆回段落(真代码块保留);向导读 Markdown 源、内容提取的向导路径与预览都先过这一层。
  - **预览不乱码**:预览只把 txt / md 当文本读(Markdown 渲染后显示);非文本源优先读同目录「内容提取」产物 `<源名>.md` 并标明来源,没有就显示示例文字 + 「生成时自动提取」提示——二进制文件不再按文本读。
- **图片提取(2026-10-12 修复)**:DocVortex 的 `convert` 只收文档(直接给图片会报 `Unsupported native input format: jpeg/png`,加 `--parse-mode ocr` 也不行),图片改为**先用 Pillow 合成单页 PDF** 再走它的本地 OCR(`--parse-mode ocr`,临时 PDF 跑完删除);内容提取面板与向导的图片源都走这条路。
1. **内容源**:书库里的书 / **PDF、Office 文档(docx/pptx/xlsx…)** / **txt 纯文本** / Markdown / HTML / 图片文件夹 / 已提取的 Doc。**定位**:提供内容 + 加样式(原版式不保留);**PDF/Office 等非文本源由向导内部自动先做提取/转换(内容提取、DocVortex),中间环节用户无感**——向导里只呈现「内容预览 → 样式/封面/目录 → 生成」。
2. **元数据与封面**:书名/作者/语言/丛书/标签(「AI 推断」从正文补全);封面三选一——① **指定图片**(书库/本地);② **自动**(书内首图或首页渲染);③ **模板生成**(标题+作者+副标题,可选配色/纹理/首图,输出 1600×2400);「AI 封面文案」给标题/副标题/系列;封面预览实时可见。
3. **章节**:按标题自动分章(1–3 级可选);可改名/合并/拆分/排序,显示字数;「**AI 建议分章**」在标题缺失时推断结构;右侧预览目录(nav/NCX)。
4. **样式**(2026-10-18 收敛为三项:缩进 / 段距 / 标题对齐,见下「字体与排版」):~~字体(内置字体 + 系统)、字号、行距、段首缩进、页边距、标题风格、对齐、主题(跟随阅读主题 / 纸白 / 暖纸 / 青瓷 / 夜间)、代码块与引用样式;默认值可用,高级折叠;右侧样张实时更新,可切换**手机/平板/桌面**宽度与明暗。~~

**字体与排版(2026-10-12 定调;2026-10-18 减法)**:
- **版式**:单栏流式(EPUB reflow),不做固定版式;新章起新页,图片居中自适应;标题层级由 CSS 控制(不写死字号)。~~预览与成品共用同一份 CSS~~(预览已移除)。
- ~~**字体来源**(乔木封面字库按需下载 + SHA-256 校验 + `userData/font-cache`)、**字体搭配**(12 套 pairing)、**EPUB 嵌字**(`pyftsubset` 子集化 → TTF,改名 `QBR <字体名>`,OFL 随包)~~ —— **字体整套移除(2026-10-18)**:不再下载、不再嵌入,字体交给阅读器自带(封面改用系统字体栈);留档见 `docs/workshop-implementation.md` 的 2026-10-18 减法条目。
- **样式设置(2026-10-18 收敛:面板只留三项)**:
  - 面板:**段首缩进**(默认 2em)/ **段间距** / **标题对齐**(左 / 居中)
  - 书里仍写入一份完整默认基线(字号 17px、行距 1.75、边距 5%、两端对齐、不写颜色),供 Kindle / Apple Books 等**外部阅读器**首次打开时使用
  - **字号 / 行距 / 边距 / 对齐 / 主题不再放面板**:这些「阅读器说了算」的项会被 UV Reader 自己的阅读设置覆盖(`reader-appearance.js` 用 `!important` 盖正文排版,foliate 分页器还会强制 `body{margin:0}`)——摆出来只是「按了没反应」的控件(用户实测反馈)。字体搭配与主题已在 2026-10-18 的减法里移除。
  - 中文排版细节(标点挤压、避头尾)交给阅读器,不写复杂 CSS;缩进只用 `text-indent`。
- **后续(不在本阶段)**:~~阅读器的字体列表也可接入同一字库~~(字库已整体移除);导入字体与「用户自行安装」的说明见 `fonts/README.md`。
5. **生成**:EPUB(主输出);可选同时导出 Markdown/HTML;可再转 AZW3/MOBI(Calibre);生成后可直接「发送到 Kindle」。

**LLM 辅助任务**(全部可选、可撤销,复用伴读 AI 配置):AI 清理(OCR/断行/漏标题)、AI 分章建议、AI 元数据推断、AI 封面文案;进任务队列显示进度,失败不影响手动流程。

**批量**:多本排队,共享元数据与样式模板。

### 5.5 任务队列

- 统一任务模型:`{id, 类型, 输入, 状态(排队/运行/完成/失败/取消), 进度, 产物, 错误}`。
- 交互:底部任务条(运行中 + 最近 3 条);展开列表(最近 20 条);取消、失败重试、完成 toast;历史落盘(不自动续跑)。

### 5.6 发送到 Kindle(邮件直发)——**已移除(2026-10-18)**

> **2026-10-18 按用户要求整条移除**:SMTP 配置繁琐、功能鸡肋。删掉的范围:UI 工具与面板、设置页 SMTP 段、`main/kindle-send.js`、两个 IPC 与 preload 桥、单测与 e2e 断言;左侧栏 6 个工具变 5 个。要恢复看 git 历史 `de2afc8` 与 `docs/workshop-implementation.md` 的 2026-10-18 条目。
> **保留**:EPUB → AZW3 / MOBI(Calibre,格式转换,不是发送)。

~~**可行性**:Amazon「Send to Kindle」邮件通道**原生支持 EPUB**(官方支持列表:PDF/DOC/DOCX/TXT/RTF/HTM/HTML/PNG/GIF/JPG/JPEG/BMP/**EPUB**),无需转换 Kindle 格式。所以只要配置一个发件邮箱即可。~~

**Amazon 侧前置条件(设置页给出引导)**:

- 在 `管理我的内容和设备 → 首选项 → 个人文档设置` 找到 **Send to Kindle 邮箱**(`xxx@kindle.com`);
- 把发件邮箱加入**已批准的个人文档电子邮件列表**(最多 15 个);
- 限制:单封邮件**最多 25 个附件、总计 ≤ 50 MB**(超出可打 ZIP,Amazon 会自动解压;>50MB 时应用自动打包);附件为受支持格式即可;投递最长尝试 60 天。

**应用内设计**:

- 入口:~~书坊 →「发送到 Kindle」(已落地)~~(已移除);书库书卡右键与「电子书制作完成后一键发送」从未实现。
- 面板:选择文件(书库勾选 / 本地文件,就地处理)→「发送到 Kindle」;结果进任务队列(任务行显示送达地址与附件名)。多个文件自动打包 ZIP(Amazon 会自动解压),打包后仍 >50MB 直接拒发并说明。
- 设置(统一在 **设置 → 书坊** 的「发送到 Kindle」段):Kindle 收件地址、SMTP 服务器、端口(465 SSL / 587 STARTTLS)、账号(完整邮箱)、发件地址(留空用账号);**「检测 SMTP」**走 `transporter.verify()`(只建连认证,不发信,结果原地显示)。收件地址目前单个(多地址分割后续再补)。
- 密码用桌面壳的 **safeStorage/SecretStorage** 保存(与 AI 密钥同一机制),**不落明文设置**:设置页密码框「已保存;留空不修改」,发送/检测时由主进程从密文里读。
- 失败处理:把 SMTP 错误翻译成可读提示(认证失败/授权码、连接被拒、大小超限、附件格式不支持);提示检查「已批准发件人列表」。

**实现**:主进程 `apps/desktop/src/main/kindle-send.js` + `nodemailer`(纯 JS,Electron 主进程可用);IPC `qbr:kindle:probe` / `qbr:kindle:send`(直连,设置页检测用)+ 任务队列 runner `kindle-send`(面板发送用,`qbr:workshop:start`);非桌面宿主不提供(桌面壳专有)。单测用真实 SMTP mock 服务器跑完整会话(单附件原字节、多文件 ZIP 解包核对、超限拒发、错误映射、检测)。

**两条路都保留** ~~① **邮件直发 EPUB**(推荐,最省事,本功能)~~(已移除);② **EPUB → AZW3/MOBI**(Calibre,给 USB 拷贝、其它阅读器或离线场景)保留。

## 6. 技术架构

- **页面**:`views.js` 新增 `createWorkshopView`(视图 `qbr-workshop`)+ 导航路由 `workshop`;窄窗口抽屉沿用书库方案。
- **主进程**:`apps/desktop/src/main/workshop.js` 任务执行器 + IPC `qbr:workshop:*`(start/cancel/list/状态事件);产物写库内目录(沿用 `resolveOcrOutput` 的库内校验)。~~发送到 Kindle 用 `apps/desktop/src/main/kindle-send.js`(nodemailer,SMTP)~~(已移除 2026-10-18)。
- **后端解析(与 OCR 设置同规则:exe 优先 → Python 目录 → 环境变量)**:
  - `pdf_tool.reader`(sidecar JSON-RPC):文字层、可搜索 PDF、`doc.convert`;
  - `docvortex`(CLI/Python SDK):文档互转;`pip install docvortex`(MIT);
  - **Calibre(CLI 形式,外置进程)**:`ebook-convert` / `ebook-meta`,main 进程 spawn;检测顺序=设置自定义路径 → 常见安装位置(`C:\Program Files\Calibre2\ebook-convert.exe`、macOS `calibre.app/Contents/MacOS/`、PATH)→ 未找到给出下载引导;常用参数 `--title/--authors/--cover/--language/--publisher/--series/--tags`、`--chapter "//h:h2"`、`--toc-threshold`、`--extra-css`、`--base-font-size`;EPUB→AZW3/MOBI 同命令换扩展名。体积大且 GPL-3,**不随包分发**;未安装时 EPUB 用 **EbookLib** 兜底构建(备选,AGPL,需评估);
  - 备选 `EbookLib`(纯 Python):需要完全内置的 EPUB 构建时使用。
- ~~**预览渲染**:壳内 iframe 渲染章节 HTML,内嵌与 EPUB 相同的 CSS(样式控件改动即时重渲染);Markdown 预览复用现有 sanitize/render 管线;EPUB 仅在「生成」时构建,预览不落盘。~~(预览已移除 2026-10-18)
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
- DocVortex 侧:扫描件 OCR 路径把 `display_formula` 当**截图**保留、行内公式走 PP-OCRv6 纯文本(上下标被拉平);原生 PDF 路径有公式检测(按字形几何,`analyzers/native/pdf/formulas.py` + `inline/scripts.py`);HTML/XHTML 输入识别 MathML、`<script type="math/tex">`、`data-tex` 等(`content/markup/formula.py`);DOCX 输出为真 OMML 公式(`render/_internal/docx/math.py`)。注意 0.5.16 的 Markdown/txt 输入**不是原生输入**(直接给 `.md`/`.txt` 会报 `Unsupported native input format: markdown|txt`;`schema.py` 的 `FileSuffix` 里没有它们)——书坊侧已桥接(2026-10-17):格式转换 / 内容提取先渲染成 HTML(见 `main/docvortex.js` 的 `textSourceHtml`,公式写成它认的 `<script type="math/tex">`、图片相对路径,桥文件落在源文件旁、跑完即删),所以上游这条只是「少一次桥」,不再是阻塞项。
- **实测桥**(`%TEMP%\dv-math-html`):LaTeX 包在 `<script type="math/tex">`(行内)/`<script type="math/tex; mode=display">`(行间)的 HTML → `docvortex convert --format docx`:7×`m:oMath`、3×`m:sSub`、2×`m:sSup`、2×`m:f`;`--format epub` 输出 MathML(`msub`)。MathML(经 latex2mathml,docvortex 自带依赖)同样可行。
- **实施 A(不改 DocVortex,已实现 2026-10-11)**:书坊「文档互转」增加**解析方式 = 公式优先(MinerU 云端,PDF)**;链路 = pdf_tool(`pdf_to_doc.py --mode mineru --formats json`)→ Doc v1 JSON → 带公式标记的 HTML → DocVortex → DOCX/EPUB/PDF。桥放在本仓(`apps/desktop/src/main/formula-html.js` 纯函数 + `workshop-formula.js` runner),pdf_tool 保持不动;每个源文件一个稳定缓存目录(重复转换复用 MinerU 产物),任务标签随阶段推进(MinerU 云端解析 → 生成公式 HTML → DocVortex 转换)。实测:14 页扫描件 → DOCX **197 个 OMML 公式(96 下标 / 52 上标)**;e2e `workshop-formula` 默认跳过(计费云服务),`QBR_E2E_MINERU=1` 才跑。**凭据来源**:面板「MinerU 凭据」→ 进程环境 `MINERU_API_KEY`/`MINERU_TOKEN` → Windows 注册表(用户/机器级,免重启;变量设好后应用没重启也能用);凭据经子进程环境传入 pdf_tool,不出现在命令行。
- **实施 B(上游/分支,终局;备忘见 `docs/docvortex-formula-upstream.md`)**:给 DocVortex 的 OCR 路径加**公式识别模型**(PP-FormulaNet / UniMERNet ONNX,与现有 PP-DocLayoutV2 / PP-OCRv6 同族),把 `display_formula` 截图与行内公式区域变成 LaTeX;顺带支持外部文本源(MinerU layout.json / vision 结果)与 Markdown 输入。优势:离线、无配额、单工具一条命令、文件不出本机;代价:改第三方包(PR/分支)、行内公式检测工作量大、模型质量上限仍不如 MinerU 的 VLM。当前**决定:采用 A,B 仅作备忘**(触发条件见备忘 §6)。
- **A-local(本地 MinerU,由 pdf_tool 侧实现)**:离线版 A——pdf_tool 增加 `--mineru-source auto|cloud|local`(本地 `mineru` CLI / `mineru-api` HTTP / OpenAI 兼容端点),档位 basic/standard/advanced,**输出契约不变**(同构 Doc JSON → 书坊桥与 DocVortex 零改动)。需求已交给 pdf_tool:`pdf_tool/docs/reader-request-mineru-local-2026-10-11.md`(接口建议、验收、硬件参考、书坊后续:解析方式加「公式优先(MinerU 本地)」)。本机可行:RTX 4060 Laptop 8GB 单并发,2–6s/页;模型 `MinerU2.5-Pro-2605-1.2B`(2026/06;Apache-2.0 系许可)。
- 顺带发现(pdf_tool 侧,未改):`render/md.py: render_html_blocks` 没有 `equation` 分支,公式块在它的 HTML 预览里被丢弃 —— 与书坊链路无关(桥不走它),但值得以后补一行。
- 不采用:把 pdf_tool 的 hybrid 双层 PDF 再喂给 DocVortex —— 文字层公式已转 Unicode、字形几何是合成的,原生路径还原不出上下标结构。
- **列表保真度(2026-10-17 实测)**:DocVortex 的 HTML→DOCX 把列表画成「`w:t` 里的字面 `1. ` / `- ` + 段落 `w:ind` 缩进」,整份文档 `w:numPr = 0`(同一产物里表格倒是真 `w:tbl`)—— Word 里不能续编号 / 改项目符号样式 / 升降层级。书坊在 **md/txt → docx** 这条链路上自己补:`main/docx-numbering.js` 识别这类段落、去掉字面标记、写 `w:numPr` 并往 `numbering.xml` 追加 abstractNum/`w:num`(层级缩进 340×n、原文起始号用 `startOverride` 保留,跳号的有序列表不动)。缩进与原来一致,编号变成 Word 自己的。

## 9. 文案与 i18n

新增约 40 个 key(`nav-workshop`、`workshop-*`、`tool-*`、`status-*`、`audit-*` 等),9 语言同步,沿用 `npm run check:i18n`。

## 10. 分期

- **P0**:页面 + 导航;文字层 / 可搜索 PDF(批量,`.uvtext.pdf`);PDF → Markdown/HTML(pdf_tool);文档互转(DocVortex:docx/ppt/odt/html/epub/mhtml/ofd → md/html/docx/pdf);任务队列。
- **P1**:电子书制作向导(**实时预览 + 样式 + 封面 + 目录**;Calibre → EPUB);**发送到 Kindle**(SMTP + 设置 + 右键/书坊入口);**EPUB → AZW3/MOBI**(Calibre,与直发并存);PDF → EPUB(先提取再制作);图片 → PDF/CBZ;DOCX → EPUB。
- **P2**:**LLM 辅助**(AI 清理 / AI 分章建议 / AI 元数据 / AI 封面文案);批量制作与元数据/样式模板;~~Markdown → EPUB、EPUB → Markdown~~(✅ 已具备:向导吃 md/txt、格式转换吃 EPUB→md;2026-10-18 补「EPUB → Markdown」预设卡);EbookLib 内置构建(可选);题目抽取(后续)。

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
8. ~~**发送到 Kindle**:走 Amazon 邮件通道,EPUB 直发;应用内配置 SMTP(授权码/应用密码走 safeStorage)与 Kindle 地址,含「测试连接」与失败提示;Amazon 侧需把发件邮箱加入「已批准的个人文档电子邮件列表」,单封 ≤25 附件 / ≤50MB(超出自动 ZIP)。~~ **已移除(2026-10-18)**。
9. **EPUB → AZW3/MOBI 转换同时保留**(Calibre,USB 拷贝/离线/其它阅读器场景),与「发送到 Kindle」并存,不做二选一。
10. ~~**预览与样式**:向导右侧实时预览(壳内 iframe + 与 EPUB 相同的 CSS),样式/封面/目录改动即时可见;EPUB 只在「生成」时构建。~~(预览与"阅读器说了算"的样式控件已移除 2026-10-18:面板只留缩进 / 段距 / 标题对齐)提取结果仍提供 Markdown/HTML/JSON 预览与结构树。
11. **LLM 辅助**:AI 清理(OCR/断行/漏标题)、AI 分章建议、AI 元数据推断、AI 封面文案等复杂任务,复用现有 AI 配置;全部可选、可撤销、失败不阻塞手动流程。
12. **Calibre 集成形式**:外置 **CLI 进程**(`ebook-convert`/`ebook-meta`),检测顺序=自定义路径 → 常见安装位置 → PATH,未找到给下载引导;体积大且 GPL-3 不随包分发,未安装时用 **EbookLib** 兜底构建 EPUB。

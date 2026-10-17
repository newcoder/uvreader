# 书坊实施计划

> 配套设计:`docs/workshop.md`(页面/工具/架构)与 `docs/workshop-preview.html`(交互预览)。
> 阶段:P0 骨架与基础工具 → P1 制作向导与发送 → P2 LLM 辅助与批量。每阶段独立可发布。

## 1. 交付物与范围

- **P0(0.4.0)**:导航页「书坊」+ 任务队列 + 文字层/可搜索 PDF + 文档互转(DocVortex)+ 产物命名/同名覆盖。
- **P1(0.5.0)**:电子书制作向导(实时预览/样式/封面/目录)+ 发送到 Kindle + EPUB→AZW3/MOBI + PDF→EPUB + 图片→PDF/CBZ。
- **P2(0.6.0)**:LLM 辅助(清理/分章/元数据/封面文案)、批量与模板、Markdown→EPUB、EPUB→Markdown、EbookLib 内置(可选)、题目抽取(后续)。

非目标见 `docs/workshop.md` §11(不做 EPUB 编辑器/在线发布;Obsidian 端不提供书坊)。

## 2. 新增与改动模块

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 页面骨架 | `apps/desktop/src/renderer/views.js`(+`createWorkshopView`)、`entry.js`(路由/工厂)、`index.html`(导航)、`base.css` | 左栏工具组 + 右栏面板 + 底部任务条;三页命名与 Logo 见设计 §2.1 |
| 任务队列 | 新 `apps/desktop/src/main/workshop.js`;`main/index.js`(IPC);`preload/index.js`(`workshop.*`) | 模型/串行队列/取消/重试/历史落盘;事件推送 |
| 文字层 | 复用 `main/pdf-ocr.js`;`main/index.js` 增 `qbr:workshop:*` 包装 | 批量 cache/export,`.uvtext.pdf`(源文件旁,同名覆盖) |
| 文档互转 | 新 `main/docvortex.js` | 检测(PATH/python -m/自定义路径)、命令构建、输出入库 |
| EPUB 制作 | 新 `main/epub-build.js`、`main/calibre.js`、`main/cover-render.js` | 章节 HTML+CSS+封面+元数据→Calibre;EbookLib 兜底 |
| 发送到 Kindle | 新 `main/kindle-send.js`(+`nodemailer` 依赖) | SMTP、授权码走 SecretStorage、≤50MB 自动 ZIP |
| 预览 | `views.js` 向导内 iframe(blob URL)+ 同一套 CSS | 样式改动即时重渲染;预览不落盘 |
| 设置 | `packages/reader/src/settings-tab.js`(书坊/发送到 Kindle 段)+ i18n ×9 | DocVortex 路径、Calibre 路径、SMTP、默认 Kindle 地址 |
| 命名助手 | `packages/reader/src/library-data.js`(复用 `freeBookPath`)或新 `workshop-names.js` | `.uvtext.pdf`(扩展名不变,同名覆盖) / 扩展名变化直接换后缀 / 冲突编号 |

## 3. 任务分解

### P0

| ID | 任务 | 主要文件 | 验收 | 测试 | 规模 |
| --- | --- | --- | --- | --- | --- |
| W0-1 | 导航与页面骨架:悦空间/书库/书坊/设置,内联 SVG 图标,路由 `workshop`,左栏五组+任务条 | `index.html`、`entry.js`、`views.js`、`base.css` | 三页可切换;书坊页可见;窄窗抽屉;导航记忆 | e2e `workshop` 场景 | M ✅ 已完成 |
| W0-2 | 任务队列:模型/串行执行/取消/重试/历史(20 条)落盘;IPC+preload+任务条 | `main/workshop.js`、`main/index.js`、`preload/index.js`、`views.js` | 启动→进度→完成/取消/重试;重启后历史可查 | 单测(队列/持久化/取消)+ e2e | M ✅ 已完成 |
| W0-3 | 文字层与可搜索 PDF:批量、`.uvtext.pdf`(源文件旁,同名覆盖)、进度 | `main/workshop.js`、`pdf-ocr.js`、`views.js` | 真实扫描件:生成文字层(阅读器可搜索)与导出可搜索 PDF | 单测(命名/参数)+ e2e(真实 sidecar) | M ✅ 已完成 |
| W0-4 | 文档互转(DocVortex):检测/命令/进度/入库;预设矩阵面板 | `main/docvortex.js`、`views.js`、设置段 | DOCX→MD/HTML、PDF→MD 成功落库 | 单测(命令/检测)+ e2e | M ✅ 已完成 |
| W0-4b | 公式优先链路:pdf_tool(MinerU)→ Doc JSON → HTML(`math/tex`)→ DocVortex(DOCX 真 OMML / EPUB MathML) | `main/formula-html.js`、`main/workshop-formula.js`、`views.js` | 扫描件公式含上下标落库 | 单测 13 + e2e(opt-in) | M ✅ 已完成 |
| W0-5 | 命名与产物:后缀约定、同名覆盖(文字层)、打开/在文件夹中显示 | `main/workshop.js`、`views.js` | 产物命名符合 §7;重复导出同名覆盖 | 单测 | S ✅ 已完成 |
| W0-6 | 收口:i18n、eslint、全量门禁、文档状态、书坊开关 | 全仓 | `npm test`/`test:shim`/`test:desktop`/`check:i18n`/eslint/build/smoke 全绿 | CI | S ✅ 已完成 |

### P1

| ID | 任务 | 主要文件 | 验收 | 测试 | 规模 |
| --- | --- | --- | --- | --- | --- |
| W1-0 | 内容提取(PDF/DOCX/图片 → 内容):pdf_tool `pdf_to_doc.py`(auto/text/vision/mineru)+ **图片提字** + **结构化 JSON(Doc v1)** + 预览/体检;`<源名>.md\|html\|json` + `<源名>.assets/` 产物 | `main/extract-doc.js`、`views.js` | 内容落源文件旁;结构化抽取按模板出 JSON | 单测 + e2e | M ✅ 已完成(题库 schema 模板待接) |
| W1-1 | Calibre 集成:检测(自定义→常见路径→PATH)、`ebook-convert`/`ebook-meta` 调用、下载引导 | `main/calibre.js`、设置段 | 检测到本机 9.15;路径可覆盖 | 单测(检测/命令) | S ✅ 已完成 |
| W1-2 | EPUB 构建器:Doc/**TXT**/MD/图片→章节 HTML+CSS+封面+元数据+nav/NCX;**字体按需下载(乔木封面字库,`index.json` SHA-256 校验,缓存 `userData/font-cache`)+ 子集化嵌入(`pyftsubset`→TTF,子集改名 `QBR …`,OFL 随包;不可子集字体只用于封面;需 Python 的 fontTools(+brotli 读 WOFF2),缺失时回退嵌原文件/系统字体)**;**非文本源(PDF/Office)自动走提取/转换,用户无感**;封面模板渲染(offscreen 截图→JPG);EbookLib 兜底 | `main/epub-build.js`、`main/workshop-fonts.js`、`main/text-book.js`、`main/workshop-epub.js`、`main/cover-render.js` | 生成 EPUB 可在阅读器打开;字体嵌入正确、体积可控;元数据/封面/目录正确 | 单测 + e2e(打开生成物、校验嵌字与许可) | L ✅ 构建器与字体子系统已完成(封面/向导 UI 待 W1-3) |
| W1-3 | 向导 UI + 实时预览:**快速成书面板已完成**(书稿选择 txt/md、书名/作者、12 套搭配、字号/行距/边距/主题 + 高级折叠、**正文 iframe 实时预览 + 模板封面缩略图预览**、**目录编辑:改名/合并/拆分/排序**、生成走队列;样式持久化);封面三模式与离线渲染亦完成;其余源(PDF/Office/图片)后续 | `views.js`、`base.css`、`main/cover-render.js`、`shared/book-chapters.js` | 样式改动即时可见;生成走队列 | e2e(向导→封面→目录改名→生成→打开) | L 部分完成 |
| W1-4 | 发送到 Kindle:nodemailer、SMTP 设置、授权码 SecretStorage、≤50MB ZIP、错误映射、三处入口 | `main/kindle-send.js`、`preload`、`settings-tab.js`、书库右键 | 本地 SMTP mock 收到附件;错误提示可读 | 单测 + e2e(SMTP mock) | M ✅ 已完成(2026-10-14:发送器 + `qbr:kindle:probe/send` + 队列 runner `kindle-send`;设置 → 书坊 的 SMTP 段(地址/服务器/端口/账号/发件地址 + 授权码只存 SecretStorage + 检测 SMTP 原地出结果);书坊「发送到 Kindle」面板(勾书库或本地文件、多文件自动 ZIP、>50MB 拒发);真 SMTP mock 单测 7/7,workshop e2e 断言 SMTP 段存在) |
| W1-5 | 图片→PDF(格式转换,后续);**EPUB→AZW3/MOBI、图片→CBZ/EPUB(电子书制作)✅**;PDF→EPUB(随向导) | `main/calibre.js`、`main/cbz.js`、`main/workshop-book.js`、`views.js` | 各产物可在阅读器/系统打开 | 单测 + e2e | M ✅ 已完成(2026-10-14:**图片 → PDF** 落地:格式转换的预设卡(每张一页、按 150dpi 换算页面,2000px 扫描页=13.3 英寸),产物落在首图旁;单测 + 转换矩阵一行 + 真实素材实测) |
| W1-6 | 收口:i18n、门禁、文档、发布说明 | 全仓 | 同 W0-6 | CI | S ✅ 已完成(2026-10-14:npm test / test:shim / test:desktop(248)/ check:i18n / eslint / build / smoke 全绿,e2e 9 场景 + workshop 全过,转换矩阵 64/64;版本升 **0.5.0**,tag → Release) |

### P2

| ID | 任务 | 说明 | 规模 |
| --- | --- | --- | --- |
| W2-1 | LLM 辅助:AI 清理/分章/元数据/封面文案(走现有 AI 桥,可选可撤销,进队列) | 提示词与结果可对比 | L |
| W2-2 | 批量与模板:多本排队、元数据/样式模板 | 复用队列 | M |
| W2-3 | Markdown→EPUB、EPUB→Markdown | Calibre / DocVortex | S |
| W2-4 | EbookLib 内置构建(可选,AGPL 评估) | 无 Calibre 时的完整方案 | M |
| W2-5 | 题目抽取入口(依赖 pdf_tool P1) | 后续 | M |

### 功能归属与预设矩阵(2026-10-12 用户定调)

按**保守程度**从高到低分四个工具——**保留内容/版式的多少,决定归属**:

| 工具 | 保留 | 放弃/新增 | 输入 | 输出 |
| --- | --- | --- | --- | --- |
| **文字层**(最保守) | 原文件一切(像素/版式/字体位置) | — | PDF | 阅读器缓存 / `<源名>.uvtext.pdf`(加不可见文字层,原页不变) |
| **格式转换**(内容+版式) | 内容与版式基本不变 | — | Office/ODF/HTML/EPUB/OFD/PDF/Markdown/纯文本(先渲染成 HTML 桥) | **文档产物**:md/html/docx/pdf/latex + 图片→PDF |
| **内容提取**(只要内容) | 文字/表格/公式等内容 | **版式**(页/栏/字体位置) | PDF(文本/扫描)、DOCX、**图片(纯图提字)**、Markdown/纯文本 | `<源名>.md` / `.html` / **`.json`** + `<源名>.assets/`;**结构化 JSON 与 schema 模板(题库等)在此** |
| **电子书制作**(内容+样式) | 内容 + **新加**的样式/版式/字体/封面/目录 | 原版式 | **书库里的书、PDF、Office(docx/pptx…)**、**txt**、md/html、图片、提取的 Doc | **电子书产物全部在此**:EPUB(主)/ AZW3 / MOBI / CBZ(Calibre/打包);可另导出 MD/HTML;**非文本源由向导内部自动提取/转换,用户无感**。已接:EPUB→AZW3/MOBI、图片→CBZ/EPUB;向导(W1-2/W1-3)后续 |

预设归属(每张卡放在**自己工具的面板**里,不再全堆在格式转换):

| 预设 | 归属 | 现状 |
| --- | --- | --- |
| 文档互转(DocVortex,内容+版式,输出文档) | 格式转换 | ✅ 已实现(20 入 / **5 出**:md/html/docx/pdf/latex) |
| 图片 → PDF(打包) | 格式转换 | 走 pdf_tool 渲染(W1-5) |
| PDF → Markdown / HTML(丢版式) | 内容提取 | 面板已列计划预设;未实现 → **W1-0**;纯文本版可先用 DocVortex 顶 |
| 结构化 JSON / 题库模板、图片 → 文字 | 内容提取 | 同上(W1-0) |
| PDF → 干净电子书、Markdown / HTML → EPUB、txt → EPUB、Office / OFD → EPUB | 电子书制作 | 面板已列计划预设;P1(W1-2/W1-3 向导) |
| **EPUB → AZW3 / MOBI**(Calibre) | 电子书制作 | ✅ 已实现(2026-10-12) |
| **图片 → CBZ / EPUB**(自打包 + Calibre) | 电子书制作 | ✅ 已实现(2026-10-12) |

**电子书产物统一归「电子书制作」**(2026-10-12 用户定调):EPUB/MOBI/AZW3/CBZ 等阅读器格式的输出都放这里——格式转换面板因此去掉 EPUB 目标与「EPUB→AZW3/MOBI」卡片;输入侧不受限(EPUB 仍可作为互转输入,如 EPUB → DOCX/Markdown)。

**结构化 JSON 只在内容提取**:格式转换的目标格式已去掉 JSON(`structured_content`);题库等结构化抽取走内容提取的 schema 模板(pdf_tool 的 vision/box 协议 + `extract_questions.py`)。

**预设卡片行为**:点按 → **路由/预填到对应工具**(如「PDF → 干净电子书」跳内容提取并选 MinerU,完成后提示去电子书制作);不在转换面板重复实现其它板块的功能。转换面板的「解析方式(本地/公式优先)」保留,作为纯转换的解析选项。

**建议顺序**:① EPUB → AZW3/MOBI(Calibre,半天)② HTML → EPUB 与 PDF → Markdown(纯文本版)预设 + 提示分流(半天)③ **W1-0 内容提取**(md/html/**json** + schema 模板 + 图片提字;1–2 天,复用公式链路 runner)④ 电子书向导(含 **txt 输入**;W1-2/W1-3)⑤ 图片 → PDF/CBZ(W1-5)。

## 4. 依赖与顺序

```text
W0-1 ─▶ W0-2 ─┬─▶ W0-3 ─┐
              └─▶ W0-4 ─┼─▶ W0-5 ─▶ W0-6 ─▶ 0.4.0
                        │
W1-1 ─▶ W1-2 ─▶ W1-3 ───┼─▶ W1-5 ─▶ W1-6 ─▶ 0.5.0
W1-4(独立,可并行)──────┘
W2-* 依赖 P1 ─────────────────────────────▶ 0.6.0
```

- W0-3 与 W0-4 可并行(文件不同);W1-4 与 W1-2/1-3 可并行。
- 每完成一个 W 任务跑一次门禁,避免收口阶段集中爆雷。

## 5. 关键实现细节

- **IPC 模式**:沿用 `qbr:<ns>:<action>` + `webContents.send` 事件(参考 `qbr:books:*`);preload 暴露 `qbrDesktop.workshop.{list,start,cancel,retry,onState}` 与 `qbrDesktop.kindle.{verify,send}`。
- **预览**:iframe 用 `blob:` URL(现有 CSP `frame-src 'self' data: blob: file:` 已允许),内容=章节 HTML + 与 EPUB 相同的 CSS;样式改动只重建 blob,不写盘。
- **封面渲染**:offscreen `BrowserWindow` 加载封面 HTML → `capturePage()` → PNG/JPG(1600×2400),无需新图像库。
- **Calibre/DocVortex/pdf_tool 检测**:统一 `resolveTool()`(自定义路径 → 常见位置 → PATH),失败给可操作提示(下载链接/设置入口)。
- **产物命名**(§7 规则:扩展名与源相同才加语义后缀;变了就直接换扩展名):`<源名>.uvtext.pdf`(文字层,源文件旁、同名覆盖、可重复导出)、`<源名>.md|html|json` + `<源名>.assets/`(内容提取)、转换产物=`<源名>.<目标扩展名>`(扩展名不变时用 `(n)` 序号);一律经 `resolveOcrOutput` 式库内校验。
- **安全**:主进程读文件/发邮件;渲染层不碰 SMTP/文件系统;CSP 不变;邮件密码只走 SecretStorage。
- **公式优先链路**(§8.1):pdf_tool(`pdf_to_doc.py --mode mineru --formats json`,缓存目录按源文件哈希)→ Doc v1 JSON → `formula-html.js` 生成带 `<script type="math/tex">` 的 HTML(图片保持相对路径,和 JSON 同目录写出)→ DocVortex 转 DOCX/EPUB。runner 是 `formula-convert`(标签:MinerU 云端解析 → 生成公式 HTML → DocVortex 转换),`formula-probe` 一次校验 pdf_tool 目录 + MinerU 凭据 + DocVortex;MinerU 产物按源文件缓存复用(云端慢且计费)。凭据解析顺序:面板「MinerU 凭据」→ 进程环境 → **Windows 注册表**(`HKCU\Environment`、HKLM 的 Session Manager 环境,免重启;环境变量设好后应用未重启也能用),再经子进程环境交给 pdf_tool;凭据缺失时把 traceback 翻译成可操作提示。
- **DocVortex 实测(2026-10-11)**:扫描件走它自带的本地 OCR(`~/.docvortex/model/MinerU-4_models_onnx`:PP-DocLayoutV2 版式 + PP-OCRv6 tiny det / small rec,首次约 226MB),与 pdf_tool 的 rapidocr 无关;行内公式按普通文字识别、上下标会被拉平(无公式模型),公式多的文档应走 pdf_tool 内容提取(MinerU,见 P1)。CLI 转换期间不输出任何进度(结束才打印产物路径),任务行与底部任务条用**不确定态滑动条 + 秒表**(`startedAt`)表达「还在跑」。

## 6. 测试与门禁

- **单测**:`apps/desktop/test/workshop.test.mjs`(队列/命名/取消/持久化)、`docvortex.test.mjs`(命令/检测)、`calibre.test.mjs`、`kindle-send.test.mjs`(报文/大小/错误映射)、`epub-build.test.mjs`(章节/CSS/元数据)。
- **E2E**:`apps/desktop/scripts/e2e.mjs` 新增场景 `workshop`(页面/任务)、`workshop-ocr`(真实 sidecar 导出 `.uvtext.pdf`)、`workshop-convert`(DocVortex)、`workshop-epub`(向导→生成→阅读器打开)、`kindle`(本地 SMTP mock)。
- **门禁**:每任务后 `npm test`、`npm run test:desktop`、`npm run check:i18n`、eslint;阶段末加 build+smoke+e2e 全量。
- **外部工具在 CI**:DocVortex/Calibre/pdf_tool 不在 CI 环境时,e2e 场景自动跳过并打印原因(沿用 OCR 场景的跳过模式)。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Calibre 未安装/路径差异 | 检测+设置覆盖+下载引导;EbookLib 兜底(W1-2 预留接口) |
| DocVortex 版本/依赖漂移 | 声明最低版本(0.5.x);命令参数校验;失败给原文错误 |
| 长任务/大文件 | 串行队列+进度+取消+超时;ZIP 前先估大小 |
| 邮件被拒(未批准/超限) | 错误映射到可操作提示 + Amazon 设置引导 |
| i18n 9 语言量 | 每任务即补 key,`check:i18n` 兜底 |
| 打包体积 | 外部工具不随包;仅新增 `nodemailer`(小) |
| 预览与成品不一致 | 预览与 EPUB 共用同一 CSS 文件,单测校验 CSS 注入 |

## 8. 发布节奏

- 0.4.0 = P0;0.5.0 = P1;0.6.0 = P2。每阶段:全量门禁 → 本地安装包 → tag → Release(沿用现有流水线)。
- 书坊入口可整体开关(`settings.workshopEnabled`,默认开;关闭时导航不显示),便于灰度与回退。
- **进度(2026-10-17)**:用户实测「文档互转」喂 `.md` 报 `Unsupported native input format: txt` —— DocVortex 0.5.16 的原生输入(FileSuffix)只有 PDF/Office/ODF/HTML/MHTML/OFD/EPUB,Markdown 与纯文本**不是**它的原生输入(它在 `schema.py` 的 `FILE_SUFFIXES` 里直接拒)。书坊侧桥接:格式转换与内容提取遇到 `.md / .markdown / .txt` 先渲染成 HTML(DocVortex 认的输入)再交给它 —— `main/docvortex.js` 新增 `textSourceKind`(shared/workshop-formats.js)/`textSourceHtml`/`writeTextSourceBridge`/`removeTextSourceBridge`,标题/列表/表格/代码走书坊自己的渲染器、公式写成 `<script type="math/tex">`(行内)与 `…; mode=display`(行间,→ DOCX 真 OMML / EPUB MathML)、图片保持相对路径;桥文件落在源文件旁(`.<源名>.bridge-<时间>.html`,DocVortex 的资源根=HTML 所在目录,相对图片才找得到)并在转换结束的 `finally` 里删掉,目录不可写时退回缓存目录。**顺带修掉一个真 bug**:`markdownToHtml` 的 `flushParagraph()` 不收列表,「1. 标题 + 紧跟正文」这种中文技术稿最常见的写法会渲染出 `<p>` 落在 `<ol>` 里的非法结构,DocVortex 把整段**丢掉** —— 用户那份 954B 的 md 转出的 docx 只有 183 字符(只剩小标题),修好后 958 字符(Intel Q870 / PCIe 等正文都在,PDF 产物 1.9KB → 23.7KB)。**另一个平台坑**:Node 24.12 + Windows 上 `fs.rmSync(path, { force: true })` / `fs.rmdirSync(dir, { recursive: true })` 对**非 ASCII 名字**(中文书名、桥文件)会**静默不删**(`unlinkSync` 正常,实测六行可复现),直接导致"清理了"其实没清;新增 `main/paths.js: removeFile / removeTree`(确定会生效的 API,只把 ENOENT 当成功)并替换四处清理点(桥文件、提取资产目录、封面临时目录、MinerU 缓存 —— 后者原先把没删掉的目录报成「已清理」)。测试:desktop **332**(新增 textSourceKind/桥 HTML/桥生命周期/转换 runner 收 HTML/提取 runner 桥接/removeFile 与 removeTree 的非 ASCII 用例/`markdownToHtml` 列表后段落回归)、core 519、shim 40、i18n、eslint、build、转换矩阵新增 `dv:md->{markdown,html,latex,docx,pdf}` 与 `dv:txt->*` **真机全绿**(md 源的回归标记只放在列表后面的段落里,产物里还能找到就说明没被丢)、e2e `workshop-convert` 扩展「本地 .md 就地转换」(源文件不动、桥文件不残留)。
- **进度(2026-10-14,第二轮)**:书坊设置集中化 + W1-4 发送到 Kindle + W1-5 尾巴 + **0.5.0 发布**。① **「设置 → 书坊」独立标签页**(与「存储与同步」同级;桌面壳包一层阅读器设置页,界面中文即可):书坊总开关、文字层/可搜索 PDF(从「存储与同步」迁出)、**MinerU**(云端 token / 本地服务地址 / 本地程序;qbr:mineru:path 自动查找并回填,状态行列出已试路径)、**DocVortex**、**Calibre**、**发送到 Kindle** 全部集中于此;链路检测**原地出结果**(新增 qbr:probe:ocr|docvortex|formula|calibre 直连探测,不入任务队列),「打开 设置 → 书坊」直达该页,输入**边打边存**(不必失焦);各工具面板只留本次任务的选项 + 一行指向「设置 → 书坊」的链接。② **W1-4 发送到 Kindle 完成**:main/kindle-send.js(nodemailer:单附件直发、多附件或 >50MB 自动 ZIP、打完包仍超 50MB 拒发、535/550/552/ENOTFOUND 错误映射、SMTP 检测)+ 主进程 qbr:kindle:probe|send(**授权码只从 safeStorage 读,不进设置文件**)+ 队列 runner kindle-send;设置页 SMTP 段(收件地址 / 服务器 / 端口 / 账号 / 发件地址 + 密码框「已保存;留空不修改」+ 检测 SMTP);书坊「发送到 Kindle」面板(勾书库 EPUB/PDF/DOCX 或本地文件 → 入队发送,任务里看结果)。单测 7 项(真实 SMTP mock 会话、ZIP 解包核对、超限拒发、错误映射、检测),e2e workshop 断言 SMTP 段存在。③ **W1-5 图片 → PDF**:格式转换预设卡,每张一页、按 150dpi 换算页面尺寸,产物落首图旁;单测 + 转换矩阵一行 + 真实素材实测。④ 收口:core/shim/desktop(**248**)/i18n/eslint/build/smoke 全绿,转换矩阵 **64/64**,e2e 9 场景全过;版本升 **0.5.0**,tag → Release(三平台安装包)。**仍待**:题库 schema 模板(等 pdf_tool 的 vision/box 协议)、P2(LLM 辅助 / 批量模板 / MD↔EPUB / EbookLib / 题目抽取)。
- **进度(2026-10-14)**:pdf_tool 的两份需求均已**交付并接入** —— **本地 MinerU**(两种形态:`--mineru-source local` CLI 与常驻服务 `MINERU_LOCAL_URL`;路由优先级 **LOCAL_URL > 云端 token > CLI**;实测同机 3 页:CLI 21.6s、服务冷 11.1s / **热 5.0s**,产物与 CLI 逐项一致,JSON-RPC `doc.convert` 亦验证)与**家具自动清理**(全模式、**默认开、无开关**,计数在 `stats.furniture`;`CSP2021.pdf` 实测页眉/页脚/水印 **0 残留**、代码样例一条不少)⇒ 书坊不再自己做 PDF 家具清理(**不经过 pdf_tool 的 DocVortex 直连仍保留红标预清**)。书坊侧新增:解析方式第四项「**公式优先(本地 MinerU 服务)**」、「本地 MinerU 服务」地址与「本地 MinerU 程序」设置(找不到时自动在 `MINERU_LOCAL_CMD` / sidecar python 同目录 / pdf_tool 下的 `.venv` 里找)、**应用启动自动拉起常驻服务**(退出只收自己拉起的那个;面板可关,并可「检测本地 MinerU / 启动服务 / 清理 MinerU 缓存」);给 pdf_tool 的进程环境补齐 `MINERU_LOCAL_URL`(**先探测 `/v1/health`,健康才给,死地址显式传空**)、`MINERU_LOCAL_CMD`(helper 靠它找 venv python)与 `PYTHONUTF8` / `PYTHONIOENCODING`(中文报错不再乱码)。质量修复:文本型跨页代码合并不再被图上的零散文字打断、**图区裁成图片**(图内文字并入图片、裁前擦掉低不透明度水印)、KaTeX 解析失败原样显示、第二次提取的**资产并目录**(图片链接不再指空)、提取 mark 加版本号、**MinerU 按页切开的代码围栏合并**(`joinSplitCodeFences`)。测试:`desktop:matrix` 转换矩阵进仓库(**63/63**:DocVortex 10 源 × 5 目标 + 文本型 × 5 + 内容提取 + Calibre/CBZ),e2e 9 场景全绿,desktop 单测 240。**仍待**:pdf_tool 的 4 个待确认问题(默认档位 / `layout.json` / 大文档并发 / 超时取消;书坊已给建议)、题库 schema 模板(W1-0 尾巴)、**W1-4 发送到 Kindle**(未开始)、图片→PDF(W1-5 尾巴)、P2 全部;版本仍在 **0.3.1**(0.4.0 / 0.5.0 的 tag 与 Release 尚未发布)。
- **进度(2026-10-12)**:W0 全部完成(0.4.0 可发布);W1-0 ✅(内容提取,题库 schema 模板待接)、W1-1 ✅(Calibre)、W1-2 ✅(构建器 / 字体 / 封面)、W1-3 ✅(向导面板 / 实时预览 / 目录 / 封面预览)、W1-5 部分(EPUB→AZW3/MOBI、图片→CBZ/EPUB 已完成;图片→PDF 待做);**W1-4 发送到 Kindle 未开始**。按用户要求:**此轮后暂停新功能开发**。同日修复制作电子书三类成品问题(图片未嵌入、LaTeX 公式未渲染、预览把二进制当文本读成乱码)与图片提取(DocVortex 只收文档,图片改为先合成单页 PDF 再 OCR),并按用户反馈把面板重排为「四步向导 + 更多工具」;随后修复格式转换的正文误判(pdf_tool/MinerU 把正文段落判成 `code` 块 → 现在按内容还原为段落并转换段内公式)、该误判块的 **caption 丢失**(caption+content 合并、`.md` 用 Doc JSON 补回、图片 caption 输出 `figcaption`),以及按用户要求「公式准确、文字不丢」新增**文字层互补合并**(`main/text-layer.js` + `main/text-merge.js`:先去跨页重复的页眉/水印,正文取 PDF 文字层逐字对齐、MinerU 丢的词逐字补回,公式仍用 MinerU 的 LaTeX;接入公式优先链路、向导 PDF 成书与 `.md` 产物)。

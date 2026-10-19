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
| W1-2 | EPUB 构建器:Doc/**TXT**/MD/图片→章节 HTML+CSS+封面+元数据+nav/NCX;**字体按需下载(乔木封面字库,`index.json` SHA-256 校验,缓存 `userData/font-cache`)+ 子集化嵌入(`pyftsubset`→TTF,子集改名 `QBR …`,OFL 随包;不可子集字体只用于封面;需 Python 的 fontTools(+brotli 读 WOFF2),缺失时回退嵌原文件/系统字体)**;**非文本源(PDF/Office)自动走提取/转换,用户无感**;封面模板渲染(offscreen 截图→JPG);EbookLib 兜底 | `main/epub-build.js`、`main/workshop-fonts.js`、`main/text-book.js`、`main/workshop-epub.js`、`main/cover-render.js` | 生成 EPUB 可在阅读器打开;字体嵌入正确、体积可控;元数据/封面/目录正确 | 单测 + e2e(打开生成物、校验嵌字与许可) | L ✅ 构建器已完成(封面/向导 UI 见 W1-3);**字体子系统 2026-10-18 移除**(不再下载/嵌入字体) |
| W1-3 | 向导 UI + 实时预览:**快速成书面板已完成**(书稿选择 txt/md、书名/作者、12 套搭配、字号/行距/边距/主题 + 高级折叠、**正文 iframe 实时预览 + 模板封面缩略图预览**、**目录编辑:改名/合并/拆分/排序**、生成走队列;样式持久化);封面三模式与离线渲染亦完成;其余源(PDF/Office/图片)后续 | `views.js`、`base.css`、`main/cover-render.js`、`shared/book-chapters.js` | 样式改动即时可见;生成走队列 | e2e(向导→封面→目录改名→生成→打开) | L ✅ 已完成(源全部接入;2026-10-18:预览 / 字体搭配 / 五个「阅读器说了算」的排版控件移除) |
| W1-4 | 发送到 Kindle:nodemailer、SMTP 设置、授权码 SecretStorage、≤50MB ZIP、错误映射、三处入口 | `main/kindle-send.js`、`preload`、`settings-tab.js`、书库右键 | 本地 SMTP mock 收到附件;错误提示可读 | 单测 + e2e(SMTP mock) | M ✅ 已完成(2026-10-14) → **2026-10-18 按用户要求整条移除**(SMTP 配置繁琐、功能鸡肋;`de2afc8`)。留档:发送器 + `qbr:kindle:probe/send` + 队列 runner `kindle-send`;设置 → 书坊 的 SMTP 段(地址/服务器/端口/账号/发件地址 + 授权码只存 SecretStorage + 检测 SMTP 原地出结果);书坊「发送到 Kindle」面板(勾书库或本地文件、多文件自动 ZIP、>50MB 拒发);真 SMTP mock 单测 7/7,workshop e2e 断言 SMTP 段存在) |
| W1-5 | 图片→PDF(格式转换,后续);**EPUB→AZW3/MOBI、图片→CBZ/EPUB(电子书制作)✅**;PDF→EPUB(随向导) | `main/calibre.js`、`main/cbz.js`、`main/workshop-book.js`、`views.js` | 各产物可在阅读器/系统打开 | 单测 + e2e | M ✅ 已完成(2026-10-14:**图片 → PDF** 落地:格式转换的预设卡(每张一页、按 150dpi 换算页面,2000px 扫描页=13.3 英寸),产物落在首图旁;单测 + 转换矩阵一行 + 真实素材实测) |
| W1-6 | 收口:i18n、门禁、文档、发布说明 | 全仓 | 同 W0-6 | CI | S ✅ 已完成(2026-10-14:npm test / test:shim / test:desktop(248)/ check:i18n / eslint / build / smoke 全绿,e2e 9 场景 + workshop 全过,转换矩阵 64/64;版本升 **0.5.0**,tag → Release) |

### P2

| ID | 任务 | 说明 | 规模 |
| --- | --- | --- | --- |
| W2-1 | LLM 辅助:AI 清理/分章/元数据/封面文案(走现有 AI 桥,可选可撤销,进队列) | 提示词与结果可对比 | L ✅ 已完成(2026-10-18/19:**元数据推断 / 封面文案**、**分章建议**、**清理(先体检、再清理、前后对比)** 全部落地) |
| W2-2 | 批量与模板:多本排队、元数据/样式模板 | 复用队列 | M |
| W2-3 | Markdown→EPUB、EPUB→Markdown | Calibre / DocVortex | S ✅ 已完成(2026-10-18:能力早已具备——向导直接吃 md/txt,格式转换吃 EPUB→md;本次补「EPUB → Markdown」预设卡 + 文档收口) |
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
| **EPUB → Markdown**(快捷预设:目标格式预选 md) | 格式转换 | ✅ 已实现(2026-10-18,W2-3) |
| 图片 → PDF(打包) | 格式转换 | ✅ 已实现(2026-10-14,W1-5) |
| PDF → Markdown / HTML(丢版式) | 内容提取 | ✅ 已实现(W1-0) |
| 结构化 JSON、图片 → 文字 | 内容提取 | ✅ 已实现;**题库 schema 模板待接**(等 pdf_tool 的 vision/box 协议) |
| PDF → 干净电子书、Markdown / HTML → EPUB、txt → EPUB、Office / OFD → EPUB | 电子书制作 | ✅ 已实现:源全部接进向导,直接选书稿成书(W1-2/W1-3) |
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
- **进度(2026-10-17)**:用户实测「文档互转」喂 `.md` 报 `Unsupported native input format: txt` —— DocVortex 0.5.16 的原生输入(FileSuffix)只有 PDF/Office/ODF/HTML/MHTML/OFD/EPUB,Markdown 与纯文本**不是**它的原生输入(它在 `schema.py` 的 `FILE_SUFFIXES` 里直接拒)。书坊侧桥接:格式转换与内容提取遇到 `.md / .markdown / .txt` 先渲染成 HTML(DocVortex 认的输入)再交给它 —— `main/docvortex.js` 新增 `textSourceKind`(shared/workshop-formats.js)/`textSourceHtml`/`writeTextSourceBridge`/`removeTextSourceBridge`,标题/列表/表格/代码走书坊自己的渲染器、公式写成 `<script type="math/tex">`(行内)与 `…; mode=display`(行间,→ DOCX 真 OMML / EPUB MathML)、图片保持相对路径;桥文件落在源文件旁(`.<源名>.bridge-<时间>.html`,DocVortex 的资源根=HTML 所在目录,相对图片才找得到)并在转换结束的 `finally` 里删掉,目录不可写时退回缓存目录。**顺带修掉一个真 bug**:`markdownToHtml` 的 `flushParagraph()` 不收列表,「1. 标题 + 紧跟正文」这种中文技术稿最常见的写法会渲染出 `<p>` 落在 `<ol>` 里的非法结构,DocVortex 把整段**丢掉** —— 用户那份 954B 的 md 转出的 docx 只有 183 字符(只剩小标题),修好后 958 字符(Intel Q870 / PCIe 等正文都在,PDF 产物 1.9KB → 23.7KB)。**另一个平台坑**:Node 24.12 + Windows 上 `fs.rmSync(path, { force: true })` / `fs.rmdirSync(dir, { recursive: true })` 对**非 ASCII 名字**(中文书名、桥文件)会**静默不删**(`unlinkSync` 正常,实测六行可复现),直接导致"清理了"其实没清;新增 `main/paths.js: removeFile / removeTree`(确定会生效的 API,只把 ENOENT 当成功)并替换四处清理点(桥文件、提取资产目录、封面临时目录、MinerU 缓存 —— 后者原先把没删掉的目录报成「已清理」)。测试:desktop **332**(新增 textSourceKind/桥 HTML/桥生命周期/转换 runner 收 HTML/提取 runner 桥接/removeFile 与 removeTree 的非 ASCII 用例/`markdownToHtml` 列表后段落回归)、core 519、shim 40、i18n、eslint、build、转换矩阵新增 `dv:md->{markdown,html,latex,docx,pdf}` 与 `dv:txt->*` **真机全绿**(md 源的回归标记只放在列表后面的段落里,产物里还能找到就说明没被丢)、e2e `workshop-convert` 扩展「本地 .md 就地转换」(源文件不动、桥文件不残留)。**同日第二轮(用户实测反馈)**:「md 里 `1. 2. 3.` 在 docx 里变成 1.1.1.1.1.」—— 两个层面的原因。① **我们桥错了**:`flushParagraph()` 的「段落一出现就关列表」把「`1. 标题` + `- 细则` + 空行 + `2. 标题`」拆成 6 个各只含一项的列表,而 HTML 语义就是每个列表从 1 开始(实测 DocVortex 忠实照办)。`markdownToHtml` 改成**列表栈**:标记行之后不带缩进的续行并进同一项(CommonMark 的 lazy continuation)、另一种标记紧跟项正文时成为该项的**嵌套列表**、外层已有同类列表时收掉嵌套层**回到外层续号**、空行不再结束列表 ⇒ 真机产物变成「一个 `<ol>` 6 项 + 每项嵌套细则」,docx 段落 1. → 6. 连续。② **DocVortex 的弱项(它这边确实没做好)**:HTML→DOCX 的列表只是「字面编号(`w:t` 里的 "1. ")+ 段落缩进」,整份文档 `w:numPr = 0` —— Word 里不能续编号、不能改项目符号样式、不能升降层级(同一份产物里表格倒是真 `w:tbl`,列表保真度明显偏低)。按用户选择**只对 md/txt → docx 这条链路**补:新增 `main/docx-numbering.js`(`scanDocxParagraphs` / `groupDocxLists` / `rewriteDocxLists` / `planNumbering` / `appendNumbering` 纯函数 + `restoreDocxLists` 用 JSZip 读写),识别「缩进 + 标记」的段落 → 去掉字面标记 → 补 `w:numPr`(按 340 twips 折层级)→ 往 `numbering.xml` 追加 abstractNum(decimal / bullet 各一份、九级、`left = 340×(n+1)`、`firstLine=0`,与 DocVortex 原来画的对齐)与 `w:num`(每块每 kind 一个 numId,原文起始号用 `startOverride` 保留);**跳号的有序列表原样保留**(换自动编号会改写语义),普通段落打断列表(与 CommonMark 一致)。真机实测用户文件:22 个列表段落全部换成真编号、字面编号 0 残留、源文件不动、桥文件不残留,产物还能被 DocVortex 反读(docx → md ✓)。测试:desktop **340**(新增 docx-numbering 8 项:识别 / 分块 / 跳号保留 / 重写 / pStyle 顺序 / numbering 追加与复用 / `restoreDocxLists` zip 幂等),矩阵 `dv:md->docx`、`dv:txt->docx`、`dv:docx->docx` 真机全绿,e2e `workshop-convert`(含 .md 就地转换)与 `workshop-epub` 全过。
- **进度(2026-10-18,PDF 成书质量修复)**:用户实测《Notes_Boltzmann》PDF → EPUB,三个症状都定位到根因(证据在 `book-cache/work/<stem>-<hash>/extract/`):① **`<sup>` 被转义** —— MinerU 自己会写 `<sup>ℓ</sup>`(本书 36+18 处),而书稿渲染器一律转义 → 成品里显示字面 `&lt;sup&gt;`;`inlineMarkdown` 现在**放行 `<sup>/<sub>`**(书稿内容可信),其它标签照旧转义(`<script>` 仍是 `&lt;script&gt;`,有单测)。② **`||` 噪声** —— MinerU 的 `page_footnote` 里公式内容在上游丢了、只剩定界符(本书 8 处);新增 `cleanFootnoteText`:只剩 `||` 的脚注整条丢掉,混合的(`ε^(d−1)||`)保留正文。③ **`未渲染 4`** —— 症状是公式里出现 `\mathbb { } _ {s+n}` 这类**空壳**(字母丢了),留下**没有基底的上下标** → latex2mathml 直接报错、整条公式退回原文。**追根(2026-10-18 晚):既不是 MinerU、也不是渲染器** —— MinerU 的 content_list 是干净的(全书空壳仅 1 个、`\mathbb { M }` 完好),是 **pdf_tool 的「水印行内剔除」误伤**(`furniture.filter_blocks`:第 25/27/28 页的隐形 OCR 层被当成水印 → `W`/`M`/`is`/`of` 等独立 token 被整词删除,**全书 2195 处、公式块 242 处**、Doc JSON 531 个空壳;证据是把 `filter_blocks` 的输出与 Doc JSON 对比**逐字符相等**)。已按约定提给 pdf_tool(`pdf_tool/docs/reader-request-watermark-token-loss-2026-10-18.md`,auto_chat `8d62bd2`);reader 侧**不做**兜底恢复(试过用 PDF 文字层把字母捞回公式,压缩键被 LaTeX 命令名污染、对不上,已撤)。`math-render.js` 的 Python helper 保留**重试路径**(空壳补 `\square`、清悬空上下标)作为渲染保险,实测本书 38 条 equation 一次通过 37 条、重试后 **0 失败**。顺带按用户要求**去掉脚注末尾的「（第 N 页）」**(读者看到的是噪声;页码信息仍在 Doc JSON 里)。测试:desktop **327**(新增 `<sup>` 放行、脚注残片、真实 latex2mathml 重试三组用例;CI 无 latex2mathml 时自动跳过),core 519、shim 40、i18n、eslint、build 全绿。
- **进度(2026-10-19,书坊引擎 E1:服务骨架 + 契约 + 客户端)**:按用户确认的「**可独立部署的本地 HTTP 服务**」架构开工(界面与功能解耦)。① **引擎**(新目录 `engine/`,FastAPI + uvicorn):`/v1/health`(读 `engine.json` 上报版本 / 平台 / Python / 包版本 / 能力 + `jobKinds`)、`/v1/jobs` **作业模型**(提交 → 轮询 `status/done/total/label` → 取结果 / `DELETE` 取消;2 个工人、历史 50 条)、`/v1/math`(LaTeX→MathML,从应用搬来:清 `\tag` 与环境外壳 + 空壳 `\square` 与悬空上下标的**修复重试**)、`/v1/jobs kind=text-layer`(PyMuPDF 逐页取文本,带进度);Bearer 令牌(设了就必须带,默认只绑 `127.0.0.1`);CLI `python -m engine serve --port 8760 --token …`。② **应用侧**:`main/engine-client.js`(health / submit / status / result / cancel / math + `normalizeEngineUrl` / `describeEngineHealth`)、IPC `qbr:probe:engine` + preload、设置 → 书坊 新增「**书坊引擎(后台能力)**」卡片(地址 / 令牌 / 检测 + 状态行)。**回退不变**:引擎只是新增能力,现有本机 spawn 链路照旧。③ **验证**:`engine-client` 单测 5 项(mock HTTP:health / 令牌 / 作业全流程 / 连不上给可读原因;真引擎冒烟在缺依赖时自动跳过)+ **真机冒烟**(临时 venv 起引擎):health `0.1.0 · 1 类作业`、不带令牌 401、两条公式(含 `\mathbb { }` 空壳)都出 MathML、**text-layer 作业** 36 页 / 87,919 字符、产物文本正确。测试:desktop **376**,core 519、shim 40、i18n、eslint、build 全绿。**E2 待办**:把 extract / convert / pdf-text / outline / redact / images-to-pdf 搬进引擎(应用 runner 优先走引擎、失败回退),删掉应用里的重复脚本,并给引擎补 **Python 侧测试 + CI 作业**。**踩坑**:`engine/requirements.txt` 写中文注释会让 pip 按 GBK 解码报错 → 保持 ASCII;`python -m engine` 要在 `engine/` 目录里跑(否则外层目录成命名空间包、撞名)。\n- **计划(2026-10-19,书坊引擎:后台能力怎么发布)**:用户提出「装完 UV Reader 还要逐个装 MinerU / pdf_tool / Calibre 太麻烦,最好做一个可独立安装的后台模块」—— 已出**评估与计划:`docs/workshop-engine-plan.md`**。要点:① **现状依赖清单**(Python / PyMuPDF / Pillow / latex2mathml / DocVortex / pdf_tool / MinerU 本地 / Calibre / boko,含许可与体积);② **三条硬线** —— 许可(**PyMuPDF 是 AGPL**、**Calibre / boko 是 GPL-3**,不能进 Electron 安装包,只能作为独立程序)、体积(MinerU 模型 3–6GB 只能按需)、平台(三平台私有 Python 运行时:Windows embeddable / macOS+Linux python-build-standalone);③ **四方案对比**,推荐「**独立书坊引擎包**」(独立程序、独立许可、单独下载;应用负责探测 / 一键安装 / 更新,用户已有的外部安装继续可用);④ **架构**:`engine.json` 契约(版本 + 能力)、探测顺序(自定义 → `%LOCALAPPDATA%/UVReader/engine/<version>` → 现有外部探测 → 引导安装)、可选组件(本地 MinerU)与外部工具(Calibre / boko,优先推 boko);⑤ **分阶段 E0–E5**(E1 定义与探测 → E2 Windows 构建脚本 → E3 一键安装 → E4 boko / MinerU 组件 → E5 收口)+ 风险对策 + 4 个待拍板项。**未开工**,等用户确认方案。\n- **0.6.0 发布(2026-10-19)**:自 0.5.0 起的这批改动 —— **W2-1 LLM 辅助四项**(AI 元数据推断 / 封面文案 / 分章建议(模型只归纳规则、本地套用验证)/ 清理(先本地体检、用户确认后再逐块清理 + 前后对比))**、txt 质量两修**(编码按内容判:GB18030 / UTF-16 / UTF-8±BOM;编号式章名 `一、` / `1.` / `001` 成串识别)**、向导④ 收敛为三项**(字号/行距/边距/主题/对齐移出面板,书里仍写默认基线)**、W2-3**(格式转换新增「EPUB → Markdown」预设卡)**、减法**(发送到 Kindle、实时预览、字体嵌入整条移除 + 死代码/死 CSS 清理)**、PDF → EPUB 质量修复**(`<sup>` 放行、脚注 `||` 残片、公式空壳重试 —— 根因是 pdf_tool 的水印行内剔除,已提给上游并由其修复)。版本:root + `apps/desktop` 同步升 **0.6.0**;发布走 `v0.6.0` tag → 三平台构建 + GitHub Release。\n- **进度(2026-10-19,AI 清理:先体检、再清理)**:W2-1 最后一片,按用户要求分两步。**① 发现问题**(纯本地、免费、不调用 AI):`shared/text-issues.js` 的 `scanTextIssues` / `scanChapterIssues` 扫四类可疑 —— 怪字符(私用区 / 替换字符 / 控制符)、乱码片段(UTF-8 被当 Latin-1 读出的 `Â¡Ã©`)、疑似吞标题(行首是章名但整行 > 30 字,后面直接接正文)、疑似断行(连续 3 行短行且不以句末标点结尾);逐章评分排序,面板列出可疑章节 + 样例,**用户勾选确认后才清理**(**「重复字」这类检测已按用户反馈去掉(2026-10-19)**:`哈哈哈哈` / `啊啊啊啊` 是对话的一部分,误报太多)。**② 实际清理**(`ai-clean` runner):按 ~4000 字切块(不切碎段落,单段超长按句号兜底),逐块只做三件事(修 OCR 错字 / 接回断行 / 把被吞的标题单独成行),**四道护栏** —— 长度 ±10%、段落数 ±1、二元组相似度(长块 ≥ 0.9、短块 ≥ 0.6)、长段落不被整段改写(< 80 字的短段不判,免得错字比重把正常修正判死);不过关就保留原文并计入「丢弃」。结果**落盘**(`cacheRoot/ai-clean/*.json`,整本书不进任务状态),任务只回传摘要 + 前 20 条对比;面板给「前:…→后:…」的**直观对比** + 「应用清理结果」/「忽略」,应用时按 **章节号 + 标题**双重校验(目录变过就跳过那章),还原 = 重新选一次书稿。成本与问题量成正比(干净的书 0 次调用;一次 ≤ 200 块,超出提示少选几章)。测试:desktop **371**(新增 `text-issues` 8 项:四类检测 / **对话里的重复字不算可疑** / 逐章排序 / 切块不碎段 / 相似度 / 护栏四类拒绝 / 对比裁剪;`workshop-ai` 新增 3 项:最小修正 + 落盘 + 对比、改写被丢弃、空选择与超量拒绝),core 519、shim 40、i18n、eslint、build、e2e `workshop-epub`(新增「体检是本地、点了就有结果」断言)。**顺带**:`workshop.test.mjs` 里三处固定 `sleep` 等待改成轮询到终态(满载 CI 上会偶发假失败)。\n- **进度(2026-10-19,AI 分章建议)**:W2-1 第二片。做法**不是**「把开头 N 行喂给模型」,也不是逐块问(15MB ≈ 500 万 token;按 4000 字切要 ~4000 次调用):① **本地抽候选行**(`shared/chapter-rules.js` 的 `collectChapterCandidates`:整行 ≤ 40 字、独立成段、不以句末标点结尾;上限 400 条,超出**均匀采样**并记住总数);② **模型只归纳规则**(封闭集合 `numbered | prefixed` + `number / prefix / suffix / separator`,**不让模型给正则**;提示词给候选行 + 开头/中间/结尾三段正文片段作风格上下文);③ **本地套用 + 验证**(`applyChapterRule`:逐行跑正则 —— 行短、不吃整篇文本;要求条数 ≥ 2、编号递增且跳号 ≤ 5、相邻 ≥ 120 字,任一不过就报错、不套用);④ **只回传规则与预览**(章数 / 前 5 / 末 3 个标题;正文不进结果,任务状态推送不背整本书)。runner `ai-chapters` 读源文件(与向导同一份编码解码;PDF/Office 读同目录提取产物)、取消转发 abort;面板在向导 **② 目录**加「AI 建议分章」按钮,结果给预览 + 「套用这份目录」/「忽略」(套用是本地按规则重切,可撤销)。**顺带修一个隐藏 bug**:目录编辑器的排序/合并/拆分/删除原来会重读源文件重切,把**改名丢掉**;现在渲染与重读分离(`renderChapterRows`),编辑动作只重渲染。测试:desktop **360**(新增 `chapter-rules` 7 项:候选抽取 / 采样 / 规则白名单 / 套用 + 四类拒绝(递增 / 跳号 / 太近 / 太少)/ 前后缀规则;`workshop-ai` 新增 3 项:规则→预览、GB18030 源读取 + 坏规则拒绝、采样片段),core 519、shim 40、i18n、eslint、build、e2e `workshop-epub`(新增「AI 建议分章」按钮断言)全绿。\n- **进度(2026-10-19,章节识别扩展:编号式章名)**:用户反馈「一大部分的 txt 书籍都是这种格式」(指 `1. 标题` / `一、标题` / 拼写英文这类章名)。`text-book.js` 的标题规则扩展:① **强标题**(上下文无关)新增 `Part N` / `Part One` / 拼写数字的 `Chapter One`;② **编号式弱标题**(`一、` / `1.` / `1、` / `001 ` 等;中文数字支持到千位)只在**没有任何强标题**时启用,并且要过三道闸 —— 首个编号 ≤ 20(挡日期)、严格递增且跳号 ≤ 3、相邻至少隔 200 字(挡列表),再加「过半步长是 1」;③ 有强标题时编号行一律留在正文(技术书里的编号列表不会被切成章)。实测:用户那份 15MB《凡人修仙传》仍走强标题路径、**2007 章不变**;新增用例覆盖「一、/ 1. / 001 成串成章」「相邻编号列表不成章」「强标题优先于编号行」「Chapter One / Part Three」。测试:desktop **350**(text-book 新增 5 项),core 519、shim 40、i18n、eslint、build、e2e(workshop-epub / workshop-convert)全绿。\n- **进度(2026-10-18/19,GB18030 中文 TXT 乱码修复)**:用户拿《凡人修仙传》的 TXT(15MB)成书,成品整本乱码。定位:**源文件是 GB18030**(旧站「校对版」中文小说的常见编码 —— 按 gb18030 解出来是正常的「更多精校小说尽在知轩藏书下载」,按 UTF-8 解是 `���ྫУС˵`),而链路一律 `readFileSync(source, "utf8")` → 成品章节标题成了 `�?1 部分`、2981 条目录其实是**按长度分块**的兜底(乱码里没有「第X章」)。修复:新增纯函数 `shared/text-encoding.js: decodeText()` —— BOM(UTF-8 / UTF-16 两序)→ 含 NUL 的按 UTF-16 两序试解、取**文本质量**高的(错序解出来几乎全是私用区 / 拉丁扩展怪字)→ 严格 UTF-8 → GB18030 兜底;主进程两处读源文本改用它(`workshop-epub.js` 成书、`docvortex.js` 的 md/txt → HTML 桥),渲染层的目录识别与 AI 提示词改用新的 `readSourceText()`(绝对路径 fs 读 + 同一份解码,vault 读兜底)。测试:desktop **345**(新增 `text-encoding` 5 项:GB18030 / UTF-8(±BOM)/ UTF-16 两序(±BOM)/ 空与超短;`workshop-epub` 新增「GB18030 txt 成书后目录与正文都是正确汉字」1 项),core 519、shim 40、i18n、eslint、build、e2e(workshop-epub / workshop-convert)全绿。\n- **进度(2026-10-18,LLM 辅助第一片:AI 元数据推断 / AI 封面文案)**:W2-1 起步。① **主进程 runner**(`main/workshop-ai.js`):两个任务类型 `ai-metadata` / `ai-cover-copy`,走桌面壳已有的 AI 运行时(`createAiRuntime`,与伴读同一套供应商 / 模型 / 密钥,**不新增设置项**);提示词只要求模型输出 JSON,解析容错(剥代码围栏 / 前后废话 / 嵌套花括号);取消把 abort 转发给 AI 运行时(排队期间就被点掉的不发请求);失败翻译成可操作中文(缺密钥 / 没配置 / 上游报错)。② **结果只作建议**:runner 返回结构化 `result`,任务队列新增 `result` 字段(只在内存与状态推送里,**不落盘** —— 历史文件既不存 `result` 也不存 `payload`);面板里显式「应用」才写字段,**只填空着的字段**(用户写的优先),可「忽略」—— 可选、可撤销。③ **面板**(向导 ③ 书名与封面):「AI 推断书名 / 作者」「AI 封面文案」两个按钮;书稿开头取 txt/md 源本身、PDF/Office 取同目录「内容提取」的 `.md` 产物(没有就提示先跑提取);没配 AI 时点按钮给可操作提示而不是静默失败。测试:desktop **339**(新增 `workshop-ai` 12 项:提示词 / JSON 解析 / 归一化 / runner 成败与取消 / 注册),e2e `workshop-epub` 新增「AI 按钮存在 + 未配置时有提示」断言。**待做**:AI 分章建议、AI 清理(OCR / 断行 / 漏标题)。\n- **进度(2026-10-18,W2-3 收尾 + 文档收口)**:① **「EPUB → Markdown」预设卡**(格式转换面板):新卡片选中后把目标格式预选成 **md**(仍可改,改了就是普通互转);「开始转换」时若一个 EPUB 都没选会拦住提示。能力本身早已具备(格式转换吃 EPUB→md、向导直接吃 md/txt)——W2-3 这条只是把入口摆明,不需要新链路。② **文档收口**:`docs/workshop.md` 里已过时的段落全部按日期标注/划掉 —— Kindle 整节(§5.6,标「已移除 2026-10-18」)、字体来源/搭配/嵌字、版式里的「预览与成品共用同一份 CSS」、封面 176×264 缩略图、§6 技术架构的 `kindle-send` 与「预览渲染」、§结论 bullet 8/10、预设归属表(图片→PDF、PDF→Markdown、电子书制作各预设全部标 ✅)、P2 列表(W2-3 标已具备);本文件的 W1-2 / W1-3 / W1-4 / W2-3 行同步更新(W1-4 标「已完成 → 2026-10-18 整条移除」)。测试:desktop 327、e2e `workshop`(新增「EPUB → Markdown 预选 md」断言;预设卡按文字查找,新增卡片不影响既有断言)、core 519、shim 40、i18n、eslint、build。\n- **进度(2026-10-18,向导④收敛)**:用户实测反馈「制作电子书时排版的样式似乎无用,这个是阅读时改的」——查证属实:`reader-appearance.js` 用 `!important` 覆盖正文的 `font-family/font-size/line-height/text-align` 与 `html/body` 的 `background/color`,foliate 分页器再强制 `body{margin:0!important}`(页边距由阅读器 `margin:48px` 的布局决定)——所以④里 **字号 / 行距 / 边距 / 主题 / 对齐五项在 UV Reader 里全部无效**,只有**首行缩进 / 段间距 / 标题对齐**(以及引用/代码/表格/图/公式这些结构样式)真正写进书、到处生效。按用户选定方案 **收敛为三项**:面板删掉那五个控件(书的 `styles.css` 仍写入完整默认基线 17px / 1.75 / 5% / 两端对齐;主题整条移除——不再写颜色,交给阅读器),`shared/book-styles.js` 删 `BOOK_THEMES` 与配色块,`views.js` 的向导载荷只发 `{indent, spacing, headingAlign}`(顺带删掉遗留的 `fonts:{pairing,embed}` 死载荷)。**顺带修掉预览移除的遗留**:向导容器还是两列网格(`qbr-workshop-wizard`,控件只占左半、右半空白)→ 改单列;并清掉预览/封面缩略图/高级折叠留下的死 CSS(`qbr-workshop-preview*`、`qbr-workshop-cover-preview`/`-box`/`-frame`、`qbr-workshop-wizard-preview`、`qbr-workshop-advanced` 与 900px 媒体查询)。测试:desktop **327**(epub-build 的主题断言改成「不写背景色」、workshop-epub 的 warm 断言改成「缩进落进 stylesheet」)、core 519、shim 40、i18n、eslint、build、e2e(`workshop-epub` 样式断言改为 `text-indent` + 无背景色,并去掉已无意义的字体载荷)。\n- **进度(2026-10-18,减法)**:按用户要求做三处移除。① **发送到 Kindle 整条链路删除**:UI 工具与面板、设置页 SMTP 卡片(host/port/账号/发件地址 + SecretStorage 里的授权码)、`main/kindle-send.js` 与两个 IPC、preload 桥、单测(kindle-send 9 项)与 e2e 里关于 SMTP 段的断言全部去掉;左侧栏从 6 个工具变 5 个(文字层 / 格式转换 / 内容提取 / 电子书制作 / 任务),设置页保留四条链路探测;EPUB → AZW3 / MOBI(Calibre)保留 —— 那是格式转换,不是发送。② **电子书制作的实时预览移除**:向导右侧预览列(正文样张 iframe + 封面缩略图 + 手机/桌面宽度按钮)整体拿掉,向导变单列;e2e 相应改为「预览列不存在」的断言(顺带修了一个被切掉的 `this._bookControls = {}`,它会让向导渲染中途抛错)。③ **字体嵌入移除**:向导里的「字体搭配」选择去掉,runner 不再调 `prepareFonts`(字体改由阅读器自带),封面渲染也不再传字体;成品 EPUB 里不再有 `OEBPS/fonts/`(实测 txt → epub 从 ~78KB 降到 55KB);单测里「嵌入字体子集」一条改为「不再嵌入字体」,e2e 的字体断言同理。**测试**:desktop **332**、core 519、shim 40、i18n、eslint、build、e2e(workshop / workshop-book / workshop-epub)全绿。**死代码已清(同日第二轮)**:预览的三个 helper(`renderBookPreview` / `renderBookCoverPreview` / `setBookPreviewWidth`)、示例文字助手、`workshop-fonts.js`、`shared/book-fonts.js` 与 `workshop-fonts.test.mjs` 全部删除;`epub-build.js` 的 `fonts`/`fontFiles`/`@font-face`/OFL 许可、`book-styles.js` 的 `fontFaces` 选项、`prepareFonts` 及其三条单测也一并去掉(封面改用系统字体栈 `COVER_FONTS`)。单测从 332 → **324**(删掉 8 条字体/预览用例,并把「嵌入字体」改为「不嵌入字体」);e2e `workshop-epub` 复测全过。**仍待**:题库 schema 模板(等 pdf_tool 的 vision/box 协议)、P2(LLM 辅助 / 批量模板 / MD↔EPUB / EbookLib / 题目抽取)。
- **进度(2026-10-14,第二轮)**:书坊设置集中化 + W1-4 发送到 Kindle + W1-5 尾巴 + **0.5.0 发布**。① **「设置 → 书坊」独立标签页**(与「存储与同步」同级;桌面壳包一层阅读器设置页,界面中文即可):书坊总开关、文字层/可搜索 PDF(从「存储与同步」迁出)、**MinerU**(云端 token / 本地服务地址 / 本地程序;qbr:mineru:path 自动查找并回填,状态行列出已试路径)、**DocVortex**、**Calibre**、**发送到 Kindle** 全部集中于此;链路检测**原地出结果**(新增 qbr:probe:ocr|docvortex|formula|calibre 直连探测,不入任务队列),「打开 设置 → 书坊」直达该页,输入**边打边存**(不必失焦);各工具面板只留本次任务的选项 + 一行指向「设置 → 书坊」的链接。② **W1-4 发送到 Kindle 完成**:main/kindle-send.js(nodemailer:单附件直发、多附件或 >50MB 自动 ZIP、打完包仍超 50MB 拒发、535/550/552/ENOTFOUND 错误映射、SMTP 检测)+ 主进程 qbr:kindle:probe|send(**授权码只从 safeStorage 读,不进设置文件**)+ 队列 runner kindle-send;设置页 SMTP 段(收件地址 / 服务器 / 端口 / 账号 / 发件地址 + 密码框「已保存;留空不修改」+ 检测 SMTP);书坊「发送到 Kindle」面板(勾书库 EPUB/PDF/DOCX 或本地文件 → 入队发送,任务里看结果)。单测 7 项(真实 SMTP mock 会话、ZIP 解包核对、超限拒发、错误映射、检测),e2e workshop 断言 SMTP 段存在。③ **W1-5 图片 → PDF**:格式转换预设卡,每张一页、按 150dpi 换算页面尺寸,产物落首图旁;单测 + 转换矩阵一行 + 真实素材实测。④ 收口:core/shim/desktop(**248**)/i18n/eslint/build/smoke 全绿,转换矩阵 **64/64**,e2e 9 场景全过;版本升 **0.5.0**,tag → Release(三平台安装包)。**仍待**:题库 schema 模板(等 pdf_tool 的 vision/box 协议)、P2(LLM 辅助 / 批量模板 / MD↔EPUB / EbookLib / 题目抽取)。
- **进度(2026-10-14)**:pdf_tool 的两份需求均已**交付并接入** —— **本地 MinerU**(两种形态:`--mineru-source local` CLI 与常驻服务 `MINERU_LOCAL_URL`;路由优先级 **LOCAL_URL > 云端 token > CLI**;实测同机 3 页:CLI 21.6s、服务冷 11.1s / **热 5.0s**,产物与 CLI 逐项一致,JSON-RPC `doc.convert` 亦验证)与**家具自动清理**(全模式、**默认开、无开关**,计数在 `stats.furniture`;`CSP2021.pdf` 实测页眉/页脚/水印 **0 残留**、代码样例一条不少)⇒ 书坊不再自己做 PDF 家具清理(**不经过 pdf_tool 的 DocVortex 直连仍保留红标预清**)。书坊侧新增:解析方式第四项「**公式优先(本地 MinerU 服务)**」、「本地 MinerU 服务」地址与「本地 MinerU 程序」设置(找不到时自动在 `MINERU_LOCAL_CMD` / sidecar python 同目录 / pdf_tool 下的 `.venv` 里找)、**应用启动自动拉起常驻服务**(退出只收自己拉起的那个;面板可关,并可「检测本地 MinerU / 启动服务 / 清理 MinerU 缓存」);给 pdf_tool 的进程环境补齐 `MINERU_LOCAL_URL`(**先探测 `/v1/health`,健康才给,死地址显式传空**)、`MINERU_LOCAL_CMD`(helper 靠它找 venv python)与 `PYTHONUTF8` / `PYTHONIOENCODING`(中文报错不再乱码)。质量修复:文本型跨页代码合并不再被图上的零散文字打断、**图区裁成图片**(图内文字并入图片、裁前擦掉低不透明度水印)、KaTeX 解析失败原样显示、第二次提取的**资产并目录**(图片链接不再指空)、提取 mark 加版本号、**MinerU 按页切开的代码围栏合并**(`joinSplitCodeFences`)。测试:`desktop:matrix` 转换矩阵进仓库(**63/63**:DocVortex 10 源 × 5 目标 + 文本型 × 5 + 内容提取 + Calibre/CBZ),e2e 9 场景全绿,desktop 单测 240。**仍待**:pdf_tool 的 4 个待确认问题(默认档位 / `layout.json` / 大文档并发 / 超时取消;书坊已给建议)、题库 schema 模板(W1-0 尾巴)、**W1-4 发送到 Kindle**(未开始)、图片→PDF(W1-5 尾巴)、P2 全部;版本仍在 **0.3.1**(0.4.0 / 0.5.0 的 tag 与 Release 尚未发布)。
- **进度(2026-10-12)**:W0 全部完成(0.4.0 可发布);W1-0 ✅(内容提取,题库 schema 模板待接)、W1-1 ✅(Calibre)、W1-2 ✅(构建器 / 字体 / 封面)、W1-3 ✅(向导面板 / 实时预览 / 目录 / 封面预览)、W1-5 部分(EPUB→AZW3/MOBI、图片→CBZ/EPUB 已完成;图片→PDF 待做);**W1-4 发送到 Kindle 未开始**。按用户要求:**此轮后暂停新功能开发**。同日修复制作电子书三类成品问题(图片未嵌入、LaTeX 公式未渲染、预览把二进制当文本读成乱码)与图片提取(DocVortex 只收文档,图片改为先合成单页 PDF 再 OCR),并按用户反馈把面板重排为「四步向导 + 更多工具」;随后修复格式转换的正文误判(pdf_tool/MinerU 把正文段落判成 `code` 块 → 现在按内容还原为段落并转换段内公式)、该误判块的 **caption 丢失**(caption+content 合并、`.md` 用 Doc JSON 补回、图片 caption 输出 `figcaption`),以及按用户要求「公式准确、文字不丢」新增**文字层互补合并**(`main/text-layer.js` + `main/text-merge.js`:先去跨页重复的页眉/水印,正文取 PDF 文字层逐字对齐、MinerU 丢的词逐字补回,公式仍用 MinerU 的 LaTeX;接入公式优先链路、向导 PDF 成书与 `.md` 产物)。

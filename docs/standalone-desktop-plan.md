# 独立桌面版（Electron）实施方案

> 状态：产品定位为**独立桌面应用**（UV Reader / 纽扣），不再作为 Obsidian 插件开发与发布。
> 关联约束见根 `AGENTS.md`；设计契约见 `DESIGN.md`。

## 0. 当前进度（2026-09）

- 插件外壳已移除：删除 `manifest.json`、`versions.json`、根 `main.js`/`styles.css`、插件构建（`esbuild.config.mjs`）与发布校验（`scripts/verify-release.mjs`、`scripts/build-profile.mjs`）；CI 改为桌面端门禁（单测 → shim → 桌面 → i18n → eslint → 桌面构建 → xvfb 冒烟）。
- 包边界建立（M2 起步）：`src/` 迁移为 `packages/reader/src/`，测试、i18n 检查、eslint 与桌面构建路径同步更新；下一步把 `packages/reader/src/main.js` 里的阅读 UI（ReaderView、选文、HUD、PDF 装配）抽成宿主无关模块，逐步去掉对 `packages/host-shim` 的依赖。
- P0 完成：`apps/desktop/` 脚手架与三产物构建（`renderer.js`/`main.cjs`/`preload.cjs` + `base.css`/`styles.css`），不触碰根产物。
- P1 完成：`packages/host-shim` 实现 Plugin/ItemView/Workspace/Vault/Modal/Setting/Notice/Menu/Scope/DOM 扩展/requestUrl/secrets/MarkdownRenderer；27 项契约测试通过（含 `src/main.js` 导入符号对齐）。
- P2 已跑通：`npm run smoke` 在 Electron 中实际启动插件，EPUB（`assets/starter-books/11.epub`）与 PDF 均可打开并达到就绪状态；进度写入 `library/plugin/reading-progress.json`，阅读笔记写入 `library/notes/<书名>.md`，AI 会话拆分到 `data/chat/`。
- P3 已跑通：`npm run e2e`（playwright-core 驱动 Electron）覆盖两条路径——EPUB：翻页 → 在书内 iframe 选中文字 → 弹窗划线 → 断言 `reading-highlights.json` 含 CFI 记录且阅读笔记包含引文；PDF：在 pdf.js 文本层选文 → 划线 → 断言块锚点记录。
- P4 已跑通：同一 E2E 起本地 OpenAI 兼容模拟服务（非流式连接测试 + SSE 流式回答），在真实 AI 侧栏点击“开始使用 AI”、发送问题，断言回答流式渲染且会话写入 `data/chat/<id>.json`（含完整 turns）。
- 运行期修复记录（对应 shim 行为）：`setViewState` 必须调用 `view.setState`；`manifest.dir` 不能为空（否则 `${dir}/x` 变成绝对路径）；`App.plugins.plugins` 必须注册插件实例（`_readerSettings` 依赖）；组件需暴露 `selectEl/toggleEl/sliderEl`；`Setting` 需暴露 `settingEl`；Dropdown `addOption` 不能清空既有选项；`Modal` 必须自带关闭按钮、点击遮罩关闭、Esc 只关最上层并恢复焦点（否则阅读设置等无自带关闭按钮的弹窗无法退出）；拖拽打开要用 `webUtils.getPathForFile`（Electron 32+ 移除了 `File.path`）；打开书籍需有加载遮罩与失败提示。
- 工作区布局：主区分栏只显示 active leaf、右栏（AI 侧栏）独立展开/收起；复用已有视图时必须**先激活再 `setState`**，否则 foliate 在零尺寸容器里无法解析阅读位置（书库点击打不开、PDF 从文件打开无反应的根因）。E2E 已覆盖“书库点卡 → 阅读器切书并隐藏书库”。
- 主区与右栏各有自己的 active leaf：激活 AI 侧栏不再隐藏阅读器/书库（此前右侧栏一激活主区就空白，表现为“返回书库是空视图”“右侧一列竖排控件”）；右栏可纵向滚动，内容不会被裁掉。
- M1.5 界面重构（按用户确认的方案）：顶部全局导航（首页 / 书库 / 设置），阅读页全屏并隐藏导航；首页视图（继续阅读 + 书库新书 + 打开文件）；阅读笔记改为**右栏面板**，与 AI 共用同一个右栏 leaf（`getRightLeaf` 复用已有 leaf），Markdown 用 `marked` 渲染并做基础清理；设置页直接嵌入插件 `SettingsTab.display()`；阅读器顶栏显示全部操作按钮（搜索/目录/高亮/计时重置不再藏进“更多”，底栏只留翻页与进度）；菜单定位做视口边界收敛。`src/main.js` 为此新增了 `opts.showTools` 与 `app.qbrDesktopOpenNote` 两个宿主挂点，根产物已重新构建。
- 顶栏布局（按用户要求）：工具栏 `position: fixed` 占满主窗口宽度；所有操作按钮移到左侧跟在“返回主页”后（书内标题隐藏）；中间为 `‹ 页码输入 / 总数 ›`（上一页/下一页按钮 + 跳页输入）；书名写入窗口标题（`<书名> — 纽扣`）。PDF 缩放控件改为绝对定位到工具栏最右侧。右侧 AI 侧栏与阅读区顶部各让出工具栏高度，互不遮挡。注意：`.view-content.qiaomu-reader-view` 的 `padding-top` 需要 `body` 前缀提高优先级，否则被插件样式表的 `padding:0` 覆盖。
- 目录改为左侧栏（与 AI 侧栏对称）：shim 增加可用的 `leftSplit` 与 `getLeftLeaf`（左栏 leaf 不参与主区激活、detach 后自动收起）；插件目录按钮在桌面端走 `app.qbrDesktopOpenToc` 挂点，打开 `qbr-toc` 视图（标题 + 关闭 + 搜索 + 层级列表，点击跳转），高度与阅读区一致、可关闭、再次点击目录按钮切换。E2E 覆盖“目录开在左侧且阅读器仍可见、可关闭”。关闭按钮复用 AI 面板的图标按钮样式（× 图标）。
- 窗口标题同步修复：同一阅读器 leaf 内换书不会触发 workspace 事件，此前标题停留在上一本；现在同时观察阅读器工具栏标题文本（`view.titleEl`）变化来刷新窗口标题，E2E 断言“书库切书后窗口标题跟随新书”。
- 阅读器 chrome 精简（按用户要求）：移除底栏与上一页/下一页按钮；顶栏中间新增页码跳转控件（输入框 + `/ 总数`，Enter 或失焦跳转；引擎书按 foliate location 估算 fraction，PDF/排版书按页/屏跳转）；滚轮翻页保留。E2E 断言底栏已移除、页码控件存在且能跳页。
- “适合页面”按钮（原专注阅读按钮改为 `fit-page`，设置持久化 `fitPage`）：引擎书把 foliate 的 `margin` 从 48px 降到 16px、`gap` 从 7% 降到 2%，并把 `max-inline-size` 从 `min(720, width/columns)` 放宽到可用宽度（滚动模式按整列宽度，之前会被 720px/列数截半）；自带排版书 `edgePad` 降到 16px 且不再做舒适行宽居中。**PDF**：点击后先切到单页布局（`_readerLayoutSettings()` 在 fit 时把 `columns` 覆盖为 1），再按 `fitPdfPageWidth(view, 0.9)` 放大到页面宽度 = 阅读栏宽度的 90%（`pdfZoomMode = "fit-page-width"`，重排/缩放后仍按 90% 重新适配）；关闭时恢复 fit-page 缩放与用户的分栏设置。实测 1249px 阅读区：EPUB 关=正文 720px/两侧 95px，开=正文 1197px/两侧 26px；PDF 单页宽度约占阅读区 90%（示例 143% 缩放）。E2E 断言 EPUB 与 PDF 两种 fit 行为。
- 主题一致：AI 侧栏/首页/设置不再固定深色，壳把阅读主题的 bg/text/ui/border/accent 映射到 `document.body` 的 Obsidian 变量（`auto` 主题保持壳默认），并同步 `color-scheme`；阅读器 `applyVars` 变化通过 MutationObserver 实时同步。
- 首页打开书籍失败（“无法打开这本书…Could not load a readable book location”）：根因是 `_syncLayout` 优先使用 `activeLeaf`（此时还是首页），新挂载的阅读器被隐藏，foliate 在零尺寸容器里初始化失败；改为**优先 `_pendingActive`**，新视图加载期间即可见。首页同时改为打开时自动调用 `plugin.ensureStarterBooks()` 并轮询刷新卡片（新装/新增书籍后无需重开首页）。
- 阅读交互补充：滚动模式下插件默认隐藏上一页/下一页按钮（`.qiaomu-reader-scrolling .qiaomu-reader-navbtn`），桌面壳通过宿主 CSS 恢复显示并还原三列底栏；插件新增滚轮翻页 `handleReaderWheel`（分页模式任意滚轮翻页；滚动模式仅在滚动容器到达顶部/底部时翻页，450ms 冷却，Ctrl/Cmd/Alt 滚轮与面板内滚轮不拦截），引擎书挂到每个章节文档，自带排版书挂到阅读区。E2E 覆盖分页滚轮翻页与滚动模式按钮可见/可翻。
- API 密钥链路修复：Obsidian 的 `SecretStorage.getSecret` 是**同步** API（插件构造请求头时同步读取），桌面端用 `ipcRenderer.sendSync` + 内存缓存桥接，否则 `cfg.key` 是 Promise、请求头变成 `Bearer [object Promise]`；`SecretComponent` 改为密码输入，粘贴后写入 safeStorage 并把 secret id 交给插件（原先只把输入当作 id，密钥从未保存）；失焦提交不得删除已存密钥（只在用户主动清空时删除）。E2E 新增 DeepSeek + 密钥场景，断言 mock 收到 `Bearer <key>`。
- 细节调整：阅读区滚动条与顶栏/底栏按钮重叠 → 桌面壳改为**顶栏与底栏各自占一行**（不再绝对定位覆盖阅读区，滚动条只在阅读区内部滚动），并禁用桌面壳的沉浸自动收起，保证两栏始终可见、不遮挡；AI 侧栏的 Setting 行允许换行，“获取密钥”按钮不再被挤成竖排文字。此调整与 `DESIGN.md` 第 5 节“HUD 不占文档高度”的 Obsidian 端行为不同，仅桌面壳生效（宿主 CSS 覆盖，未改插件样式）。
- 品牌与工具栏图标：`logo.jpg` 经 `apps/desktop/scripts/import-logo.cjs` 生成透明圆形 logo（`assets/logo.png`）与安装图标（`build/icon.png`，用于打包）；`uvreader_icons.png` 经 `scripts/slice-app-icons.mjs` 切出 16 个白底转透明的 32px 图标（`assets/icons/`），桌面壳以 CSS mask + `currentColor` 渲染并替换工具栏对应图标（返回/AI/适合宽度/目录/搜索/缩放/翻页/批注/笔记/书库等），非桌面宿主仍用内联 SVG 兜底。按用户要求，导航栏与首页不再显示品牌 logo 文字，首页也不再提供“书库”按钮（书库仍可从顶部导航进入）。
- 书库重构（左右布局 + 导航树 + 标签流程）：左侧可收缩导航树（本地书库 → 添加图书 / 标签 / 阅读状态 / 文件夹；网络搜书显示来源数），右侧内容区（搜索框在右侧，顶部不再有品牌与标题）；下载 / 导入 / 主页打开书库外的书自动打标（「下载」「导入」，与已有标签合并，不覆盖）；书籍右键菜单「标签…」可重新选择标签；主页打开书库外的书复制进书库，同一外部路径再次打开复用已有副本（`settings.importedBooks`）；窄容器（≤700px）下侧栏为抽屉。设计记录见 `docs/library-redesign.md`，预览见 `docs/library-redesign-preview.html`。
- 网络搜书稳定性（按用户反馈"全部显示没有找到可下载版本"）：Z-Library 查询预算 20s→35s 并给页面加载加 1.5s 间隔（批量找书不再触发限流→超时→冷却的连锁）；来源因冷却被跳过时如实上报（分组卡片显示"来源搜索失败：…"），不再表现为"没有可下载版本"；OCR 通知与启动响应同 chunk 的时序竞争一并修复（`pdf-ocr.js`）。
- 书中图片查看与 AI 附加（新功能）：点击书内插图（EPUB 章节 iframe 与 PDF 页图）打开可缩放查看器——滚轮/按钮缩放（光标为中心）、拖动平移、双击/单击还原、适应窗口、100%、Esc/遮罩/✕ 关闭；工具栏「附加到 AI」把图片经现有附件管线送入 AI 对话（自动打开侧栏，附件命名取图片 alt 或「插图」+ 时间戳）。实现：`reader-chrome.js` 的 `openImageLightbox`（原 lightbox 升级）+ `attachEngineChrome` 图片入口；`wire.js` 的 `attachImageToAi`/`ensureAiChat`/`imageBlobFromElement`（canvas 取像素，绕开 CSP 对 data:/blob: 的 fetch 限制）。
- AI 工具轮次修复（用户反馈 400 "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"）：模型只调工具、没有文字的 assistant 轮次在保存时被 `filter(turn => turn.content)` 丢掉，恢复后留下孤立 tool 消息。现在 `normalizeAiChatHistory` 保留带 toolCalls 的空文本 assistant 轮次、丢弃无对应调用的孤立 tool 结果，并在 `aiMessages` 发送前再做一次一致性裁剪（含"调用无结果"的中断轮次降级为纯文本），旧会话在加载时自愈。
- 工具栏统一 toggle 与按下态（用户反馈）：AI 伴读按钮此前只能打开不能关闭，现与目录/批注一致——再点关闭侧栏（`reader-view.js` 的 `_toggleAiCompanion`，关闭状态判断用 `plugin.aiCompanionOpen()`；宿主没有该方法时退回直接打开）。三个开关在打开时加 `qiaomu-reader-ibtn-on` + `aria-expanded="true"`（`_syncToolButtons`），样式为强调色底 + 内阴影且悬停不消失；目录按钮（桌面走左栏 leaf）由壳在 leaf 变化时同步（`entry.js` 的 `syncReaderToolButtons`），批注停靠面板的 ✕ 关闭也会复位按钮（`wire.js`）。单测覆盖开关与同步，E2E 断言目录按钮的按下/复位（含计算样式）与 AI 按钮的关-开切换。
- 书库重复导入修复（用户反馈"正在阅读 / 导入标签里好几本《萤窗小语》"）：根因是首页卡片把**库内相对路径**交给 `openBook`，而 `openBook` 只把「绝对路径位于库根下」判为库内，于是库内书被当成外部书复制入库——每打开一次产生一个 `书名 (1).epub` 副本，自动打「导入」标签并生成独立阅读记录（副本也进入「正在阅读」）。修复：`openBook` 先按库内相对路径解析（`vault.getAbstractFileByPath`）再判绝对路径；`importBookToLibrary` 加 `existingVaultBookPath` 守卫（源路径已指向库内文件时直接复用，不复制）。测试：`tests/library-import.test.mjs`（vm 提取方法 + 假库）与 `library-data.test.mjs` 的 `existingVaultBookPath`；E2E home 场景断言从首页打开库内书不再产生副本。已有的历史重复（《萤窗小语》×3）已备份清理并合并会话。
- OCR sidecar 解析修复（用户反馈"找不到 OCR 程序：pdf_tool_reader.exe"）：设置里 `ocrSidecarExe` 存的是裸文件名且 exe 不存在时，旧逻辑直接失败、不会回退到可用的 `pdf_tool` 目录。现在裸文件名会先在 `ocrSidecarDir` 与打包资源目录里查找；exe 失效但目录可用时回退到 `python -m pdf_tool.reader` 并在日志说明。`apps/desktop/test/pdf-ocr.test.mjs` 覆盖裸名解析与回退；实测真实 sidecar `probe` 返回 `ok`。
- 目录滚动条被工具栏遮挡修复（用户反馈"长目录只有下箭头，没有上箭头"）：左/右栏自己带 `overflow-y:auto`，同时又有 `padding-top:40px` 让开固定的阅读工具栏——滚动条画在整个栏的边框盒上（从窗口 y=0 开始），顶部 40px 被工具栏盖住，上箭头消失。现在栏本身不再滚动（`overflow:hidden` + flex 列），由栏内视图滚动（`flex:1 1 auto; min-height:0; overflow-y:auto`），滚动条从工具栏下方开始、上下箭头与滑块完整；AI 侧栏/笔记栏同构。实测 82 项目录（道德经）：栏 `scrollHeight=clientHeight`、视图从 y=40 起滚动；E2E `ebook/ai/toc` 通过。
- 书坊页面设计（文档处理 / 格式转换 / 电子书制作，设计稿）：新增导航页「书坊」，左栏五组（文字层与可搜索 PDF / 内容提取 / 格式转换 / 电子书制作 / **发送到 Kindle** / 任务），右栏工具面板 + 底部任务条；输入来自书库（本地文件就地处理），产物默认落源文件旁，**不单独建书坊目录**，派生文件命名：扩展名与源相同才加语义后缀（`.uvtext.pdf`），扩展名变化直接换后缀；不加标签。三页命名与 Logo：**悦空间 Reading Space**（打开的书+星光）、**书库 So Cool**（三本书，沿用现有图标）、**书坊 So Fun**（打开的书+魔杖星光）；导航=图标+中文名，页头=中文主标题+英文小写大写弱化字；备选见 `docs/page-logos.html`。**预览与样式**：向导右侧实时预览（封面/目录/章节样张，同一套 CSS 的 iframe，样式改动即时重渲染，EPUB 只在生成时构建）；样式含字体/字号/行距/缩进/主题；封面支持指定图片、首图自动、模板生成（1600×2400）与 AI 文案；目录自动分章+手动改名/合并/拆分/排序。**LLM 辅助**（可选可撤销，复用伴读 AI 配置）：AI 清理（OCR/断行/漏标题）、AI 分章建议、AI 元数据推断、AI 封面文案。后端分工：pdf_tool 负责 PDF/OCR（文字层、可搜索 PDF、结构化提取），**DocVortex**（已安装，MIT，20 入 / 7 出：Office/ODF/HTML/EPUB/OFD → md/html/docx/pdf/epub/latex/json）负责文档互转，**Calibre 以 CLI 外置进程集成**（`ebook-convert`/`ebook-meta` 9.15.0，本机已装；检测顺序=自定义路径→常见安装位置→PATH，未装给下载引导；参数 `--title/--authors/--cover/--chapter XPath/--toc-threshold/--extra-css`；EPUB→AZW3/MOBI 换扩展名；体积大且 GPL-3 不随包分发，未装时 EbookLib 兜底）；**发送到 Kindle 走 Amazon 邮件通道、EPUB 直发**（SMTP + 授权码存 safeStorage，Amazon 侧需加入已批准发件人列表，单封 ≤25 附件/≤50MB 超出自动 ZIP），与 AZW3 转换并存。在线提取复用伴读 AI 配置、行为保持现状。分期 P0（文字层批量 + PDF→MD/HTML + 文档互转 + 任务队列）→ P1（电子书向导：预览/样式/封面/目录 + 发送到 Kindle + EPUB→AZW3 + PDF→EPUB + 图片→PDF/CBZ）→ P2（LLM 辅助 + 批量模板 + Markdown→EPUB + EPUB→Markdown + 题目抽取）。设计记录见 `docs/workshop.md`，交互预览见 `docs/workshop-preview.html`。
- 待办：`base.css` 组件细节；P5 CLI/ACP 实测（Electron 原生 `window.require`）；打包签名；Windows 外的平台验证。
- 书坊实施计划（0.4.0 = P0 → 0.5.0 = P1 → 0.6.0 = P2）：任务分解 W0-1..W0-6（导航/队列/文字层/DocVortex/命名/收口）、W1-1..W1-6（Calibre/EPUB 构建/向导预览/Kindle/AZW3/收口）、W2-1..W2-5（LLM 辅助/批量模板/格式互转/EbookLib/题目抽取），含文件、验收、测试、依赖图、风险与发布节奏；详见 `docs/workshop-implementation.md`。
- 书坊 W0-1 完成（导航与页面骨架）：导航改为「悦空间 / 书库 / 书坊 / 设置」+ 内联 SVG 图标（打开的书+星光 / 三本书 / 打开的书+魔杖 / 滑杆，见 `icons.js` 新增 `reading-space`、`books`、`workshop`）；新增 `qbr-workshop` 视图（`views.js` 的 `createWorkshopView`：左栏六工具分组——处理 4 + 发送 1 + 队列 1、右栏面板、收起按钮、工具与折叠状态记忆到 localStorage）；`entry.js` 接入 `showRoute("workshop")`、视图工厂与 `syncChrome` 激活态；`base.css` 新增书坊样式。E2E 新增 `workshop` 场景（6 工具、面板单选切换、路由记忆），`home/library/ebook` 回归通过；eslint/单测/i18n/build 全绿。
- 书坊 W0-2 完成（任务队列）：新增 `apps/desktop/src/main/workshop.js`（任务模型、串行 drain、进度 `report`、AbortController 取消、重试、历史最近 20 条落盘到 `userData/workshop-tasks.json`、`register(kind, runner)` 供 W0-3+ 注册）；主进程注册首个真实任务 `probe`（探测 OCR sidecar）+ IPC `qbr:workshop:{list,start,cancel,retry,clear}` + 状态推送 `qbr:workshop:state`；preload 暴露 `qbrDesktop.workshop.*`（`onState` 返回取消订阅）；书坊「任务」面板（运行环境自检/清空历史、任务行含进度条/状态/取消/重试/产物）与底部任务条（运行中显示、完成隐藏、点击查看任务）。测试：`apps/desktop/test/workshop.test.mjs` 6 项（串行/进度/取消排队与运行中/失败重试/历史落盘与重载/未知类型）；E2E `workshop` 场景新增真实 probe 任务（完成并列入面板）；全量门禁与 `home/library/ebook` 回归通过。
- 书坊 W0-3 完成（文字层与可搜索 PDF）：新增 `apps/desktop/src/main/workshop-ocr.js`（`ocr-cache` 逐页 OCR 写入阅读器同一缓存、`ocr-export` 驱动导出、相对路径按库根解析、取消时 cancel/close 会话）与共享命名 `src/shared/workshop-names.js`（`<源名>.uvtext.pdf`，冲突自动 `(1)` 且后缀贴扩展名）；`pdf-ocr.js` 的 `openSession` 改为 async 并返回 `doc.open` 的页数/扫描页（阅读器调用兼容）；主进程新增 IPC `qbr:workshop:{pick-files,save-as}`（多选本地文件 / 另存为对话框），preload 同步；书坊「文字层」面板变为可用：书库 PDF 勾选列表、本地文件自动导入、生成文字层 / 导出可搜索 PDF 两种方式、另存为、批量入队、最近任务。修复两处小问题：runner 的 `log` 默认值误用 console 对象（改为函数）、书坊样式 `display` 盖过 `[hidden]` 导致任务条/另存为行常显（`.qbr-workshop-view [hidden]{display:none!important}`）。测试：`apps/desktop/test/workshop-ocr.test.mjs` 5 项（命名/缓存逐页与清理/导出进度与路径/取消）＋ `pdf-ocr` 用例补 `doc.open` 页数；E2E 新增 `workshop-ocr` 场景（真实扫描件生成文字层 + 导出 `.uvtext.pdf`），`workshop/ocr/home/library/ebook` 回归通过。
- 书坊 W0-4 完成（文档互转 DocVortex）：新增 `apps/desktop/src/main/docvortex.js`（候选解析：自定义路径 → PATH `docvortex` → `python -m docvortex`；`--version` 探测；转换带超时/取消、产物必须存在）与共享格式表 `src/shared/workshop-formats.js`（20 入 / 7 出）、命名 `convertPath`（目标扩展名 + 冲突序号）；runner `docvortex-probe`（检测）与 `docvortex-convert`（相对路径按库根解析）；「格式转换」面板可用：预设矩阵（其余五项标注「后续阶段」）、按输入格式过滤的书库勾选列表、本地文件自动导入、目标格式下拉、检测按钮 + 可选 DocVortex 路径（持久化到设置）、批量入队、状态行与最近任务。测试：`apps/desktop/test/docvortex.test.mjs` 9 项（命名/参数/候选/探测回退/转换成功·失败·取消/两个 runner）；E2E 新增 `workshop-convert` 场景（自造最小 DOCX → 真实 CLI 转 Markdown 并校验文本落库），全量门禁与 `workshop/workshop-ocr/home/library/ebook` 回归通过。
- 书坊 W0-5/W0-6 完成（产物操作与收口）：任务行产物操作补齐「打开产物」+「**在文件夹中显示**」（`showItemInFolder`）；新增**书坊入口开关** `settings.workshopEnabled`（默认开，关闭时导航隐藏且路由回首页，`syncChrome` 同步、E2E 断言隐藏与恢复）；收口门禁：单测 0 fail、`test:shim` 40、`test:desktop` 82、i18n 1464、eslint 0、build 0、smoke boot ok，E2E `workshop/workshop-ocr/workshop-convert/pdf/ocr/home/library/ebook` 全过。壳层面板沿用首页的中文文案（阅读器包设置项的 9 语言随 W1-4 发送到 Kindle 一起补）。**P0（0.4.0）功能全部完成**，可发布。
- 书坊 W0-4 实测反馈修复：确认 DocVortex 转换扫描件走它**自带的本地 OCR**（`~/.docvortex/model/MinerU-4_models_onnx` 约 226MB：PP-DocLayoutV2 版式 + PP-OCRv6 tiny det / small rec），与 pdf_tool 的 rapidocr 无关；公式上下标受其 OCR 限制（无公式模型，面板加提示，公式多的文档留待 pdf_tool 内容提取）。CLI 转换期间**零进度输出**（实测仅结束时打印产物路径）→ 任务队列补 `startedAt`，任务行与底部任务条改为**不确定态滑动条 + 秒表**（`syncTicker` 每秒刷新、视图关闭清理），转换中不再像卡住。
- 修复「本地文件自动导入书库」在桌面壳失效：shim 的 `getAbstractFileByPath` 会把库外绝对路径解析到真实文件系统（这是有意的，用于读取库外文件），`importBookToLibrary` 因此把磁盘上任何存在的文件当成「已在库内」而**跳过复制**（用户实测 DocVortex 转换本地 PDF 时产物落在原目录，即此因）。新增纯函数 `isInsideVaultPath`（绝对路径只有在库根下才算库内，相对路径照旧；库根未知时不设限），`importBookToLibrary` 用它兜底；单测覆盖 `tests/library-data.test.mjs` 与 `tests/library-import.test.mjs`（后者模拟桌面 shim 的宽松查找：库外仍复制、库内绝对路径仍复用）；E2E `workshop-convert` 改为从库外文件开始（导入 → 转 Markdown → 产物落在书库副本旁）。
- 书坊「公式优先」链路完成（A 方案，MinerU → DocVortex）：确认公式质量来自 MinerU（本地 rapidocr 无公式模型），DocVortex 渲染管线完整（LaTeX→MathML→OMML/MathML/ziamath），桥用 HTML 里的 `<script type="math/tex">`（实测 DOCX 真 OMML）。新增 `apps/desktop/src/main/formula-html.js`（Doc v1 → HTML 纯函数：标题/文本/公式/表格/图片/代码/题目，行内 `$…$` 与 `$$…$$` 包装、转义、图片相对路径）与 `apps/desktop/src/main/workshop-formula.js`（`pdfToolScriptCommand` 解析 checkout、`pdfToolArgs`、按源文件哈希的缓存目录、`createFormulaChain` 驱动 pdf_tool 并生成 bridge.html、runner `formula-probe`/`formula-convert`）；「格式转换」面板新增「解析方式：本地解析 / 公式优先(MinerU 云端,PDF)」（PDF 才走链路）、「检测公式链路」按钮与状态行、最近任务含公式任务；面板 payload 带上 pdf_tool 设置（`ocrSidecarDir/ocrSidecarExe/ocrPython`）。测试：`apps/desktop/test/formula-html.test.mjs`（6 项）＋ `formula-chain.test.mjs`（7 项：命令/参数/缓存/成功·失败·取消/两个 runner）；E2E `workshop-formula`（默认跳过，`QBR_E2E_MINERU=1` 真跑云端：3 页 → 50 OMML/10 下标）。真机实测：14 页扫描件经 UI 全流程 → DOCX **197 OMML（96 下标 / 52 上标）**，任务条阶段标签 `MinerU 云端解析 → DocVortex 转换`。
- 修复公式链路「找不到 MinerU 凭据」（用户现场：机器级环境变量在应用启动后才设，进程看不到）：凭据解析改为**面板「MinerU 凭据」→ 进程环境 → Windows 注册表**（`HKCU\Environment` + HKLM Session Manager 环境，`reg query`，免重启），并经子进程环境（而非命令行）传给 pdf_tool；「转换设置」新增 MinerU 凭据输入（只在公式优先时露出，持久化到设置），`formula-probe`/失败提示都给出可操作文案（traceback 翻译成「填写凭据或设环境变量后重启」）。单测补 `resolveMineruToken`/`friendlyPdfToolError`/环境传递（desktop 98 项）；真机验证：应用进程**没有**环境变量时，probe 通过、3 页链路 → DOCX 47 OMML/10 下标（注册表兜底生效）。
- 公式方案定调：**采用 A**（MinerU → DocVortex，质量优先），**B 方案记录备忘**在 `docs/docvortex-formula-upstream.md`（把公式识别做进 DocVortex 的 OCR 路径：实施钩子/优势/代价/中间路线 B′/触发条件/复现资料），等离线或隐私需求出现时再启动。**A-local（本地 MinerU）交 pdf_tool 实现**：需求文档 `pdf_tool/docs/reader-request-mineru-local-2026-10-11.md`（`--mineru-source auto|cloud|local`、档位 basic/standard/advanced、输出契约不变、验收与 8GB 硬件参考）；书坊侧等 pdf_tool 就绪后加「公式优先(MinerU 本地)」并透传参数，其余不动。
- 文字层导出简化（用户反馈）：去掉「另存为…」按钮（未生成完也能点、且没必要），导出固定在**源文件旁** `<源名>.uvtext.pdf`、**同名直接覆盖**（可重复导出，不再自动加序号）；同步移除 `qbr:workshop:save-as` IPC/preload 与 `uvtextPath` 的冲突编号参数；E2E `workshop-ocr` 增加「重复导出不产生 (1) 副本」断言。
- 书坊「本地文件」流程调整（用户反馈）：本地文件**就地处理、不再导入书库**（原文件留在原处），产物一律落在**源文件旁**（文字层 `.uvtext.pdf` 同名覆盖；互转/公式链路产物在源文件旁）；面板提示改为「本地文件就地处理,产物落在源文件旁」。E2E `workshop-ocr` / `workshop-convert` 各增「库外文件就地处理」断言（产物在源文件旁、书库无副本）。
- 预设矩阵分工规划（用户反馈「有些转换是不是已经实现/有的属于电子书制作」）：按**保守程度**定调四层——**文字层**(最保守)>**格式转换**(内容+版式)>**内容提取**(只要内容、可丢版式;**JSON/结构化与 schema 模板在此**)>**电子书制作**(内容+新样式,支持 **txt** 输入)。**格式转换**目标格式去掉 JSON(`structured_content`);DocVortex 矩阵 + Calibre EPUB→AZW3/MOBI + 图片→PDF/CBZ;**HTML→EPUB、PDF→Markdown 纯文本版今天就可用**(提示分流);Markdown→EPUB 需先转 HTML(DocVortex 不接受 md),随向导 W1-2;高保真提取补为 **W1-0**(原实施计划缺失),含**图片提字**与**结构化 JSON / 题库 schema 模板**;预设卡片改为**路由/预填**到对应工具。写入 `docs/workshop-implementation.md`「功能归属与预设矩阵」与 `docs/workshop.md` §5.2/§5.3/§5.4。
- 命名规则与向导输入定调（用户反馈）：① 命名规则=**输出扩展名与源相同才加语义后缀**（文字层 pdf→pdf 用 `.uvtext.pdf`；格式转换/内容提取扩展名变化就不加后缀，直接换扩展名；同扩展名转换用 `(n)` 序号，不覆盖源文件）；内容提取产物改为 `<源名>.md|html|json` + `<源名>.assets/`（去掉 `.uvdoc` 段），`docs/workshop.md` §7、实施计划与设计预览同步。② **电子书制作输入直接支持 PDF / Office（docx/pptx/xlsx…）**：非文本源由向导内部自动走提取/转换（内容提取、DocVortex），**中间环节用户无感**；W1-2 构建器与向导内容源照此更新。
- 预设归属落地（用户反馈）：**打开本地文件对话框**过滤集合扩为「电子书 + Office/ODF/OFD/HTML + 纯文本 + 图片」(`WORKSHOP_PICK_EXTENSIONS`,默认过滤器就能看见 docx/pptx/odt/ofd 等);**预设卡片各归其位**——格式转换只留 3 张(文档互转、EPUB→AZW3/MOBI、图片→PDF/CBZ),「PDF→干净电子书」「Markdown/HTML→EPUB」移到**电子书制作**面板,「PDF→Markdown」「结构化 JSON/题库模板」「图片→文字」移到**内容提取**面板(均为计划中占位)。新增 `apps/desktop/test/workshop-formats.test.mjs`(过滤集合含 Office/ODF/OFD/txt/md/图片;格式转换目标不含 JSON)。文档:实施计划预设归属表、`workshop.md` §5.2/§5.3/§5.4。
- 预设归属再定调（用户反馈）：**输出是电子书（EPUB/MOBI/AZW3/CBZ 等阅读器格式）的功能全部归「电子书制作」**——格式转换面板去掉 EPUB 目标（`DOCVORTEX_FORMATS` 只剩 md/html/docx/pdf/latex）与「EPUB→AZW3/MOBI」卡片（挪进电子书制作预设）；格式转换只剩「文档互转、图片→PDF」两张卡；输入侧不受限（EPUB 仍可作互转输入）。公式优先链路的提示改为「真公式 DOCX / PDF；要 EPUB 走电子书制作」。测试与文档同步。
- 电子书制作首批功能落地(继续 P1):**W1-1 Calibre 集成**完成(`main/calibre.js`:自定义路径→常见安装位置→PATH 的候选检测、`--version` 探测、`ebook-convert` 转换带超时/取消、缺失时给可操作提示);**「EPUB → AZW3 / MOBI」**可用(书库/本地文件 → 目标格式 → 产物落源文件旁);**「图片 → CBZ / EPUB」**可用(`main/cbz.js` 自打包:png/jpg/webp/gif/bmp/tiff/jp2,自然排序 1<2<10、同名序号、输出 `<目录名>.cbz`;EPUB 先打 CBZ 再交 Calibre);电子书制作面板:两张卡就绪 + 检测 Calibre + 路径设置 + 最近任务。测试:calibre(7)/cbz(5)/workshop-book(5)共 17 项,E2E `workshop-book`(图片→CBZ 自然排序、EPUB→AZW3 10.9KB、图片→EPUB 50KB,真实 Calibre;无 Calibre 时跳过转换部分)。
- 电子书字体与排版定调（用户输入）：**字体**用[乔木封面字库](https://github.com/joeseesun/qiaomu-cover-fonts)（34 款 SIL OFL，12 套「标题/正文/英文」搭配，WOFF2 子集，`index.json` 带 SHA-256）——**按需下载 + 校验缓存**(`userData/font-cache`)，**嵌入 EPUB 前子集化**(`pyftsubset`→TTF，子集改名 `QBR <字体名>`，OFL 文本随包；抖音美好体等 no-modify 字体只用于封面)；**版式**=单栏流式(reflow，不写死字号，新章起新页，图片居中)；**样式设置**=顶层 5 项(字体搭配/字号/行距/边距/主题)+ 高级折叠(缩进/段距/对齐/标题/引用/代码/图片/章节起始)，默认 17px / 1.75 / 5% / 两端对齐 / 2em 首行缩进。写入 `docs/workshop.md` §5.4 与实施计划 W1-2/W1-3。
- 电子书向导 W1-2 完成(构建器 + 字体子系统):新增 `main/epub-build.js`(EPUB 3:存储 mimetype、container、OPF 元数据/清单/spine、nav + NCX、章节 XHTML、封面页、版权与字体许可页;`renderBookCss` 单栏流式样式:主题/字号/行距/边距/缩进/对齐/标题/引用/代码/图片,预览与成品共用)、`main/text-book.js`(「第X章/回/卷、Chapter N、序章/楔子/后记」等标题识别分章,无标题按长度分块;纯文本段落化 + 最小 Markdown 渲染)、`main/workshop-fonts.js`(乔木封面字库 12 套搭配与文件表、按需下载 + 缓存 + SHA-256、许可文本抓取、fontTools 子集化脚本(子集改名 `QBR …`)、字符集收集)、`main/workshop-epub.js`(`book-build` runner:txt/md → 章节 → 字体(pairing 下载或本机字体文件)→ 子集 → EPUB;子集不可用时回退原文件/系统字体)。实测:朱雀 2.5MB WOFF2 → **22KB 子集**(整本 27.8KB),阅读器直接打开;e2e `workshop-epub` 覆盖(含许可文件断言)。测试:workshop-fonts(5)/epub-build(6)/text-book(6)/workshop-epub(5)。依赖备注:WOFF2 子集化需 Python `fontTools` + `brotli`(本机已装 brotli);TTF/OTF 字体不需要 brotli。向导 UI(W1-3)后续。
- 电子书向导 W1-3 完成(面板 + 实时预览):「电子书制作」面板新增「快速成书(txt / Markdown → EPUB)」:书稿选择(书库 txt/md 勾选 + 本地文件)、书名/作者、**12 套字体搭配**、字号/行距/边距滑块与主题(跟随阅读主题/纸白/暖纸/青瓷/夜间)、高级折叠(首行缩进/段间距/对齐/标题对齐)、**iframe(blob)实时预览**(手机/桌面宽度;选中书稿后显示其开头,样式改动即时重渲染,与成品共用 `renderBookCss`)、「生成 EPUB」入任务队列;样式持久化 localStorage;预设卡 `txt → EPUB`、`Markdown / HTML → EPUB`(Markdown 已可用)点亮为可用。为共享样式/字体表新增 `src/shared/book-styles.js` 与 `src/shared/book-fonts.js`(主进程与渲染层共用,避免预览与成品走样)。测试:desktop 139 全过;E2E `workshop-epub` 扩展 UI 路径(选择书稿 → 预览出现稿件文字 → 生成 47KB EPUB → 阅读器打开);门禁 core 515/shim 40/i18n/eslint/build/smoke 全绿。封面与 PDF/Office/图片源后续。
- 电子书封面完成(2026-10-12):新增 `main/cover-render.js`(模板封面 1600×2400:暖纸/纸白/青瓷/夜墨四色、标题/副标题/作者、嵌入所选搭配字体;纯 HTML/CSS → Electron 离屏窗口 → `capturePage` → JPEG;**字体写成临时文件用 `file://` 引用**,绕开 data URL 2MB 上限(covers 之前正是因 `ERR_INVALID_URL` 静默失败);窗口创建后再 `setContentSize` 绕开 Windows 把窗口高度截到屏幕高度的问题)、`resolveCover`(指定图片:注入的 nativeImage 统一转 JPEG;自动:Markdown 首图,缺图回退模板;模板:调离屏渲染)、面板「封面」行(模式/配色/副标题/选择图片,持久化)。EPUB 内封面进 OPF(`cover-image` + `<meta name="cover">` + spine 首项)。测试:cover-render 5 项(离屏窗口假实现、临时文件与清理、auto/模板/指定图片分支);E2E `workshop-epub` 断言模板封面是真 JPEG(75KB)且向导默认产出封面(82KB EPUB);门禁 core 515/shim 40/desktop 144/i18n/eslint/build/smoke 全绿。
- 向导补强(2026-10-12):**封面实时预览**(面板 176×264 缩略图,与离屏渲染共用同一份 `coverHtml`;配色/副标题/书名改动即时更新)+ **目录编辑**(共享纯函数 `src/shared/book-chapters.js`:改名 / 与下一章合并 / 按段落中点拆分(第二章标题自动加「（下）」)/ 上下排序;选中书库书稿后自动分章并列出标题与字数,编辑结果作为 `payload.chapters` 提交,runner 优先使用面板目录;本地文件仍自动识别)。测试:book-chapters 6 项 + runner「面板目录优先」1 项 → desktop 151;E2E `workshop-epub` 断言封面预览出现书名、识别出 2 章、改名后的标题进入 EPUB nav(向导产物 84.9KB)。
- 内容提取 W1-0 完成(最后一轮新功能):新增 `main/extract-doc.js` —— PDF 走 pdf_tool(`pdf_to_doc.py`,模式 auto/mineru/text/vision;产物 `<stem>_doc.md|.html|.json`、`<stem>_audit.json`、`mineru/` 在 runner 里**按 §7 改名**为 `<源名>.md|.html|.json|.audit.json` + `<源名>.assets/`,并改写产物里的 `mineru/` 资产引用;同名加序号不覆盖);Office/ODF/OFD/HTML/EPUB/**图片**走 DocVortex(→ `<源名>.md|.html|.json`)。共享表 `src/shared/extract-formats.js`(输入类别/模式;渲染层不引主进程模块)。「内容提取」面板:书库/本地文件选择(PDF/Office/OFD/HTML/图片)、PDF 模式选择、**检测提取链路**、批量入队、最近任务与**结果预览**(vault 内产物:Markdown 开头 1500 字 + `<源名>.audit.json` 体检摘要)。**向导接入更多源**:`book-build` 对非文本源**内部先提取**(中间产物放 `userData` 缓存,用户无感),提取的 Markdown 按 1–3 级标题分章;书稿选择器与本地文件过滤扩到全部支持格式。测试:extract-doc 7 项 + workshop-epub「office 源先提取再成书」1 项 → desktop **159**;E2E 新增 `workshop-extract`(书库 DOCX → 面板提取 md/json 落源文件旁 + 预览可见 → 向导直接吃 DOCX 出 EPUB),回归 `workshop/workshop-ocr/workshop-convert/workshop-epub/home/library` 全过;门禁 core 515/shim 40/i18n/eslint/build/smoke 全绿。**按用户要求:此轮后暂停新功能开发**(剩余:题库 schema 模板、发送到 Kindle、图片→PDF)。
- 渲染层收紧（安全）：主窗口加 `will-navigate`/`setWindowOpenHandler` 守卫（外链交给系统浏览器，`window.open` 一律拒绝）；Markdown 清洗升级为 `renderer/sanitize.js`（标签与 URL 协议白名单，notes/AI 输出统一入口，另配点击兜底）；CSP 去掉 `script-src` 的内联脚本许可；来源窗口（登录/页加载/下载）只允许 http(s) 加载；下载格式白名单与大小上限；OCR 请求加超时。剩余：`contextIsolation`/`sandbox` 翻转（需把 shim 的 fs 端口改为 IPC）与 `webSecurity` 关闭项清理。
- 制作电子书质量修复 + 界面重排（2026-10-12，用户实测反馈）：修掉三类成品问题——**图片**（章节 HTML 引用的本地图片按提取目录解析后嵌入 EPUB `images/image-N.*`，缺失/不支持格式丢弃并记日志；新增 `epub-build.collectBookImages`）、**公式**（新增 `main/math-render.js`：`collectLatex` 收集 `$…$`/`$$…$$`/`\(…\)`/`\[…\]`，Python `latex2mathml` 一次转 MathML，行间公式标 `display="block"`，失败回退原文不阻断出书；`text-book.markdownToHtml({ renderMath })` 负责替换）、**假代码块**（新增 `shared/markdown-fix.js`：MinerU 偶尔把正文段落包进没有语言标记的围栏，段落因此变代码块、公式不渲染，`unwrapProseFences()` 把「像正文」的围栏拆回段落、真代码块保留；向导读 md / 提取路径 / 预览都先过一层）。**预览不乱码**：预览只把 txt / md 当文本读（Markdown 渲染后显示），非文本源优先读同目录已提取的 `<源名>.md` 并标注来源，否则示例文字 + 「生成时自动提取」提示。**图片提取修复**：DocVortex 的 `convert` 只收文档（直接给图片报 `Unsupported native input format: jpeg/png`，加 `--parse-mode ocr` 也不行），改为先用 Pillow 合成单页 PDF 再走 `--parse-mode ocr`（临时 PDF 跑完删除），内容提取面板与向导图片源共用。**面板重排**（用户「界面层次不清晰，重新设计」）：向导四步（① 内容 ② 目录 ③ 书名与封面 ④ 排版样式）+ 右侧全程预览，「更多工具」收 EPUB → AZW3/MOBI、图片 → CBZ/EPUB 与折叠的 Calibre 设置，向导上方的预设矩阵撤掉。实测用户论文（7 页 `1.DUL+paper.pdf`）：3 张图全部嵌入、34 条公式全部转 MathML（0 处遗留 `$…$`）、5 章、120KB。测试：desktop **171**（math-render 4 / text-book +2 / workshop-epub「图片 + 公式」1 / extract-doc 图片转 PDF 2 / markdown-fix 3）；E2E `workshop-epub` 扩展（md + 图 + 公式构建断言、四步结构、非文本预览读已提取 md），`workshop-extract` 扩展（canvas 画 PNG → 提取 OCR 出文本）。
- 格式转换「正文误判」修复（2026-10-12，用户实测 `1.DUL+paper.html`）：两栏论文转 HTML 后有两段正文显示成代码。定位：上游 pdf_tool / MinerU 把这两段判成 **`code` 块**（Doc JSON `type: "code"`、md 里是无语言围栏），`formula-html.blockToHtml()` 忠实照搬成 `<pre><code class="language-latex">`，段内的 `$…$` 因此也不转换。修法：`shared/markdown-fix.js` 抽出 `looksLikeProseBlock()`（去掉 `$…$` 后无代码 / LaTeX 特征 + 有句子 + 够多词 → 正文），`formula-html.codeBlockHtml()` 据此把 `code` 块按段落渲染（新增 `joinProseLines()` 把 PDF 硬换行并回一段、断开的数字粘回 `61.\n91` → `61.91`，段内公式照常转 `<script type="math/tex">`），`adoptPdfToolOutputs` 对 `.md` 产物做同一处理。实测同一份 Doc JSON 重跑链路的 HTML：`data-block-type="code"` 2 → 0、段落 37 → 39、公式 span 73 → 89、标题 10 / 图片 24 / 总字数不变；两段正文恢复为 `<p class="docvortex-text">`，`\(6 5 ~ ^ { \circ } \mathrm { C }\)` 等段内公式正常。**第二轮（caption）**：用户接着发现段落**开头整句不见**——MinerU 把正文前半段塞进了块的 `caption` 字段，而 MinerU 自己的 `.md` / `.html` 写作器都丢弃 caption，我们的渲染也只读 `content`。修法：`codeBlockHtml()` 把 caption 与 content 合并成一段（真代码块的 caption 作为说明段置前）、`image` 块 caption 输出 `<figcaption>`（DocVortex → `image_caption`）、`adoptPdfToolOutputs` 在拆假围栏前用 Doc JSON 把 caption 补回 `.md`（向导与预览因此也完整）。实测：段落 39（不变）、公式 89 → 91、字数 +827，`In the experiments, the silicon wafer capped with a 4-μm thick SiO2 layer…` 回来了；用户 Downloads 里的 HTML 已用同一份缓存重生成。附带发现（**上游缺陷**）：`The 1 2 Y-branch` 少了 `×`、`at the speed of 3000 rpm for` 少了 `3000 rpm for`——MinerU 返回的文本里就没有（md / JSON 均查无此串），而 **PDF 文字层是完整的**。
- 论文「文字层互补」合并（2026-10-12，用户要求「公式准确、文字不丢」）：新增 `main/text-layer.js`（PyMuPDF `page.get_text()` 逐页文本，写 UTF-8 文件而不是 stdout——Windows 控制台编码会破坏连字 `ﬁ`）+ `main/text-merge.js`，在公式优先链路里把**正文取文字层、公式取 MinerU 的 LaTeX** 合并：
  - **先清页眉/水印**：按行统计跨 ≥3 页重复的行并删除（实测只命中期刊页眉、IEEE 下载戳、running title 三行，正文一行没动）。
  - **对齐**：压缩键（NFKC + 小写 + 只留字母数字汉字；短键要求词边界，避免 `30` 命中 `3000`）+ 长段落 ~8 词分块、失败二分；两个锚点之间的间隙正是 MinerU 丢掉的词，逐字补回；公式位置换成 LaTeX（字形跳过不重复）；任一段对不上即整段回退 MinerU 原文（不猜不造）。
  - **接入**：`createFormulaChain.prepare()` 在生成 HTML 前合并（格式转换的 HTML/DOCX 因此都受益）、`extractMarkdown()`（向导吃 PDF）改用合并稿成书、`extract-pdf` runner 把 `.md` 产物改写成合并稿（图片引用照 §7 改到 `<源名>.assets/`，`.json` 仍是 MinerU 原始记录）。
  - **实测** `1.DUL+paper.pdf`：补回 `3000 rpm for`、`×`、`designed`（断词）、公式后的句号；文字块合并 35/39（4 个回退，回退块正文本身完好），14 display + 40 inline 公式全在；成品 HTML 段落 39 / 公式 91 / 图片 24 与纯 MinerU 版一致，用户 Downloads 的 HTML 已重生成（69KB）。测试：text-layer 2 项、text-merge 9 项、extract-doc「合并稿写入」1 项 → desktop 191。
- 格式转换全面测试 + 界面两处反馈（2026-10-12）：15 组互转（docx/pdf/epub/html/csv × md/html/tex/docx/pdf）+ 命名冲突 + 公式优先（含缓存）+ 3 条错误路径全过；修掉 **表格**（DocVortex 的 DOCX 渲染器无法物化 HTML 表格、PDF 渲染器静默丢表格 → 新增目标感知 `tableModeFor()`：docx/pdf 用 MinerU 表格截图、html/latex 用真 `<table>`；实测 DOCX 178KB 内嵌 3 张截图、PDF 285KB、HTML 3 个真表格）、**本地文件同名覆盖**（渲染层只查书库 → 新增 `main/paths.js` 的 `uniqueFile()` 接入三个 runner；实测 `报价单.md` + `报价单 (1).md`）、**MinerU 缓存复用**（prepare/extractMarkdown 命中已有 Doc JSON 就跳过云端，向导工作目录改为按路径+大小+mtime 稳定）、**Markdown 管道表格**渲染成真表格（`markdownToHtml` + 表格样式）、**界面反馈**（内容提取页标题去掉「PDF → Doc」→「内容提取 EXTRACT」；撤掉该面板会误导的预设矩阵——选中本无效果；格式转换面板的预设卡片补上可见选中态 `is-selected` + 对勾）。测试：paths 1、formula-html +1、formula-chain +2、docvortex +1、text-book +1 → desktop **200**；e2e `workshop` 扩展断言（内容提取无预设矩阵、转换预设可选中）、`workshop-extract` / `workshop-convert` 回归通过。
- 文本型 PDF 改为本地确定性提取（2026-10-12，用户反馈「跨页代码块被拆散、页眉水印没清理」）：新增 `main/pdf-text.js` —— PyMuPDF 取结构化行（字体/字号/位置）→ 去掉跨页重复行（阈值 max(2, 页数×30%)）、页码样式行、旋转水印 → 按字号判标题（1–3 级）、等宽字体判代码、行距分块 → **跨页代码块续成一块**（换行缩进原样）、跨页断句段落接回、断词合并、中文行不加空格 → 输出 Doc v1 + §7 产物。**完全本地**：不需要 pdf_tool / OCR / 模型凭据（修了「没配 pdf_tool 就用不了文本型」的接线问题）；代价是无 LaTeX 公式。实测：自造「代码块跨页 + 页眉 + 页码」2 页 PDF → 代码块合成一块、页眉页码全去掉；另修合并逻辑不再压平真代码块的换行（只还原被误判成 code 的正文段落）。测试：pdf-text 6 项 + extract-doc 文本型 1 项 → desktop **208**；门禁 core/shim/i18n/eslint/build/smoke/e2e 全绿。
- 书坊设置集中 + W1-4 发送到 Kindle + 图片→PDF + **0.5.0 发布**(2026-10-14):① **「设置 → 书坊」独立标签页**(与「存储与同步」同级):书坊总开关、文字层/可搜索 PDF(从「存储与同步」迁出)、**MinerU**(云端 token / 本地服务地址 / 本地程序;qbr:mineru:path 自动查找 + 回填,状态行列出已试路径)、**DocVortex**、**Calibre**、**发送到 Kindle** 集中于此;链路检测**原地出结果**(qbr:probe:ocr|docvortex|formula|calibre 直连 IPC,不入任务队列),「打开 设置 → 书坊」直达该页,输入**边打边存**;工具面板只留本次任务的选项 + 一行链接。② **W1-4 发送到 Kindle 完成**:main/kindle-send.js(nodemailer;单附件直发、多附件或 >50MB 自动 ZIP、打完包仍超 50MB 拒发、535/550/552/ENOTFOUND 错误映射、SMTP 检测)+ qbr:kindle:probe|send(**授权码只从 safeStorage 读**)+ runner kindle-send;设置页 SMTP 段(收件地址/服务器/端口/账号/发件地址 + 密码框「已保存;留空不修改」+ 检测 SMTP);书坊「发送到 Kindle」面板(勾书库 EPUB/PDF/DOCX 或本地文件 → 入队,任务里看结果)。单测 7 项(真实 SMTP mock 会话 + ZIP 解包核对 + 超限拒发 + 错误映射),e2e workshop 断言 SMTP 段存在。③ **W1-5 图片 → PDF**:格式转换预设卡,每张一页、按 150dpi 换算页面尺寸,产物落首图旁。④ 收口:core/shim/desktop(**248**)/i18n/eslint/build/smoke 全绿,转换矩阵 **64/64**,e2e 9 场景全过;版本 **0.5.0**,tag → Release。**仍待**:题库 schema 模板(等 pdf_tool vision/box 协议)、P2。
- **0.5.0 发布 + 发布前修复**(2026-10-14):① **v0.5.0 已发布** —— Release 工作流三平台构建 + 创建发布页(`releases/tag/v0.5.0`),产物:`UV-Reader-0.5.0-setup.exe`、`-portable.exe`、`-x64.dmg`、`-arm64.dmg`、`-x86_64.AppImage`。
② **发布前发现 CI 的 `test:desktop` 在 Linux 上已连红约 60 次**(与书坊功能无关,Window 上全绿):`calibreCandidates` 的「常见安装位置」只列了 Windows/macOS(补 `/opt/calibre/ebook-convert`、`/snap/bin/ebook-convert`)、公式链路「失败退出」用例依赖跑测机器上的 MinerU 凭据(改为显式给 token + 固定 `readEnv`)、`mineru-kit` 兄弟路径断言硬写反斜杠(改用 `path.join`)。
同时给 CI 加了一步:失败时用 TAP reporter 重跑并把失败用例名与错误行输出成 **check 注解**,这样不用登录下载 job 日志也能定位(日志接口要权限,注解是公开的)。
③ **PDF 划线跳页兜底**:按需渲染回收掉目标页后,该页文本层不在 DOM 里,点击面板里的划线只弹「找不到这条划线」;现在锚点找不回来时按 **block → 页** 直接跳过去(与面板 `[第 N 页]` 前缀同一规则),页面画出来后再闪烁。`tests/reader-view.test.mjs` 覆盖。
④ **队列测试时序**:CI 上出现过 `'running' !== 'done'`(book-build 做真活,固定 40–80ms 不够),新增 `apps/desktop/test/wait-for-task.mjs`,把断言「任务终态」的固定 sleep 换成轮询(公式链路 / 电子书构建 / Calibre / DocVortex / 内容提取 / 文本型提取);断言「still running」的 sleep 保持原样。
⑤ 验证:整轮 e2e `E2E OK`(9 场景)、CI 全绿(含 xvfb smoke)、core/shim/desktop 248/i18n/eslint/build 全绿。
- **成书公式与图注修复**(2026-10-14,用户实测《光学(第五版)》1628/1804 图 → 公式成片漏渲染):
① **跨行 `$$…$$` 公式全部漏渲染**:收集公式表时键里带换行,而成书前段落合并会把换行压成空格,查表因此落空 → 回退成原始 LaTeX(成品里满屏 `$$…\tag{6.46}$$`)。键改为统一归一化(`mathKey` / `normalizeMathMap`,查表用 Map),真实稿复核:7091 条公式从「1233+ 条查不到」降到 1 条(表格行误配对)。
② **图注里带公式或方括号的图片被丢掉**:`inlineWithMath` 按公式把一行切开、逐段跑 Markdown,图片语法被切碎(`![图 2.5 $\psi$ 对 $t$ 的变化](a.jpg)` → 三段),1798 张里 169 张(全部含 `$…$` 的图注)没进成品;改成「先用占位符遮住公式 → 整行照常解析 Markdown → 再把公式换回来」,`alt` / `title` 里放纯 LaTeX(不塞 MathML);图片/链接文字同时允许一层嵌套方括号(`![(b) [五] 衍射]`、`![…[引自 A. B. …]…]` 一类 7 张)。
③ 复核(用真实提取稿跑流水线):1804 张图全部入库、跳过 0、残留未解析图片语法 0;单测 text-book ×2 + workshop-epub「跨行公式」×1,desktop 254 全绿。
- **去掉书里的印刷目录**(2026-10-14,用户实测「目录那段文字还在书本中,格式也是乱的」):电子书自带导航目录,PDF 里那几页印刷目录(`第 1 章 光学简史 …… 1` / `1.1 开场白 …… 11`)却会作为一章被提取出来。新增纯函数 `apps/desktop/src/shared/printed-toc.js`:
识别「目录条目」= 短行以页码结尾(可带点线/省略号/中点引导),整章条目比例 ≥ 0.5、或标题就叫 目录/目次/Contents/Table of Contents;**没有标题时只在全书前 20% 这么判**(否则后面章节里的编号列表会被误删——初版就误删了 46 章 345 行,收紧后 0);只删「目录」标题之后的那一段条目,其余行一行不动;全部删光时自动还原(不出空书)。
接入:`book-build` 默认去掉(面板 ②目录 里有开关,默认开),任务结果显示「去印刷目录 N 章」,日志另记删了多少行。实测《光学》:掉 1 章(目录,267 行),其余 419 章未动。测试:printed-toc 7 项 + workshop-epub「默认去掉 / 关掉保留」1 项;desktop 266。
- **导航目录去噪**(2026-10-14,用户反馈《数学在科学和社会中的作用》目录有点乱、目录里有 `$^` 符号):不是缓存问题,是两个具体原因 ——
① **标题里的行内标记没清**:提取出的章节标题带脚注标记(「集合论的一种公理化 $^{①}$」),面板把它原样传给成书,导航里就出现 `$ ^ { }`;新增 `cleanChapterTitle()`(去 `$…$`/`\(…\)` 定界符、去 `\命令`、`^{…}` 取内容、去 Markdown 强调与反引号),分章与成书统一走它。
② **页眉/扉页被当成章节**:书名页、丛书名(「读读大师 走近数学」)在提取稿里各有两三处,导航里就重复出现。规则:连续同名的章节标题并进上一章(标题行丢掉);全书同名里「短页(<200 字)+ 长章」并存时,短的那页按扉页丢掉(实测本书掉 1 页);标题等于书名的也丢。
③ 面板 ②目录 的章节编辑器新增**删除**按钮(`removeChapter`,最后一章不允许删空),自动规则没覆盖的(比如纯英文扉页)可以手删。
真实数据:《数学在科学和社会中的作用》分章 68 → 去重复页眉 1 → 去印刷目录 1 → **66 章**,标题里 `$ \ ^ _ { }` 归零;任务结果会写「去重复页眉 N 章」。测试:cleanChapterTitle/分章去重 3 项、normalizeBookChapters 1 项、removeChapter 1 项、runner 导航 1 项;desktop 272。

## 1. 目标与范围

M1 只做最小可用闭环：**打开本地文件 → 阅读 → 划线/笔记 → AI 对话日志落盘**。

做：

- Electron 壳（Windows 优先，macOS/Linux 后置）。
- `obsidian` 兼容层（`packages/host-shim`），直接复用 `src/main.js`（`export default QiaomuBookReader`）。
- 打开文件对话框 + 后缀过滤（`ENGINE_EXTENSIONS` + `pdf`，见 `src/reader-engine.js`、`src/main.js:16-19`）。
- 阅读、翻页/缩放、进度、三色划线、批注、阅读笔记 Markdown。
- AI 对话（HTTP 优先）与会话日志/草稿按文件保存。

不做：书库 UI、完整设置页、移动端、`obsidian://` 回跳、ReaderView 重写、安装包签名与自动更新。

## 2. 关键决策

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | 兼容层复用 `src/main.js`，不重写 ReaderView | `main.js` 13k 行；15 个测试文件与 `check-i18n` 断言其字符串，重写成本与回归风险远高于 shim |
| 2 | `apps/desktop` 独立 `package.json`，不加入根 workspaces | 根 `package-lock.json` 是提交产物且 CI 要求构建可复现 |
| 3 | M1 不修改 `src/main.js` | 保住插件门禁；桌面差异全在 shim/宿主层 |
| 4 | 书身份 = 绝对路径（复用现有 path-key JSON store） | 零改动复用 `highlights.json` / `reading-progress.json` 逻辑；M2 再做 bookId 迁移 |
| 5 | 桌面 UI 文案放 `apps/desktop`，不进插件 i18n 字典 | 新增字典 key 需要 9 语言 + 精确字符串断言 |
| 6 | M1 窗口临时 `nodeIntegration: true` + `webSecurity: false` | `src/ai-cli.js:139` 依赖 `window.require`，AI 流式走 `window.fetch`；M2 换 preload 桥收紧 |

## 3. 目录结构

```text
apps/desktop/
  package.json          # electron/esbuild/playwright，独立锁文件
  build.mjs             # 构建 main / preload / renderer
  src/main/index.js     # 窗口、菜单、打开对话框、argv/单实例、safeStorage、net
  src/preload/index.js  # 预留收紧通道
  src/renderer/entry.js # createApp + 启动插件 + 打开 argv 文件
  src/renderer/base.css # Obsidian 基础组件样式与主题变量
packages/host-shim/
  src/{host,dom,events,paths,files,vault,workspace,ui,services,plugin,index}.js
  test/*.test.mjs
```

构建复用插件的关键件，避免 PDF/foliate 行为分叉：

- `scripts/foliate-elements.mjs`（补丁 + `__QBR_ENGINE_VIEW_TAG__`）。
- `esbuild.config.mjs` 的 `loadPatchedWorker()`、Iterator shim、字体 base64 注入、node builtins alias（renderer 端保留 Electron 真实模块，不 alias）。

## 4. 兼容层范围（按实测调用点）

| 模块 | 必须实现 |
| --- | --- |
| `Plugin` | `loadData/saveData`、`registerView`、`registerExtensions`、`addCommand`、`addRibbonIcon`、`addSettingTab`、`registerEvent`、`register`、`registerObsidianProtocolHandler` |
| `ItemView`/`View`/`Component` | `containerEl/contentEl`、`onOpen/onClose`、`addAction`、`onPaneMenu`、`registerDomEvent/Interval` |
| `Workspace` | `getLeaf/getRightLeaf`、`getLeavesOfType`、`revealLeaf`、`detachLeavesOfType`、`getActiveViewOfType`、`getActiveFile`、`iterateAllLeaves`、`onLayoutReady`、`on(...)`、`activeLeaf`、`rightSplit` |
| `Vault`/`adapter` | `read/cachedRead/readBinary/modify/create/createBinary/createFolder/process/getAbstractFileByPath/getFiles/getMarkdownFiles/getAllLoadedFiles/getRoot/getName/getResourcePath/on`；adapter：`read/readBinary/write/writeBinary/exists/mkdir/process/getFullPath` |
| UI | `Modal`、`Setting`（Text/TextArea/Toggle/Dropdown/Slider/Button/ExtraButton）、`Notice`、`Menu`、`Scope`、`PluginSettingTab`、`FuzzySuggestModal`、`AbstractInputSuggest`、`SecretComponent` |
| 服务 | `Platform`、`requestUrl`、`setIcon`、`MarkdownRenderer`、`secretStorage` |
| DOM 扩展 | `createEl/createDiv/createSpan/setText/getText/appendText/addClass/removeClass/toggleClass/hasClass/empty/detach/setAttr/setAttrs/find/findAll/setCssProps/setCssStyles/show/hide` |
| 全局 | `activeDocument`、`activeWindow`、`app.isMobile`、`app.keymap.pushScope/popScope` |

## 5. 数据落盘

```text
<userData>/
  data.json                 # 插件设置（Plugin.loadData/saveData）
  chat/index.json           # AI 会话索引（shim 从 data.json 拆出）
  chat/<conversationId>.json# 单条 AI 会话日志
  library/                  # vault 根
    notes/<书名>.md         # 阅读笔记
    reading-progress.json
    highlights.json
    ai-drafts.json
  secrets.json              # safeStorage 密文
```

AI 会话拆文件在 shim 的 `loadData/saveData` 完成，`src/main.js` 无感知。

## 6. 打开文件与过滤

- 白名单：`epub, fb2, fbz, mobi, azw, azw3, cbz, pdf`。
- 入口：菜单 `Ctrl/Cmd+O`、拖拽、命令行参数 / `open with`（单实例转发）。
- 非书籍后缀：拒绝并提示，不进入 reader。
- 启动：无参数显示极简欢迎页；有参数直接 `plugin.openFile(file)`。

## 7. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 脚手架、双构建、窗口、独立锁文件 | `build.mjs` 产出三个产物；不影响根 CI |
| P1 | shim 核心 + 契约测试 | `onload()` 不抛错；shim 测试通过 |
| P2 | 打开文件 → EPUB/PDF → 翻页/缩放 → 进度落盘 | 关闭重开恢复位置 |
| P3 | 划线/批注 → `highlights.json` + 阅读笔记 | 文件内容正确、可回跳（M1 内部协议） |
| P4 | AI HTTP 对话 + 会话/草稿落盘 + secrets | 至少一个 provider 可用 |
| P5 | CLI/ACP 直连（Electron 原生 `window.require`） | 探测/提问/取消/退出清理 |
| P6 | Playwright-Electron 冒烟 + 文档 | 开书→翻页→划线→文件断言 |

## 8. 测试与门禁

- shim 契约测试：`node --test packages/host-shim/test/*.test.mjs`（jsdom）。
- 导出对齐测试：解析 `src/main.js` 的 `obsidian` import，断言 shim 全部导出。
- 现有插件门禁不动：`npm test`、`npm run check:i18n`、`npm run build`、`npm run verify:release`、`npx eslint src/`、`git diff --exit-code`。
- E2E：Playwright `_electron.launch`，夹具用 `assets/starter-books/11.epub` 与测试 PDF。

## 9. 风险

| 风险 | 缓解 |
| --- | --- |
| Obsidian 基础 CSS 缺口 | P1 先写 `base.css`，用阅读设置弹窗/选文菜单验收 |
| shim 未知缺口 | 尽早 boot `src/main.js`，按报错补并维护缺口清单 |
| 放宽 `nodeIntegration/webSecurity` | 仅 M1；M2 换 preload + IPC |
| 绝对路径 book key | M2 引入 bookId + 迁移 |
| 误改 `src/main.js` 破坏字符串断言 | M1 冻结；确需修改则同步测试并跑全门禁 |

## 10. M2 预告

将 `ReaderView`、选文/HUD、PDF 装配从 `main.js` 抽到 `packages/reader-ui`，通过 ports 注入宿主；插件退化为 Obsidian adapter。在此之前先完成 M1 验证复用率。

## 11. M2 进度

插件外壳已删除（`583991c`），`src/` 已迁到 `packages/reader/src/`；抽离按“小簇 + 工厂注入依赖 + 单测锁定”的方式推进。

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| M2.1 | `reader-dom.js`（`docOf/winOf/selOf`）与 `reader-icons.js`（icon 表、`ensureSvgNamespace/parseSvgRoot/svgIcon/iconLabel`，`DOMParser` 从宿主 window 取） | 完成，`tests/reader-icons.test.mjs` |
| M2.2 | `page-jump.js`（`createPageJump({ translate, svgIcon, docOf, isPdf, pdfPages, rememberJump })`：`pageInfo/update/jump/build`） | 完成，`tests/page-jump.test.mjs` |
| M2.3 | `pdf-zoom-ui.js`（`createPdfZoomUi({ translate, isPdf })`：`syncControls/visiblePageScrollers/apply/change/fitWidth/fitPageWidth/setPanMode`；`Menu`/`Modal` 装配仍留在 `main.js`） | 完成，`tests/pdf-zoom-ui.test.mjs` |
| M2.4a | `selection-actions.js`（`createSelectionActions(ports)`：选文→高亮弹层→三色下拉→批注编辑器→More 菜单→AI/复制/翻译入口，21 个函数；端口为 translate/Notice/Menu/Scope/TranslateModal/setIcon/window/isPdf/hlColorCss/hlColors/positionPopup/refreshHlPanel/autoFocus/paintAiSource/copyToClipboard/quoteMarkdown/createNoteFromSelection/hlCommentMd/flowSelectionParts/raiseSelectionPopup） | 完成，`tests/selection-actions.test.mjs` 直接 import 模块 |
| M2.4b-1 | `reader-timer.js`（`createReaderTimer({ translate, notice, window })`：计时/目标条/计时胶囊）与 `reader-hud.js`（`createReaderHud({ translate, notice, window, platform, isPdf, jumpToHighlight, escapeSelector })`：启动遮罩、autoFocus/blur、footnote 弹层与回跳胶囊、`positionPopup`） | 完成，`tests/reader-timer.test.mjs`、`tests/reader-hud.test.mjs` |
| M2.4b-2 | `reader-view.js`：`createReaderView(ports)` 返回 `class ReaderView extends ItemView`（宿主基类注入），整类 1,056 行移出；纯模块（reader-engine/reader-dom/reader-icons/reader-load/reader-experience/pdf-page-mode/pdf-zoom/reader-appearance/highlight-navigation）直接 import，其余 74 个宿主/本地依赖走端口 | 完成，`tests/reader-view.test.mjs`；`main.js` 13,018 → 11,848 行 |
| M2.4b-3 | `reader-modal.js`：`createReaderModal(ports)` 返回 `class ReaderModal extends Modal`（Modal 基类注入），772 行移出；65 个端口 | 完成，`tests/reader-modal.test.mjs`；`main.js` 11,848 → 11,144 行 |
| M2.4b-4 | `LibraryModal`（573）、`AiChatView`（406）、`AiExplainModal`（374）、`ReadSettingsModal`（333）同样按工厂模式抽离 | 完成（`library-modal.js`、`ai-chat-view.js`、`ai-explain-modal.js`、`read-settings-modal.js` 均为工厂；`wire.js` 只做装配） |

## 12. 打包与发布进度

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| P-1 | 应用图标：`logo.jpg` → `apps/desktop/scripts/import-logo.cjs`（Chromium 解码 JPEG，圆形透明遮罩，输出 512×512 PNG） | 完成 |
| P-2 | electron-builder 26 接入：`apps/desktop/electron-builder.config.cjs`，版本取根 `package.json`（`extraMetadata.version`），Win NSIS+portable、mac dmg、Linux AppImage | 完成 |
| P-3 | 文件关联（epub/pdf/mobi/azw3/fb2/cbz）、单实例、命令行打开书籍 | 完成 |
| P-4 | 打包产物冒烟：`npm run desktop:smoke:packaged`（免安装目录 / 便携版，退出码 0/1） | 完成（Windows 实测 0） |
| P-5 | CI 发布流水线：tag → 三平台构建 → 上传 GitHub Release | 完成（`.github/workflows/release.yml`） |
| P-6 | 代码签名/公证、自动更新（electron-updater） | 计划 |

发布流程（P-5）：

1. 版本号写在根 `package.json`（electron-builder 通过 `extraMetadata.version` 继承）；推送 `v*` tag 触发 `release.yml`。
2. `verify` 作业先跑完整门禁，并用 `scripts/check-release-tag.mjs` 校验 tag 与 `package.json` 版本一致（不一致直接失败）。
3. `build` 矩阵在 Windows/macOS/Ubuntu 上各自 `npm ci` + `npm run desktop:dist`，产物（`.exe`/`.dmg`/`.AppImage`）作为构建产物上传。
4. `release` 作业汇总产物，用 `gh release create --generate-notes` 创建 GitHub Release。
5. 签名/公证尚未接入，macOS 产物为未签名包（`CSC_IDENTITY_AUTO_DISCOVERY=false`），P-6 处理。

已知注意：electron-builder 首次运行会下载 electron 与 nsis/winCodeSign 资源，网络受限时设置 `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`；`apps/desktop/release/` 已加入 `.gitignore`。

## 13. AI 传输层（已由 pi-ai 替换 CLI/ACP）

> 2026-09 更新：CLI/ACP 通道已整体移除（`ai-cli.js`、`ai-acp-manual.js`、`ai-transport.js`、`ai-stream.js` 已删除），改为桌面主进程的 pi-ai 运行时。

- `apps/desktop/src/main/ai-runtime.js`：用 `@earendil-works/pi-ai` 构建 provider（全部走 `openai-completions`），负责流式增量、错误归一化（`auth/forbidden/limit/timeout/cancelled/empty/notconfigured/nokey`）与连接测试；本地端点自动加 `supportsFinishReason: false`，keyless 服务用占位 key。
- `apps/desktop/src/preload/index.js`：暴露 `qbrDesktop.ai.{stream,abort,test}`；主进程经 IPC 事件回传增量。
- `packages/reader/src/ai-pi.js`：把桥接适配成原有 `aiExplain` 契约，聊天 UI 零改动。
- provider 收敛为 API key 服务 + 本地/自定义 OpenAI 兼容端点；旧设置（`aiCliPaths`/`aiAcpPaths`/`aiCliEfforts`、CLI provider id）在启动迁移时清除并重置。
- 测试：`apps/desktop/test/ai-runtime.test.mjs`（faux provider）、`tests/ai-pi.test.mjs`；E2E 的 AI 场景经 mock 端点走主进程链路。

注意事项：新模块导出的符号必须显式 `export`（构建期缺失只会让 esbuild 降级成 `(void 0)`，`npm test` 抓不到，靠 smoke/E2E 兜底）；测试用 `jsdom` + `installDomExtensions(window)` 补 Obsidian DOM 扩展。抽离后按名字切 `main.js` 源码的测试要改读新模块（`core-config`、`engine-integration`、`reader-experience`、`check-i18n` 均已同步）；模块内函数有 2 空格缩进，按 `\n}` 切函数会切到工厂结尾，需带缩进匹配。端口命名避免与函数内局部变量重名（`HL_COLORS`→`hlColors` 就撞上了 `openSelectionMoreMenu` 里的局部 `colors`）。

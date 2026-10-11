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
- 待办：`base.css` 组件细节；P5 CLI/ACP 实测（Electron 原生 `window.require`）；打包签名；Windows 外的平台验证。
- 渲染层收紧（安全）：主窗口加 `will-navigate`/`setWindowOpenHandler` 守卫（外链交给系统浏览器，`window.open` 一律拒绝）；Markdown 清洗升级为 `renderer/sanitize.js`（标签与 URL 协议白名单，notes/AI 输出统一入口，另配点击兜底）；CSP 去掉 `script-src` 的内联脚本许可；来源窗口（登录/页加载/下载）只允许 http(s) 加载；下载格式白名单与大小上限；OCR 请求加超时。剩余：`contextIsolation`/`sandbox` 翻转（需把 shim 的 fs 端口改为 IPC）与 `webSecurity` 关闭项清理。

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

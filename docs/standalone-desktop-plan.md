# 独立桌面版（Electron）实施方案

> 状态：产品定位为**独立桌面应用**（UV Reader / 柚肥阅读），不再作为 Obsidian 插件开发与发布。
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
- 顶栏布局（按用户要求）：工具栏 `position: fixed` 占满主窗口宽度；所有操作按钮移到左侧跟在“返回主页”后（书内标题隐藏）；中间为 `‹ 页码输入 / 总数 ›`（上一页/下一页按钮 + 跳页输入）；书名写入窗口标题（`<书名> — 柚肥阅读`）。PDF 缩放控件改为绝对定位到工具栏最右侧。右侧 AI 侧栏与阅读区顶部各让出工具栏高度，互不遮挡。注意：`.view-content.qiaomu-reader-view` 的 `padding-top` 需要 `body` 前缀提高优先级，否则被插件样式表的 `padding:0` 覆盖。
- 目录改为左侧栏（与 AI 侧栏对称）：shim 增加可用的 `leftSplit` 与 `getLeftLeaf`（左栏 leaf 不参与主区激活、detach 后自动收起）；插件目录按钮在桌面端走 `app.qbrDesktopOpenToc` 挂点，打开 `qbr-toc` 视图（标题 + 关闭 + 搜索 + 层级列表，点击跳转），高度与阅读区一致、可关闭、再次点击目录按钮切换。E2E 覆盖“目录开在左侧且阅读器仍可见、可关闭”。关闭按钮复用 AI 面板的图标按钮样式（× 图标）。
- 窗口标题同步修复：同一阅读器 leaf 内换书不会触发 workspace 事件，此前标题停留在上一本；现在同时观察阅读器工具栏标题文本（`view.titleEl`）变化来刷新窗口标题，E2E 断言“书库切书后窗口标题跟随新书”。
- 阅读器 chrome 精简（按用户要求）：移除底栏与上一页/下一页按钮；顶栏中间新增页码跳转控件（输入框 + `/ 总数`，Enter 或失焦跳转；引擎书按 foliate location 估算 fraction，PDF/排版书按页/屏跳转）；滚轮翻页保留。E2E 断言底栏已移除、页码控件存在且能跳页。
- “适合页面”按钮（原专注阅读按钮改为 `fit-page`，设置持久化 `fitPage`）：引擎书把 foliate 的 `margin` 从 48px 降到 16px、`gap` 从 7% 降到 2%，并把 `max-inline-size` 从 `min(720, width/columns)` 放宽到可用宽度（滚动模式按整列宽度，之前会被 720px/列数截半）；自带排版书 `edgePad` 降到 16px 且不再做舒适行宽居中。**PDF**：点击后先切到单页布局（`_readerLayoutSettings()` 在 fit 时把 `columns` 覆盖为 1），再按 `fitPdfPageWidth(view, 0.9)` 放大到页面宽度 = 阅读栏宽度的 90%（`pdfZoomMode = "fit-page-width"`，重排/缩放后仍按 90% 重新适配）；关闭时恢复 fit-page 缩放与用户的分栏设置。实测 1249px 阅读区：EPUB 关=正文 720px/两侧 95px，开=正文 1197px/两侧 26px；PDF 单页宽度约占阅读区 90%（示例 143% 缩放）。E2E 断言 EPUB 与 PDF 两种 fit 行为。
- 主题一致：AI 侧栏/首页/设置不再固定深色，壳把阅读主题的 bg/text/ui/border/accent 映射到 `document.body` 的 Obsidian 变量（`auto` 主题保持壳默认），并同步 `color-scheme`；阅读器 `applyVars` 变化通过 MutationObserver 实时同步。
- 首页打开书籍失败（“无法打开这本书…Could not load a readable book location”）：根因是 `_syncLayout` 优先使用 `activeLeaf`（此时还是首页），新挂载的阅读器被隐藏，foliate 在零尺寸容器里初始化失败；改为**优先 `_pendingActive`**，新视图加载期间即可见。首页同时改为打开时自动调用 `plugin.ensureStarterBooks()` 并轮询刷新卡片（新装/新增书籍后无需重开首页）。
- 阅读交互补充：滚动模式下插件默认隐藏上一页/下一页按钮（`.qiaomu-reader-scrolling .qiaomu-reader-navbtn`），桌面壳通过宿主 CSS 恢复显示并还原三列底栏；插件新增滚轮翻页 `handleReaderWheel`（分页模式任意滚轮翻页；滚动模式仅在滚动容器到达顶部/底部时翻页，450ms 冷却，Ctrl/Cmd/Alt 滚轮与面板内滚轮不拦截），引擎书挂到每个章节文档，自带排版书挂到阅读区。E2E 覆盖分页滚轮翻页与滚动模式按钮可见/可翻。
- API 密钥链路修复：Obsidian 的 `SecretStorage.getSecret` 是**同步** API（插件构造请求头时同步读取），桌面端用 `ipcRenderer.sendSync` + 内存缓存桥接，否则 `cfg.key` 是 Promise、请求头变成 `Bearer [object Promise]`；`SecretComponent` 改为密码输入，粘贴后写入 safeStorage 并把 secret id 交给插件（原先只把输入当作 id，密钥从未保存）；失焦提交不得删除已存密钥（只在用户主动清空时删除）。E2E 新增 DeepSeek + 密钥场景，断言 mock 收到 `Bearer <key>`。
- 细节调整：阅读区滚动条与顶栏/底栏按钮重叠 → 桌面壳改为**顶栏与底栏各自占一行**（不再绝对定位覆盖阅读区，滚动条只在阅读区内部滚动），并禁用桌面壳的沉浸自动收起，保证两栏始终可见、不遮挡；AI 侧栏的 Setting 行允许换行，“获取密钥”按钮不再被挤成竖排文字。此调整与 `DESIGN.md` 第 5 节“HUD 不占文档高度”的 Obsidian 端行为不同，仅桌面壳生效（宿主 CSS 覆盖，未改插件样式）。
- 待办：`base.css` 组件细节；P5 CLI/ACP 实测（Electron 原生 `window.require`）；打包签名；Windows 外的平台验证。

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
| M2.3 | PDF 缩放簇：`syncPdfZoomControls`、`createPdfZoomControls`（`main.js:3819`、`3943` 附近） | 下一步 |
| M2.4 | 选文/HUD、`ReaderView` 装配拆到 ports 注入 | 计划 |

注意事项：新模块导出的符号必须显式 `export`（构建期缺失只会让 esbuild 降级成 `(void 0)`，`npm test` 抓不到，靠 smoke/E2E 兜底）；测试用 `jsdom` + `installDomExtensions(window)` 补 Obsidian DOM 扩展。

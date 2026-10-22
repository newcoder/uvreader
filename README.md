<p align="center"><img src="logo.jpg" alt="UV Reader（纽扣）" width="160"></p>

# UV Reader（纽扣）

**简体中文** · [English](#english) · [许可证](LICENSE) · [问题反馈](https://github.com/newcoder/uvreader/issues)

UV Reader 是一个 **中文优先的本地桌面阅读器**（Electron），支持 EPUB、PDF、FB2/FBZ、MOBI/AZW/AZW3、CBZ，内置高亮、批注、阅读笔记和可选的 AI 助读。书籍、进度和笔记默认都在本机；日常阅读不需要账号，也不需要联网。

> **当前版本**：`0.7.49`。Windows / macOS 安装包见 [Releases](https://github.com/newcoder/uvreader/releases/tag/v0.7.49)。
>
> **来源**：fork 自 Obsidian 插件 [qiaomu-reader](https://github.com/joeseesun/qiaomu-reader)，现在作为独立桌面应用维护；Obsidian 插件形态不再作为主线。
>
> **原则**：读得好、做得快、保持轻量，再逐步扩展（Do it well, do it fast, do it lean, then scale it.）

## 功能总览

### 阅读

- **格式**：EPUB、PDF、FB2、FBZ、MOBI、AZW、AZW3、CBZ；支持系统文件关联，双击书籍直接打开。
- **阅读模式**：分页 / 滚动；单栏 / 双栏；鼠标滚轮、触控板、方向键、按钮和滑动翻页；页码跳转、章节跳转、阅读位置自动恢复。
- **版面**：适配页宽 / 页高、PDF 原始页面渲染与缩放、页间距、页边距、对齐方式；不同设备可以保存不同阅读设置。
- **目录**：PDF 大纲、印刷目录、正文标题等多来源目录；层级导航、当前章节定位、目录搜索。
- **搜索**：全书搜索、结果定位、命中高亮。
- **外观**：多套阅读主题、字体、字号、行距、段距、对齐和栏数设置；内置阅读字体，也支持导入字体。
- **PDF**：原页渲染、文本层、可搜索 PDF；扫描页可以通过文字层 / OCR 变成可搜索、可划线的文本。
- **阅读统计**：累计阅读时间、连续天数、每日目标、最近两周阅读图表。
- **位置书签**：保存 / 重命名 / 删除阅读位置。

### 高亮、批注和笔记

- 选中文本后高亮、写批注、改颜色、复制、搜索、翻译或询问 AI。
- 高亮可以带批注和位置书签；支持跨页/跨章节选择与定位。
- 拼音提示、词义/生词辅助；选中文本可以直接查词。
- **每本书一篇 Markdown 阅读笔记**：摘录按章节分组，带原文位置链接，点击可跳回书内。
- 书籍笔记、自动追加摘录、AI 回复追加到笔记；也可以导出全部高亮。
- 笔记和摘录使用普通 Markdown，便于外部编辑、搜索和备份。

### 书库

- 本地导入 EPUB / PDF / MOBI / AZW3 / FB2 / CBZ 等文件，支持拖拽、批量导入和文件关联。
- 封面、书名、作者、语言、标签、简介等元数据编辑；可以选封面、自动取封面或生成模板封面。
- 最近阅读、阅读进度、阅读中/未读状态、书库筛选和搜索。
- 所有书籍、进度、标注和笔记都保存在本地应用数据目录，不依赖云书库。

### 书坊（Workshop）

书坊是阅读器内置的文档处理工作台，任务进入队列，可以取消、重试、打开产物。

#### 文字层与可搜索 PDF

- 把扫描 PDF 变成可搜索、可划线的 PDF。
- 支持本地文字层写回阅读器，也可以导出 `<源名>.uvtext.pdf`。
- 可选 OCR DPI、识别模式；处理过程有进度和失败页统计。

#### 格式转换（DocVortex）

- 输入：PDF、Office（DOC/DOCX/PPT/PPTX/XLS/XLSX/CSV/TSV/RTF）、ODF、HTML/MHTML、EPUB、OFD、Markdown、纯文本等。
- 输出：Markdown、HTML、LaTeX、DOCX、PDF；另有 EPUB → Markdown、图片 → PDF 预设。
- 尽量保持内容与版式；Markdown / 纯文本会先渲染成 HTML 再交给 DocVortex。
- 可选公式优先路径（MinerU）处理公式较多的 PDF。

#### 内容提取

- PDF / DOCX / 图片 / Office / ODF / OFD / HTML / EPUB / Markdown / 纯文本 → **Markdown / HTML / 结构化 JSON / 图片资源**。
- 文本型 PDF 使用本地确定性提取：去页眉页脚、页码、水印，合并跨页段落和代码。
- 扫描 PDF / 公式文档可走 MinerU；公式保留为 LaTeX / MathML。
- 题库提取：生成 `uvreader.question-bank/v1` JSON，作为答题页和外部工具的索引。
- 提取结果可以在面板里预览 Markdown / HTML / JSON，并查看缺图、重复图、失败页等体检信息。

#### 电子书制作

- 从 PDF、Office、ODF、OFD、HTML、EPUB、txt、Markdown、图片制作 EPUB。
- 自动提取 / 分章，编辑章节标题、合并 / 拆分 / 排序，设置元数据、封面、目录和基础排版样式。
- EPUB 3 输出（nav + NCX），公式转 MathML，图片嵌入，生成后可直接在 UV Reader 打开。
- 通过 Calibre 可继续转换为 AZW3 / MOBI；图片可以打包成 CBZ 或 EPUB。
- 支持多本书批量制作。

#### 答题页

- **答题页（交互 HTML）**：把转换后的 Markdown 试卷生成自包含 HTML；客观题本地判分，主观题显示参考答案自评，答案/解析初始隐藏。
- **AI 答题页（实验）**：用提示词让 AI 从 Markdown 直接生成整页答题页，支持答案解析、导航配色、MathML 公式、代码格式化和圆圈数字占位符；生成后用本地后处理内联图片、校正公式/代码。
- 两者都保留在格式转换中；AI 答题页需要先在「设置 → AI 助读」配置模型。

#### 任务与外部组件

- 统一的运行队列：进度、取消、重试、产物打开、失败信息。
- 可选本地引擎：pdf_tool / MinerU / DocVortex / Calibre；设置页提供探测、路径配置和启动状态。
- 外部工具缺失时只影响对应功能，不影响阅读和已有书籍。

### AI（可选）

- 支持 HTTP OpenAI 兼容服务（DeepSeek、Kimi、通义千问、智谱 GLM、MiniMax、OpenRouter、OpenAI 等），也支持本地 OpenAI 兼容端点（Ollama、llama.cpp、LM Studio）。
- **AI 助读**：选中文本解释、总结、追问、翻译，读取书籍上下文；可以自定义提示词和回复语言。
- **AI 书坊**：推断元数据、生成封面文案、建议分章规则、按块做最小文本清理。
- **AI 答题页**：生成答案、解析和整页交互 HTML（实验功能）。
- 不配置 AI 时，阅读、标注、笔记、转换、成书全部照常工作；AI 请求只在用户主动操作时发生。

### 其他

- 界面支持 9 种语言。
- 本地优先：无账号、无强制云同步；支持系统凭据存储保存 AI 密钥。
- 阅读器核心与 Electron 壳解耦，90+ 个 host-agnostic 模块，便于测试和后续扩展。

## 快速开始

前置：Node.js 22 或更高版本。

```bash
npm ci
npm run desktop:install   # 安装 Electron；网络受限时可设置 ELECTRON_MIRROR
npm run desktop:build
npm run desktop:start
```

开发：

```bash
npm run desktop:dev       # watch 编译 + 启动应用
npm run desktop:smoke     # 启动冒烟测试，退出码 0/1
npm run desktop:e2e       # Playwright-Electron 端到端
```

## 构建与发布

```bash
npm run desktop:dist:dir       # 只生成安装目录 apps/desktop/release/win-unpacked
npm run desktop:dist           # Windows NSIS 安装包 + 便携版；macOS 生成 dmg
npm run desktop:smoke:packaged # 用打包产物做冒烟测试
npm run build:icon             # logo.jpg → 应用图标
npm run build:icons            # uvreader_icons.png → 各平台图标
```

- 发行产物：`apps/desktop/release/UV-Reader-<版本>-setup.exe`、`-portable.exe`、macOS `.dmg`。
- 发版：修改根 `package.json` 版本，提交后推送 `v<版本>` tag；`.github/workflows/release.yml` 会校验版本、跑测试、构建 Windows/macOS 并创建 GitHub Release。
- 详细工具链：`docs/workshop-implementation.md`。

## 项目结构

```text
apps/desktop/         Electron 壳：主进程、preload、渲染进程、构建脚本
  src/main/           阅读/书坊/引擎/AI 主进程服务
  src/preload/        受控 IPC 桥
  src/renderer/       阅读器、书库、书坊、设置界面
packages/reader/src/  阅读器核心：阅读引擎、标注、笔记、AI 适配等 90+ 模块
  main.js             薄入口，export { default } from "./wire.js"
  wire.js             依赖装配与宿主接线
  plugin.js           Obsidian 兼容适配器（仅保留兼容）
  settings-tab.js     设置页适配器
packages/host-shim/   Obsidian API 兼容层，仅由适配器使用
assets/starter-books/ 内置公版示例书
docs/                 设计、实现、实验和验收记录
scripts/              构建、检查、预览和转换工具
```

阅读器核心不依赖 Electron/Obsidian；AI 请求和文档工具由桌面主进程提供。独立答题页与阅读器内阅读界面分开，阅读器不再内置旧答题面板。

## 测试与检查

```bash
npm test              # reader-core 单元测试
npm run test:shim     # host-shim 兼容层测试
npm run test:desktop  # 桌面壳测试
npm run check:i18n    # 9 种语言的字典 / 占位符 / 链接一致性
npm run check:epub -- "path/to/book.epub"   # EPUB 结构检查
npx eslint packages/reader/src packages/host-shim apps/desktop/src apps/desktop/test apps/desktop/scripts apps/desktop/build.mjs tests scripts --max-warnings=0
```

CI 顺序：test → test:shim → test:desktop → check:i18n → eslint → desktop build → xvfb 下的 smoke。转换矩阵可用 `npm run desktop:matrix` 跑 DocVortex / 文本 PDF / MinerU / Calibre / CBZ 等真实链路。

## 数据与隐私

- 书籍、封面、阅读进度、高亮、笔记和设置默认保存在本机应用数据目录；没有账号体系。
- AI 只在主动使用时发送所选文本 / 书籍上下文；本地模型端点不会离开本机。
- 翻译使用 Google Translate 网络请求（可关闭）；MinerU 云端模式会把扫描页发送到对应服务。
- AI 密钥保存在系统凭据存储，不写进书籍或笔记文件。
- 具体安全说明见 [SECURITY.md](SECURITY.md)。

## 许可证

GPL-3.0-only。第三方组件、字体和示例书声明见 [NOTICE.md](NOTICE.md)、[fonts/README.md](fonts/README.md) 和 [licenses/](licenses/)。商业授权请联系项目作者。

---

<a name="english"></a>

# English

UV Reader is a Chinese-first **standalone desktop reader** (Electron) for EPUB, PDF, FB2/FBZ, MOBI/AZW/AZW3 and CBZ. Reading, highlighting, notes, library management and optional AI assistance live in one local-first app; Obsidian is no longer required.

**Status:** `0.7.49`; Windows and macOS installers are available on [Releases](https://github.com/newcoder/uvreader/releases/tag/v0.7.49).

## Features

- **Reading:** paged or scrolling mode, single/two columns, wheel/keyboard/swipe paging, page and chapter jumps, fit width/height, PDF original-page rendering and zoom, multiple themes and fonts, per-device reading settings, location bookmarks, reading statistics and daily goals.
- **Annotations and notes:** multi-colour highlights, inline comments, cross-page selection, pinyin/word hints, translation, AI explain/ask, bookmarks; one Markdown reading note per book with chapter-grouped excerpts and links back to the source; book notes and highlight export.
- **Library:** local import, covers and metadata editing, tags, recent books, progress, search and file associations.
- **Workshop:** OCR/text layers for scanned PDFs; DocVortex format conversion (Office/ODF/PDF/EPUB/HTML/OFD/Markdown/text → Markdown/HTML/LaTeX/DOCX/PDF, EPUB → Markdown, images → PDF); content extraction to Markdown/HTML/JSON/assets; question-bank extraction; EPUB creation from PDF/Office/text/Markdown/images with chapters, metadata, covers and TOC; AZW3/MOBI via Calibre; image → CBZ/EPUB; deterministic and experimental AI answer pages.
- **AI (optional):** OpenAI-compatible cloud providers or local endpoints (Ollama, llama.cpp, LM Studio); reading companion, explanations, summaries, translation, custom prompts; AI metadata/cover copy/chapter suggestions/cleanup; AI answer-page generation. All local reading, annotation and conversion features work without AI.
- **Local-first:** no account, no mandatory cloud library; keys use OS credential storage; network is used only for explicitly enabled AI, translation, or cloud OCR.

## Build

Requires Node.js 22+.

```bash
npm ci
npm run desktop:install
npm run desktop:build
npm run desktop:start
```

Tests: `npm test`, `npm run test:shim`, `npm run test:desktop`, `npm run check:i18n`, `npm run check:epub -- "path/to/book.epub"`, and the ESLint command in the Chinese section.

Release: set the root `package.json` version, push a `v<version>` tag; the release workflow verifies the version, builds Windows/macOS installers and creates the GitHub Release.

Architecture: `apps/desktop` is the Electron shell; `packages/reader/src` contains the host-agnostic reader core (90+ modules); `packages/host-shim` is only used by the Obsidian compatibility adapters. The reader no longer embeds an answering panel; interactive answer pages are standalone HTML exports.

License: GNU GPL v3.0 only. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

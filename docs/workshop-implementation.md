# 书坊实施计划

> 配套设计:`docs/workshop.md`(页面/工具/架构)与 `docs/workshop-preview.html`(交互预览)。
> 阶段:P0 骨架与基础工具 → P1 制作向导与发送 → P2 LLM 辅助与批量。每阶段独立可发布。

## 1. 交付物与范围

- **P0(0.4.0)**:导航页「书坊」+ 任务队列 + 文字层/可搜索 PDF + 文档互转(DocVortex)+ 产物命名/另存为。
- **P1(0.5.0)**:电子书制作向导(实时预览/样式/封面/目录)+ 发送到 Kindle + EPUB→AZW3/MOBI + PDF→EPUB + 图片→PDF/CBZ。
- **P2(0.6.0)**:LLM 辅助(清理/分章/元数据/封面文案)、批量与模板、Markdown→EPUB、EPUB→Markdown、EbookLib 内置(可选)、题目抽取(后续)。

非目标见 `docs/workshop.md` §11(不做 EPUB 编辑器/在线发布;Obsidian 端不提供书坊)。

## 2. 新增与改动模块

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 页面骨架 | `apps/desktop/src/renderer/views.js`(+`createWorkshopView`)、`entry.js`(路由/工厂)、`index.html`(导航)、`base.css` | 左栏工具组 + 右栏面板 + 底部任务条;三页命名与 Logo 见设计 §2.1 |
| 任务队列 | 新 `apps/desktop/src/main/workshop.js`;`main/index.js`(IPC);`preload/index.js`(`workshop.*`) | 模型/串行队列/取消/重试/历史落盘;事件推送 |
| 文字层 | 复用 `main/pdf-ocr.js`;`main/index.js` 增 `qbr:workshop:*` 包装 | 批量 cache/export,`.uvtext.pdf`,另存为 |
| 文档互转 | 新 `main/docvortex.js` | 检测(PATH/python -m/自定义路径)、命令构建、输出入库 |
| EPUB 制作 | 新 `main/epub-build.js`、`main/calibre.js`、`main/cover-render.js` | 章节 HTML+CSS+封面+元数据→Calibre;EbookLib 兜底 |
| 发送到 Kindle | 新 `main/kindle-send.js`(+`nodemailer` 依赖) | SMTP、授权码走 SecretStorage、≤50MB 自动 ZIP |
| 预览 | `views.js` 向导内 iframe(blob URL)+ 同一套 CSS | 样式改动即时重渲染;预览不落盘 |
| 设置 | `packages/reader/src/settings-tab.js`(书坊/发送到 Kindle 段)+ i18n ×9 | DocVortex 路径、Calibre 路径、SMTP、默认 Kindle 地址 |
| 命名助手 | `packages/reader/src/library-data.js`(复用 `freeBookPath`)或新 `workshop-names.js` | `.uvtext.pdf` / `.uvdoc.*` / 冲突编号 |

## 3. 任务分解

### P0

| ID | 任务 | 主要文件 | 验收 | 测试 | 规模 |
| --- | --- | --- | --- | --- | --- |
| W0-1 | 导航与页面骨架:悦空间/书库/书坊/设置,内联 SVG 图标,路由 `workshop`,左栏五组+任务条 | `index.html`、`entry.js`、`views.js`、`base.css` | 三页可切换;书坊页可见;窄窗抽屉;导航记忆 | e2e `workshop` 场景 | M ✅ 已完成 |
| W0-2 | 任务队列:模型/串行执行/取消/重试/历史(20 条)落盘;IPC+preload+任务条 | `main/workshop.js`、`main/index.js`、`preload/index.js`、`views.js` | 启动→进度→完成/取消/重试;重启后历史可查 | 单测(队列/持久化/取消)+ e2e | M ✅ 已完成 |
| W0-3 | 文字层与可搜索 PDF:批量、`.uvtext.pdf`、另存为、进度 | `main/workshop.js`、`pdf-ocr.js`、`views.js` | 真实扫描件:生成文字层(阅读器可搜索)与导出可搜索 PDF | 单测(命名/参数)+ e2e(真实 sidecar) | M ✅ 已完成 |
| W0-4 | 文档互转(DocVortex):检测/命令/进度/入库;预设矩阵面板 | `main/docvortex.js`、`views.js`、设置段 | DOCX→MD/HTML、PDF→MD 成功落库 | 单测(命令/检测)+ e2e | M ✅ 已完成 |
| W0-5 | 命名与产物:后缀约定、冲突编号、另存为对话框、打开/在书库中显示 | `main/workshop.js`、`views.js` | 产物命名符合 §7;另存为到库外可用 | 单测 | S ✅ 已完成 |
| W0-6 | 收口:i18n、eslint、全量门禁、文档状态、书坊开关 | 全仓 | `npm test`/`test:shim`/`test:desktop`/`check:i18n`/eslint/build/smoke 全绿 | CI | S ✅ 已完成 |

### P1

| ID | 任务 | 主要文件 | 验收 | 测试 | 规模 |
| --- | --- | --- | --- | --- | --- |
| W1-1 | Calibre 集成:检测(自定义→常见路径→PATH)、`ebook-convert`/`ebook-meta` 调用、下载引导 | `main/calibre.js`、设置段 | 检测到本机 9.15;路径可覆盖 | 单测(检测/命令) | S |
| W1-2 | EPUB 构建器:Doc/MD→章节 HTML+CSS+封面+元数据+nav/NCX;封面模板渲染(offscreen 截图→JPG);EbookLib 兜底 | `main/epub-build.js`、`main/cover-render.js` | 生成 EPUB 可在阅读器打开;元数据/封面/目录正确 | 单测 + e2e(打开生成物) | L |
| W1-3 | 向导 UI + 实时预览:5 步、iframe(blob)同 CSS、样式控件、封面/目录预览 | `views.js`、`base.css` | 样式改动即时可见;生成走队列 | e2e(向导→生成→打开) | L |
| W1-4 | 发送到 Kindle:nodemailer、SMTP 设置、授权码 SecretStorage、≤50MB ZIP、错误映射、三处入口 | `main/kindle-send.js`、`preload`、`settings-tab.js`、书库右键 | 本地 SMTP mock 收到附件;错误提示可读 | 单测 + e2e(SMTP mock) | M |
| W1-5 | AZW3/MOBI、图片→PDF/CBZ、PDF→EPUB 预设 | `main/calibre.js`、`workshop.js`、`views.js` | 各产物可在阅读器/系统打开 | 单测 + e2e | M |
| W1-6 | 收口:i18n、门禁、文档、发布说明 | 全仓 | 同 W0-6 | CI | S |

### P2

| ID | 任务 | 说明 | 规模 |
| --- | --- | --- | --- |
| W2-1 | LLM 辅助:AI 清理/分章/元数据/封面文案(走现有 AI 桥,可选可撤销,进队列) | 提示词与结果可对比 | L |
| W2-2 | 批量与模板:多本排队、元数据/样式模板 | 复用队列 | M |
| W2-3 | Markdown→EPUB、EPUB→Markdown | Calibre / DocVortex | S |
| W2-4 | EbookLib 内置构建(可选,AGPL 评估) | 无 Calibre 时的完整方案 | M |
| W2-5 | 题目抽取入口(依赖 pdf_tool P1) | 后续 | M |

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
- **产物命名**:`<源名>.uvtext.pdf`、`<源名>.uvdoc.md|html|json`、`<源名>.uvdoc.assets/`、转换产物=目标扩展名+冲突编号;一律经 `resolveOcrOutput` 式库内校验(另存为除外,走 `showSaveDialog`)。
- **安全**:主进程读文件/发邮件;渲染层不碰 SMTP/文件系统;CSP 不变;邮件密码只走 SecretStorage。
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

# UV Reader（柚肥阅读）

**中文** · [English](#english) · [许可证](LICENSE) · [问题反馈](https://github.com/newcoder/uvreader/issues)

> 不离开书页，读懂一个观点，留下一条真正有用的笔记。

UV Reader 是中文优先的**独立桌面阅读器**（Electron），支持 EPUB、PDF、FB2、MOBI、AZW3 和 CBZ。阅读、划线、批注、阅读笔记和可选的 AI 伴读都在同一个窗口里完成，不再依赖 Obsidian。

> 状态：开发中，计划作为独立桌面应用发布，暂未提供安装包；当前可从源码构建运行。

## 功能

| 能力 | 说明 |
| --- | --- |
| 阅读 | 分页 / 滚动两种模式，滚轮翻页，页码跳转，单栏或双栏，五套阅读主题，内置与自定义字体 |
| 划线批注 | 三色划线、就近批注、右键菜单，阅读笔记自动汇总 |
| 阅读笔记 | 每本书一篇 Markdown 笔记，`↩` 可跳回原文对应位置 |
| 目录 | 左侧栏，可搜索、可关闭，高度与阅读区一致 |
| 适合页面 | 正文按可用宽度铺满；PDF 切到单页并放大到约 90% 阅读区宽度 |
| AI 伴读（可选） | HTTP 服务（DeepSeek、Kimi、通义千问、智谱 GLM、MiniMax、硅基流动、豆包、OpenRouter、OpenAI）与本地端点（Ollama、LM Studio、自定义 OpenAI 兼容接口），由主进程的 pi-ai 运行时统一承载 |
| 本地优先 | 书籍、进度、划线、笔记都保存在本机文件；AI 关闭时不联网 |

## 运行

前置：Node.js 22 或更高。

```bash
npm ci
npm run desktop:install   # 安装 Electron；网络受限时先设置 ELECTRON_MIRROR
npm run desktop:build
npm run desktop:start
```

- 开发：`npm run desktop:dev`（watch 构建，重启应用生效）
- 冒烟：`npm run desktop:smoke`（打开内置示例书，退出码 0/1）
- 端到端：`npm run desktop:e2e`（Playwright 驱动 Electron：翻页、划线、笔记、目录、AI 密钥链路等）

## 打包

```bash
npm run desktop:dist:dir   # 只出免安装目录（apps/desktop/release/win-unpacked）
npm run desktop:dist       # Windows：NSIS 安装包 + 便携版
npm run desktop:smoke:packaged   # 用打包产物跑冒烟（退出码 0/1）
npm run build:icon         # 重新生成应用图标（纯 Node，无外部依赖）
```

- 产物：`apps/desktop/release/UV-Reader-<版本>-setup.exe`、`UV-Reader-<版本>-portable.exe`；macOS 为 dmg、Linux 为 AppImage（需在对应系统上构建）。
- 发布：把版本号写进根 `package.json` 后推送 `v<版本>` tag，`.github/workflows/release.yml` 会先跑门禁校验版本一致性，再在三个平台构建并创建 GitHub Release。
- 版本号取自根 `package.json`；图标由 `scripts/make-app-icon.mjs` 生成到 `apps/desktop/build/icon.png`。
- 已注册 `.epub/.pdf/.mobi/.azw3/.fb2/.cbz` 文件关联与单实例；用“打开方式”传入的路径会在启动后自动打开。
- 网络受限时先设置镜像：`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`（例如 npmmirror 对应路径）。

## 测试与校验

```bash
npm test              # 阅读核心单元测试
npm run test:shim     # 宿主兼容层契约测试
npm run test:desktop  # 桌面壳测试
npm run check:i18n    # 9 种语言字典与占位符一致性
npx eslint packages/reader/src/ --max-warnings=0
```

CI（`.github/workflows/ci.yml`）按上述顺序执行，并在 xvfb 下跑一次桌面冒烟。

AI 伴读的传输层由桌面主进程的 pi-ai 运行时提供：渲染层通过 preload 桥发送请求，主进程负责 provider 调用、流式增量与错误归一化。本地模型只需提供 OpenAI 兼容端点（Ollama / llama.cpp server / LM Studio）即可接入。

## 架构

```text
apps/desktop/         Electron 壳：主进程、预加载、渲染进程、打包脚本
packages/reader/src/  阅读核心：60+ 个宿主无关模块（阅读、划线、笔记、AI、界面）
  main.js             入口（仅 re-export，供桌面壳与测试引用）
  wire.js             辅助函数与端口装配（唯一接触宿主 API 的接线层）
  plugin.js           Obsidian 插件适配（注入 Plugin 基类）
  settings-tab.js     设置页适配（注入 PluginSettingTab 基类）
packages/host-shim/   Obsidian API 兼容层（仅 wire/plugin/settings-tab 使用）
assets/starter-books/ 内置公版示例书
```

迁移状态：阅读、划线、批注、笔记、AI 与全部界面/弹窗都已是宿主无关模块，可独立单测；只有 `wire.js`、`plugin.js`、`settings-tab.js` 通过 `packages/host-shim` 接触宿主 API。计划与进度见 [docs/standalone-desktop-plan.md](docs/standalone-desktop-plan.md)。

## 隐私

书籍、阅读进度、划线和笔记都在本地文件中，无账号、无遥测。可选联网能力默认关闭：翻译（Google Translate）、AI 伴读（你选择并配置的服务，含本地模型端点）。详见 [SECURITY.md](SECURITY.md)。

## 许可

项目整体采用 **GNU GPL v3.0 only**（`GPL-3.0-only`），完整条款见 [LICENSE](LICENSE)。第三方组件、字体与改编来源见 [NOTICE.md](NOTICE.md)、[fonts/README.md](fonts/README.md) 与 [licenses/](licenses/)。需要 GPL 之外的授权可联系作者协商[商业授权](COMMERCIAL-LICENSE.md)。

---

<a name="english"></a>

# English

UV Reader is a Chinese-first **standalone desktop reader** (Electron) for EPUB, PDF, FB2, MOBI, AZW3 and CBZ. Reading, highlighting, notes and an optional AI companion live in one window; Obsidian is no longer required.

> Status: in development; planned for release as a standalone desktop app. No installer is published yet — build from source for now.

Features: paged/scrolling reading, wheel paging, page jump, single or two columns, five page themes, bundled and custom fonts, three-colour highlights with inline comments, one Markdown reading note per book with backlinks, a searchable left TOC sidebar, fit-to-width reading (PDFs are zoomed to ~90% of the reading area), and optional AI assistance through HTTP providers or local OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp).

Build and run:

```bash
npm ci
npm run desktop:install
npm run desktop:build
npm run desktop:start
```

Tests: `npm test`, `npm run test:shim`, `npm run test:desktop`, `npm run check:i18n`, `npx eslint packages/reader/src/ --max-warnings=0`.

License: GNU GPL v3.0 only. Third-party notices live in [NOTICE.md](NOTICE.md).

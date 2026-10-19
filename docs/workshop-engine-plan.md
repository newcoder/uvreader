# 书坊引擎(workshop engine):发布方案评估与计划

日期:2026-10-19 · 状态:**计划(未开工)** · 关联:`docs/workshop.md` §6(技术架构)、`docs/workshop-implementation.md`

## 0. 问题

用户装完 UV Reader,**书坊的后台能力还得自己装一堆**:Python、PyMuPDF、Pillow、latex2mathml、DocVortex、pdf_tool、本地 MinerU(模型 GB 级)、Calibre…… 每样都要单独找、单独装、单独配路径。

目标:把书坊后台做成**一个可独立安装的模块(「书坊引擎」)** —— 应用负责探测、一键安装/更新,用户不再逐个装。

## 1. 现状盘点(事实)

### 1.1 应用自身(随安装包,无需额外安装)

Electron 壳 + 阅读器 + 书坊面板 + **EPUB 构建器(纯 JS)** + 封面渲染(离屏)+ 文档列表后处理(JS,`docx-numbering.js`)+ 图片→CBZ(JS)+ MathML 渲染端 + 转换矩阵脚本。**这些不依赖引擎。**

### 1.2 后台依赖(今天要用户自己装的部分)

| 组件 | 用来做什么 | 形态 | 许可 | 体积 |
| --- | --- | --- | --- | --- |
| Python 3 | 所有 Python 脚本的运行时 | 系统安装 | PSF | ~50MB |
| **PyMuPDF(fitz)** | 文字层、文本型提取、红标清理、PDF 大纲 | pip | **AGPL-3.0** ⚠️ | ~20MB |
| Pillow | 图片 → 单页 PDF(再交给 OCR) | pip | HPND | ~3MB |
| latex2mathml | LaTeX → MathML(公式) | pip | MIT | <1MB |
| DocVortex | 文档互转(Office/OFD/HTML/EPUB → md/html/docx/pdf/latex) | pip | MIT | ~100MB(+模型 226MB 按需) |
| pdf_tool | PDF → Doc JSON(MinerU 链路)、阅读器 sidecar、家具清理 | git checkout | 自有 | 几 MB(依赖同上) |
| MinerU 本地 | 本地 OCR / 公式(离线) | venv + 模型 | Apache-2.0 系 | **3–6GB**(GPU) |
| MinerU 云端 | 同上(需 token) | 网络 | — | 0 |
| Calibre | EPUB → AZW3/MOBI、图片 → EPUB | 系统安装 | **GPL-3** ⚠️ | ~300MB |
| boko(候选) | EPUB → AZW3/KFX、AZW3/KFX → EPUB | 单文件二进制 | **GPL-3** ⚠️ | ~5MB |

### 1.3 已有的探测与设置(引擎化的基础)

设置 → 书坊 已有整套探测:`qbr:probe:ocr|docvortex|formula|calibre` + `qbr:mineru:status|ensure|path`(本地 MinerU 还能随应用自动拉起)。**引擎化之后这些全部保留**,作为「外部安装」的兼容路径。

## 2. 约束(三条硬线)

1. **许可** ⚠️:PyMuPDF(AGPL)、Calibre / boko(GPL-3)**不能进 Electron 安装包**(会传染)。→ 只能作为**独立程序**分发(独立进程调用,与今天用 Calibre 的方式一致)。
2. **体积** ⚠️:MinerU 模型 3–6GB → **绝不能默认下载**;必须按需 + 明确提示(尺寸 / 耗时 / 是否需要 GPU)。
3. **平台** ⚠️:Windows / macOS(arm64+x64)/ Linux 三套;Python 运行时用**可重定位发行版**(Windows embeddable、macOS/Linux 用 `python-build-standalone`),不要求用户装 Python。

## 3. 方案对比

| 方案 | 做法 | 体积 | 许可 | 体验 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A 全打进安装包 | Electron 包里带 Python + 全部依赖 | +400MB 起;模型不可能 | ✗ AGPL/GPL 传染 | 最省事 | **不可行** |
| B 应用内按需下载 | 首次用书坊时下载各组件 | 按需 | 仍受许可约束 | 好 | 部分可行 |
| **C 独立「书坊引擎」包**(推荐) | 单独可下载/可独立安装的引擎(独立程序、独立许可),应用探测 + 一键安装/更新 | 基础包 ~200–300MB | ✓ 独立程序,AGPL/GPL 可用 | 最好 | **推荐** |
| D 引导用户逐个装 | 现在这样 | 0 | ✓ | 差 | 兜底 |

**推荐 = C(主)+ B(安装方式)+ D(兜底)**:引擎是独立程序(单独下载、单独许可与来源说明),应用只负责探测、下载校验、解压、拉起;用户机器上已有的外部安装继续可用。

## 4. 推荐架构

### 4.1 引擎包含什么(基础包)

- **私有 Python 运行时**(Windows embeddable / macOS+Linux `python-build-standalone`,固定版本)
- 依赖:PyMuPDF、Pillow、latex2mathml、DocVortex(含其依赖)
- **pdf_tool**(固定 commit,`git archive` 进来的源码 + 其依赖)
- `engine.json` 清单(见 4.3)

注:我们的 Python 辅助脚本是**内联在应用 JS 里**的字符串,引擎只需要「运行时 + 库」,不含脚本 —— 脚本随应用升级,库随引擎升级。

### 4.2 不包含(可选组件 / 外部工具)

- **本地 MinerU**(venv + 模型):引擎的**可选组件**,按需下载;CPU 模式可用但慢,GPU 推荐;不装则用云端 token 或跳过。
- **Calibre / boko**(GPL-3 ⚠️):不进引擎包;走「外部工具」模式(探测 + 引导安装/下载)。boko 比 Calibre 轻得多 → **优先推荐 boko**(EPUB → AZW3/KFX),MOBI 仍由 Calibre 提供。

### 4.3 契约与探测

- `engine.json`:
  ```json
  { "schemaVersion": 1, "engineVersion": "1.0.0", "platform": "win32-x64",
    "python": { "version": "3.12.x" },
    "packages": { "PyMuPDF": "1.2x", "Pillow": "1x", "latex2mathml": "3.x", "docvortex": "0.5.x" },
    "pdfTool": { "commit": "…" },
    "capabilities": { "docvortex": true, "pdfTool": true, "mineruLocal": false } }
  ```
- **探测顺序**:设置里的自定义路径 → `%LOCALAPPDATA%/UVReader/engine/<version>`(取最新兼容)→ 现有外部探测(pdf_tool 目录 / Python / DocVortex / Calibre)→ 都没有 → 引导安装。
- **版本协商**:应用声明最低 `engineVersion` + 需要的 capability;不满足 → 设置页状态行「引擎需要更新」+ 一键更新。
- 现有设置项(`ocrPython` / `ocrSidecarDir` / `docvortexPath` / `calibrePath`)降级为**高级覆盖**(渐进披露)。

### 4.4 构建与发布

- 新脚本 `scripts/build-engine.mjs`:取 Python 运行时 → `pip install --target` 固定版本依赖 → vendor pdf_tool(固定 commit)→ 生成 `engine.json` + **许可清单**(`pip-licenses`)→ 打包 zip + sha256。
- 新工作流 `.github/workflows/engine.yml`:手动或打 `engine-v*` tag 触发,三平台各自构建 → 产物挂到 Release(**引擎版本独立编号**,与应用解耦)。
- 体积预估:基础包 200–300MB;本地 MinerU 组件 3–6GB(可选)。

## 5. 分阶段计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **E0** | 本文档(计划) | 用户确认方案与待确认项 |
| **E1** | 引擎定义与探测:`main/engine.js` + `engine.json` 契约 + 设置页状态行(未安装 / 已装 vX / 需更新)+ 回退现有探测 | 单测(探测顺序 / 版本协商 / 回退)+ e2e(状态行) |
| **E2** | 构建脚本:先跑通 Windows(embeddable Python + 依赖 + vendor pdf_tool + engine.json + zip) | 本机用引擎跑通:文本型提取 / 文字层 / 公式 / DocVortex 转换 / pdf_tool 提取 |
| **E3** | 一键安装:应用内「下载并安装引擎」(sha256 校验、解压到 LOCALAPPDATA、探测、进度)+ 手动指定路径 + 离线 zip 安装 | e2e(本地 zip 走完整流程)+ 断网 / 校验失败路径 |
| **E4** | 可选组件:boko(EPUB→AZW3/KFX + 反向)按外部工具模式接;本地 MinerU 组件(下载 + 首次模型提示) | 转换矩阵用引擎跑一遍;boko 单测 + 矩阵 |
| **E5** | 收口:文档、发布说明、旧用户迁移说明、矩阵回归 | 全量门禁 + 三平台引擎产物可下载 |

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 许可(AGPL / GPL) | 引擎 = 独立程序(单独下载、独立许可与来源说明);应用不打包 AGPL/GPL 内容;构建时输出许可清单 |
| 体积 / 下载体验 | 基础包与可选组件分离;下载显示大小与进度;支持离线 zip 安装 |
| 三平台差异 | python-build-standalone 固定版本;CI 三平台各自构建;矩阵回归 |
| pdf_tool 版本联动 | 引擎固定 commit + 兼容性测试(转换矩阵);pdf_tool 更新走引擎版本升级 |
| GPU / 模型 | 本地 MinerU 默认不装;CPU 模式可用;云端 token 兜底 |
| 回退 | 探测顺序保证「外部安装仍然可用」;设置里可停用引擎 |

## 7. 待确认(需要拍板)

1. 引擎产物挂在 **uvreader 的 Release** 还是**独立仓库/Release**?(建议:先挂 uvreader Release,版本独立编号 `engine-v*`)
2. 本地 MinerU 是否进「可选组件」?(建议:进,但默认不下载模型)
3. Calibre 继续支持,还是只推 boko(EPUB→AZW3/KFX)、MOBI 标注「老格式,需 Calibre」?(建议:后者)
4. E1+E2 先做,还是 E1–E3 一起(一次做到「用户能一键装」)?(建议:先 E1+E2,拿到 Windows 实测再决定 E3)

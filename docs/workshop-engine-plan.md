# 书坊引擎(workshop engine):发布方案评估与计划

日期:2026-10-19 · 状态:**计划(未开工,按「本地 HTTP 服务」架构修订)** · 关联:`docs/workshop.md` §6(技术架构)、`docs/workshop-implementation.md`

## 0. 问题

用户装完 UV Reader,**书坊的后台能力还得自己装一堆**:Python、PyMuPDF、Pillow、latex2mathml、DocVortex、pdf_tool、本地 MinerU(模型 GB 级)、Calibre…… 每样都要单独找、单独装、单独配路径。

目标:把书坊后台做成**一个可独立部署的模块(「书坊引擎」)**,以**本地 HTTP 服务**的形式暴露能力 —— 应用只负责探测、安装/更新与调用,**界面与功能解耦**;引擎也能单独跑在别的机器上(NAS / 服务器 / 带 GPU 的机器)。

## 1. 现状盘点(事实)

### 1.1 应用自身(随安装包,不需要引擎)

Electron 壳 + 阅读器 + 书坊面板 + **EPUB 构建器(纯 JS)** + 封面渲染(离屏)+ 文档列表后处理(JS,`docx-numbering.js`)+ 图片→CBZ(JS)+ MathML 渲染端 + 转换矩阵脚本。**这些属于产品逻辑,留在应用里。**

### 1.2 后台依赖(今天要用户自己装的部分)

| 组件 | 用来做什么 | 形态 | 许可 | 体积 |
| --- | --- | --- | --- | --- |
| Python 3 | 所有 Python 脚本的运行时 | 系统安装 | PSF | ~50MB |
| **PyMuPDF(fitz)** | 文字层、文本型提取、红标清理、PDF 大纲 | pip | **AGPL-3.0** ⚠️ | ~20MB |
| Pillow | 图片 → 单页 PDF(再交给 OCR) | pip | HPND | ~3MB |
| latex2mathml | LaTeX → MathML(公式) | pip | MIT | <1MB |
| DocVortex | 文档互转(Office/OFD/HTML/EPUB → md/html/docx/pdf/latex) | pip | MIT | ~100MB(+模型 226MB 按需) |
| pdf_tool | PDF → Doc JSON(MinerU 链路)、阅读器 sidecar、家具清理 | git checkout | 自有 | 几 MB(依赖同上) |
| MinerU 本地 | 本地 OCR / 公式(离线) | venv + 模型(已是 HTTP 服务) | Apache-2.0 系 | **3–6GB**(GPU) |
| MinerU 云端 | 同上(需 token) | 网络 | — | 0 |
| Calibre | EPUB → AZW3/MOBI、图片 → EPUB | 系统安装 | **GPL-3** ⚠️ | ~300MB |
| boko(候选) | EPUB → AZW3/KFX、AZW3/KFX → EPUB | 单文件二进制 | **GPL-3** ⚠️ | ~5MB |

### 1.3 已有的探测与设置(引擎化的基础)

设置 → 书坊 已有整套探测:`qbr:probe:ocr|docvortex|formula|calibre` + `qbr:mineru:status|ensure|path`;**本地 MinerU 本身就是 HTTP 服务**(`MINERU_LOCAL_URL` + `/v1/health` + 随应用自动拉起)—— **引擎直接沿用这套模式**,应用侧连探测/拉起/采纳的代码都能复用。引擎化之后现有探测**全部保留**作为「外部安装」的兼容路径。

## 2. 约束(三条硬线)

1. **许可** ⚠️:PyMuPDF(AGPL)、Calibre / boko(GPL-3)**不能进 Electron 安装包**(会传染)。→ 引擎作为**独立程序**(独立进程 / 独立服务)分发与调用,与今天用 Calibre 的方式一致。
2. **体积** ⚠️:MinerU 模型 3–6GB → **绝不能默认下载**;按需 + 明确提示(尺寸 / 耗时 / 是否需要 GPU)。
3. **平台** ⚠️:Windows / macOS(arm64+x64)/ Linux 三套;Python 运行时用**可重定位发行版**(Windows embeddable、macOS/Linux `python-build-standalone`),不要求用户装 Python。

## 3. 方案对比

| 方案 | 做法 | 体积 | 许可 | 体验 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A 全打进安装包 | Electron 包里带 Python + 全部依赖 | +400MB 起;模型不可能 | ✗ AGPL/GPL 传染 | 最省事 | **不可行** |
| B 应用内按需下载 CLI | 下载各组件,应用直接 spawn 命令行 | 按需 | 仍受许可约束 | 好 | 可行但耦合 |
| **C 独立引擎 = 本地 HTTP 服务**(推荐) | 单独部署的服务,`/v1/*` 暴露能力;应用只做探测/安装/调用 | 基础包 ~200–300MB | ✓ 独立程序,AGPL/GPL 可用 | 最好 | **推荐** |
| D 引导用户逐个装 | 现在这样 | 0 | ✓ | 差 | 兜底 |

**推荐 = C(主)+ B(安装方式)+ D(兜底)**:引擎是一个**可单独部署的本地 HTTP 服务**(单独下载、独立许可与来源说明),应用只负责探测、下载校验、拉起、调用;**用户已有的外部安装继续可用**。

### 3.1 为什么是 HTTP 服务(而不是 CLI)

- **界面/功能解耦** ✓:应用侧只剩一个 HTTP 客户端;引擎怎么实现、用什么语言、装在哪,应用不关心。
- **可单独部署** ✓:引擎能跑在 NAS / 服务器 / 带 GPU 的机器上,应用通过 URL 连过去(和本地 MinerU 服务的用法一致)。
- **进程与依赖隔离** ✓:AGPL/GPL 组件都关在引擎里,应用不打包它们。
- **版本与能力协商** ✓:`/v1/health` 一次问清版本与能力(有没有 DocVortex、有没有本地 MinerU、有没有 Calibre/boko)。
- **一处升级** ✓:引擎换版本 = 换一个服务;应用不需要跟着发版。
- 代价 ✗:多一层进程(需要端口、令牌、拉起/采纳逻辑)—— 但这些我们**已经在本地 MinerU 上做过一遍**,是熟路。

## 4. 推荐架构

### 4.1 引擎包含什么(基础包)

- **私有 Python 运行时**(Windows embeddable / macOS+Linux `python-build-standalone`,固定版本)
- **服务框架**:FastAPI + uvicorn(轻,自带 OpenAPI 文档,便于调试)
- 处理依赖:PyMuPDF、Pillow、latex2mathml、**DocVortex**(含其依赖)
- **pdf_tool**(固定 commit,`git archive` 进来的源码 + 其依赖)
- 我们的**服务代码**(`engine/` 包:路由、任务、日志)
- `engine.json`(随包清单,服务启动时读出来对外暴露,见 4.3)

注:应用里的 Python 辅助脚本(文字层 / 文本型 / 大纲 / 红标清理)会**搬进引擎**(它们本来就是后台能力);应用只保留产品逻辑(EPUB 组装、分章、AI、矩阵)。

### 4.2 不包含(可选组件 / 外部工具)

- **本地 MinerU**(venv + 模型):可选组件;CPU 可用但慢,GPU 推荐;不装则用云端 token 或跳过。引擎的 job 参数里带 MinerU 源(本地 URL / 云端 token),与今天应用传给 pdf_tool 的一致。
- **Calibre / boko**(GPL-3 ⚠️):不进引擎包;引擎**探测并调用**它们(路径可配),能力经 `/v1/health` 上报;boko 轻得多 → 优先推 boko(EPUB→AZW3/KFX + 反向),MOBI 仍由 Calibre 提供。

### 4.3 服务契约(草案,v1)

```
GET   /v1/health                     → { ok, engineVersion, schemaVersion, platform, packages, pdfTool,
                                         capabilities: { <名字>: { ok, detail }, …, jobKinds: [...] } }
                                         # 能力是引擎**自己探出来的**(?refresh=1 强制重探;默认 30s 缓存)
GET   /v1/config                     → { config, path }        # 配置的单一来源在引擎;令牌只回 has
PATCH /v1/config { patch }           → { config, capabilities } # 部分更新;令牌留空 = 不改;改完立刻重探
POST  /v1/jobs       { kind, args }  → { jobId }               # 长任务一律走作业
GET   /v1/jobs/{id}                  → { status, progress, label, error }
GET   /v1/jobs/{id}/result           → 结果(JSON 或产物路径)
DELETE /v1/jobs/{id}                 → 取消
POST  /v1/math       { latex[] }     → { mathml[] }            # 轻量同步接口
```

**引擎配置**(路径 / 凭据 / 并发):存在 `ENGINE_CONFIG` 或 `~/.uvreader-engine/config.json`;字段
`pdfToolDir` / `python` / `docvortexPath` / `mineruLocalUrl` / `mineruToken` / `mineruModel` / `calibrePath` / `bokoPath` / `workers`。
**应用只做 UI**:设置页读 `/v1/config` 渲染、改完 `PATCH` 回去;应用侧的路径输入降级为「没有引擎时的手动配置」。

`kind`(v1 覆盖今天应用直接 spawn 的全部能力):
`extract`(PDF→md/html/json;auto/text/mineru/vision)、`convert`(DocVortex)、`text-layer`、`pdf-text`、`outline`、`redact`、`images-to-pdf`、`ebook-convert`(Calibre/boko)。

- **鉴权**:安装时生成随机 token,应用存在密钥库;`Authorization: Bearer …`;**默认只绑 `127.0.0.1`**;要对外暴露需显式配置(那时 token 必须有)。
- **文件传递**:v1 用**本地路径**(同机部署,引擎直接读文件);远程部署的**上传模式**放到 v2(multipart)。
- **作业模型**:长任务(提取 / 转换 / 文字层)一律作业化,进度用轮询(应用的任务队列本来就是轮询 ✓);作业结果给「产物路径 + 摘要」。
- **生命周期**:应用可以自己拉起引擎(和拉起本地 MinerU 一样),也可以**采纳已在运行的服务**(`/v1/health` 探测);退出时只关自己拉起的那个。

### 4.4 应用侧改造(尽量薄)

- 新增 `main/engine-client.js`:HTTP 客户端(health / job 提交 / 轮询 / 取消 / 结果)+ 令牌读取。
- 现有 runner(`extract-doc` / `pdf-text` / `text-layer` / `math-render` / `workshop-formula`)**优先走引擎**;引擎不可用 → **回退到今天的本机 spawn**(兼容不破)。
- 设置 → 书坊 增加「**书坊引擎**」段:状态行(未安装 / 已装 vX / 需更新 / 运行中 / 外部地址)、URL 与令牌(高级)、「下载并安装/更新」「启动服务」「检测」。
- 现有 `ocrPython` / `ocrSidecarDir` / `docvortexPath` / `calibrePath` 降级为**高级覆盖**。

### 4.5 构建与发布

- `scripts/build-engine.mjs`:取 Python 运行时 → `pip install --target` 固定版本依赖 → vendor pdf_tool(固定 commit)→ 复制服务代码 → 生成 `engine.json` + **许可清单**(`pip-licenses`)→ 打 zip + sha256。
- `.github/workflows/engine.yml`:手动或打 `engine-v*` tag,三平台各自构建 → **挂到 uvreader 的 Release**(已确认),引擎版本独立编号。
- 体积预估:基础包 200–300MB;本地 MinerU 组件 3–6GB(可选)。

## 5. 分阶段计划
| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **E0** | 本计划(服务架构版) | 用户确认 ✓ |
| **E1 ✅ 已完成(2026-10-19)** | **服务骨架 + 契约**:`engine/`(FastAPI:health / jobs / math)+ token + `engine.json`;应用侧 `engine-client` + 设置页「书坊引擎」状态行 + **回退现有 spawn** | 单测(客户端:探测/作业/取消/回退)✓ + 真机冒烟(health / 令牌 / math / text-layer 作业 36 页)✓ + e2e 待补 |
| **E2 ✅ 已完成(2026-10-19)** | **搬能力**:文字层 / pdf-text / outline / redact / images-to-pdf 从应用脚本搬进引擎;`extract`(pdf_tool)与 `convert`(DocVortex)作业化 | 七类作业全部搬好并接线(引擎优先、失败回退);引擎自测 **11 项**进 CI。注:应用里的 Python 脚本**保留**作为「没有引擎」的兜底,等 E3 把引擎变成默认后可以删 |
| **E3** | **打包与一键安装**:三平台构建脚本 + 应用内「下载并安装/更新引擎」(sha256、解压到 `%LOCALAPPDATA%/UVReader/engine/<version>`、拉起、进度)+ 离线 zip 安装 | e2e(本地 zip 走完整流程)+ 断网 / 校验失败 / 版本过旧路径 |
| **E4** | **可选组件与外部工具**:boko 接入(EPUB→AZW3/KFX + 反向)、Calibre 探测与调用、本地 MinerU 组件(模型按需下载 + 提示) | 转换矩阵用引擎跑一遍;boko 单测 + 矩阵 |
| **E5** | **收口**:文档、发布说明、旧用户迁移说明、矩阵回归、远程部署说明(URL + token) | 全量门禁 + 三平台引擎产物可下载 |

### 5.1 E1 落地记录(2026-10-19)
- **引擎**(`engine/`,FastAPI + uvicorn):`/v1/health`(读 `engine.json`,上报版本 / 平台 / Python / 包版本 / **能力** + `jobKinds`)、`/v1/jobs`(**作业模型**:提交 → `status/done/total/label` 轮询 → 结果 / `DELETE` 取消;2 个工人、历史 50 条)、`/v1/math`(同步;从应用搬来:清 `\tag` 与环境外壳、空壳 `\square` + 悬空上下标**修复重试**)、`/v1/jobs kind=text-layer`(PyMuPDF 逐页取文本,带进度)。Bearer 令牌(设了就必须带;默认只绑 `127.0.0.1`);CLI:`python -m engine serve --port 8760 --token …`。
- **应用侧**:`main/engine-client.js`(`health / submit / status / result / cancel / math` + `normalizeEngineUrl` + `describeEngineHealth`)、IPC `qbr:probe:engine` + preload、设置 → 书坊 新增「**书坊引擎(后台能力)**」卡片(地址 / 令牌 / 检测 + 状态行)。**回退不变**:引擎只是新增能力,现有本机 spawn 链路照旧。
- **验证**:`engine-client` 单测 5 项(mock HTTP:health、令牌、作业全流程、连不上给可读原因;真引擎冒烟在缺依赖时自动跳过)+ **真机冒烟**(临时 venv 起引擎):health `0.1.0 · 1 类作业`、不带令牌 401、两条公式(含 `\mathbb { }` 空壳)都出 MathML、**text-layer 作业** 36 页 / 87,919 字符、产物文本正确。
- **踩坑**:`engine/requirements.txt` 写中文注释会让 pip 按 GBK 解码报错 → 该文件保持 ASCII;`python -m engine` 要在 `engine/` 目录里跑(否则外层目录成为命名空间包、撞名)。
- **E2 要补**:引擎的 **Python 侧测试 + CI 作业**(现在真引擎冒烟只在有依赖的机器上跑);搬能力时把应用的脚本删掉(避免两份实现)。

### 5.2 e2e 覆盖(2026-10-19,打包前)

按用户要求「先把 e2e 做详细,再打包」,两层:

1. **引擎 ↔ 真客户端**(`scripts/engine-e2e.mjs`):起**真服务**(临时 `ENGINE_CONFIG`、随机端口、Bearer 令牌),用应用的真客户端跑 **27 项** —— health(版本 / 七类作业 / 能力形状)、不带令牌被拒、配置往返(令牌不回显、未知字段忽略、**能力随配置变化**、落盘在引擎侧)、`math`(含 `\mathbb { }` 空壳修复)、**七类作业各跑一遍**(文字层产物与进度 / 大纲层级 / pdf-text 结构化行 / 红标擦掉标区且保留区外 / 图片→PDF 页数 / extract 走假 pdf_tool / convert 走假 docvortex)、取消、未知作业类型、缺文件的可读错误。依赖缺失本地默认跳过,CI 用 `--require` 直接失败;**已进 CI 的 engine 作业**。
2. **应用 ↔ 引擎**(e2e `workshop` 场景扩展):用本地 **stub 服务**验证设置页「书坊引擎」卡片 —— 填地址与令牌 → 「检测引擎」→ 状态行显示版本与能力、**能力清单逐项 ✓/✗**、地址存进设置、应用真的打了 `/v1/health`;**服务停掉后再检测 → 如实报「不可用」**。真引擎与应用的联调(任务级)留给 E3 的一键安装后回归。

### 5.3 手工验证:这次是不是引擎干的?

三层证据(建议 1 + 3 一起看):

1. **应用里**:设置 → 书坊 → 「书坊引擎」卡片 → **「查看引擎作业」** —— 列出引擎最近的作业(`时间 · kind · 状态 · 参数摘要`)。跑一次任务后这里多出对应的一条,就是引擎干的。
2. **引擎控制台**:起服务时那个窗口,每个作业提交/结束都有一行
   `[job] <id> <kind> submitted {…}` / `[job] <id> <kind> done`。
3. **HTTP 直查**(最权威):
   ```powershell
   $t = "你的令牌"   # 没设令牌就删掉 -Headers
   Invoke-RestMethod -Headers @{ Authorization = "Bearer $t" } "http://127.0.0.1:8760/v1/jobs?limit=20" | ConvertTo-Json -Depth 4
   ```

**应用路径 → 引擎作业的对应表**:

| 你在书坊点的 | 引擎里的 kind |
| --- | --- |
| 内容提取 / 向导选「文本型」/ 格式转换·文本型 | `pdf-text` |
| 公式优先(PDF 提取) | `extract`(pdf_tool) |
| 格式转换(DocVortex 那条) | `convert` |
| PDF 清理(喂给 DocVortex 前的红标擦除) | `redact` |
| 成书时的 PDF 大纲 | `outline` |
| 文字层导出(已搬,尚未接线) | `text-layer` |
| 图片 → PDF(已搬,尚未接线) | `images-to-pdf` |

**两条前提**:① 只有**配了 `engineUrl`** 才会走引擎(没配 = 零开销);② 引擎**不可用或失败**时会**回退本机** —— 这时清单里没有对应记录,所以「清单里有没有」正好能区分两条路。

### 5.4 本机(开发机)运行引擎

- **安装位置**:venv 在 `%LOCALAPPDATA%\UVReader\engine\venv`;启动器 `…\engine\start-engine.cmd`(读同目录 `token.txt`,端口 8760,日志 `engine.log`);引擎配置 `~/.uvreader-engine/config.json`。
- **启动/停止**:双击 `start-engine.cmd`(或 `node scripts/engine-e2e.mjs` 会自己起临时实例);停止 = 关掉那个窗口,或按端口杀:`Get-NetTCPConnection -LocalPort 8760 | Stop-Process -Id {$_.OwningProcess}`。
- **应用侧**:`设置 → 书坊 → 书坊引擎` 里填 `http://127.0.0.1:8760` + 令牌(`token.txt`),或直接写进 `%APPDATA%\qiaomu-reader-desktop\data\data.json` 的 `settings.engineUrl` / `settings.engineToken`(应用没在跑时)。
- **DocVortex 的调用顺序**(实测坑):**配置路径 → PATH 上的 `docvortex`(CLI,Windows 是 `docvortex.exe`)→ `python -m docvortex`** —— 最后一个在 0.5.16 上会报 `No module named docvortex.__main__`,只能当兜底。

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 许可(AGPL / GPL) | 引擎 = 独立服务(单独下载、独立许可与来源说明);应用不打包 AGPL/GPL 内容;构建时输出许可清单 |
| 端口 / 安全 | 默认 `127.0.0.1` + Bearer token(安装时生成、存密钥库);对外暴露必须配 token;端口冲突自动换端口并回报 |
| 体积 / 下载体验 | 基础包与可选组件分离;下载显示大小与进度;支持离线 zip 安装 |
| 三平台差异 | python-build-standalone 固定版本;CI 三平台各自构建;矩阵回归 |
| pdf_tool 版本联动 | 引擎固定 commit + 兼容性测试(转换矩阵);pdf_tool 更新走引擎版本升级 |
| 作业/进度语义 | 作业模型与现有任务队列对齐(status/progress/cancel);应用侧保留超时与重试 |
| 回退 | 引擎不可用 → 回退现有 spawn;设置里可停用引擎;外部安装继续可用 |
| 服务存活 | 应用可拉起、可采纳、只关自己拉起的;崩溃后下次任务自动重启一次 |

## 7. 待确认

1. 引擎**服务端口**与 token:默认 `127.0.0.1:8760`(可配)+ 安装时生成 token —— 可以吗?
2. `ebook-convert`(Calibre / boko)是**由引擎统一代理**,还是应用自己调(像今天这样)?(建议:引擎统一代理,应用只认 `/v1/jobs`)
3. 远程部署(引擎跑在另一台机器)v1 就支持「URL + token + 本地路径不可用」的提示,还是等 v2 上传模式一起做?(建议:v1 支持 URL 连接,文件传递先要求同机;上传模式 v2)
4. 开工范围:E1+E2 先做(拿到真实素材实测),还是 E1–E3 一起(一步做到「一键装引擎」)?(建议:先 E1+E2)

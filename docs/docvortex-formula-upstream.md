# 备忘:把公式识别做进 DocVortex(B 方案)

> 状态:**未开工,备查**。当前采用 **A 方案**(书坊「公式优先」链路:pdf_tool MinerU → HTML → DocVortex),见 `docs/workshop.md` §8.1 与 `docs/workshop-implementation.md`。
> 记录日期:2026-10-11(基于 DocVortex 0.5.16 实测)。

## 1. B 是什么

把公式**识别**补进 DocVortex 自己的扫描件 OCR 链路,而不是在书坊里把 MinerU 拼在前面:

1. 给 OCR 路径加**公式识别模型**(PP-FormulaNet / UniMERNet 的 ONNX 版,与它现有 PP-DocLayoutV2 / PP-OCRv6 同族),把 `display_formula` 裁剪图与行内公式区域转成 LaTeX;
2. 顺带支持**外部文本源**(喂 MinerU layout.json / vision 结果,参照 pdf_tool 的 `--source mineru|hybrid`:文本替换、位置保留);
3. 顺带补齐 **Markdown / txt 输入**(0.5.16 里 `TEXT_EXTENSIONS` 只是 ingestible、`FileSuffix` 里根本没有,`convert` 会报 `Unsupported native input format: markdown|txt`)。**书坊侧已于 2026-10-17 自解**:转换 / 提取遇到文本源先渲染成 HTML 桥(见 `docs/workshop.md` §8.1 与 `main/docvortex.js` 的 `textSourceHtml`),上游补不补都不再阻塞使用。

## 2. 为什么"只缺识别"

- **渲染管线已完整**:LaTeX → MathML(`latex2mathml`)→ OMML(`mathml2omml`)写 DOCX(`render/_internal/docx/math.py`);EPUB 输出 MathML(`render/_internal/epub/renderer.py`);PDF 用 `ziamath` 画矢量(`render/_internal/pdf/formula.py`);公式编号 `\tag{}` 也有(`foundation/_text.py: build_tagged_formula_content`)。
- **内部表示就是裸 LaTeX**:`content/markup/formula.py` 集中识别静态 HTML/XHTML 公式并归一化为 LaTeX(支持 MathML、`<script type="math/tex">`、`data-tex`、annotation 等来源)。
- **OCR 路径现状**:`analyzers/ocr/pdf.py` 的 `_VISUAL_TYPES` 把 `display_formula` 映射为 `equation` 但**保留为截图**;`formula_number` 会并入公式框;行内公式走 `analyzers/ocr/text.py`(PP-OCRv6 纯文本,上下标拉平)。
- **模型是固定 ONNX**:`analyzers/ocr/runtime.py`(`LayoutModel` + `TextModel`,进程内复用)、`analyzers/ocr/download.py`(首次自动下载,`~/.docvortex/model`)。

## 3. 实施钩子(开工时从这里入手)

| 目标 | 落点 |
| --- | --- |
| 公式识别模型 | `analyzers/ocr/runtime.py` + `download.py` 增加 `FormulaModel`(CPU ONNX);模型候选 PP-FormulaNet_plus / UniMERNet |
| 显示公式 | `analyzers/ocr/pdf.py`:`display_formula` 由"截图"改为"LaTeX + 可选截图兜底";`_merge_formula_number_regions` 已有 |
| 行内公式 | 难点:版式模型只标显示公式。需几何启发式(字号/基线偏移)或专门 inline 检测;可先做"显示公式 LaTeX + 行内保持现状"的最小版本 |
| 外部文本源 | 参照 pdf_tool `pdf_tool/ocr/sources.py`(layout.json / vision 结果 → Line/blocks)与 `--source mineru|hybrid` |
| Markdown 输入 | `document/source.py: FILE_SUFFIXES` 不含 md;需接一个 markdown 分析器,公式走 `content/markup/formula.py` 的 LaTeX 定界符 |
| 渲染 | **无需改动**(DOCX/EPUB/PDF 三条渲染已就绪) |

## 4. 优势与代价

**优势**

- **离线**:无云端、无 token、无页数配额;文件不出本机(试卷/内部资料刚需)。
- **一体化**:一条命令 `docvortex convert scan.pdf --format docx`,不依赖 pdf_tool checkout 与 HTML 桥,失败面小。
- **可组合**:识别能力同时服务图片输入与 EPUB/PDF 输出;A 退化为"最高质量档"(可选)。
- 隐私、速度(无上下传)、成本(本地推理)都优于 A。

**代价/风险**

- 改**第三方包**:提 PR 或维护分支,需跟上游版本走,长期维护成本。
- 模型质量上限:PP-FormulaNet/UniMERNet 对干净裁剪很好,模糊/手写/密集排版仍不如 MinerU 的 VLM;硬案例还得靠 A。
- 行内公式检测是工作量大头(见上表)。
- 体积:+100–300MB 模型,首次运行变慢(与现有 PP-OCRv6 首次下载同性质)。

## 5. 中间路线 B′(不改 DocVortex,离线优先)

在**书坊的桥**里挂本地公式模型:pdf_tool 本地 OCR 定位公式裁剪 → 本地 ONNX 公式模型出 LaTeX → 填进我们生成的 HTML(仍是 `<script type="math/tex">` → DocVortex 渲染)。
优点:完全在我们仓库内、离线、可控;缺点:做不到 B 的"单工具一条命令"。改动估计 1–2 天(模型集成 + 裁剪 + 单测/e2e)。

## 6. 触发条件(什么时候值得启动)

- 出现**不能上传云端**的场景(试卷、内部资料、客户文档);
- MinerU 配额/价格/政策变化,或需要大批量(几百页以上)离线处理;
- 想让书坊减少外部依赖(pdf_tool checkout + token + 网络三层);
- 上游 DocVortex 接受公式模型 PR(或我们决定维护分支)。

## 7. 复现与验证资料

- 桥与链路:`apps/desktop/src/main/formula-html.js`、`apps/desktop/src/main/workshop-formula.js`(A 方案;B/B′ 可复用其中的 HTML 公式载体约定)。
- 实测数据:14 页扫描件 → DOCX **197 OMML(96 下标 / 52 上标)**;3 页 → 50 OMML / 10 下标;EPUB 输出 MathML。
- MinerU 侧证据:`pdf_tool/output/testpdf2/mineru/full.md`(公式 LaTeX 含上下标/分式)。
- e2e:`workshop-formula`(`QBR_E2E_MINERU=1` 才真跑云端)。

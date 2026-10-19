# pdf_tool 完整测试报告（文字层 + pdf_to_doc）

- 日期：2026-10-11
- 对象：① 扫描 PDF 文字层（阅读器在用）② `pdf_to_doc`（PDF → Doc v1 完整提取）
- 环境：Windows / Python 3.11（`python -m pdf_tool.reader`）/ rapidocr PP-OCRv6 / 真实 sidecar + 真实扫描件
- 入口：阅读器（Electron，真实 `pdf_tool.reader` 子进程）与 `pdf_tool` CLI；题目抽取本轮不在范围

## 1. 文字层（阅读器路径）

夹具：`pdf_tool/pdfs/small_ocr.pdf`（2 页真实扫描，gitignored；本轮从 `test-docs/testpdf2.pdf` 前两页重建，此前缺失导致 OCR E2E 静默跳过）。

| 用例 | 结果 |
|---|---|
| `probe`（启动 + ping） | `ok` / `pdf_tool.reader` |
| 懒加载单页 OCR（冷缓存） | 2.0–3.0s/页，35 行、35 items |
| 同会话缓存命中 | **5ms**，行数一致 |
| 跨进程缓存复用（模拟重开应用） | 新 sidecar 733ms（未重跑 OCR），35 行一致 |
| hybrid（MinerU `layout.json`） | `source=hybrid`，737ms，35 行 |
| 导出可搜索 PDF（扫描件，缓存热） | ok，1.4s，插入 61 行，短语命中 1 次（源 0 次），832 字符 |
| 导出可搜索 PDF（**冷缓存**，`workers=1`） | ok，7.1s，`failed_pages=[]` —— **09-26 报告的 P0 挂起已修复** |
| 导出文本型 PDF（`aitest.pdf`） | ok，`skipped_text_pages=2`、`lines_inserted=0`；短语命中数与源一致（4/4、1/1）—— **P1-1 重复文字层已修复** |
| 阅读器 E2E（真实 sidecar，2 页扫描） | 进度 0/2 → 首页文字可见 → 页面文字层上屏 → 查找面板 1/1 命中并可跳转 → `文字层已生成`，E2E OK |
| `tests/test_pdf_tool_reader_server.py` | 11 项全过 |

复跑：

```bash
# sidecar 集成（uvreader 的 createPdfOcr 直连真实 sidecar；脚本在临时目录）
node %TEMP%/opencode/ocr-full-test.mjs
# 阅读器完整流程
cd D:/projects/uvreader/apps/desktop && QBR_E2E_ONLY=ocr node scripts/e2e.mjs
# sidecar 单测
cd D:/projects/auto_chat && python -m pytest tests/test_pdf_tool_reader_server.py -q
```

## 2. pdf_to_doc（完整提取）

离线部分（不需要模型 key）：

| 用例 | 结果 |
|---|---|
| `PythonTest.pdf` blocks → Doc v1 | 68 blocks → 11 页：text 50 / heading 6 / image 6 / table 3 / code 3；`audit_ok=True` |
| `math-deep-p20.pdf` blocks → Doc v1 | 22 blocks → 18 页；正文保留 LaTeX（`$\sum_{i\in I}a_i$`、`$E^{*}$`、`$\mathfrak{su}(2)$`） |
| md/html 渲染 | md：标题/表格管道语法/``` 代码/`![...]` 图片；html：`<table>`×3、`<pre>`×3、`<img>`×6、标题层级 |

真实历史产物（模型/ MinerU 跑过的输出）元素覆盖统计：

- text 2276、heading 200、image 141、code 47、table 9、question 367（题目抽取）；
- **公式没有独立 block 类型**：以 LaTeX 形式留在 text 块里（CSP2021_doc 7 块、math-deep-p20 7 块、CSP2019_doc 1 块）；扫描件里的公式/图是整块栅格图（image）。
- 若后续要「重新排版」，公式建议考虑 `formula` 块类型或至少给 LaTeX text 块打标；图片目前是裁图资产 + `![插图n]` 锚点。

本轮**未跑** text/vision/mineru 的在线模式：当前 shell 没有 `DEEPSEEK_API_KEY` / `MINERU_API_KEY`（用户环境里也没有），需要 key 才能跑；blocks 模式与渲染已覆盖到「blocks → Doc → md/html + 审计」全链。

## 3. 备注

- `--out-dir` 指到输出根之外的目录时，审计会告警「图片文件不存在」（blocks 里的 src 相对输出根解析）；用默认输出目录或绝对 src 即可。
- 建议把「冷缓存导出」「跨进程缓存复用」两个用例固化成自动化测试，防止 P0/P1 回归。
- `pdf_tool/pdfs/` 是 gitignored 的测试输入目录；建议保留一份小扫描件（或让阅读器 E2E 回退到 `test-docs/ctest.pdf`），避免再次静默跳过。

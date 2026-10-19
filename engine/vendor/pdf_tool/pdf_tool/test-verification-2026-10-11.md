# pdf_tool 完整测试报告（文字层 + pdf_to_doc）

- 日期：2026-10-11
- 范围：① 扫描 PDF 文字层（阅读器在用）② `pdf_to_doc` 完整提取；题目抽取本轮不在范围
- 环境：Windows / Python 3.11.9 / PyMuPDF 1.26.7 / rapidocr 3.10（PP-OCRv6）/
  paddleocr 3.7（PP-DocLayoutV2）/ 真实 sidecar 子进程 / 真实 DeepSeek API + MinerU
- 结论速览：两个功能全链路通过；本轮发现并修复 2 个问题（旋转页水印过滤、外部
  `--out-dir` 图片路径）；全量 `pytest` **392 passed / 5 skipped**，`ruff` 全绿。
- 相关：`pdf_tool/reader-verification-2026-10-11.md`（阅读器 Electron E2E 视角，外部会话
  产出）；`pdf_tool/pdfs/small_ocr.pdf`（gitignored 测试夹具）。

---

## 1. 文字层（扫描 PDF → 可搜索层，阅读器路径）

### 1.1 单测

`test_pdf_tool_ocr_layer / ocr_page / textlayer / reader_server / text_sources /
line_align / latex_text`：**40 passed**。

### 1.2 CLI 端到端（`ocr_layer_pdf.py`，7/7）

| 用例 | 结果 |
|---|---|
| 全量 CSP2019（9 页扫描） | 插入 536 行，导出 PDF 每页可提取文字（合计 7417 字符）；冷缓存 12.8s（6 workers），热缓存 2.8s |
| 页范围（ctest 2-3） | 仅 2/3 页有文字层 |
| `--source mineru`（layout.json） | 22 行，dpi=72 |
| `--source hybrid` | 105 行，`merge_coverage=0.928` |
| 文本型 PDF 跳过 | `skipped_text_pages=1`、`lines_inserted=0` |
| `--ocr windows`（winocr） | 55 行 / 0.7s |
| 90° 旋转页 | 49 行 / 799 字符；调试图确认文字框贴合旋转后的文本行 |

### 1.3 几何校验

未旋转与旋转页的文字层 word 框均与墨迹对齐（质心偏移 ≤ ~7pt；并输出红框调试图目视确认）。

### 1.4 阅读器真实 sidecar 端到端（真进程 + 冷缓存）

| 用例 | 结果 |
|---|---|
| **P0 回归**：全新进程、首个请求即冷导出 | 4.8s 完成（51 行、`workers=1`、9 页保留、p1 888 字符可搜） |
| `ocr.page` 冷 / 命中 | 2.9s / 命中行内容完全一致 |
| `search.query` | 2 命中、`cached_pages=1` |
| `ocr.prefetch` | 2 个 `ocr.prefetched` 通知 / 4.4s |
| `convert.start mode=cache`（2-3 页） | done 2/2、`failed_pages=[]` |
| `convert.start mode=export`（1-2 页） | 105 行、`failed_pages=[]`；导出 PDF 页数保留、前两页可搜 |
| `convert.status` | `kind=ocr`、终态正确 |
| `cache.stats / cache.clear` | 3 页/32KB → 清后 0（需传 `path` 参数） |
| `doc.convert mode=blocks` | `audit_ok=true`，json/md/html/audit 齐全 |
| `convert.page` | mode=blocks、1 页、983 字符 md |
| **P1-1 回归**：文本型 PDF 导出 | `skipped_text_pages=1`、`lines_inserted=0`、原命中数不变 |

---

## 2. pdf_to_doc（完整提取：文字/图片/表格/代码/公式）

### 2.1 单测

`test_pdf_tool_convert / model / doc_mode / doc_audit / blocks_to_md / blocks_to_pdf /
mineru / mineru_chunked / pdf_doc_pipeline / text_sources`：**60 passed**。

### 2.2 CLI 端到端（9 用例）

| 模式 | 用例 | 结果 |
|---|---|---|
| blocks（离线） | CSP2019_box | 0.2s，30 blocks，audit ok |
| text | aitest 2 页 | 26 blocks，audit ok |
| text | PythonTest p1-3 | 表格 2 个，audit ok |
| vision | ctest 5 页扫描 | 24 blocks，audit ok |
| mineru | aitest 2 页 | 44 blocks（含 1 code + 1 image），audit ok |
| auto（无 token） | aitest | 正确路由到 text |
| mineru | testpdf2 p1-2（物理卷） | equations=1 / tables=2；md 含 19 处 LaTeX |
| vision | testpdf2 p1-2 | audit ok（`stats.ok=false` 仅因模型引用了不存在的框号） |
| text | PythonTest 代码页 | 该页"代码"实为题干内联 `print(...)`，未打围栏是正确的 |

内容类型覆盖：文字 ✔、图片 ✔（裁图资产 + `![插图n]` 锚点）、表格 ✔、代码 ✔
（blocks/mineru）、公式 ✔（LaTeX 内联在 text 块，无独立 `equation` 块类型）。

---

## 3. 本轮修复记录（2026-10-11）

| 问题 | 处理 | 验证 |
|---|---|---|
| `/Rotate≠0` 页面水印过滤静默失效（OCR 框在渲染空间、texttrace 在未旋转空间） | `core/watermark.filter_ocr_lines` 增加 `derotation` 参数；`ocr/backends.process_page` 传 `page.derotation_matrix` | 新增 `test_filter_ocr_lines_rotated_page`（旋转页剔除成功；不传 derotation 的旧行为也被断言固化） |
| `--out-dir` 在 `pdf_tool/output` 之外时，vision 模式遇图 `ValueError`（`relative_to(OUT_ROOT)`） | `assets/crops` 新增 `_rel_asset`：OUT_ROOT → 本次输出目录 → 绝对路径 三级回退；三处 stage2 全部改用它 | 新增 `test_rel_asset_fallback_outside_output_root`；E2E：testpdf2 vision + 外部 out-dir 从崩溃变为 exit 0、21 图、`audit ok`、md 图片链接为 `assets/imgs/...` |
| （顺带）`stage2_crops` PLR0917 超参数 | `pp_source` 改 keyword-only | `ruff check` 全绿 |

## 4. 遗留（未在本轮修复，均有证据）

- **扫描件的图像水印会被 OCR 进文字层**：CSP2019 的"山西"像素水印被识别为 149pt 巨框；
  现有过滤只看 PDF 自带文本水印（get_texttrace），看不到像素水印。
- vision 模式模型偶发引用不存在的框号（`stats.ok=false`，`unknown_refs=[22]`；doc 审计仍 ok）。
- 公式没有独立 block 类型（LaTeX 留在 text 块）；若后续"重新排版"，建议加 `formula`
  类型或给 LaTeX text 块打标。
- `--out-dir` 外部路径下，blocks 模式的审计仍会对相对 src 告警（见 reader-verification 备注）。

## 5. 复跑方式（关键命令）

```bash
# 文字层批量
python pdf_tool/ocr_layer_pdf.py --pdf pdf_tool/test-docs/CSP2019.pdf --out /tmp/searchable.pdf
# 阅读器 sidecar（行 JSON-RPC over stdio）
python -m pdf_tool.reader
# PDF → Doc（blocks / text / vision / mineru / auto）
python pdf_tool/pdf_to_doc.py --pdf pdf_tool/test-docs/aitest.pdf --mode text
python pdf_tool/pdf_to_doc.py --pdf pdf_tool/test-docs/ctest.pdf --mode vision
python pdf_tool/pdf_to_doc.py --pdf pdf_tool/test-docs/aitest.pdf --mode mineru   # 读 MINERU_TOKEN / MINERU_API_KEY
# 全量测试
python -m pytest
```

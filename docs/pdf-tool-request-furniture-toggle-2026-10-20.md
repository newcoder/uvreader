# pdf_tool 需求:家具清理(水印 / 页眉页脚)加一个开关

日期:2026-10-20 · 提出方:reader(UV Reader / 纽扣)

## 背景

书坊「数据提取」页要提供选项:**去除水印 / 页眉页脚**(默认保持现状 = 去)。原因:试卷 / 练习册的页眉常带卷名、页码常带题目连续信息;有些用户希望原样保留,以便核对。

## 现状(reader 侧核对了 vendored 快照 `engine/vendor/pdf_tool`)

- `pdf_tool/convert/pipeline.py` 里 `filter_blocks(blocks, scan_pdf(pdf))` 是**无条件调用**;
- 结果有计数(`stats.furniture`);MinerU 路线另有 `strip_furniture_lines`;
- CLI(`pdf_to_doc.py` / `extract_questions.py` / ingest)都**没有**对应开关。

## 需求

1. CLI 加一个开关(名字随你们,**建议 `--keep-furniture`**,不加 = 保持今天的行为):
   - `pdf_tool/pdf_to_doc.py`:`--keep-furniture` → 跳过 `filter_blocks`;
   - `pdf_tool/extract_questions.py` 与 ingest 路径 → 透传同一个开关;
   - 输出 stats 里如实记录,例如 `furniture: {"removed": 0, "kept": true}`。
2. 语义:开着时**一条都不删**(页眉 / 页脚 / 页码 / 水印全部保留),`stats.furniture.removed = 0` 且 `kept = true`,便于 reader 在结果里显示。
3. 验收:一份带页眉 + 页码 + 水印的 PDF,两种模式各跑一次:
   - 默认:页眉 / 页码 / 水印都不在产物里,`stats.furniture.removed > 0`;
   - `--keep-furniture`:它们**逐字**都在,`kept = true`。
   建议加进现有家具测试;reader 的 `scripts/engine-e2e.mjs` 也会加一条对照(同一份 PDF 两种模式)。

## reader 侧会怎么用

- 引擎的 `extract` 作业把复选框状态透传成参数;数据提取页的复选框**默认勾选(去)**,取消勾选时传 `--keep-furniture`;
- 在 pdf_tool 支持之前,页面只写说明「pdf_tool 目前总是自动清理(已提需求)」,**不做假开关**。

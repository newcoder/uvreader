#!/usr/bin/env python3
"""本地毫秒级页面筛查：找出含图片/矢量图（图表）的页，供 box 精确挂图只处理这些页。

- PyMuPDF `get_images()` / `get_drawings()`：~2ms/页，2204 页全扫约 5 秒；
- 纯文字页直接跳过 box 提取，可省 ~90% 的版面模型/上传时间；
- 结果是候选集合（宁可多不可漏），是否真有插图由 box 模型判定。
"""
from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("qb.triage")


def flag_pages(pdf: Path, *, min_drawings: int = 20) -> list[int]:
    """返回含嵌入图片或矢量图（drawings >= min_drawings）的页码（1-based，升序）。"""
    import fitz

    doc = fitz.open(pdf)
    flagged: list[int] = []
    total = doc.page_count
    try:
        for i, page in enumerate(doc):
            if page.get_images() or len(page.get_drawings()) >= min_drawings:
                flagged.append(i + 1)
    finally:
        doc.close()
    log.info("[triage] %d 页中筛出 %d 个候选页", total, len(flagged))
    return flagged

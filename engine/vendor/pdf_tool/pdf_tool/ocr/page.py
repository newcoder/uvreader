"""单页文字层（阅读器懒加载）：OCR（页级缓存）→ 可选文本源对齐 → pdf.js items。"""
from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path

from pdf_tool.ocr import backends
from pdf_tool.ocr.cache import page_cache_file
from pdf_tool.ocr.lines import Line, parse_pages

log = logging.getLogger("qb.ocrpage")


def ocr_page_lines(pdf, page_no: int, *, ocr: str = "rapid", dpi: float = 200.0,
                   min_score: float = 0.5, cache_root: Path | None = None,
                   backend=None, force: bool = False, name: str | None = None,
                   skip_text_chars: int = 0) -> list[Line]:
    """单页 OCR（页级缓存）；backend 仅测试注入，name 默认文件 stem（阅读器传指纹）。"""
    cache_file = page_cache_file(name or Path(pdf).stem, page_no, ocr, dpi, min_score,
                                 cache_root)
    args = (str(pdf), page_no, dpi, ocr, min_score, str(cache_file), force,
            skip_text_chars)
    if backend is not None:
        backends._WORKER = backend
    _, lines_json, _seconds, _skipped = backends.process_page(args)
    return [Line.from_json(v) for v in lines_json]


def ocr_page_items(pdf, page_no: int, *, ocr: str = "rapid", dpi: float = 200.0,
                   min_score: float = 0.5, text_source: Path | None = None,
                   cache_root: Path | None = None, backend=None, force: bool = False,
                   name: str | None = None) -> dict:
    """单页文字层：OCR 行 →（可选）文本源块内对齐 → pdf.js TextContent。

    返回 {page, dpi, source(ocr|hybrid), lines, content, has_text}。
    """
    import fitz

    from pdf_tool.ocr import sources
    from pdf_tool.ocr.textlayer import lines_to_content

    lines = ocr_page_lines(pdf, page_no, ocr=ocr, dpi=dpi, min_score=min_score,
                           cache_root=cache_root, backend=backend, force=force, name=name)
    source = "ocr"
    if text_source is not None:
        blocks = sources.load_text_blocks(Path(text_source)).get(page_no) or []
        if blocks and lines:
            texts, _cov = sources.merge_layout_blocks(
                blocks, [ln.to_json() for ln in lines], dpi)
            lines = [Line(t, ln.quad, ln.score) for ln, t in zip(lines, texts, strict=False)]
            source = "hybrid"

    doc = fitz.open(str(pdf))
    try:
        page = doc[page_no - 1]
        content = lines_to_content(lines, page, dpi)
    finally:
        doc.close()
    return {"page": page_no, "dpi": dpi, "source": source,
            "lines": [ln.to_json() for ln in lines], "content": content,
            "has_text": bool(content["items"])}


def warm_pages(pdf, pages, *, ocr: str = "rapid", dpi: float = 200.0,
               min_score: float = 0.5, cache_root: Path | None = None, backend=None,
               force: bool = False, name: str | None = None,
               on_page: Callable[[int, int, int], bool | None] | None = None) -> dict:
    """批量预热页级缓存（不产 PDF）；on_page(page_no, done, total) 返回 False 则停止。"""
    import fitz

    doc = fitz.open(str(pdf))
    try:
        total = doc.page_count
    finally:
        doc.close()
    if isinstance(pages, (list, tuple)):
        page_list = [int(p) for p in pages if 1 <= int(p) <= total]
    else:
        page_list = parse_pages(str(pages or ""), total)

    done = 0
    failed: list[dict] = []
    for page_no in page_list:
        try:
            ocr_page_lines(pdf, page_no, ocr=ocr, dpi=dpi, min_score=min_score,
                           cache_root=cache_root, backend=backend, force=force, name=name)
        except Exception as e:
            log.warning("预热第 %d 页失败: %s", page_no, e)
            failed.append({"page": page_no, "error": f"{type(e).__name__}: {e}"})
        done += 1
        if on_page is not None and on_page(page_no, done, len(page_list)) is False:
            return {"pages": len(page_list), "done": done, "cancelled": True,
                    "failed": failed}
    return {"pages": len(page_list), "done": done, "cancelled": False, "failed": failed}

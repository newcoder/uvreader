"""PDF 结构操作公用：页面范围导出等。"""
from __future__ import annotations

from pathlib import Path


def make_chunk_pdf(src, pages: list[int], dest: Path) -> None:
    """把指定页（1-based，按给定顺序）导出为一个临时 PDF。

    按连续段合并 insert_pdf：逐页插入会把共享资源复制 N 份（实测 20 页膨胀到 5.5MB），
    按段插入 20 页仅 ~0.5MB。
    """
    import fitz

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = fitz.open()
    start = prev = None
    for p in pages:
        if start is None:
            start = prev = p
        elif p == prev + 1:
            prev = p
        else:
            part.insert_pdf(src, from_page=start - 1, to_page=prev - 1)
            start = prev = p
    if start is not None:
        part.insert_pdf(src, from_page=start - 1, to_page=prev - 1)
    part.save(dest)
    part.close()


def split_ranges(total: int, max_pages: int) -> list[tuple[int, int]]:
    """1-based 闭区间分卷：total=250, max_pages=200 → [(1,200), (201,250)]。"""
    if max_pages <= 0:
        return [(1, total)]
    return [(s, min(s + max_pages - 1, total)) for s in range(1, total + 1, max_pages)]

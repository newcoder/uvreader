"""文字层主流程 build()：取文字（OCR / 文本源 / 混合）→ 插入不可见层 → 保存。"""
from __future__ import annotations

import logging
import multiprocessing as mp
from pathlib import Path

from pdf_tool.ocr import backends
from pdf_tool.ocr.backends import _worker_init, process_page_safe
from pdf_tool.ocr.cache import cache_dir as _cache_dir
from pdf_tool.ocr.layer import _load_font, _load_math_font, insert_layer
from pdf_tool.ocr.lines import parse_pages
from pdf_tool.ocr.sources import (
    lines_from_layout,
    load_text_blocks,
    merge_layout_blocks,
)

log = logging.getLogger("qb.ocrlayer")

DEFAULT_DPI = 200.0


class ConversionCancelled(RuntimeError):
    """转换被 on_page 回调取消（不产出文件）。"""


def build(pdf: Path, out: Path, *, ocr: str = "rapid", dpi: float = DEFAULT_DPI,
          pages_spec: str = "", min_score: float = 0.5, workers: int = 6,
          force: bool = False, backend=None, skip_text_chars: int = 200,
          source: str = "ocr", layout_path: Path | None = None,
          intra_op: int | None = 2, on_page=None,
          cache_root: Path | None = None, cache_name: str | None = None) -> dict:
    """主流程：取文字（并行 OCR / MinerU layout / 两者混合）→ 插入不可见文字层 → 保存。

    backend 仅测试用：传入后端实例则单进程直跑（便于离线断言）。
    skip_text_chars：页内已有文字超过该长度则跳过（原生文本 PDF 无需叠加）。
    source：
      ocr    本地 OCR（行级位置）
      mineru MinerU layout.json 的 span（行级 bbox；hybrid 后端产物多为块级）
      hybrid rapid 行级位置 + 文本源（MinerU/vision/blocks JSON）块内序列对齐
    on_page(page_no, done, total)：每页 OCR 完成后回调（返回 False 取消转换）。
    """
    import fitz

    if source in ("mineru", "hybrid"):  # 先校验文本源，避免 hybrid 白跑一遍 OCR 才报错
        if layout_path is None or not Path(layout_path).exists():
            raise FileNotFoundError(
                f"--source {source} 需要存在的文本源 JSON（--layout）：{layout_path}")
    src = fitz.open(pdf)
    total = src.page_count
    pages = parse_pages(pages_spec, total)
    # 缓存键含 backend/dpi/min_score：任一变化都重新 OCR（旧键缓存不匹配即失效）
    # cache_name：批处理默认文件 stem，阅读器传内容指纹（与逐页模式共用同一缓存）
    cache_dir = _cache_dir(cache_name or pdf.stem, ocr, dpi, min_score, cache_root)

    results: dict[int, list[list]] = {}
    ocr_seconds = 0.0
    skipped = 0
    merge_coverage = None
    done_pages = 0
    failed_pages: list[dict] = []

    def _progress(page_no: int) -> None:
        nonlocal done_pages
        done_pages += 1
        if on_page is not None and on_page(page_no, done_pages, total) is False:
            raise ConversionCancelled(f"第 {page_no} 页后取消")

    def _collect(page_no, lines, sec, was_skipped, err) -> None:
        """收集单页结果：失败页只记入 failed_pages，不中断整本。"""
        nonlocal ocr_seconds, skipped
        if err:
            failed_pages.append({"page": page_no, "error": err})
        results[page_no] = lines
        ocr_seconds += sec
        skipped += int(was_skipped)
        _progress(page_no)

    if source == "mineru":
        layout_lines = lines_from_layout(Path(layout_path))
        for p in pages:
            results[p] = [ln.to_json() for ln in layout_lines.get(p, [])]
            _progress(p)
        dpi = 72.0  # MinerU bbox 已是 PDF 点
    else:  # ocr / hybrid：先拿 rapid 行级框
        tasks = [(str(pdf), p, dpi, ocr, min_score,
                  str(cache_dir / f"page_{p:04d}.json"), force, skip_text_chars)
                 for p in pages]
        if backend is not None:
            backends._WORKER = backend
            for t in tasks:
                page_no, lines, sec, was_skipped, err = process_page_safe(t)
                _collect(page_no, lines, sec, was_skipped, err)
        elif workers > 1 and len(tasks) > 1:
            with mp.Pool(workers, initializer=_worker_init,
                         initargs=(ocr, intra_op)) as pool:
                for page_no, lines, sec, was_skipped, err in pool.imap_unordered(
                        process_page_safe, tasks, chunksize=1):
                    _collect(page_no, lines, sec, was_skipped, err)
        else:
            _worker_init(ocr, intra_op)
            for t in tasks:
                page_no, lines, sec, was_skipped, err = process_page_safe(t)
                _collect(page_no, lines, sec, was_skipped, err)
        if source == "hybrid":
            layout_blocks = load_text_blocks(Path(layout_path))
            covs: list[float] = []
            for p in pages:
                blocks = layout_blocks.get(p) or []
                if not blocks or not results.get(p):
                    continue
                texts, cov = merge_layout_blocks(blocks, results[p], dpi)
                covs.append(cov)
                for i, t in enumerate(texts):
                    results[p][i][0] = t
            merge_coverage = round(sum(covs) / len(covs), 3) if covs else 0.0

    fontname, fontfile = _load_font()
    math_font = _load_math_font()
    inserted = 0
    for page_no in pages:
        page = src[page_no - 1]
        inserted += insert_layer(page, results.get(page_no, []), dpi, fontname, fontfile,
                                 math_font)
    try:
        src.subset_fonts()
    except Exception as e:
        log.warning("字体子集化失败: %s", e)
    out.parent.mkdir(parents=True, exist_ok=True)
    src.save(str(out), garbage=4, deflate=True)
    src.close()

    stats = {"pages": len(pages), "source": source, "skipped_text_pages": skipped,
             "lines_inserted": inserted, "ocr_seconds": round(ocr_seconds, 1),
             "ocr": ocr if source != "mineru" else None, "dpi": dpi, "workers": workers,
             "size_kb": out.stat().st_size // 1024}
    if merge_coverage is not None:
        stats["merge_coverage"] = merge_coverage
    if failed_pages:
        stats["failed_pages"] = failed_pages
        stats["ok"] = False
    log.info("[ocr-layer] %s", stats)
    return stats

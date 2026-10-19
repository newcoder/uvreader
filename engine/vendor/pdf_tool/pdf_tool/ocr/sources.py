"""文字层文本源：MinerU layout / vision results / blocks JSON，以及块内序列对齐。"""
from __future__ import annotations

import html
import json
import logging
import re
from pathlib import Path

from pdf_tool.ocr.lines import Line

log = logging.getLogger("qb.ocrlayer")

# 无 bbox 的文本源（vision / box / doc 产物）按页对齐：整页占位框
WHOLE_PAGE_BBOX = (-1e6, -1e6, 1e6, 1e6)


# ---------------- 文本源（MinerU layout / vision results / blocks JSON） ----------------

def _load_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise TypeError(f"文本源 JSON 顶层应为对象: {path}")
    return data


def _iter_layout_blocks(data: dict):
    """MinerU layout.json → 逐 (页码, block) 产出（只走 para_blocks 的阅读顺序）。"""
    for pg in data.get("pdf_info") or []:
        page_no = int(pg.get("page_idx") or 0) + 1
        for block in pg.get("para_blocks") or []:
            yield page_no, block


def _span_text(sp: dict) -> str | None:
    """span → 可进文字层的文本：公式转 Unicode，图片/空内容返回 None。"""
    t = sp.get("type")
    if t in ("image", "seal"):
        return None
    raw = str(sp.get("content") or "").strip()
    if not raw:
        return None
    if t in ("inline_equation", "interline_equation") or "$" in raw:
        from pdf_tool.ocr.latex_text import latex_to_text

        return latex_to_text(raw).strip() or None
    return raw


def _blocks_from_layout(data: dict) -> dict[int, list[dict]]:
    pages: dict[int, list[dict]] = {}
    for page_no, block in _iter_layout_blocks(data):
        parts: list[str] = []
        for ln in block.get("lines") or []:
            for sp in ln.get("spans") or []:
                text = _span_text(sp)
                if text:
                    parts.append(text)
        text = " ".join(parts).strip()
        bbox = block.get("bbox")
        if text and bbox and len(bbox) == 4:
            pages.setdefault(page_no, []).append(
                {"bbox": [float(v) for v in bbox], "text": text})
    return pages


def lines_from_layout(layout_path: Path) -> dict[int, list[Line]]:
    """MinerU `layout.json` → {页码: [Line]}（span bbox，单位已是 PDF 点）。

    - 只读 `para_blocks`（阅读顺序），`discarded_blocks`（页眉/页脚）天然剔除；
    - 公式 span 经 `latex_to_text` 转 Unicode；图片/空 span 跳过。
    """
    pages: dict[int, list[Line]] = {}
    for page_no, block in _iter_layout_blocks(_load_json(layout_path)):
        out = pages.setdefault(page_no, [])
        for ln in block.get("lines") or []:
            for sp in ln.get("spans") or []:
                text = _span_text(sp)
                if text is None:
                    continue
                bbox = sp.get("bbox") or ln.get("bbox") or block.get("bbox")
                if not bbox or len(bbox) != 4:
                    continue
                x0, y0, x1, y1 = (float(v) for v in bbox)
                if x1 <= x0 or y1 <= y0:
                    continue
                out.append(Line(text, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 1.0))
    return {p: v for p, v in pages.items() if v}


def blocks_from_layout(layout_path: Path) -> dict[int, list[dict]]:
    """MinerU `layout.json` → {页码: [{"bbox", "text"}]}（保留块级 bbox，供 hybrid 对齐）。"""
    return _blocks_from_layout(_load_json(layout_path))


def _block_plain_text(b: dict) -> str:
    """我们的 blocks JSON（box/doc/vision 产物）→ 该块可进文字层的纯文本。"""
    t = b.get("type")
    if t == "question" or "stem" in b:  # vision 抽取的题目 type 是题型枚举，用 stem 判定
        no = str(b.get("no") or b.get("number") or "").strip()
        stem = str(b.get("stem") or "")
        parts = [f"{no}. {stem}" if no else stem]
        for o in b.get("options") or []:
            if not isinstance(o, dict):
                parts.append(str(o))
                continue
            oid = str(o.get("option_id") or o.get("key") or "").strip()
            otext = str(o.get("option_text") or o.get("text") or "")
            parts.append(f"{oid}. {otext}" if oid else otext)
        for key in ("answer", "explanation"):
            if b.get(key):
                parts.append(str(b[key]))
        return " ".join(p for p in parts if p)
    if t == "code":
        return str(b.get("content") or b.get("code") or "")
    if t == "table":
        head = [str(h) for h in b.get("headers") or []]
        rows = [" ".join(str(c) for c in row) for row in b.get("rows") or []]
        return " ".join([*head, *rows]).strip()
    return str(b.get("text") or b.get("content") or "")


def _blocks_from_doc(data: dict) -> dict[int, list[dict]]:
    """Doc v1（{schema_version, pages:[{page, blocks}]}）→ 每页块文本（供 hybrid 对齐）。"""
    pages: dict[int, list[dict]] = {}
    for pg in data.get("pages") or []:
        if not isinstance(pg, dict) or not isinstance(pg.get("page"), int):
            continue
        parts = [_block_plain_text(b) for b in pg.get("blocks") or []]
        text = " ".join(p for p in parts if p.strip()).strip()
        if text:
            pages[pg["page"]] = [{"bbox": list(WHOLE_PAGE_BBOX), "text": text}]
    return pages


def _middle_block_text(b: dict) -> str:
    """docvortex.middle v2 块 → 纯文本（表格 HTML 去标签；图片/图表无文本返回空）。"""
    if b.get("type") == "equation":
        return str(b.get("content") or "").strip()
    parts: list[str] = []
    for c in b.get("content") or []:
        if not isinstance(c, dict):
            continue
        body = c.get("content")
        if not body:
            continue
        if c.get("type") == "table_body":
            body = re.sub(r"<[^>]+>", " ", str(body))
        elif c.get("type") not in ("text", "code_body", "code"):
            continue
        parts.append(str(body))
    text = html.unescape(" ".join(parts))
    return re.sub(r"\s+", " ", text).strip()


def _blocks_from_middle_v2(data: dict) -> dict[int, list[dict]]:
    """docvortex.middle v2（MinerU 4.x 本地产物）→ {页码: [{"bbox", "text"}]}。

    bbox 在 middle 里是 0-1 归一化，用 `extensions.docvortex_layout` 的页尺寸换算成
    点，与 rapid 行框（×72/dpi）同一坐标系，供 hybrid 按块对齐。
    """
    sizes: dict[int, tuple[float, float]] = {}
    layout = (data.get("extensions") or {}).get("docvortex_layout") or {}
    for pg in layout.get("pages") or []:
        if isinstance(pg, dict) and pg.get("page_idx") is not None:
            try:
                sizes[int(pg["page_idx"])] = (float(pg["width_pt"]), float(pg["height_pt"]))
            except (TypeError, ValueError):
                continue
    pages: dict[int, list[dict]] = {}
    for pg in data.get("pages") or []:
        if not isinstance(pg, dict):
            continue
        try:
            idx = int(pg.get("page_idx") or 0)
        except (TypeError, ValueError):
            continue
        w, h = sizes.get(idx, (0.0, 0.0))
        out: list[dict] = []
        for b in pg.get("blocks") or []:
            if not isinstance(b, dict):
                continue
            text = _middle_block_text(b)
            if not text:
                continue
            bbox = b.get("bbox")
            if isinstance(bbox, (list, tuple)) and len(bbox) == 4 and w > 0 and h > 0:
                x0, y0, x1, y1 = (float(v) for v in bbox)
                box = [x0 * w, y0 * h, x1 * w, y1 * h]
            else:
                box = list(WHOLE_PAGE_BBOX)
            out.append({"bbox": box, "text": text})
        if out:
            pages[idx + 1] = out
    return pages


def _blocks_from_vision_results(data: dict) -> dict[int, list[dict]]:
    pages: dict[int, list[dict]] = {}
    for res in data.get("pages") or []:
        page_no = res.get("page")
        if not isinstance(page_no, int):
            continue
        parts = [_block_plain_text(q) for q in res.get("questions") or []]
        text = " ".join(p for p in parts if p.strip()).strip()
        if text:
            pages[page_no] = [{"bbox": list(WHOLE_PAGE_BBOX), "text": text}]
    return pages


def blocks_from_vision_results(path: Path) -> dict[int, list[dict]]:
    """vision_results.json（{"pages":[{page, questions,…}]}）→ 每页一个块（整页 bbox）。

    没有行/块 bbox 的文本源（vision 抽取、box/doc blocks）只能按页对齐，
    故 bbox 用整页占位；位置仍来自 rapid 行框，精度不受影响。
    """
    return _blocks_from_vision_results(_load_json(path))


def _blocks_from_blocks_json(data: dict) -> dict[int, list[dict]]:
    by_page: dict[int, list[str]] = {}
    for b in data.get("blocks") or []:
        m = re.search(r"(\d+)", str(b.get("position") or ""))
        if not m:
            continue
        text = _block_plain_text(b).strip()
        if text:
            by_page.setdefault(int(m.group(1)), []).append(text)
    return {p: [{"bbox": list(WHOLE_PAGE_BBOX), "text": " ".join(parts)}]
            for p, parts in by_page.items()}


def blocks_from_blocks_json(path: Path) -> dict[int, list[dict]]:
    """我们的 blocks JSON（box/doc 产物，带 `position` 页码）→ 按页合并的块文本。"""
    return _blocks_from_blocks_json(_load_json(path))


def load_text_blocks(path: Path) -> dict[int, list[dict]]:
    """按内容自动识别文本源：MinerU layout.json / vision_results.json / blocks JSON。"""
    data = _load_json(path)
    if isinstance(data, dict) and data.get("schema") == "docvortex.middle":
        # MinerU 4.x 本地产物：须先于 Doc v1 判定（同样带 schema_version + pages）
        return _blocks_from_middle_v2(data)
    if "pdf_info" in data:
        return _blocks_from_layout(data)
    if "schema_version" in data and "pages" in data:  # Doc v1（convert 产物）
        return _blocks_from_doc(data)
    if "pages" in data:
        return _blocks_from_vision_results(data)
    if "blocks" in data:
        return _blocks_from_blocks_json(data)
    raise ValueError(
        f"无法识别的文本源 JSON（须 schema=docvortex.middle / pdf_info / "
        f"schema_version+pages / pages / blocks）: {path}")


# ---------------- 块内对齐（hybrid：文本源 → rapid 行） ----------------

def _center_inside(rect: tuple[float, float, float, float],
                   bbox: list[float], ratio: float = 0.5) -> bool:
    """行框中心在块框内、且与块框重叠面积占比达标 → 视为该块的行。"""
    cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
    x0, y0, x1, y1 = bbox
    if not (x0 - 2 <= cx <= x1 + 2 and y0 - 2 <= cy <= y1 + 2):
        return False
    ow = max(0.0, min(rect[2], x1) - max(rect[0], x0))
    oh = max(0.0, min(rect[3], y1) - max(rect[1], y0))
    area = max(1e-6, (rect[2] - rect[0]) * (rect[3] - rect[1]))
    return ow * oh / area >= ratio


def merge_layout_blocks(blocks: list[dict], lines_json: list[list], dpi: float,
                        ) -> tuple[list[str], float]:
    """块内对齐：MinerU 块文本 → rapid 各行文本；返回 (每行新文本, 平均块覆盖率)。

    未被任何块覆盖的 rapid 行保持原文本（MinerU 漏检区域的兜底）。
    """
    from pdf_tool.ocr.line_align import merge_block_text

    scale = 72.0 / dpi
    texts = [str(item[0]) for item in lines_json]
    rects: list[tuple[float, float, float, float]] = []
    for item in lines_json:
        x0, y0, x1, y1 = Line.from_json(item).rect
        rects.append((x0 * scale, y0 * scale, x1 * scale, y1 * scale))

    coverages: list[float] = []
    for block in blocks:
        idxs = [i for i, r in enumerate(rects) if _center_inside(r, block["bbox"])]
        if not idxs:
            continue
        new_texts, cov = merge_block_text(block["text"], [texts[i] for i in idxs])
        coverages.append(cov)
        for k, i in enumerate(idxs):
            texts[i] = new_texts[k]
    avg = sum(coverages) / len(coverages) if coverages else 0.0
    return texts, avg

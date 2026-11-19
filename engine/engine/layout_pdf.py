"""Scanned-PDF layout rebuild: OCR boxes + MinerU text -> clean text PDF.

The input is a scanned PDF (one image per page) plus a MinerU layout JSON:
``{"pages": [{"page": 1, "blocks": [{"type": "text",
"bbox": [x0, y0, x1, y1], "text": "..."}]}]}``.

For every text line we:
1. take the line box from RapidOCR (layout),
2. take the correct characters from MinerU (recognition),
3. erase the scanned glyphs with the local background colour,
4. draw the text back with a system CJK font.

Illustrations, coloured panels and decorative rules stay untouched. Text inside
image/table blocks and rotated text are left as raster; they may get an invisible
text layer so search still works.
"""
from __future__ import annotations

import difflib
import io
import json
import logging
import math
import os
import re
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("engine.layout_pdf")

DEFAULT_DPI = 216
MIN_SCORE = 0.7
MAX_ANGLE = 5.0
JPEG_QUALITY = 70
SKIP_BLOCK_TYPES = {"image", "table"}
MIXED_BACKGROUND_STD = 15.0
# Text over artwork is kept as raster: a flat fill leaves bands across the
# picture. Background pixels inside the line box stay below this on paper.
TEXTURE_STD = 12.0
# Background samples stay close to the line box: a wider ring reaches the
# neighbouring line on tight leading and makes a plain page look "mixed", which
# used to leave every other paragraph as unscanned raster.
BACKGROUND_PAD = 2
# Headings on a colour bar fill their band, so the ring straddles the bar edge.
# For those blocks the dominant colour inside the line box is the background.
TITLE_KINDS = {"doc_title", "paragraph_title", "header", "footer"}
CJK_RANGES = r"\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef"


# ── small pure helpers (unit-testable, no heavy imports) ────────────────────

def parse_pages(value: str, total: int) -> list[int]:
    """Parse ``"1-3,8"`` into 1-based page numbers; empty means all pages."""
    if not str(value or "").strip():
        return list(range(1, max(0, int(total)) + 1))
    wanted: set[int] = set()
    for part in str(value).split(","):
        part = part.strip()
        if not part:
            continue
        match = re.match(r"^(\d+)\s*-\s*(\d+)$", part)
        if match:
            start, end = int(match.group(1)), int(match.group(2))
            if start > end:
                start, end = end, start
            wanted.update(range(start, end + 1))
        elif part.isdigit():
            wanted.add(int(part))
    return sorted(page for page in wanted if 1 <= page <= int(total))


def clean_text(text: str) -> str:
    """Undo MinerU's ``^{①}`` superscript markers and soft hyphens."""
    value = str(text or "")
    value = re.sub(r"\^\{([^{}]*)\}", r"\1", value)
    value = value.replace("\u00ad", "")
    # MinerU often leaves a space around superscript markers and before CJK
    # punctuation. Chinese typesetting does not use those; the header's
    # intentional "图解 纳兰词" space is kept.
    value = re.sub(r"\s*([\u2460-\u2473\u24ea-\u24ff])\s*", r"\1", value)
    value = re.sub(r"\s+([，。！？；：、）》」』】])", r"\1", value)
    value = re.sub(r"([（《「『【])\s+", r"\1", value)
    # MinerU separates some runs with spaces ("集， 名", "《纳兰词》 的"), which
    # pushes a line past its OCR box. Drop spaces only between CJK characters;
    # Latin words, numbers and code keeps its spacing.
    value = re.sub(rf"(?<=[{CJK_RANGES}])[ \t\u00a0]+(?=[{CJK_RANGES}])", "", value)
    value = re.sub(r"[ \t]{2,}", " ", value)
    # Bullets belong to the printed page, not to the OCR line box: MinerU often
    # keeps the bullet while the box starts after it, which drew "●●".
    value = re.sub(r"^[\u25cf\u25cb\u25c6\u25c7\u25a0\u25a1\u25aa\u25ab\u2022]+[ \t]*", "", value)
    return value.strip()


def _boundaries(ocr_all: str, target: str) -> tuple[list[int], float]:
    matcher = difflib.SequenceMatcher(None, ocr_all, target, autojunk=False)
    mapping = [0] * (len(ocr_all) + 1)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for index in range(i1, i2 + 1):
                mapping[index] = j1 + (index - i1)
        elif tag == "replace":
            span = max(1, i2 - i1)
            for index in range(i1, i2 + 1):
                mapping[index] = j1 + round((j2 - j1) * (index - i1) / span)
        elif tag == "delete":
            for index in range(i1, i2 + 1):
                mapping[index] = j1
        elif tag == "insert":
            # Inserted target characters belong at the *start* of the next OCR
            # line, not the end of the current one: OCR line breaks follow the
            # printed width, and MinerU usually recovers a character the OCR
            # missed at the beginning of the next line.
            mapping[i1] = j1
    return mapping, matcher.ratio()


def align_lines(text: str, lines: list[dict]) -> tuple[list[str], float]:
    """Map MinerU block text onto the OCR line boxes.

    The OCR text only supplies character counts; the characters themselves come
    from MinerU, so OCR mistakes do not leak into the rebuilt page. SequenceMatcher
    keeps the mapping stable when OCR drops or adds a character.
    """
    cleaned = clean_text(text)
    ocr_all = "".join(str(line.get("text") or "") for line in lines)
    if not ocr_all:
        return [cleaned] + [""] * (len(lines) - 1), 1.0
    mapping, ratio = _boundaries(ocr_all, cleaned)
    result: list[str] = []
    position = 0
    for index, line in enumerate(lines):
        length = len(str(line.get("text") or ""))
        start = mapping[position]
        position += length
        end = mapping[position]
        if index == len(lines) - 1:
            end = len(cleaned)
        result.append(cleaned[start:end])
    return result, ratio


def split_by_weights(text: str, lines: list[dict]) -> list[str]:
    """Fallback when SequenceMatcher cannot align: split by OCR character counts."""
    cleaned = clean_text(text)
    if len(lines) <= 1:
        return [cleaned]
    weights = [max(1, len(str(line.get("text") or ""))) for line in lines]
    total = sum(weights)
    pieces: list[str] = []
    start = 0
    used = 0
    for index, weight in enumerate(weights):
        if index == len(weights) - 1:
            end = len(cleaned)
        else:
            used += weight
            end = min(len(cleaned), max(start + 1, round(len(cleaned) * used / total)))
        pieces.append(cleaned[start:end])
        start = end
    return pieces


def choose_lines(blocks: list[dict], lines: list[dict], width: int, height: int) -> list[dict]:
    """Assign every OCR line to at most one text block; return drawable items.

    ``lines`` are dicts with ``text``, ``score``, ``rect`` in pixels and ``angle``
    in degrees. ``blocks`` are MinerU blocks with normalised bboxes.
    """
    image_boxes = [block["bbox"] for block in blocks if block.get("type") in SKIP_BLOCK_TYPES]

    def inside_image(line: dict) -> bool:
        x0, y0, x1, y1 = line["rect"]
        cx = (x0 + x1) / 2 / max(1, width)
        cy = (y0 + y1) / 2 / max(1, height)
        return any(
            box[0] - 0.005 <= cx <= box[2] + 0.005 and box[1] - 0.005 <= cy <= box[3] + 0.005
            for box in image_boxes
        )

    usable = [
        line for line in lines
        if float(line.get("score") or 1.0) >= MIN_SCORE
        and abs(float(line.get("angle") or 0.0)) <= MAX_ANGLE
        and (line["rect"][2] - line["rect"][0]) >= (line["rect"][3] - line["rect"][1]) * 0.66
        and not inside_image(line)
    ]
    assigned: dict[int, list[int]] = {}
    leftover: list[int] = []
    for index, line in enumerate(usable):
        x0, y0, x1, y1 = line["rect"]
        cx = (x0 + x1) / 2 / max(1, width)
        cy = (y0 + y1) / 2 / max(1, height)
        best: tuple[float, int] | None = None
        for block_index, block in enumerate(blocks):
            if block.get("type") in SKIP_BLOCK_TYPES:
                continue
            bx0, by0, bx1, by1 = block["bbox"]
            if not (bx0 <= cx <= bx1 and by0 <= cy <= by1):
                continue
            overlap_x = max(0.0, min(x1 / max(1, width), bx1) - max(x0 / max(1, width), bx0))
            overlap_y = max(0.0, min(y1 / max(1, height), by1) - max(y0 / max(1, height), by0))
            score = overlap_x * overlap_y / max(1e-6, (x1 - x0) / max(1, width) * (y1 - y0) / max(1, height))
            if best is None or score > best[0]:
                best = (score, block_index)
        if best is None:
            leftover.append(index)
        else:
            assigned.setdefault(best[1], []).append(index)

    items: list[dict] = []
    for block_index, indexes in assigned.items():
        block = blocks[block_index]
        lines_in_block = [usable[index] for index in indexes]
        lines_in_block.sort(key=lambda line: (round(line["rect"][1] / 10), line["rect"][0]))
        explicit = [part.strip() for part in clean_text(block.get("text") or "").split("\n") if part.strip()]
        if len(explicit) == len(lines_in_block):
            texts = explicit
        else:
            texts, ratio = align_lines(block.get("text") or "", lines_in_block)
            if ratio < 0.6 or not any(texts):
                texts = split_by_weights(block.get("text") or "", lines_in_block)
        for line, text in zip(lines_in_block, texts):
            if text:
                items.append({
                    "rect": line["rect"],
                    "text": text,
                    "kind": block.get("type") or "text",
                    "visible": True,
                    "color": None,
                })
    for index in leftover:
        line = usable[index]
        items.append({
            "rect": line["rect"],
            "text": str(line.get("text") or ""),
            "kind": "text",
            "visible": True,
            "color": None,
        })
    return items


def ring_background(image, rect, pad: int = 10):
    """Median colour and channel spread in a ring around ``rect`` (pixels).

    The ring excludes the text itself, so the result is the local panel colour
    even when the glyphs are thick. A large spread means the box straddles two
    colours (e.g. a title bar and the page below it); those lines are skipped.
    """
    import numpy as np

    height, width = image.shape[:2]
    x0, y0, x1, y1 = [int(round(value)) for value in rect]
    rx0, ry0 = max(0, x0 - pad), max(0, y0 - pad)
    rx1, ry1 = min(width, x1 + pad), min(height, y1 + pad)
    region = image[ry0:ry1, rx0:rx1]
    if region.size == 0:
        return None, 999.0
    ring = np.ones(region.shape[:2], dtype=bool)
    ring[y0 - ry0:y1 - ry0, x0 - rx0:x1 - rx0] = False
    pixels = region[ring].reshape(-1, 3)
    if len(pixels) == 0:
        return None, 999.0
    return np.median(pixels, axis=0), float(np.mean(np.std(pixels, axis=0)))


def text_mask(subimage, background):
    """Pixels that differ from the local background; returns (mask, distance)."""
    import cv2
    import numpy as np

    distance = np.sqrt(((subimage.astype(np.float32) - background.astype(np.float32)) ** 2).sum(axis=2))
    if float(distance.max()) < 18:
        return None, distance
    distance8 = np.clip(distance, 0, 255).astype(np.uint8)
    threshold, _ = cv2.threshold(distance8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Keep the anti-aliased fringe: a higher cut-off leaves a grey ghost of the
    # printed glyph under the new text, which reads as "the scan was not
    # replaced" at normal zoom.
    threshold = max(14, int(threshold * 0.45))
    mask = (distance > threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    height, width = subimage.shape[:2]
    keep = np.zeros_like(mask)
    for index in range(1, count):
        area = stats[index, cv2.CC_STAT_AREA]
        box_height = stats[index, cv2.CC_STAT_HEIGHT]
        if area <= 0.45 * width * height and box_height <= height * 0.95:
            keep[labels == index] = 1
    return keep, distance


def rect_background(patch) -> tuple[object, float]:
    """Dominant colour inside a line box and the share of pixels it covers.

    Headings printed on a colour bar fill the bar, so the ring around the box
    mixes the bar with the page and looks "mixed". Their own box is almost
    entirely one colour; use that when it is a clear majority.
    """
    import cv2
    import numpy as np

    if patch is None or patch.size == 0:
        return None, 0.0
    luminance = patch.astype(np.int16).mean(axis=2).astype(np.uint8)
    threshold, _ = cv2.threshold(luminance, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = luminance <= threshold
    for group in (dark, ~dark):
        share = float(group.mean())
        if share >= 0.55:
            return np.median(patch[group], axis=0), share
    return None, 0.0


def pick_font(preferred: str = "") -> tuple[str, str]:
    """Return ``(fontfile, fontname)`` for a readable CJK serif face.

    ``preferred`` is an optional path from the job. If nothing is found, the
    built-in ``china-s`` (Droid Sans Fallback) keeps the job working, just with
    a sans-serif face.
    """
    candidates = []
    if preferred and Path(preferred).is_file():
        candidates.append(preferred)
    candidates.extend([
        r"C:\Windows\Fonts\simsun.ttc",
        r"C:\Windows\Fonts\STSONG.TTF",
        r"C:\Windows\Fonts\NotoSerifSC-VF.ttf",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    ])
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate, "QbrLayout"
    return "", "china-s"


class RapidOcr:
    """Small wrapper so the heavy ONNX import happens only in the worker."""

    def __init__(self) -> None:
        import logging as _logging

        from rapidocr import RapidOCR

        _logging.getLogger("RapidOCR").setLevel(_logging.WARNING)
        self._engine = RapidOCR()

    def __call__(self, image) -> list[dict]:
        result = self._engine(image)
        texts = list(getattr(result, "txts", None) or [])
        boxes = getattr(result, "boxes", None)
        scores = list(getattr(result, "scores", None) or [])
        lines: list[dict] = []
        if boxes is None:
            return lines
        for index, text in enumerate(texts):
            if index >= len(boxes) or not str(text).strip():
                continue
            quad = boxes[index].tolist() if hasattr(boxes[index], "tolist") else boxes[index]
            x0 = min(float(point[0]) for point in quad)
            x1 = max(float(point[0]) for point in quad)
            y0 = min(float(point[1]) for point in quad)
            y1 = max(float(point[1]) for point in quad)
            if x1 - x0 < 10 or y1 - y0 < 10:
                continue
            dx = float(quad[1][0]) - float(quad[0][0])
            dy = float(quad[1][1]) - float(quad[0][1])
            # Use the longer edge for the reading direction. A tall vertical
            # line whose first edge happens to point right would otherwise be
            # mistaken for horizontal text.
            if abs(dy) > abs(dx):
                dx = float(quad[2][0]) - float(quad[1][0])
                dy = float(quad[2][1]) - float(quad[1][1])
            angle = abs(math.degrees(math.atan2(dy, dx)))
            lines.append({
                "text": str(text),
                "score": float(scores[index]) if index < len(scores) else 1.0,
                "rect": [x0, y0, x1, y1],
                "angle": angle,
            })
        return lines


def _ocr_cached(ocr: Callable[[Any], list[dict]], image, page_number: int,
                cache_dir: str | Path, source_mtime: float, dpi: int) -> list[dict]:
    cache_path = Path(cache_dir) / f"page-{page_number:04d}-{dpi}.json" if cache_dir else None
    if cache_path and cache_path.is_file():
        try:
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            if abs(float(data.get("sourceMtime") or 0) - float(source_mtime)) < 1 and int(data.get("dpi") or 0) == dpi:
                return list(data.get("lines") or [])
        except Exception:  # noqa: BLE001 - a broken cache is just a cache miss
            pass
    lines = ocr(image)
    if cache_path:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps({
                "sourceMtime": source_mtime,
                "dpi": dpi,
                "lines": lines,
            }, ensure_ascii=False), encoding="utf-8")
        except Exception:  # noqa: BLE001 - caching must never fail the job
            pass
    return lines


def _draw_text(page, font, fontfile: str, item: dict, zoom: float, fallback=None) -> None:
    x0, y0, x1, y1 = [value / zoom for value in item["rect"]]
    text = str(item.get("text") or "")
    if not text or not item.get("color"):
        return
    rect_height = max(1.0, y1 - y0)
    rect_width = max(1.0, x1 - x0)
    chosen = font
    name, path = "QbrLayout", fontfile
    if fallback:
        try:
            missing = any(not chosen.has_glyph(ord(char)) for char in text if not char.isspace())
        except Exception:  # noqa: BLE001 - older PyMuPDF may not expose has_glyph
            missing = False
        if missing:
            chosen, name, path = fallback
    unit = chosen.text_length(text, 1.0)
    size = rect_height * 0.95
    if unit > 0:
        # 0.99 keeps the last glyph inside the OCR box; 1.02 used to push the
        # line past a panel border and clip it at the page edge.
        size = min(size, rect_width * 0.99 / unit)
    size = max(4.0, size)
    descender = -chosen.descender * size
    baseline = y1 - descender * 0.55
    color = tuple(item["color"])
    if item.get("visible", True):
        # A hair of stroke makes headings closer to the printed weight; a large
        # border_width turns SimSun into a blob, so keep it tiny.
        bold = item.get("kind") in ("paragraph_title", "doc_title", "header")
        render_mode = 2 if bold else 0
        border_width = 0.015 if bold else 0
        page.insert_text((x0, baseline), text, fontsize=size, fontname=name if path else "china-s",
                         fontfile=path or None, color=color, fill=color,
                         render_mode=render_mode, border_width=border_width)
    else:
        page.insert_text((x0, baseline), text, fontsize=size, fontname="china-s",
                         color=(0, 0, 0), render_mode=3)


def process_page(page, blocks: list[dict], ocr, font, fontfile: str, dpi: float,
                 cache_dir: str | Path, source_mtime: float, fallback=None,
                 replace: bool = True) -> dict:
    """Build one output page.

    Returns ``{"image": bytes|None, "items": [...], "visible": int}``.
    ``image`` is the cleaned JPEG; ``None`` means keep the original pixels.
    ``replace=False`` keeps the artwork (book covers) and only adds the
    invisible text layer used for search.
    """
    import fitz
    import numpy as np
    from PIL import Image

    zoom = float(dpi) / 72.0
    pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
    if pixmap.n == 1:
        image = np.repeat(image[:, :, None], 3, axis=2)
    elif pixmap.n == 4:
        image = image[:, :, :3]
    lines = _ocr_cached(ocr, image, page.number + 1, cache_dir, source_mtime, int(round(float(dpi))))
    items = choose_lines(blocks, lines, pixmap.width, pixmap.height)
    if not items:
        return {"image": None, "items": [], "visible": 0}
    for item in items:
        item["text"] = clean_text(item.get("text") or "")
    if not replace:
        for item in items:
            item["visible"] = False
            item["color"] = (0.0, 0.0, 0.0)
        return {"image": None, "items": items, "visible": 0}

    clean = image.copy()
    visible = 0
    for item in items:
        x0, y0, x1, y1 = [int(round(value)) for value in item["rect"]]
        x0, y0 = max(0, x0 - 1), max(0, y0 - 1)
        x1, y1 = min(pixmap.width, x1 + 2), min(pixmap.height, y1 + 2)
        subimage = image[y0:y1, x0:x1]
        if subimage.size == 0:
            item["visible"] = False
            item["color"] = (0.0, 0.0, 0.0)
            continue
        background, spread = ring_background(image, item["rect"], pad=BACKGROUND_PAD)
        if background is None:
            item["visible"] = False
            item["color"] = (0.0, 0.0, 0.0)
            continue
        if spread > MIXED_BACKGROUND_STD:
            # A heading on a colour bar fills its band, so the ring also sees
            # the page beyond the bar. Its own box is still one flat colour.
            candidate, share = rect_background(image[y0:y1, x0:x1])
            if item.get("kind") in TITLE_KINDS and candidate is not None and share >= 0.55:
                background = candidate
            else:
                # The box really crosses two backgrounds (artwork or a rule).
                # Keeping the original pixels is better than guessing a fill.
                item["visible"] = False
                item["color"] = (0.0, 0.0, 0.0)
                continue
        mask, distance = text_mask(subimage, background)
        if mask is None or int(mask.sum()) < 8:
            item["visible"] = False
            item["color"] = (0.0, 0.0, 0.0)
            continue
        # Text printed over an illustration has a structured background. Filling
        # the glyphs with one colour leaves visible bands across the artwork, so
        # keep those lines as raster instead of smearing the picture.
        halo = cv2_dilate(mask, size=11)
        remaining = subimage[halo == 0]
        texture = float(np.mean(np.std(remaining.astype(np.float32), axis=0))) if len(remaining) >= 50 else 0.0
        if texture > TEXTURE_STD:
            item["visible"] = False
            item["color"] = (0.0, 0.0, 0.0)
            continue
        flat = subimage.reshape(-1, 3)
        flat_distance = distance.reshape(-1)
        top = max(1, int(len(flat_distance) * 0.08))
        indexes = np.argsort(flat_distance)[-top:]
        item["color"] = tuple((np.median(flat[indexes], axis=0) / 255.0).tolist())
        mask = cv2_dilate(mask)
        clean[y0:y1, x0:x1][mask > 0] = background.astype(np.uint8)
        visible += 1

    if visible == 0:
        return {"image": None, "items": items, "visible": 0}
    buffer = io.BytesIO()
    Image.fromarray(clean).save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return {"image": buffer.getvalue(), "items": items, "visible": visible}


def cv2_dilate(mask, size: int = 7):
    import cv2
    import numpy as np

    return cv2.dilate(mask, np.ones((size, size), np.uint8), iterations=1)


# ── engine job ─────────────────────────────────────────────────────────────

def load_layout(path: str | Path) -> dict[int, list[dict]]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    pages = data.get("pages") if isinstance(data, dict) else data
    result: dict[int, list[dict]] = {}
    if isinstance(pages, list):
        for page in pages:
            try:
                number = int(page.get("page") or 0)
            except Exception:  # noqa: BLE001
                continue
            if number > 0:
                result[number] = list(page.get("blocks") or [])
    elif isinstance(pages, dict):
        for key, value in pages.items():
            try:
                number = int(key)
            except Exception:  # noqa: BLE001
                continue
            if number > 0:
                result[number] = list(value or [])
    return result


def run_layout_pdf(job) -> dict:
    """Engine job ``kind=layout-pdf``."""
    import fitz

    from .jobs import report_progress

    source = str(job.args.get("source") or "")
    if not source or not Path(source).is_file():
        raise FileNotFoundError(f"找不到 PDF:{source}")
    target = str(job.args.get("out") or "").strip()
    if not target:
        raise ValueError("没有输出路径")
    layout_path = str(job.args.get("layout") or "").strip()
    if not layout_path or not Path(layout_path).is_file():
        raise ValueError("没有版面数据(layout)")
    dpi = max(120.0, min(400.0, float(job.args.get("dpi") or DEFAULT_DPI)))
    cache_dir = str(job.args.get("cacheDir") or "").strip()
    fontfile, _fontname = pick_font(str(job.args.get("font") or "").strip())

    document = fitz.open(source)
    try:
        total_pages = document.page_count
        pages = parse_pages(str(job.args.get("pages") or ""), total_pages)
        layout = load_layout(layout_path)
        if not pages:
            raise ValueError("没有可处理的页面")
        if str(job.args.get("pages") or "").strip():
            missing = [page for page in pages if page not in layout]
            if missing:
                raise ValueError(f"版面数据缺少第 {missing[0]} 页：请刷新 MinerU 解析")
        elif layout and max(layout) != total_pages:
            raise ValueError(
                f"版面数据覆盖 {max(layout)} 页，与源 PDF 的 {total_pages} 页不一致："
                "请刷新 MinerU 解析或检查版面缓存"
            )
        ocr = RapidOcr()
        font = fitz.Font(fontfile=fontfile) if fontfile else fitz.Font("china-s")
        try:
            fallback = (fitz.Font("china-s"), "china-s", "")
        except Exception:  # noqa: BLE001
            fallback = None
        output = fitz.open()
        source_mtime = Path(source).stat().st_mtime
        replaced = 0
        kept = 0
        # The cover and back cover are artwork: retypesetting their display
        # lettering in SimSun (and MinerU's block order for it) looks broken.
        # Keep the pixels and add only the invisible search text.
        artwork_pages = {1, total_pages} if total_pages >= 3 else set()
        report_progress(job, done=0, total=len(pages), label="保留版式重排…")
        for index, page_number in enumerate(pages, start=1):
            if job.cancelled():
                raise RuntimeError("已取消")
            page = document[page_number - 1]
            blocks = layout.get(page_number) or []
            result = {"image": None, "items": [], "visible": 0}
            if blocks:
                result = process_page(
                    page, blocks, ocr, font, fontfile, dpi, cache_dir, source_mtime, fallback,
                    replace=page_number not in artwork_pages,
                )
            if result["image"] is None:
                output.insert_pdf(document, from_page=page_number - 1, to_page=page_number - 1)
                new_page = output[-1]
                kept += 1
            else:
                new_page = output.new_page(width=page.rect.width, height=page.rect.height)
                new_page.insert_image(new_page.rect, stream=result["image"])
                replaced += 1
            for item in result["items"]:
                _draw_text(new_page, font, fontfile, item, dpi / 72.0, fallback)
            report_progress(
                job, done=index, total=len(pages),
                label=f"保留版式重排 {index}/{len(pages)} 页",
            )
        try:
            output.subset_fonts(verbose=False)
        except Exception:  # noqa: BLE001 - subsetting is an optimisation
            pass
        toc_rows = []
        for item in job.args.get("toc") or []:
            try:
                level = min(3, max(1, int(item.get("level") or 1)))
                title = str(item.get("title") or "").strip()
                page = int(item.get("page") or 0)
            except Exception:  # noqa: BLE001 - one bad bookmark must not fail the PDF
                continue
            if title and 1 <= page <= output.page_count:
                toc_rows.append([level, title, page])
        if toc_rows:
            try:
                output.set_toc(toc_rows)
            except Exception as exc:  # noqa: BLE001 - outline is optional
                log.warning("layout pdf: could not write the outline: %s", exc)
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        partial = f"{target}.part"
        output.save(partial, garbage=3, deflate=True)
        output.close()
        os.replace(partial, target)
    finally:
        document.close()
    return {
        "path": target,
        "pages": len(pages),
        "replaced": replaced,
        "kept": kept,
        "toc": len(toc_rows),
        "bytes": Path(target).stat().st_size if Path(target).exists() else 0,
        "font": fontfile or "built-in china-s",
    }

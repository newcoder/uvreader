"""水印/背景字识别（低不透明度 get_texttrace）与安全的渲染遮罩。

设计要点：**文本 + 字号双匹配**水印自身，而不是"中心落在水印框内"——
水印常与正文重叠（CSP2021 实测 239 处正文 span 中心落在水印 bbox 内），
只按位置过滤会误删正文。

消费方（全部格式/通道共用）：
- `extract/doc_mode.page_lines`：文本行流过滤（text/doc 模式，任何 PDF）；
- `extract/vision_extract.render_pages`：vision/box 页图渲染前遮罩；
- `assets/crops.stage2_local`：版面检测页图渲染前遮罩；
- `ocr/backends.process_page`：OCR 行过滤（可搜索文字层，所有 OCR 通道）。
"""
from __future__ import annotations

import logging

log = logging.getLogger("qb.watermark")

FAINT_OPACITY = 0.35   # 低于此填充不透明度视为水印/背景字
OBLIQUE_SIN = 0.05     # dir 分量超过此值视为非水平/垂直（倾斜文字）


def faint_traces(page) -> list[dict]:
    """低不透明度文字的 [{bbox, text, size}]（get_texttrace；不可用返回 []）。"""
    try:
        traces = page.get_texttrace()
    except Exception:
        return []
    out: list[dict] = []
    for t in traces:
        opacity = t.get("opacity")
        if opacity is None or opacity >= FAINT_OPACITY:
            continue
        bbox = t.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        text = "".join(chr(c[0]) for c in (t.get("chars") or []) if c)
        out.append({"bbox": tuple(float(v) for v in bbox), "text": text.strip(),
                    "size": float(t.get("size") or 0), "opacity": float(opacity)})
    return out


def _norm(text: str) -> str:
    return "".join((text or "").split())


def _center_in(bbox, box) -> bool:
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    x0, y0, x1, y1 = box
    return x0 <= cx <= x1 and y0 <= cy <= y1


def is_watermark_span(text: str, size: float, bbox, faint: list[dict],
                      median_size: float = 0.0) -> bool:
    """span 是否水印**自身**：中心在 faint 框内，且文本互含 + 字号相当。

    trace 无文本（异常 PDF）时退回"字号 ≥ 2× 页面中位"的保守判定。
    """
    if not faint:
        return False
    t = _norm(text)
    for f in faint:
        if not _center_in(bbox, f["bbox"]):
            continue
        ft = _norm(f["text"])
        if ft:
            size_ok = f["size"] <= 0 or size >= 0.8 * f["size"]
            if t and (t in ft or ft in t) and size_ok:
                return True
        elif median_size and size >= 2 * median_size:
            return True
    return False


def filter_ocr_lines(lines: list, faint: list[dict], dpi: float,
                     derotation=None) -> list:
    """OCR 行序列中剔除水印自身（Line 鸭子类型：.text / .quad 像素坐标）。

    OCR quad 在**渲染图（显示）空间**，而 faint 框来自 get_texttrace、是**未旋转页面
    坐标**。页面有 /Rotate 时必须传 derotation（page.derotation_matrix）把 quad 折算
    回未旋转坐标，否则两侧坐标系不一致，过滤在旋转页会静默失效（实测）。
    """
    if not faint:
        return lines
    import fitz

    k = 72.0 / dpi
    keep = []
    for ln in lines:
        try:
            xs = [p[0] for p in ln.quad]
            ys = [p[1] for p in ln.quad]
        except Exception:
            keep.append(ln)
            continue
        box_pt = (min(xs) * k, min(ys) * k, max(xs) * k, max(ys) * k)
        if derotation is not None:  # 显示空间 → 未旋转页面坐标（与 faint 同空间）
            r = fitz.Rect(box_pt) * derotation
            box_pt = (r.x0, r.y0, r.x1, r.y1)
        t = _norm(getattr(ln, "text", ""))
        drop = False
        for f in faint:
            if not _center_in(box_pt, f["bbox"]):
                continue
            ft = _norm(f["text"])
            if ft and t and (t in ft or ft in t):
                drop = True
                break
        if not drop:
            keep.append(ln)
    return keep


def mask_safe_boxes(page) -> list[tuple[float, float, float, float]]:
    """可安全涂白的 faint 框：其内没有正文 span 中心、且不与页内图片相交。

    有不透明内容重叠时涂白会连正文/插图一起抹掉 → 不遮罩，交给 prompt 规则。
    """
    faint = faint_traces(page)
    if not faint:
        return []
    centers: list[tuple[float, float]] = []
    try:
        d = page.get_text("dict")
    except Exception:
        d = {"blocks": []}
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for s in line.get("spans", []):
                text = (s.get("text") or "").strip()
                if not text:
                    continue
                sbox = s["bbox"]
                if is_watermark_span(text, float(s.get("size") or 0), sbox, faint):
                    continue  # 水印自身不算"正文重叠"
                centers.append(((sbox[0] + sbox[2]) / 2, (sbox[1] + sbox[3]) / 2))
    try:
        imgs = [tuple(float(v) for v in inf["bbox"]) for inf in page.get_image_info()]
    except Exception:
        imgs = []
    safe = []
    for f in faint:
        x0, y0, x1, y1 = f["bbox"]
        if any(x0 <= cx <= x1 and y0 <= cy <= y1 for cx, cy in centers):
            continue
        if any(ix0 < x1 and ix1 > x0 and iy0 < y1 and iy1 > y0
               for ix0, iy0, ix1, iy1 in imgs):
            continue
        safe.append(f["bbox"])
    return safe


def mask_page(page) -> int:
    """渲染前把安全的水印框涂白（页面内存拷贝，不影响磁盘文件）；返回遮罩数。"""
    import fitz

    boxes = mask_safe_boxes(page)
    for b in boxes:
        page.draw_rect(fitz.Rect(b), color=None, fill=(1, 1, 1))
    if boxes:
        log.debug("[watermark] 遮罩 %d 处水印", len(boxes))
    return len(boxes)

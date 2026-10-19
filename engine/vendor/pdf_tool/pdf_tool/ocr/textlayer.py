"""行框（渲染图像像素）→ pdf.js TextContent items（PDF 用户空间变换）。

坐标系链（与 `ocr/layer.insert_layer` 同一套数学的逆用）：
    OCR quad（页面显示方向、左上原点、dpi 像素）
      ×72/dpi → ×page.derotation_matrix → 未旋转页坐标（PyMuPDF 左上原点）
      → 平移到 cropbox → 翻转 y → PDF 用户空间（左下原点）
pdf.js 的 viewport 会在渲染时把 PDF 用户空间映射到画布（含页 /Rotate 与 y 翻转），
因此 item.transform 必须是 **PDF 用户空间**，缩放/旋转都不用重算。

item.transform `[a,b,c,d,e,f]`：基线方向 (a,b)、字高方向 (c,d)（PDF 下 +y 为上）、
基线起点 (e,f)；`width` 为基线长度（点），`height` 为字号（点）。
"""
from __future__ import annotations

import math

from pdf_tool.ocr.lines import Line

# 与 layer.insert_layer 一致的基线位置（框高的下移比例）
BASELINE_RATIO = 0.18


def line_to_item(line: Line, page, dpi: float, *, font_name: str = "ocr") -> dict | None:
    """单行 → pdf.js item；无效行（空文本/零尺寸）返回 None。"""
    import fitz

    x0, y0, x1, y1 = line.rect
    h_img = y1 - y0
    if h_img <= 1 or x1 <= x0 or not str(line.text).strip():
        return None
    scale = 72.0 / dpi
    cb = page.cropbox
    mat = page.derotation_matrix
    base_img = y1 - h_img * BASELINE_RATIO

    def to_pdf(x_img: float, y_img: float):
        p = fitz.Point(x_img * scale, y_img * scale) * mat  # 未旋转页坐标（左上）
        return fitz.Point(cb.x0 + p.x, cb.y1 - p.y)         # PDF 用户空间（左下）

    p0 = to_pdf(x0, base_img)
    p1 = to_pdf(x1, base_img)
    vx, vy = p1.x - p0.x, p1.y - p0.y
    length = math.hypot(vx, vy)
    if length < 1e-6:
        return None
    dx, dy = vx / length, vy / length
    h_pt = h_img * scale
    return {
        "str": str(line.text),
        "dir": "ltr",
        "width": round(length, 2),
        "height": round(h_pt, 2),
        "transform": [round(dx * h_pt, 3), round(dy * h_pt, 3),
                      round(-dy * h_pt, 3), round(dx * h_pt, 3),
                      round(p0.x, 2), round(p0.y, 2)],
        "fontName": font_name,
        "hasEOL": True,
    }


def lines_to_content(lines: list[Line], page, dpi: float, *,
                     font_name: str = "ocr") -> dict:
    """行列表 → pdf.js TextContent（items/styles/lang），可直接喂给文本层。"""
    items = []
    for line in lines:
        item = line_to_item(line, page, dpi, font_name=font_name)
        if item is not None:
            items.append(item)
    return {
        "items": items,
        "styles": {font_name: {"fontFamily": "sans-serif", "ascent": 0.8,
                               "descent": -0.2, "vertical": False}},
        "lang": None,
    }

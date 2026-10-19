"""照片 → 单页 PDF：EXIF 旋转 + 适配 A4 内接，复用 vision 抽取管线。"""
from __future__ import annotations

import io
import logging
from pathlib import Path

log = logging.getLogger("pdf_tool.ingest.photo")

A4_W, A4_H = 595.0, 842.0


def to_pdf(img_path: Path, out_pdf: Path, *, quality: int = 92) -> Path:
    """把单张照片包成单页 PDF（保持长宽比，缩放到 A4 内接尺寸）。"""
    import fitz
    from PIL import Image, ImageOps

    im = ImageOps.exif_transpose(Image.open(str(img_path))).convert("RGB")
    w, h = im.size
    if w <= 0 or h <= 0:
        raise ValueError(f"图片尺寸异常: {img_path}")
    scale = min(A4_W / w, A4_H / h)
    pw, ph = max(1, round(w * scale)), max(1, round(h * scale))
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    try:
        page = doc.new_page(width=pw, height=ph)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality)
        page.insert_image(fitz.Rect(0, 0, pw, ph), stream=buf.getvalue())
        doc.save(str(out_pdf))
    finally:
        doc.close()
    log.info("[ingest] 照片 → PDF: %s (%dx%d -> %dx%d pt)", out_pdf.name, w, h, pw, ph)
    return out_pdf

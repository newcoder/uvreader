import fitz, json, os, sys

def is_cjk(ch):
    code = ord(ch)
    return 0x3400 <= code <= 0x9fff or 0x3000 <= code <= 0x303f or 0xff00 <= code <= 0xffef

CLOSERS = ("）", ")", "，", "。", "、", "；", "：", "”", "’", ",", ".", ";", ":", "!", "?", "！", "？")

PAD = 6.0          # 绘图元素聚类时允许的空隙(把一张图的零散线条聚成一块)
MIN_W, MIN_H = 24.0, 24.0
MIN_PATHS = 5      # 线画图至少这么多路径(填空下划线 / 表格线只有 1–4 条)

def rect_overlap(a, b, pad):
    return not (b.x1 + pad < a.x0 or a.x1 + pad < b.x0 or b.y1 + pad < a.y0 or a.y1 + pad < b.y0)

def figure_regions(page):
    """图区:矢量线画(聚类后够大、够多路径、不是表格线框)与内嵌图片(够大、不在页边带)。"""
    groups = []
    for drawing in page.get_drawings():
        rect = drawing["rect"]
        hit = None
        for group in groups:
            if any(rect_overlap(rect, item["rect"], PAD) for item in group):
                hit = group
                break
        if hit is None:
            groups.append([drawing])
            continue
        hit.append(drawing)
        changed = True
        while changed:
            changed = False
            for other in groups:
                if other is hit:
                    continue
                if any(rect_overlap(item["rect"], entry["rect"], PAD) for item in hit for entry in other):
                    hit.extend(other)
                    groups.remove(other)
                    changed = True
                    break
    regions = []
    for group in groups:
        rect = group[0]["rect"]
        for other in group[1:]:
            rect = rect | other["rect"]
        if rect.width < MIN_W or rect.height < MIN_H or len(group) < MIN_PATHS:
            continue
        horizontal = vertical = 0
        for drawing in group:
            for item in drawing.get("items", []):
                if item[0] != "l":
                    continue
                ax, ay = item[1].x, item[1].y
                bx, by = item[2].x, item[2].y
                length = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
                if abs(ay - by) <= 1.5 and length >= 0.8 * rect.width:
                    horizontal += 1
                elif abs(ax - bx) <= 1.5 and length >= 0.8 * rect.height:
                    vertical += 1
        # 表格是两个方向都有贯穿线;宽扁条多是表格行 / 分隔带
        if horizontal >= 2 and vertical >= 2:
            continue
        if rect.width >= 200 and rect.height < 30:
            continue
        regions.append({"rect": rect, "scale": 3.0})
    page_area = page.rect.width * page.rect.height
    for info in page.get_image_info():
        rect = fitz.Rect(info["bbox"])
        if rect.width < 64 or rect.height < 32 or rect.width * rect.height < 0.04 * page_area:
            continue
        # 整页扫描图不是插图;页眉页脚带里的图片多是刊头 / 装饰条
        if rect.width * rect.height >= 0.85 * page_area:
            continue
        if rect.y1 <= page.rect.height * 0.08 or rect.y0 >= page.rect.height * 0.92:
            continue
        if any(rect_overlap(rect, region["rect"], 4.0) for region in regions):
            continue
        # 照片类图按内嵌像素定倍率(上限 2.5),产物里存 JPEG 压体积
        scale = min(2.5, max(1.2, float(info.get("width") or 0) / max(rect.width, 1.0)))
        regions.append({"rect": rect, "scale": scale, "image": True})
    return regions

def is_faint(span):
    """低不透明度(≤0.6)的大字 = 水印。实测:CSP2021 是 100pt/0.1,noip1 是 120pt/0.5。"""
    return float(span.get("opacity", 1) or 1) <= 0.6

def faint_boxes(page):
    """水印的每个字符矩形:裁图前先把它们擦掉,水印就不会烘进图里。"""
    boxes = []
    try:
        for span in page.get_texttrace():
            if not is_faint(span):
                continue
            for char in span.get("chars", []):
                if len(char) > 3 and char[3] is not None:
                    box = fitz.Rect(char[3])
                    if box.width > 0 and box.height > 0:
                        boxes.append(box)
    except Exception:
        return []
    return boxes

def redact_watermarks(page):
    boxes = faint_boxes(page)
    if not boxes:
        return
    for box in boxes:
        page.add_redact_annot(box)
    try:
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_NONE,
            graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
        )
    except TypeError:
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

doc = fitz.open(sys.argv[1])
assets_dir = sys.argv[3] if len(sys.argv) > 3 else ""
if assets_dir:
    os.makedirs(assets_dir, exist_ok=True)
pages = []
for page in doc:
    lines = []
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        direction = block.get("dir", (1, 0))
        rotated = float(direction[0] or 0) < 0.7
        for line in block.get("lines", []):
            spans = [s for s in line.get("spans", []) if str(s.get("text", "")).strip()]
            if not spans:
                continue
            # 行内拼接:相邻 span 之间的水平空隙超过阈值时补一个空格(中西文用不同阈值)
            parts = []
            previous = None
            fonts = {}
            for span in spans:
                if previous is not None:
                    text_span = str(span["text"])
                    prev_text = str(previous["text"])
                    gap = float(span["bbox"][0]) - float(previous["bbox"][2])
                    size = min(float(span["size"]), float(previous["size"]))
                    edge_cjk = is_cjk(prev_text[-1]) or (bool(text_span) and is_cjk(text_span[0]))
                    threshold = 0.4 * size if edge_cjk else 0.18 * size
                    if (
                        gap > threshold
                        and not prev_text.endswith(("(", "（", '"'))
                        and not text_span[:1].isspace()
                        and not text_span.startswith(CLOSERS)
                    ):
                        parts.append(" ")
                parts.append(span["text"])
                name = str(span.get("font", ""))
                fonts[name] = fonts.get(name, 0) + len(str(span["text"]))
                previous = span
            text = "".join(parts)
            x0, y0, x1, y1 = line["bbox"]
            lines.append({
                "text": text,
                "fonts": fonts,
                "size": round(max(float(span["size"]) for span in spans), 1),
                "x0": round(x0, 1),
                "x1": round(x1, 1),
                "y0": round(y0, 1),
                "y1": round(y1, 1),
                "rotated": rotated,
            })
    # 低不透明度文字 = 水印(如 100pt / opacity 0.1 的「山西」、120pt / 0.5 的「江西」),单独收集供整行剔除。
    faint = []
    try:
        for span in page.get_texttrace():
            if not is_faint(span):
                continue
            text = "".join(chr(char[0]) for char in span.get("chars", []) if char and char[0]).strip()
            if text:
                faint.append(text)
    except Exception:
        faint = []
    # 图(线画 / 内嵌图片)裁成 png(线画)或 jpg(照片),图区内部的文字并入图片(不再作为正文)。
    # 整页没有文字时(扫描件)不做:那种 PDF 本来就走不了「文本型」。
    figures = []
    if assets_dir and lines:
        regions = figure_regions(page)
        # 先把低不透明度水印擦掉(只删这层文字:图片像素 / 线画都保留),再裁图,
        # 否则水印会跟着图一起被烘进图片。
        if regions:
            redact_watermarks(page)
        for order, region in enumerate(regions, start=1):
            rect = region["rect"]
            suffix = "jpg" if region.get("image") else "png"
            name = "fig-p%d-%d.%s" % (page.number + 1, order, suffix)
            clip = fitz.Rect(rect.x0 - 3, rect.y0 - 3, rect.x1 + 3, rect.y1 + 3) & page.rect
            try:
                pix = page.get_pixmap(matrix=fitz.Matrix(region["scale"], region["scale"]), clip=clip)
                if suffix == "jpg":
                    pix.save(os.path.join(assets_dir, name), jpg_quality=85)
                else:
                    pix.save(os.path.join(assets_dir, name))
            except Exception:
                continue
            figures.append({
                "rect": [round(rect.x0, 1), round(rect.y0, 1), round(rect.x1, 1), round(rect.y1, 1)],
                "file": name,
            })
            inside = fitz.Rect(rect.x0 - 1, rect.y0 - 1, rect.x1 + 1, rect.y1 + 1)
            lines = [line for line in lines if not inside.contains(fitz.Rect(line["x0"], line["y0"], line["x1"], line["y1"]))]
    pages.append({
        "width": round(page.rect.width, 1),
        "height": round(page.rect.height, 1),
        "lines": lines,
        "faint": faint,
        "figures": figures,
    })
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    json.dump(pages, fh, ensure_ascii=False)

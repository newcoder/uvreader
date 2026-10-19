"""版面检测与图片资产：文本型走 fitz 图对象，扫描件走 PP-DocLayoutV2 / 在线 PaddleOCR。

产出 assets/imgs/IMG_nnn_pPP.jpg + rect2x（zoom=2 渲染像素坐标），vision/text/box/doc 共用。
"""
from __future__ import annotations

import logging
import re
import shutil
import urllib.request
from pathlib import Path

from pdf_tool.core import watermark
from pdf_tool.core.io import load_json as _load
from pdf_tool.core.io import save_json as _save
from pdf_tool.core.paths import OUT_ROOT

log = logging.getLogger("qb.assets")


def _rel_asset(path: Path, out_dir: Path) -> str:
    """图片资产的引用路径：优先相对 OUT_ROOT（默认产物布局）；`--out-dir` 在输出根
    之外时退回相对本次输出目录（viewer/审计按 JSON 所在目录解析也能命中）；再不行
    用绝对路径——保证外部 out-dir 下不会因相对计算失败而中断抽取。"""
    for base in (OUT_ROOT, out_dir):
        try:
            return path.relative_to(base).as_posix()
        except ValueError:
            continue
    return path.as_posix()


# ---------- stage 2 ----------
_MATCH_DIFF = 8.0  # 同源裁剪重编码的 JPEG 噪声上限
# pp 的裁剪 key：数字即页面渲染像素坐标。实测有两族（卷内混排）：
#   img_in_image_box_x0_y0_x1_y1.jpg（普通插图）
#   img_in_chart_box_x0_y0_x1_y1.jpg（图表；两卷实测各出现 1 次且进了产物）
_BOX_KEY_RE = re.compile(
    r"img_in_(?:image|chart)_box_(\d+)_(\d+)_(\d+)_(\d+)(?:\.[A-Za-z0-9]+)?")


def _rect_from_key(name: str) -> list[int] | None:
    """从 pp 裁剪 key 解析 rect2x；整名锚定，形态不符即 None。

    旧实现取名字里全部数字的前 4 个，会把 `2x_img_in_image_box_1_2_3_4.jpg`
    这类前导数字当成 x0，得到垃圾框（图被画到错误位置且无人察觉）。
    """
    m = _BOX_KEY_RE.fullmatch(name)
    return [int(v) for v in m.groups()] if m else None


def _load_gray(path: Path):
    import numpy as np
    from PIL import Image
    return np.asarray(Image.open(path).convert("L"), dtype=np.float32)


def _crop_offset(child, parent):
    """child 是否像素级内嵌于 parent（同页版面渲染的两块同尺度裁剪）。

    粗扫（1/4 分辨率全偏移）+ 全分辨率 ±3 精调；返回 (dy, dx, mean_abs_diff)
    或 None。命中时 diff ≈ JPEG 噪声（实测 0.001），非重合内容通常 >10。
    """
    import numpy as np
    ch, cw = child.shape
    ph, pw = parent.shape
    if ch > ph or cw > pw:
        return None
    if (ch, cw) == (ph, pw):
        return 0, 0, float(np.abs(parent - child).mean())
    cs, ps = child[::4, ::4], parent[::4, ::4]
    chs, cws, phs, pws = cs.shape[0], cs.shape[1], ps.shape[0], ps.shape[1]
    best: tuple[float, int, int] | None = None
    for dy in range(phs - chs + 1):
        for dx in range(pws - cws + 1):
            m = float(np.abs(ps[dy:dy + chs, dx:dx + cws] - cs).mean())
            if best is None or m < best[0]:
                best = (m, dy * 4, dx * 4)
    if best is None:
        return None
    m, y0, x0 = best
    for dy in range(max(0, y0 - 3), min(ph - ch + 1, y0 + 4)):
        for dx in range(max(0, x0 - 3), min(pw - cw + 1, x0 + 4)):
            m2 = float(np.abs(parent[dy:dy + ch, dx:dx + cw] - child).mean())
            if m2 < m:
                m, y0, x0 = m2, dy, dx
    return y0, x0, m


def dedupe_crops(items: list[dict], referenced: set[str]) -> list[dict]:
    """剔除同页“幽灵子块”：与同页另一张图像素级重合（内嵌或同内容），
    且自身从未被 markdown 正文 <img> 引用。

    PaddleOCR doc_parsing 偶发把同一版面对象切成两块：markdownImages 里
    多出一个从未在正文出现的子裁剪。这类图若进入附图清单，会被大模型猜
    引、被孤儿归位误挂。通用判定：同尺度裁剪 → 直接像素模板匹配。
    """
    if len(items) < 2:
        return items
    cache: dict[Path, object] = {}

    def gray(f: dict):
        a = cache.get(f["file"])
        if a is None:
            a = _load_gray(f["file"])
            cache[f["file"]] = a
        return a

    def refd(f: dict) -> bool:
        return Path(f["key"]).name in referenced

    keep = list(items)
    while True:
        moved = False
        for i, a in enumerate(keep):
            for b in keep[i + 1:]:
                ga, gb = gray(a), gray(b)
                if ga.size <= gb.size:
                    child, parent, gc, gp = a, b, ga, gb
                else:
                    child, parent, gc, gp = b, a, gb, ga
                hit = _crop_offset(gc, gp)
                if not hit or hit[2] > _MATCH_DIFF:
                    continue  # 内容不同
                cr, pr = refd(child), refd(parent)
                if cr and pr:
                    continue  # 双锚定：可能是版面真重复，保留
                # 多余的是"未被正文引用"的那块；两者皆幽灵时去小留大
                # （等尺寸时留更早出现的一块 = 后遍历到的 parent）
                if pr:
                    victim = child  # pr 为真则 cr 必为假（双真已 continue）
                elif cr or gc.size == gp.size:
                    victim = parent
                else:
                    victim = child
                other = parent if victim is child else child
                keep.remove(victim)
                log.info("[stage2] dropped redundant crop %s (pixel-contained in %s)",
                         Path(victim["key"]).name, Path(other["key"]).name)
                moved = True
                break
            if moved:
                break
        if not moved:
            return keep


def stage2(result_json: Path, imgs_dir: Path, meta: Path) -> list[dict]:
    imgs_dir.mkdir(parents=True, exist_ok=True)
    for stale in imgs_dir.glob("IMG_*.jpg"):  # 编号会因子块剔除而后移，先清旧资产
        stale.unlink()
    fetch_dir = imgs_dir / ".fetch"
    if fetch_dir.exists():
        shutil.rmtree(fetch_dir)
    fetch_dir.mkdir()
    data = _load(result_json)

    # 全卷 markdown 正文引用的图 basename（"幽灵子块"判定基准：在
    # markdownImages 里、正文从未 <img> 引用）
    referenced: set[str] = set()
    for page in data["pages"]:
        for m in re.finditer(r'<img[^>]*src="([^"]+)"', page.get("markdownText") or ""):
            referenced.add(m.group(1).split("/")[-1])

    figs: list[dict] = []
    n = 0
    for page_no, page in enumerate(data["pages"], 1):
        items: list[dict] = []
        for idx, (key, url) in enumerate((page.get("markdownImages") or {}).items()):
            dest = fetch_dir / f"p{page_no:02d}_{idx:02d}_{Path(key).name}"
            # 图片资产是百度 bcebos 的公开签名 URL，直连即可；走本机代理反而慢且易断（SSL EOF）。
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})  # noqa: S310
            fetcher = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            dest.write_bytes(fetcher.open(req, timeout=90).read())
            items.append({"page": page_no, "key": key, "file": dest})
        for f in dedupe_crops(items, referenced):
            n += 1
            final = imgs_dir / f"IMG_{n:03d}_p{page_no:02d}.jpg"
            f["file"].replace(final)
            f.update(n=n, rel=_rel_asset(final, imgs_dir.parent.parent), file=final,
                     rect2x=_rect_from_key(Path(f["key"]).name))
            figs.append(f)
    shutil.rmtree(fetch_dir, ignore_errors=True)
    _save(meta, [{k: v for k, v in f.items() if k != "file"} for f in figs])
    log.info("[stage2] downloaded %d figures (%d KB)", len(figs),
             sum(f["file"].stat().st_size for f in figs) // 1024)
    return figs


# ---------- stage 2a-local: 扫描件本地版面检测（PP-DocLayoutV2，免在线 token） ----------
_FIG_LABELS = frozenset({"image", "figure", "table", "chart"})
_MIN_FIG_PX = 40
_MERGE_GAP_PX = 28  # 同一图形的相邻碎块（如栈图逐格）合并阈值


def _merge_boxes(boxes: list[tuple[int, int, int, int]],
                 gap: int = _MERGE_GAP_PX) -> list[tuple[int, int, int, int]]:
    """只合并**同一行内水平相邻**的碎块（一个图形被横向切成多格时）。

    纵向堆叠的两个独立图形（如四个选项图上下排布）不得合并——否则会丢图。
    """
    pending = list(boxes)
    merged = True
    while merged:
        merged = False
        out: list[tuple[int, int, int, int]] = []
        while pending:
            a = pending.pop()
            i = 0
            while i < len(pending):
                b = pending[i]
                v_overlap = min(a[3], b[3]) - max(a[1], b[1])
                same_row = v_overlap > 0.5 * min(a[3] - a[1], b[3] - b[1])
                h_close = not (a[2] + gap < b[0] or b[2] + gap < a[0])
                if same_row and h_close:
                    a = (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
                    pending.pop(i)
                    merged = True
                else:
                    i += 1
            out.append(a)
        pending = out
    return sorted(pending, key=lambda t: (t[1], t[0]))


def _is_furniture_box(box: tuple[int, int, int, int],
                      page_w: int, page_h: int) -> bool:
    """页面装饰框（页眉/页脚 logo、条纹）判定：过小，或贴顶/贴底且矮小。"""
    x0, y0, x1, y1 = box
    if x1 - x0 < _MIN_FIG_PX or y1 - y0 < _MIN_FIG_PX:
        return True
    h = y1 - y0
    if y0 < 0.05 * page_h and h < 0.12 * page_h:
        return True  # 页眉 logo：贴顶且矮小
    # 页脚 logo/条纹：贴底且很矮（8% 页高以内；更高的底部图形视为正文内容）
    return y1 > 0.95 * page_h and h < 0.08 * page_h


def stage2_local(pdf: Path, imgs_dir: Path, meta: Path,
                 zoom: float = 2.0, model_name: str = "PP-DocLayoutV2") -> list[dict]:
    """扫描件图片/表格定位与裁剪：本地 PP-DocLayoutV2，坐标即 zoom 渲染像素空间。"""
    import io

    import fitz  # PyMuPDF
    import numpy as np
    from paddleocr import LayoutDetection
    from PIL import Image

    model = LayoutDetection(model_name=model_name)
    imgs_dir.mkdir(parents=True, exist_ok=True)
    for stale in imgs_dir.glob("IMG_*.jpg"):
        stale.unlink()
    doc = fitz.open(str(pdf))
    figs: list[dict] = []
    n = 0
    try:
        for page_no, page in enumerate(doc, 1):
            watermark.mask_page(page)  # 浅色水印先涂白，避免被版面检测误判为内容/裁进图
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
            page_h = img.size[1]
            results = model.predict(input=np.asarray(img))
            boxes = results[0]["boxes"] if results else []
            seen: set[tuple[int, int, int, int]] = set()
            raw_boxes: list[tuple[int, int, int, int]] = []
            for b in boxes:
                if b.get("label") not in _FIG_LABELS:
                    continue
                x0, y0, x1, y1 = (round(v) for v in b["coordinate"])
                box = (x0, y0, x1, y1)
                if box in seen:  # header_image 与 image 常对同一框重复标注
                    continue
                if _is_furniture_box(box, img.size[0], page_h):
                    continue  # 过小 / 页眉页脚 logo、条纹，非正文插图
                seen.add(box)
                raw_boxes.append(box)
            for x0, y0, x1, y1 in _merge_boxes(raw_boxes):
                n += 1
                dest = imgs_dir / f"IMG_{n:03d}_p{page_no:02d}.jpg"
                img.crop((x0, y0, x1, y1)).save(dest, "JPEG", quality=90)
                figs.append({"n": n, "page": page_no, "key": dest.name,
                             "pos": [round(x0 / zoom), round(y0 / zoom),
                                     round(x1 / zoom), round(y1 / zoom)],
                             "rect2x": [x0, y0, x1, y1],
                             "rel": _rel_asset(dest, imgs_dir.parent.parent),
                             "file": dest})
    finally:
        doc.close()
    _save(meta, [{k: v for k, v in f.items() if k != "file"} for f in figs])
    log.info("[stage2-local] %d figures", len(figs))
    return figs


# ---------- stage 2b: layout engine（文本型 PDF，fitz 图对象） ----------
def stage2_layout(pdf: Path, assets_dir: Path, meta: Path) -> list[dict]:
    """文本型 PDF 的图片裁剪：按 fitz 图对象抠图并记录 zoom=2 像素坐标。"""
    import fitz  # PyMuPDF

    assets_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(pdf))
    figs: list[dict] = []
    n = 0
    try:
        for page_no, page in enumerate(doc, 1):
            for inf in page.get_image_info():
                if inf["width"] < 40 or inf["height"] < 40:
                    continue
                bbox = fitz.Rect(inf["bbox"])
                zw, zh = page.rect.width * 2, page.rect.height * 2
                if _is_furniture_box((bbox.x0 * 2, bbox.y0 * 2, bbox.x1 * 2, bbox.y1 * 2),
                                     zw, zh):
                    continue  # 页眉/页脚 logo、条纹、过小框，非正文插图
                n += 1
                dest = assets_dir / f"IMG_{n:03d}_p{page_no:02d}.jpg"
                pix = page.get_pixmap(clip=bbox + (-2, -2, 2, 2), matrix=fitz.Matrix(2, 2))  # noqa: RUF005
                pix.save(str(dest))
                figs.append({"n": n, "page": page_no, "key": dest.name,
                             "pos": [int(v) for v in bbox],
                             "rect2x": [round(v * 2) for v in bbox],  # 与 zoom=2 页渲染同空间
                             "rel": _rel_asset(dest, assets_dir.parent.parent),
                             "file": dest})
    finally:
        doc.close()
    _save(meta, [{k: v for k, v in f.items() if k != "file"} for f in figs])
    log.info("[stage2-layout] %d figures", len(figs))
    return figs


def stage2_crops(pdf: Path, engine: str, result_json: Path, imgs_dir: Path,
                 meta: Path, *, pp_source: str = "local") -> list[dict]:
    """vision 路径专用：只收裁剪 + 记录 rect2x（zoom=2 渲染像素坐标），不产 markdown。

    pp 引擎默认走本地 PP-DocLayoutV2（免在线 token）；不可用或 --pp-source online 时回退
    在线 PaddleOCR doc_parsing。
    """
    if engine == "pp":
        if pp_source == "local":
            try:
                return stage2_local(pdf, imgs_dir, meta)
            except Exception as e:
                log.warning("本地版面检测不可用（%s），回退在线 PaddleOCR", e)
        return stage2(result_json, imgs_dir, meta)
    return stage2_layout(pdf, imgs_dir, meta)


def detect_engine(pdf: Path) -> str:
    """按页判定引擎：多数页有足量文本层 → layout（fitz 行流）；否则 pp（PaddleOCR）。

    扫描件常带少量残留文字层（页码、水印），按全卷字符总量判定会被误判为
    文本型；改为逐页统计（>80 字符视为文本页），至少半数页达标才走 layout。
    """
    import math

    import fitz
    doc = fitz.open(str(pdf))
    try:
        text_pages = sum(1 for page in doc if len(page.get_text().strip()) > 80)
        needed = max(1, math.ceil(doc.page_count / 2))
        return "layout" if text_pages >= needed else "pp"
    finally:
        doc.close()

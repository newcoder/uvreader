#!/usr/bin/env python3
"""blocks JSON（box/doc 协议输出）→ 重排文字版 PDF：真文字 + 原扫描插图。

- 标题/正文/代码/表格用真实文字（可选中/搜索/复制），插图用原扫描裁剪图插入；
- 字体优先系统中文字体（msyh/simsun/simhei…），缺失时回退 PyMuPDF 内置 CJK；
- 表格按网格渲染（等宽列 + 单元格换行）；图片按内容宽等比缩放，超页自动分页；
- 离线、无第三方依赖（PyMuPDF + Pillow）。

用法:
  python pdf_tool/blocks_to_pdf.py --json output/{stem}/{stem}_doc.json --out out.pdf
"""
from __future__ import annotations

import argparse
import base64
import html as html_mod
import io
import json
import logging
import re
from pathlib import Path

import fitz
from PIL import Image

from pdf_tool.core.paths import WORK_ROOT
from pdf_tool.model.document import page_of

log = logging.getLogger("qb.pdf")

IMG_MD_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")
INLINE_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
FIG_NO_RE = re.compile(r"IMG_(\d+)_p\d+")
# 选项/子图标签：A. / b) / 1. / 甲 / （a） 等
LABEL_RE = re.compile(
    r"^(?:[A-Za-z]|[0-9]|[甲乙丙丁戊己庚辛壬癸]|[（(][A-Za-z0-9]{1,2}[）)])[.、．]?$")
TOKEN_RE = re.compile(r"[A-Za-z0-9_\-.,;:!?'\"()\[\]{}<>+=*/\\|@#$%&~^`]+|\s+|.")
PAGE_SIZES = {"a4": (595.0, 842.0), "letter": (612.0, 792.0)}
FONT_CANDIDATES = (
    # 注意：msyh（雅黑）写出的空格会变成 \xa0（不利于搜索），故排在后面
    ("simsun", "C:/Windows/Fonts/simsun.ttc"),
    ("simhei", "C:/Windows/Fonts/simhei.ttf"),
    ("simkai", "C:/Windows/Fonts/simkai.ttf"),
    ("msyh", "C:/Windows/Fonts/msyh.ttc"),
    ("wqy", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
    ("pingfang", "/System/Library/Fonts/PingFang.ttc"),
)


def as_text(v) -> str:
    """把 str / {text|content} / list 等字段统一成文本。"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float, bool)):
        return str(v)
    if isinstance(v, list):
        return "\n".join(x for x in (as_text(i) for i in v) if x)
    if isinstance(v, dict):
        for k in ("text", "content"):
            if isinstance(v.get(k), str):
                return v[k]
        if isinstance(v.get("steps"), list):
            return "\n".join(x for x in (as_text(i) for i in v["steps"]) if x)
    return str(v)


def src_url(s) -> str:
    """src 可能是 markdown 链接 `![alt](url)`，也可能是裸 url/[[box:n]]。"""
    m = IMG_MD_RE.match(str(s or ""))
    return m.group(1) if m else str(s or "")


def strip_inline_images(text: str) -> str:
    """正文里的内联图占位替换成可见标记（图另行成块插入）。"""
    return INLINE_IMG_RE.sub(lambda m: f"〔{m.group(1) or '图'}〕", str(text))


def inline_images(text) -> list[tuple[str, str]]:
    """取正文里的内联图 (alt, src)，供按块插入。"""
    return [(alt or "图", src) for alt, src in INLINE_IMG_RE.findall(str(text or ""))]


def _load_font() -> tuple[fitz.Font | None, str | None]:
    for _name, path in FONT_CANDIDATES:
        p = Path(path)
        if not p.exists():
            continue
        try:
            return fitz.Font(fontfile=str(p)), str(p)
        except Exception as e:  # 字体损坏/不支持时继续尝试下一个
            log.warning("字体不可用 %s: %s", path, e)
    return None, None


class PdfWriter:
    """简易流式排版：按内容宽换行，自动分页，图片/表格独立成块。"""

    def __init__(self, page_size: str = "a4", margin: float = 56.0,
                 base_size: float = 10.5, line_ratio: float = 1.55,
                 crop_zoom: float = 2.0, img_scale: float = 1.0):
        self.w, self.h = PAGE_SIZES[page_size]
        self.margin = margin
        self.base_size = base_size
        self.line_ratio = line_ratio
        # 裁剪资产是页面 zoom 倍渲染的 → 原始显示尺寸 = 像素 / crop_zoom
        self.crop_zoom = max(0.1, float(crop_zoom))
        self.img_scale = max(0.1, float(img_scale))
        self.doc = fitz.open()
        self.font, self.fontfile = _load_font()
        self.fontname = Path(self.fontfile).stem if self.fontfile else "china-s"
        self.page: fitz.Page | None = None
        self.json_dir = Path.cwd()
        self.fig_boxes: dict[int, tuple[float, float, float, float]] = {}
        self.fig_boxes_by_src: dict[str, tuple[float, float, float, float]] = {}
        self.y = 0.0
        self.new_page()

    # ---- 基础 ----

    def new_page(self) -> None:
        # 注意：PyMuPDF 里新建页后旧 Page 对象即失效（parent=None），
        # 因此不缓存 Page 对象，保存时按索引重新取页。
        self.page = self.doc.new_page(width=self.w, height=self.h)
        self.y = self.margin

    def _ensure(self, height: float) -> None:
        if self.y + height > self.h - self.margin:
            self.new_page()

    def width_of(self, text: str, size: float) -> float:
        if self.font is not None:
            return self.font.text_length(text, size)
        # 回退：CJK 全角按 1.0em、其余按 0.55em 估算
        return sum(size if ord(ch) > 0x2E80 else size * 0.55 for ch in text)

    def _wrap(self, text: str, size: float, width: float) -> list[str]:
        lines: list[str] = []
        for para in str(text).split("\n"):
            if not para.strip():
                lines.append("")
                continue
            cur = ""
            for tok in TOKEN_RE.findall(para):
                if tok.isspace():
                    if cur:
                        cur += " "
                    continue
                if self.width_of(cur + tok, size) <= width:
                    cur += tok
                    continue
                if cur.strip():
                    lines.append(cur.rstrip())
                cur = ""
                for ch in tok:  # 单个超长 token 逐字切
                    if not cur or self.width_of(cur + ch, size) <= width:
                        cur += ch
                    else:
                        lines.append(cur.rstrip())
                        cur = ch
            lines.append(cur.rstrip())
        return lines

    def _draw(self, x: float, y: float, text: str, size: float, color) -> None:
        self.page.insert_text((x, y), text, fontname=self.fontname,
                              fontfile=self.fontfile, fontsize=size, color=color)

    # ---- 块级 ----

    def write_text(self, text: str, *, size: float | None = None, indent: float = 0.0,
                   gap_before: float = 0.0, gap_after: float = 3.0,
                   color=(0.13, 0.13, 0.13), bg=None) -> None:
        size = size or self.base_size
        lh = size * self.line_ratio
        x = self.margin + indent
        width = self.w - 2 * self.margin - indent
        lines = self._wrap(strip_inline_images(text), size, width)
        self.y += gap_before
        if bg is not None and lines:
            self._ensure(lh * len(lines) + 6)
            rect = fitz.Rect(x - 5, self.y - 3, x + width + 5, self.y + lh * len(lines) + 3)
            self.page.draw_rect(rect, color=None, fill=bg)
        for ln in lines:
            self._ensure(lh)
            if ln:
                self._draw(x, self.y + size, ln, size, color)
            self.y += lh
        self.y += gap_after

    def load_figs(self, figs_json: Path) -> int:
        """载入原始图框 bbox（figs.json），用于按原文坐标分行/并排。

        支持两种条目：{n, page, pos}（本地检测）与带 `src` 的（MinerU 等外部来源，
        按图片相对路径精确匹配）。
        """
        data = json.loads(Path(figs_json).read_text(encoding="utf-8"))
        for f in data:
            pos = f.get("pos")
            if pos and len(pos) == 4:
                self.fig_boxes[int(f["n"])] = tuple(float(v) for v in pos)
            src = f.get("src")
            if src and pos:
                self.fig_boxes_by_src[str(src)] = tuple(float(v) for v in pos)
        return len(self.fig_boxes)

    def _fig_box(self, src) -> tuple[float, float, float, float] | None:
        """按图片路径 / 文件名 IMG_nnn_pXX.jpg / alt 插图n 反查原始 bbox。"""
        u = src_url(src)
        if u in self.fig_boxes_by_src:
            return self.fig_boxes_by_src[u]
        m = FIG_NO_RE.search(u)
        if m:
            return self.fig_boxes.get(int(m.group(1)))
        m = re.search(r"插图(\d+)", str(src or ""))
        return self.fig_boxes.get(int(m.group(1))) if m else None

    def _split_rows(self, items: list[tuple[str, str, str]]) -> list[list[tuple[str, str, str]]]:
        """按原始 bbox 的 y 把同组图分行（行内按 x 排序，行间按 y 排序）。

        无 bbox 元数据时全部视为一行（保持旧行为）。
        """
        boxes = [self._fig_box(src) for _alt, src, _cap in items]
        if any(b is None for b in boxes):
            return [items]
        rows: list[list[tuple[tuple[str, str, str], tuple]]] = []
        for it, box in zip(items, boxes, strict=False):
            for row in rows:
                if abs(row[0][1][1] - box[1]) <= 12:  # y0 相近 → 同一行
                    row.append((it, box))
                    break
            else:
                rows.append([(it, box)])
        rows.sort(key=lambda r: min(b[1] for _, b in r))
        for r in rows:
            r.sort(key=lambda t: t[1][0])
        return [[it for it, _ in r] for r in rows]

    def write_caption(self, text: str, size: float = 9.0) -> None:
        """居中题注（图下方的小标签，如 A. / 甲）。"""
        w = self.width_of(text, size)
        self.write_text(text, size=size, gap_after=4, color=(0.35, 0.35, 0.35),
                        indent=max(0.0, (self.w - 2 * self.margin - w) / 2))

    def write_text_with_images(self, text: str, **kw) -> None:
        """按内联图位置分段输出：文字 → 图（组）→ 文字 …

        - 同一视觉行的图并排渲染（按原始 bbox 的 y 分行，如 ABCD 选项 2×2）；
        - 短标签（`A.` / `甲` / `(a)`）作题注，自动判断标签在图前还是图后。
        """
        s = str(text)
        matches = list(INLINE_IMG_RE.finditer(s))
        if not matches:
            if s.strip():
                self.write_text(s, **kw)
            return

        def _label_kind(t: str) -> str | None:
            """标签方向：precede（`A.`/`(a)` 属下一张图）/ follow（`甲`/`乙` 属上一张图）。"""
            t = t.strip()
            if not LABEL_RE.match(t):
                return None
            if re.search(r"[.、．]$", t) or t.startswith(("(", "（")):
                return "precede"
            return "follow"

        # 首个图之前的行首标签（如 "A. ![img]" 位于块首）
        head = s[max(0, matches[0].start() - 12):matches[0].start()]
        m_head = re.search(r"(?:^|[\t\n]| {2,})([^\s]{1,4})[ \t]*$", head)
        head_label = m_head.group(1) if m_head and _label_kind(m_head.group(1)) else ""

        groups: list[tuple[int, int, list[tuple[str, str, str]]]] = []
        for m in matches:
            item = (m.group(1) or "图", m.group(2), "")
            if groups:
                gap = s[groups[-1][1]:m.start()]
                if not gap.strip():  # 纯空白 → 同行
                    groups[-1][2].append(item)
                    groups[-1] = (groups[-1][0], m.end(), groups[-1][2])
                    continue
                kind = _label_kind(gap)
                if kind == "precede":  # 标签属于本图
                    item = (item[0], item[1], gap.strip())
                    groups[-1][2].append(item)
                    groups[-1] = (groups[-1][0], m.end(), groups[-1][2])
                    continue
                if kind == "follow":  # 标签属于上一张图
                    prev = groups[-1][2][-1]
                    groups[-1][2][-1] = (prev[0], prev[1], gap.strip())
                    groups[-1][2].append(item)
                    groups[-1] = (groups[-1][0], m.end(), groups[-1][2])
                    continue
            if not groups and head_label:
                item = (item[0], item[1], head_label)
            groups.append((m.start(), m.end(), [item]))

        tail = s[matches[-1].end():]
        if groups and _label_kind(tail) == "follow":  # 行尾标签 → 最后一图题注
            prev = groups[-1][2][-1]
            groups[-1][2][-1] = (prev[0], prev[1], tail.strip())
            groups[-1] = (groups[-1][0], len(s), groups[-1][2])

        pos = 0
        for gi, (start, end, items) in enumerate(groups):
            before = s[pos:start]
            if gi == 0 and head_label and items and not items[0][2]:
                m2 = re.search(r"(?:^|[\t\n]| {2,})([^\s]{1,4})[ \t]*$", before)
                if m2 and _label_kind(m2.group(1)):
                    first = items[0]
                    items[0] = (first[0], first[1], m2.group(1))
                    before = before[:m2.start(1)]
            if before.strip():
                self.write_text(before, **kw)
            for row in self._split_rows(items):
                if len(row) > 1:
                    self.write_image_row(row)
                else:
                    alt, src, cap = row[0]
                    self.write_image(src, alt)
                    if cap:
                        self.write_caption(cap)
            pos = end
        rest = s[pos:]
        if rest.strip():
            self.write_text(rest, **kw)

    def write_table(self, headers, rows, *, size: float = 9.0) -> None:
        head = [as_text(h) for h in headers or []]
        body = [[as_text(c) for c in r] for r in rows or []]
        cols = len(head) or (len(body[0]) if body else 0)
        if not cols:
            return
        avail = self.w - 2 * self.margin
        col_w = avail / cols
        self.y += 4

        def cell_lines(text: str) -> list[str]:
            return self._wrap(text, size, col_w - 8) or [""]

        for i, row in enumerate([head, *body]):
            row = list(row) + [""] * (cols - len(row))
            wrapped = [cell_lines(c) for c in row]
            row_h = max(len(ws) for ws in wrapped) * size * 1.35 + 6
            self._ensure(row_h)
            y0 = self.y
            for j, ws in enumerate(wrapped):
                x0 = self.margin + j * col_w
                self.page.draw_rect(fitz.Rect(x0, y0, x0 + col_w, y0 + row_h),
                                    color=(0.72, 0.72, 0.72), width=0.4,
                                    fill=(0.94, 0.96, 0.99) if i == 0 else None)
                ty = y0 + 3 + size
                for ln in ws:
                    if ln:
                        self._draw(x0 + 4, ty, ln, size, (0.13, 0.13, 0.13))
                    ty += size * 1.35
            self.y += row_h
        self.y += 8

    def _resolve_image(self, src) -> tuple[Path | None, bytes | None]:
        u = src_url(src)
        if u.startswith("data:"):
            try:
                b64 = u.split(",", 1)[1]
                return None, base64.b64decode(b64)
            except Exception:
                return None, None
        if not u or u.startswith("[[box:"):
            return None, None
        p = Path(u)
        if p.is_absolute() and p.exists():
            return p, None
        for base in (self.json_dir, self.json_dir.parent, Path.cwd()):
            cand = base / u
            if cand.exists():
                return cand, None
        return None, None

    def write_image(self, src, alt: str = "", *, max_h_ratio: float = 0.55) -> None:
        path, stream = self._resolve_image(src)
        if path is None and stream is None:
            self.write_text(f"〔插图缺失：{alt or src}〕", size=9.0,
                            color=(0.7, 0.2, 0.2), gap_after=6)
            return
        try:
            iw, ih = self._image_size(path, stream)
        except Exception as e:
            log.warning("图片读取失败 %s: %s", src, e)
            return
        max_w = self.w - 2 * self.margin
        max_h = self.h * max_h_ratio
        # 保持原文档中的显示尺寸（像素/zoom），仅超宽/超高时缩小
        base = self.img_scale / self.crop_zoom
        scale = min(base, max_w / iw, max_h / ih)
        dw, dh = iw * scale, ih * scale
        self._ensure(dh + 10)
        x = (self.w - dw) / 2
        rect = fitz.Rect(x, self.y, x + dw, self.y + dh)
        if stream is not None:
            self.page.insert_image(rect, stream=stream)
        else:
            self.page.insert_image(rect, filename=str(path))
        self.y += dh + 10

    def _image_size(self, path: Path | None, stream: bytes | None) -> tuple[int, int]:
        with Image.open(io.BytesIO(stream) if stream is not None else path) as im:
            return im.size

    def write_image_row(self, items: list[tuple[str, str, str]], *,
                        max_h_ratio: float = 0.55, gap: float = 14.0) -> None:
        """同一行并排渲染多张图（如 11(2) 的甲/乙）：保持原始相对尺寸，总宽超出时统一缩放。

        items: [(alt, src, caption)]，caption 画在图下方（短标签如 甲/乙）。
        """
        resolved: list[tuple[Path | None, bytes | None, int, int, str]] = []
        for _alt, src, caption in items:
            path, stream = self._resolve_image(src)
            if path is None and stream is None:
                log.warning("并排图中的图片缺失：%s", src)
                continue
            try:
                iw, ih = self._image_size(path, stream)
            except Exception as e:
                log.warning("并排图读取失败 %s: %s", src, e)
                continue
            resolved.append((path, stream, iw, ih, caption))
        if len(resolved) < 2:  # 缺失太多则退回逐张
            for alt, src, _caption in items:
                self.write_image(src, alt)
            return

        avail = self.w - 2 * self.margin
        base = self.img_scale / self.crop_zoom
        widths = [iw * base for _, _, iw, _, _ in resolved]
        heights = [ih * base for _, _, _, ih, _ in resolved]
        total_gap = gap * (len(resolved) - 1)
        scale = 1.0
        if sum(widths) + total_gap > avail:
            scale = (avail - total_gap) / sum(widths)
        max_h = self.h * max_h_ratio
        if max(heights) * scale > max_h:
            scale = min(scale, max_h / max(heights))
        dws = [w * scale for w in widths]
        dhs = [h * scale for h in heights]
        cap_size = 9.0
        cap_h = cap_size * 1.4 if any(c for *_, c in resolved) else 0.0
        row_h = max(dhs) + cap_h
        self._ensure(row_h + 10)
        x = self.margin + max(0.0, (avail - (sum(dws) + total_gap)) / 2)
        for (path, stream, _, _, caption), dw, dh in zip(resolved, dws, dhs,
                                                         strict=False):
            rect = fitz.Rect(x, self.y, x + dw, self.y + dh)
            if stream is not None:
                self.page.insert_image(rect, stream=stream)
            else:
                self.page.insert_image(rect, filename=str(path))
            if caption:
                cw = self.width_of(caption, cap_size)
                self._draw(x + (dw - cw) / 2, self.y + dh + cap_size,
                           caption, cap_size, (0.35, 0.35, 0.35))
            x += dw + gap
        self.y += row_h + 10

    # ---- 文档级 ----

    def write_blocks(self, blocks: list[dict]) -> None:
        heading_sizes = {1: 18.0, 2: 15.0, 3: 13.0}
        i = 0
        while i < len(blocks):
            b = blocks[i]
            t = b.get("type")
            if t == "image":  # 连续图片块：按原始 bbox 分行并排（MinerU/box 输出）
                run: list[tuple[str, str, str]] = []
                while i < len(blocks) and blocks[i].get("type") == "image":
                    im = blocks[i].get("image") if isinstance(blocks[i].get("image"), dict) \
                        else blocks[i]
                    run.append((as_text(im.get("alt")) or "图", im.get("src"), ""))
                    i += 1
                if len(run) > 1 and all(self._fig_box(src) for _a, src, _c in run):
                    for row in self._split_rows(run):
                        if len(row) > 1:
                            self.write_image_row(row)
                        else:
                            self.write_image(row[0][1], row[0][0])
                else:
                    for alt, src, _c in run:
                        self.write_image(src, alt)
                continue
            if t == "heading":
                level = min(max(int(b.get("level") or 2), 1), 3)
                self.write_text(as_text(b.get("text")), size=heading_sizes[level],
                                gap_before=10, gap_after=6)
            elif t == "text":
                text = as_text(b.get("text") if b.get("text") is not None else b.get("content"))
                self.write_text_with_images(text)
                for im in b.get("images") or []:
                    if isinstance(im, dict):
                        self.write_image(im.get("src"), as_text(im.get("alt")))
            elif t == "code":
                self.write_text(as_text(b.get("content") or b.get("code")), size=9.0,
                                indent=12, gap_after=6, bg=(0.96, 0.97, 0.98))
            elif t == "table":
                tb = b.get("table") if isinstance(b.get("table"), dict) else b
                self.write_table(tb.get("headers"), tb.get("rows"))
            elif t == "equation":  # 优先用原公式裁剪图，缺失时退化为 LaTeX 文本
                im = b.get("image") if isinstance(b.get("image"), dict) else None
                if im and im.get("src"):
                    self.write_image(im["src"], as_text(im.get("alt")) or "公式")
                else:
                    self.write_text(as_text(b.get("text")), size=9.0, indent=12,
                                    color=(0.2, 0.2, 0.5), gap_after=6)
            elif t == "page_footnote":  # 脚注：小号灰字 + 页码前缀
                page = page_of(b.get("position"))
                prefix = f"【注{page}】" if page else "【注】"
                self.write_text(prefix + as_text(b.get("text")), size=8.5, indent=12,
                                color=(0.45, 0.45, 0.45), gap_after=4)
            elif t == "question":  # 兼容考题输出
                self.write_text(f"题 {as_text(b.get('number'))}", size=12.0,
                                gap_before=10, gap_after=4)
                stem = as_text(b.get("stem"))
                self.write_text_with_images(stem)
                for im in b.get("images") or []:
                    if isinstance(im, dict):
                        self.write_image(im.get("src"), as_text(im.get("alt")))
                opts = b.get("options")
                items = (list(opts.items()) if isinstance(opts, dict)
                         else list(enumerate(opts or [])))
                for k, v in items:
                    key = k if isinstance(k, str) else chr(65 + int(k))
                    opt_text = as_text(v.get("text") if isinstance(v, dict) else v)
                    self.write_text(f"{key}. {opt_text}", indent=12, gap_after=1)
                    if isinstance(v, dict) and isinstance(v.get("image"), dict):
                        self.write_image(v["image"].get("src"), as_text(v["image"].get("alt")))
                if isinstance(b.get("table"), dict):
                    self.write_table(b["table"].get("headers"), b["table"].get("rows"))
                if b.get("answer"):
                    self.write_text("答案：" + as_text(b.get("answer")), size=9.5,
                                    color=(0.05, 0.45, 0.3), gap_after=2)
                if b.get("explanation"):
                    self.write_text("解析：" + as_text(b.get("explanation")), size=9.5,
                                    color=(0.35, 0.35, 0.35), gap_after=6)
            i += 1

    def save(self, out: Path, title: str = "") -> None:
        total = self.doc.page_count
        if title:
            self.doc[0].insert_text((self.margin, self.margin - 16), title,
                                    fontname=self.fontname, fontfile=self.fontfile,
                                    fontsize=11, color=(0.45, 0.45, 0.45))
        for i in range(total):
            page = self.doc[i]
            label = f"{i + 1} / {total}"
            w = self.width_of(label, 8)
            page.insert_text(((self.w - w) / 2, self.h - self.margin / 2), label,
                             fontname=self.fontname, fontfile=self.fontfile,
                             fontsize=8, color=(0.55, 0.55, 0.55))
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.doc.subset_fonts()  # 只嵌入用到的字形（否则 simsun 整包 ~18MB）
        except Exception as e:
            log.warning("字体子集化失败（不影响可读性）: %s", e)
        self.doc.save(str(out))
        self.doc.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="blocks JSON → 重排文字版 PDF")
    ap.add_argument("--json", required=True, help="blocks 格式 JSON（doc/box 模式输出）")
    ap.add_argument("--out", required=True, help="输出 .pdf")
    ap.add_argument("--page-size", default="a4", choices=sorted(PAGE_SIZES))
    ap.add_argument("--margin", type=float, default=56.0)
    ap.add_argument("--font-size", type=float, default=10.5)
    ap.add_argument("--crop-zoom", type=float, default=2.0,
                    help="图片裁剪时的页面缩放倍率（默认 2.0，用于还原原始显示尺寸）")
    ap.add_argument("--img-scale", type=float, default=1.0,
                    help="图片整体缩放系数（默认 1.0=原尺寸）")
    ap.add_argument("--figs", default="",
                    help="原始图框元数据 figs.json（按原文坐标分行并排，如 ABCD 选项 2×2）")
    ap.add_argument("--title", default="", help="页眉标题（默认取 JSON 文件名）")
    args = ap.parse_args()

    src = Path(args.json).resolve()
    data = json.loads(src.read_text(encoding="utf-8"))
    blocks = data.get("blocks") or []

    writer = PdfWriter(page_size=args.page_size, margin=args.margin,
                       base_size=args.font_size, crop_zoom=args.crop_zoom,
                       img_scale=args.img_scale)
    writer.json_dir = src.parent

    figs_path = Path(args.figs) if args.figs else None
    if figs_path is None:  # 默认找同名工作目录 / MinerU 输出的 figs.json
        stem = src.stem.replace("_doc", "").replace("_box", "")
        cands = [
            src.parent / "mineru" / "figs.json",  # MinerU 输出的 bbox（按 src 匹配）
            WORK_ROOT / stem / "figs.json",
        ]
        figs_path = next((c for c in cands if c.exists()), None)
    if figs_path and figs_path.exists():
        n = writer.load_figs(figs_path)
        print(f"figs: {n} boxes ({figs_path})")

    writer.write_blocks(blocks)
    out = Path(args.out).resolve()
    writer.save(out, title=args.title or html_mod.unescape(src.stem))
    size_kb = out.stat().st_size // 1024
    print(f"written {out} ({size_kb} KB, {len(blocks)} blocks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""不可见文字层：字体选择（CJK + 数学字体逐段）与插入（render_mode=3）。"""
from __future__ import annotations

import logging
from pathlib import Path

from pdf_tool.ocr.lines import Line

log = logging.getLogger("qb.ocrlayer")

FONT_CANDIDATES = (
    ("simsun", "C:/Windows/Fonts/simsun.ttc"),
    ("simhei", "C:/Windows/Fonts/simhei.ttf"),
    ("simkai", "C:/Windows/Fonts/simkai.ttf"),
)
# 兜底字体：优先同时覆盖 CJK 与上下标（MS Gothic 实测 ²₀₁√α 中文 全有）
MATH_FONT_CANDIDATES = (
    ("msgothic", "C:/Windows/Fonts/msgothic.ttc"),
    ("seguisym", "C:/Windows/Fonts/seguisym.ttf"),
    ("cambria", "C:/Windows/Fonts/cambria.ttc"),
    ("dejavu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
)
# CJK 字体缺上下标时的 ASCII 退化映射（字形缺失会写成 NUL，比退化更糟）
SUB_ASCII = str.maketrans("₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎", "0123456789+-=()")
SUP_ASCII = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ", "0123456789+-=()ni")


# ---------------- 写文字层 ----------------

def _load_font() -> tuple[str, str | None]:
    for name, path in FONT_CANDIDATES:
        if Path(path).exists():
            return name, path
    return "china-s", None


def _load_math_font() -> tuple[str, str] | None:
    for name, path in MATH_FONT_CANDIDATES:
        if Path(path).exists():
            return name, path
    return None


def _font_runs(text: str, primary, math) -> list[tuple[str, tuple]]:
    """把行文本按字形覆盖切成 (子串, 字体) 序列。

    主字体缺字形（如下标 ₀）而数学字体有 → 该字符换用数学字体，实现
    「中文用宋体 + 下标用数学字体」同行混排；两者都缺 → 上/下标退化 ASCII，
    仍缺则丢弃（字形缺失会写成 NUL，比退化更糟）。
    """
    pfont = primary[2]
    if pfont is None:  # 内置字体无字形表：整行原样
        return [(text, primary)]
    runs: list[tuple[str, tuple]] = []
    buf: list[str] = []
    cur: tuple | None = None
    for ch in text:
        if pfont.has_glyph(ord(ch)):
            entry = primary
        elif math is not None and math[2].has_glyph(ord(ch)):
            entry = math
        else:
            alt = ch.translate(SUB_ASCII).translate(SUP_ASCII)
            if alt != ch and pfont.has_glyph(ord(alt)):
                entry, ch = primary, alt
            else:
                continue
        if cur is not entry:
            if buf and cur is not None:
                runs.append(("".join(buf), cur))
            buf, cur = [], entry
        buf.append(ch)
    if buf and cur is not None:
        runs.append(("".join(buf), cur))
    return runs


def insert_layer(page, lines: list[list], dpi: float, fontname: str,
                 fontfile: str | None, math_font: tuple[str, str] | None = None) -> int:
    """把行级文本按框插入为不可见文字（render_mode=3）。返回插入行数。

    math_font：补 CJK 字体缺字（下标/根号等）的字体；同一行内按字形自动分段插入。
    """
    import fitz

    scale = 72.0 / dpi
    mat = page.derotation_matrix  # 渲染图坐标 → 页面坐标（处理 /Rotate）
    pfont = None
    if fontfile:
        try:
            pfont = fitz.Font(fontfile=fontfile)
        except Exception:
            pfont = None
    primary = (fontname, fontfile, pfont)
    math = None
    if math_font is not None:
        try:
            math = (math_font[0], math_font[1], fitz.Font(fontfile=math_font[1]))
        except Exception:
            math = None
    inserted = 0
    for item in lines:
        ln = Line.from_json(item)
        x0, y0, x1, y1 = ln.rect
        h = y1 - y0
        if h <= 1 or x1 <= x0:
            continue
        runs = _font_runs(ln.text, primary, math)
        if not runs:
            continue
        size = max(3.0, h * scale * 0.9)
        box_w = (x1 - x0) * scale
        width = sum(f[2].text_length(t, size) for t, f in runs if f[2] is not None)
        if width > box_w > 0:  # 让文字宽度不超过框宽，提升选择精度
            size = max(3.0, size * box_w / width)
        x = x0 * scale
        baseline = (y1 - h * 0.18) * scale
        for text, entry in runs:
            page.insert_text(fitz.Point(x, baseline) * mat, text,
                             fontname=entry[0], fontfile=entry[1],
                             fontsize=size, render_mode=3)
            if entry[2] is not None:
                x += entry[2].text_length(text, size)
        inserted += 1
    return inserted

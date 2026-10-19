"""文字层的行模型、阅读顺序与页码解析（公用）。"""
from __future__ import annotations

import itertools
from dataclasses import dataclass

from pdf_tool.core.pages import parse_pages as parse_pages  # 公用：页码解析（向后兼容导出）


@dataclass
class Line:
    """一行 OCR 结果：文本 + 四点框（图像像素坐标）+ 置信度。"""

    text: str
    quad: list[list[float]]
    score: float = 1.0

    @property
    def rect(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.quad]
        ys = [p[1] for p in self.quad]
        return min(xs), min(ys), max(xs), max(ys)

    def to_json(self) -> list:
        return [self.text, self.quad, round(self.score, 3)]

    @staticmethod
    def from_json(v: list) -> Line:
        return Line(str(v[0]), v[1], float(v[2]) if len(v) > 2 else 1.0)


def _yx_key(line: Line) -> tuple[float, float]:
    """阅读顺序：先上下（y），再左右（x）。"""
    return line.rect[1], line.rect[0]


# ---------------- 阅读顺序 ----------------

def order_lines(lines: list[Line], page_width: float) -> list[Line]:
    """栏检测（竖直空白带）→ 先左栏后右栏；栏内按 (y, x) 排序。"""
    if len(lines) < 4:
        return sorted(lines, key=_yx_key)
    spans = [(ln.rect[0], ln.rect[2]) for ln in lines]
    edges = sorted({s[0] for s in spans} | {s[1] for s in spans})
    cands = []
    for a, b in itertools.pairwise(edges):
        if b - a < 24 or a < 0.25 * page_width or b > 0.80 * page_width:
            continue
        if any(x0 < b and x1 > a for x0, x1 in spans):
            continue
        cands.append((a, b))
    if not cands:
        return sorted(lines, key=_yx_key)
    a, b = max(cands, key=lambda t: t[1] - t[0])
    left = [ln for ln in lines if (ln.rect[0] + ln.rect[2]) / 2 <= a]
    right = [ln for ln in lines if (ln.rect[0] + ln.rect[2]) / 2 >= b]
    mid = [ln for ln in lines if a < (ln.rect[0] + ln.rect[2]) / 2 < b]
    need = max(3, int(0.15 * len(lines)))
    if len(left) < need or len(right) < need:
        return sorted(lines, key=_yx_key)
    return sorted(left, key=_yx_key) + sorted(mid, key=_yx_key) + sorted(right, key=_yx_key)


# ---------------- 页码解析 ----------------

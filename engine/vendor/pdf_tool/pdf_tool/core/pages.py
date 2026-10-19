"""页码范围解析（公用）。"""
from __future__ import annotations


def parse_pages(spec: str, total: int) -> list[int]:
    """`1-100,105` → [1..100, 105]（1-based）。空 = 全部。"""
    if not spec:
        return list(range(1, total + 1))
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return [p for p in out if 1 <= p <= total]

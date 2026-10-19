"""行文本对齐：把 MinerU 的块级文本按序列对齐分派到 rapid 的行级文本上。

用途：MinerU（公式/阅读顺序好，但 hybrid 后端 bbox 只到段落）提供文本，
rapid OCR 提供行级位置；对齐后每行拿到属于自己的 MinerU 文本，
从而同时得到「行级位置 + 公式正确的文字层」。
"""
from __future__ import annotations

import difflib

SUP_ASCII = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ", "0123456789+-=()ni")
SUB_ASCII = str.maketrans("₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜ",
                          "0123456789+-=()aeoxhklmnpst")
_PUNCT_MAP = {"，": ",", "；": ",", "：": ":", "（": "(", "）": ")",
              "。": ".", "“": '"', "”": '"', "‘": "'", "’": "'"}
# 单行对齐覆盖率低于该比例时保留原 OCR 文本（宁可不换，也不要用半句替换）
MIN_LINE_COVERAGE = 0.3
# 块对齐总覆盖率低于该比例时整块保留原 OCR 文本
MIN_BLOCK_COVERAGE = 0.6
# 行间空隙（MinerU 有、OCR 无的字符）归前一行时的最大长度
MAX_GAP = 40


def norm_char(c: str) -> str:
    """归一化单字符：去空白、上下标→ASCII、全角标点→半角、统一小写。"""
    if c.isspace():
        return ""
    c = c.translate(SUP_ASCII).translate(SUB_ASCII)
    c = _PUNCT_MAP.get(c, c)
    return c.lower()


def norm_with_map(s: str) -> tuple[str, list[int]]:
    """归一化并返回「归一化字符 → 原串下标」映射（对齐用）。"""
    out: list[str] = []
    idx: list[int] = []
    for i, c in enumerate(s):
        for n in norm_char(c):
            out.append(n)
            idx.append(i)
    return "".join(out), idx


def merge_block_text(mineru_text: str, rapid_texts: list[str]) -> tuple[list[str], float]:
    """把 MinerU 块文本按对齐分派到 rapid 各行；返回 (每行文本, 块覆盖率)。

    - 行覆盖率 < MIN_LINE_COVERAGE → 该行保留原 OCR 文本；
    - 块覆盖率 < MIN_BLOCK_COVERAGE → 整块保留原 OCR 文本；
    - 行间空隙（≤ MAX_GAP 字符）归前一行，避免丢 MinerU 字符。
    """
    original = list(rapid_texts)
    if not mineru_text.strip() or not rapid_texts:
        return original, 0.0
    a, a_idx = norm_with_map(mineru_text)
    b, _ = norm_with_map("".join(rapid_texts))
    if not a or not b:
        return original, 0.0

    bounds: list[tuple[int, int]] = []
    acc = 0
    for text in rapid_texts:
        n = len(norm_with_map(text)[0])
        bounds.append((acc, acc + n))
        acc += n

    matcher = difflib.SequenceMatcher(None, b, a, autojunk=False)
    spans: list[list[int] | None] = [None] * len(rapid_texts)
    matched = 0
    for blk in matcher.get_matching_blocks():
        if blk.size == 0:
            continue
        matched += blk.size
        for i, (s, e) in enumerate(bounds):
            lo, hi = max(s, blk.a), min(e, blk.a + blk.size)
            if lo >= hi:
                continue
            j0 = blk.b + (lo - blk.a)
            j1 = j0 + (hi - lo)
            if spans[i] is None:
                spans[i] = [j0, j1]
            else:
                spans[i][0] = min(spans[i][0], j0)
                spans[i][1] = max(spans[i][1], j1)

    coverage = matched / len(a)
    if coverage < MIN_BLOCK_COVERAGE:
        return original, coverage

    prev_end = 0
    for sp in spans:  # 单调化（对齐区间不得回退）
        if sp is None:
            continue
        sp[0] = max(sp[0], prev_end)
        prev_end = max(prev_end, sp[1])
    for i, sp in enumerate(spans):  # 行间空隙归前一行
        if sp is None:
            continue
        nxt = next((s[0] for s in spans[i + 1:] if s is not None), len(a))
        sp[1] = max(sp[1], min(nxt, sp[1] + MAX_GAP))

    out: list[str] = []
    for i, text in enumerate(rapid_texts):
        sp = spans[i]
        line_len = max(1, len(norm_with_map(text)[0]))
        if sp is None or (sp[1] - sp[0]) < MIN_LINE_COVERAGE * line_len:
            out.append(text)
            continue
        out.append(mineru_text[a_idx[sp[0]]: a_idx[sp[1] - 1] + 1].strip() or text)
    return out, coverage

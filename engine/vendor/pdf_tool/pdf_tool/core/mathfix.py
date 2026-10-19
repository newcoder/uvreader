"""公式分隔符修复：把「半截公式」（`\\(` 与 `$` 混用 / 落单）归一成对。

reader P1-a：MinerU 的表格单元格里会出现 `\\( s_o=2f$`、`$f倒像缩小` 这类半截公式，
渲染端无法解析 → 在单元格层面归一成对（统一 `$…$`）。

保守策略：
- 正常内容（无 `\\(`/`\\)` 且 `$` 成对）原样返回；
- `\\(`/`\\)` 一律折算成 `$`；
- 落单的 `$`：在「补一个」与「删一个」之间选**公式更像**的方案（按跨度数学分），
  都无法安全修复时删掉落单符（退回纯文本，至少能正常渲染，不再出半截公式）。
"""
from __future__ import annotations

import re

_MATH_CHARS = set("\\^_{}[]()+-=<>|/·×÷±∞∑∫√∠°′″%,")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _score(span: str) -> int:
    """片段「像公式」的程度：数学符号 +，ASCII 字母数字 +，CJK −。"""
    s = 0
    for c in span:
        if c in _MATH_CHARS:
            s += 3
        elif c.isascii() and c.isalnum():
            s += 1
        elif _CJK_RE.match(c):
            s -= 3
    return s


def _drop_best(s: str, idx: list[int]) -> str:
    """落单符多于 1 个：删掉一个让公式跨度总得分最高。"""
    best, best_score = s, None
    for drop in range(len(idx)):
        keep = [i for j, i in enumerate(idx) if j != drop]
        candidate = "".join(c for i, c in enumerate(s) if i != idx[drop])
        score = sum(_score(s[a + 1:b]) for a, b in zip(keep[0::2], keep[1::2], strict=False))
        if best_score is None or score > best_score:
            best, best_score = candidate, score
    return best


def normalize_math_delims(text: str) -> str:
    """单元格文本 → 分隔符成对的文本（能修则修，修不动就删落单符）。"""
    s = str(text or "")
    if not s:
        return s
    if "\\(" not in s and "\\)" not in s and s.count("$") % 2 == 0:
        return s  # 正常内容不动
    s = s.replace("\\(", "$").replace("\\)", "$")
    idx = [i for i, c in enumerate(s) if c == "$"]
    if not idx or len(idx) % 2 == 0:
        return s
    if len(idx) == 1:
        i = idx[0]
        # 单个 `$`：能「补一个」更优时补（`$f倒像缩小`→`$f$倒像缩小`；`$x^2`→`$x^2$`）
        if i == 0 and len(s) > 1:
            m = _CJK_RE.search(s, 1)
            end = m.start() if m else len(s)
            head = s[1:end]
            if head and _score(head) > 0:
                return s[:end] + "$" + s[end:]
        if i > 0 and not _CJK_RE.search(s[:i]) and _score(s[:i]) > 0:
            return "$" + s
        return s.replace("$", "", 1)
    return _drop_best(s, idx)

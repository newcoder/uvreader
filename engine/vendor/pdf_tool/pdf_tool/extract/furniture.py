"""页面装饰（水印 / 页眉 / 页脚 / 页码）的通用识别与剔除，`pdf_to_doc` 全模式共用。

识别依据（与具体文档、来源格式无关）：
- **水印**：`core.watermark.faint_traces` 里 **0 < opacity < 0.35** 的可见浅色文字；
  隐形文字（`opacity == 0`，多为残留的隐形 OCR 层）**不算水印**（reader 2026-10-18）；
- **跨页重复行**：数字归一后出现在 ≥ 半数页、且位于页边带（默认上下 10%）的行
  （页眉/页脚/装订线文字；正文里重复的半页行不会被误伤）；
- **页码样式行**：整行匹配 `第 N 页` / `第 N 页，共 M 页` / `Page N of M` / `N / M` 等。

过滤：对 blocks 的文本字段按**整行**归一匹配剔除；
**行内独立 token 剔除**（水印才做）的三重护栏（reader 2026-10-18 回归修复）：
  ① 只处理 text/heading/脚注块，**公式块（equation）与代码块跳过**，且不碰 `$…$`/`$$…$$` 片段；
  ② 候选词 ≥2 字（单字母 `W`/`M`/`i` 永不整词删）；
  ③ 用「trace 出现在 ≥ 半数页」判定热度（不再用子串计数），且该词必须**在可见文字层里低频**
  （可见层里大量出现的 `is`/`of`/`in` 显然不是水印）。
空块丢弃。调用方：`convert.pipeline.convert()`（text / vision / mineru / blocks 均生效）。
"""
from __future__ import annotations

import logging
import re
from collections import Counter
from pathlib import Path

from pdf_tool.core import watermark

log = logging.getLogger("qb.furniture")

# 页码样式行（整行）：宁窄勿宽——不匹配裸数字行（可能是正文/代码）
PAGE_LIKE_RE = re.compile(
    r"^\s*(?:"
    r"第\s*\d{1,4}\s*页(?:\s*[,，、/]?\s*共\s*\d{1,4}\s*页)?"
    r"|page\s*\d{1,4}(?:\s*(?:of|/)\s*\d{1,4})?"
    r"|\d{1,4}\s*/\s*\d{1,4}"
    r"|[—–-]\s*\d{1,4}\s*[—–-]"
    r")\s*$",
    re.IGNORECASE,
)

# 公式片段（行内/行间）：行内 token 剔除不得越过这些片段
_MATH_SPAN_RE = re.compile(r"(\$\$[\s\S]*?\$\$|\$[^$\n]*\$)")

_BAND = 0.10  # 页边带比例（上下各 10%）
_INLINE_GUARD = r"(?<![0-9A-Za-z\u4e00-\u9fff])%s(?![0-9A-Za-z\u4e00-\u9fff])"
_INLINE_TYPES = ("text", "heading", "page_footnote")  # 做行内剔除的块类型


def _norm(text: str) -> str:
    """归一化：数字→#、去空白（用于跨页重复/水印整行匹配）。"""
    return re.sub(r"\s+", "", re.sub(r"\d+", "#", (text or "").strip()))


def scan_pdf(pdf: Path, *, band: float = _BAND) -> dict:
    """通用扫描一份 PDF 的页面装饰。

    返回 `{"pages", "watermark_texts", "repeated_lines", "page_like_lines",
    "watermark_pages", "watermark_visible"}`：
    - `watermark_texts`：归一化水印文本（**不含 opacity==0 的隐形文字**）；
    - `watermark_pages`：每条水印文本出现在多少页（热度判定的依据）；
    - `watermark_visible`：每条水印文本在**可见文字层**（page_lines）里的子串出现次数（护栏）。
    """
    import fitz

    from pdf_tool.extract.doc_mode import page_lines

    wm: set[str] = set()
    wm_pages: Counter = Counter()
    counts: Counter = Counter()
    band_hits: Counter = Counter()
    page_like: set[str] = set()
    visible_parts: list[str] = []
    pages = 0
    doc = fitz.open(str(pdf))
    try:
        pages = doc.page_count
        for page in doc:
            seen_wm: set[str] = set()
            for f in watermark.faint_traces(page):
                if float(f.get("opacity") or 0) <= 0:
                    continue  # 隐形 OCR 层不是水印（reader 2026-10-18）
                t = _norm(f.get("text") or "")
                if t and t not in seen_wm:
                    seen_wm.add(t)
                    wm.add(t)
                    wm_pages[t] += 1
            h = float(page.rect.height) or 1.0
            seen: set[str] = set()
            for y0, text in page_lines(page):
                n = _norm(text)
                if not n:
                    continue
                visible_parts.append(n)
                if PAGE_LIKE_RE.match(text):
                    page_like.add(text.strip())
                if n in seen:
                    continue
                seen.add(n)
                counts[n] += 1
                if y0 < band * h or y0 > (1 - band) * h:
                    band_hits[n] += 1
    finally:
        doc.close()
    visible = "".join(visible_parts)
    repeated: set[str] = set()
    if pages >= 3:  # <3 页无重复统计意义，交给页码样式/水印
        need = max(2, int(pages * 0.5))
        repeated = {t for t, c in band_hits.items() if c >= need}
    if wm or repeated or page_like:
        log.info("[furniture] pages=%d 水印=%s 重复页边行=%d 页码行=%d",
                 pages, sorted(wm)[:4], len(repeated), len(page_like))
    return {"pages": pages, "watermark_texts": wm, "repeated_lines": repeated,
            "page_like_lines": page_like, "watermark_pages": dict(wm_pages),
            "watermark_visible": {t: visible.count(t) for t in wm}}


def _texts_of(block: dict) -> list[str]:
    return [v for k in ("text", "content") if isinstance((v := block.get(k)), str)]


def _strip_hot(ln: str, hot: set[str]) -> tuple[str, bool]:
    """行内独立 token 剔除；公式片段（$…$ / $$…$$）原样保留。"""
    parts = _MATH_SPAN_RE.split(ln)
    changed = False
    for i, part in enumerate(parts):
        if i % 2 or not part:  # 奇数下标是公式片段
            continue
        new = part
        for t in hot:
            new = re.sub(_INLINE_GUARD % re.escape(t), "", new)
        if new != part:
            changed = True
            parts[i] = new
    return ("".join(parts) if changed else ln), changed


def filter_blocks(blocks: list[dict], furniture: dict) -> tuple[list[dict], dict]:
    """按 `scan_pdf` 结果过滤 blocks 的文本字段；返回 (过滤后 blocks, 统计)。"""
    pages = int(furniture.get("pages") or 0)
    wm = set(furniture.get("watermark_texts") or ())
    rep = set(furniture.get("repeated_lines") or ())
    stats = {"dropped_lines": 0, "dropped_watermark_inline": 0, "dropped_blocks": 0,
             "hot_tokens": []}
    if not wm and not rep:
        return blocks, stats

    hot: set[str] = set()
    if wm:
        wm_pages = dict(furniture.get("watermark_pages") or {})
        wm_visible = dict(furniture.get("watermark_visible") or {})
        need = max(2, int(pages * 0.5)) if pages >= 2 else 2
        # 三重护栏：≥2 字 + trace 覆盖 ≥ 半数页 + 可见文字层里低频（reader 2026-10-18）
        hot = {t for t in wm if len(t) >= 2
               and wm_pages.get(t, 0) >= need
               and wm_visible.get(t, 0) < need}
    stats["hot_tokens"] = sorted(hot)
    log.info("[furniture] 过滤: 重复行=%d 水印=%s 行内水印=%s", len(rep),
             sorted(wm)[:4], sorted(hot)[:4])

    out: list[dict] = []
    for b in blocks:
        if not isinstance(b, dict):
            out.append(b)
            continue
        b2 = dict(b)
        allow_inline = b2.get("type") in _INLINE_TYPES
        for key in ("text", "content"):
            v = b2.get(key)
            if isinstance(v, str):
                b2[key] = _filter_text(v, rep, wm, hot if allow_inline else set(), stats)
        if (b2.get("type") in ("text", "heading", "code", "page_footnote")
                and not (_texts_of(b2) and any(t.strip() for t in _texts_of(b2)))):
            stats["dropped_blocks"] += 1
            continue
        out.append(b2)
    return out, stats


def _filter_text(text: str, rep: set[str], wm: set[str], hot: set[str],
                 stats: dict) -> str:
    keep: list[str] = []
    for ln in text.splitlines() or [text]:
        n = _norm(ln)
        if n and (n in rep or n in wm or PAGE_LIKE_RE.match(ln)):
            stats["dropped_lines"] += 1
            continue
        if hot:
            new, changed = _strip_hot(ln, hot)
            if changed:
                stats["dropped_watermark_inline"] += 1
                ln = re.sub(r"[ \t]{2,}", " ", new).strip()
        if ln.strip():
            keep.append(ln)
    return "\n".join(keep).strip()

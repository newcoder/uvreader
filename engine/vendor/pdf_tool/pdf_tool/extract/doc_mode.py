#!/usr/bin/env python3
"""整份文档文本抽取模式（doc/text mode）。

与逐页 vision 不同：把版面解析得到的**完整文本**（图片保留 `[IMG_n]` 锚点）分块交给
文本模型，跨页内容（尤其代码块）天然完整。产物经 `vision_extract.parse_page_result`
与 `assemble` 汇入同一 schema，故输出结构与 vision 路径完全一致。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from pdf_tool.core import watermark

log = logging.getLogger("qb.doc")

_PAGE_MARK_RE = re.compile(r"===== 第 (\d+) 页 =====")
_IMG_TAG_RE = re.compile(r'<img[^>]*src="([^"]+)"[^>]*/?>')

# ---------- 文本层修复：坏字符不该进交付 JSON ----------
# 适用 Symbol 编码表的字体：Symbol/SymbolMT 与 TeX CM 数学字体家族（共用同一区域）。
# 其余字体（0xE000 系私用区、Wingdings、自定义嵌入子集）一律不套表 —— 见 doc_mode 测试
# 里的反例：中文论文3 的 DY1+ZFIGyC-2 套表会得到 47 个连续 `⊂`。
SYMBOL_PUA_FONT_RE = re.compile(r"^(?:Symbol|SymbolMT|CMEX\d*|CMSY\d*|CMMI\d*|CMR\d*)$",
                                re.IGNORECASE)
_SUBSET_PREFIX_RE = re.compile(r"^[A-Z]{6}\+")
# `¼ ð Þ` 一类"看似合法码位"的替换（TeX CM 字体缺 ToUnicode 时），以及 √ 的碎片
_SUBSTITUTION_CHARS = frozenset("¼½ðÞ")
_SUBSTITUTION_FRAGMENTS = ("ffiffi", "pffiffi", "ffiffiffi", "ﬃﬃ")
_ALLOWED_CONTROL = frozenset("\t\n\r")
# 私用区（BMP 内）
PUA_RANGE = (0xE000, 0xF8FF)


def _is_disallowed_control(c: str) -> bool:
    """非法控制字符：C0（除 \\t\\n\\r）与 DEL + C1。"""
    o = ord(c)
    return (o < 32 or 0x7F <= o <= 0x9F) and c not in _ALLOWED_CONTROL


def _is_pua(c: str) -> bool:
    return PUA_RANGE[0] <= ord(c) <= PUA_RANGE[1]


def base_font_name(font: str) -> str:
    """去掉 6 字母子集前缀（`ABCDEF+SymbolMT` → `SymbolMT`）。"""
    return _SUBSET_PREFIX_RE.sub("", str(font or "").strip())


def repair_extracted_text(text: str, font: str = "") -> str:
    """修复从 PDF span 抽出的文本；只修能确信的，其余原样保留。

    1. 非法控制字符 → 空格（直接删除会把相邻词粘在一起）；
    2. Symbol 系字体的 `U+F000+byte` 私用区 → 按 Adobe Symbol 标准编码还原。

    不处理：0xE000 系私用区、非 Symbol 系字体的私用区、`¼ ð Þ` 类替换 —— 这些都
    无法可靠还原，留给 `text_layer_health` 计数后由审计告警。

    幂等：对已修复文本再跑一次结果不变。
    """
    if not text:
        return text
    out = "".join(" " if _is_disallowed_control(c) else c for c in text)
    if font and SYMBOL_PUA_FONT_RE.match(base_font_name(font)):
        from pdf_tool.extract.symbol_encoding import SYMBOL_ENCODING
        out = "".join(
            SYMBOL_ENCODING.get(ord(c) & 0xFF, c) if _is_pua(c) else c for c in out)
    return out


def text_layer_health(text: str) -> dict[str, int]:
    """统计文本里**仍未修复**的坏字符数，供门控与审计使用。

    返回 {"control", "pua", "substitution", "total"}。
    """
    control = pua = 0
    for c in text or "":
        if _is_disallowed_control(c):
            control += 1
        elif _is_pua(c):
            pua += 1
    sub = sum(1 for c in (text or "") if c in _SUBSTITUTION_CHARS)
    sub += sum((text or "").count(f) for f in _SUBSTITUTION_FRAGMENTS)
    return {"control": control, "pua": pua, "substitution": sub,
            "total": control + pua + sub}

# 只清 HTML 标签，避免误删 C++ 的 `#include <cstdlib>` 这类尖括号内容
_HTML_TAG_RE = re.compile(
    r"</?(?:div|span|p|br|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|b|i|u|s|strong|em|"
    r"center|font|a|img|sup|sub|section|article|style|script|blockquote|pre|code)\b[^>]*>",
    re.IGNORECASE)


def _page_fig_lines(figs: list[dict]) -> dict[int, list[int]]:
    by_page: dict[int, list[int]] = {}
    for f in figs:
        by_page.setdefault(f["page"], []).append(f["n"])
    return by_page


def build_doc_text_from_pp(result_json: Path, figs: list[dict]) -> str:
    """PaddleOCR doc_parsing 结果 → 全卷文本（`<img>` → `[IMG_n]`，按页分隔）。"""
    data = json.loads(result_json.read_text(encoding="utf-8"))
    key2n = {Path(f["key"]).name: f["n"] for f in figs}
    by_page = _page_fig_lines(figs)
    parts: list[str] = []
    for pi, page in enumerate(data["pages"], 1):
        md = page.get("markdownText") or ""

        def _img(m):
            name = m.group(1).split("/")[-1]
            return f"[IMG_{key2n[name]}]" if name in key2n else ""

        md = _IMG_TAG_RE.sub(_img, md)
        md = _HTML_TAG_RE.sub("", md)
        md = re.sub(r"\n{3,}", "\n\n", md)
        page_figs = " ".join(f"IMG_{n}" for n in by_page.get(pi, []))
        parts.append(f"===== 第 {pi} 页 =====\n{md.strip()}\n\n[本页附图：{page_figs}]")
    return "\n\n".join(parts)


def _median(values: list[float]) -> float:
    v = sorted(values)
    return v[len(v) // 2] if v else 0.0


def page_lines(page) -> list[tuple[float, str]]:
    """把一页的 span 重组为「视觉行」（栏检测 → 中心聚类 → x 排序 → 间距补空格）。

    - 双栏版面：检测栏间竖直空白带（gutter），先左栏后右栏，避免左右栏同行被合并；
    - 聚类用 span 垂直中心 (y0+y1)/2，兼容同行不同字号（如目录的标题+页码）；
    - 水印/背景字剔除（`core.watermark`）：**文本+字号双匹配水印自身**，只按位置会误删
      与水印重叠的正文；倾斜（dir 非水平/垂直）的 span 不入正文；
    - 返回 [(行首 y0, 行文本), ...]（阅读顺序）。
    """
    faint = watermark.faint_traces(page)
    raw: list[tuple[tuple[float, float, float, float], str, float]] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            direction = line.get("dir") or (1.0, 0.0)
            if (abs(float(direction[1])) > watermark.OBLIQUE_SIN
                    and abs(float(direction[0])) > watermark.OBLIQUE_SIN):
                continue  # 倾斜文字（典型水印），非水平/垂直
            for s in line.get("spans", []):
                # 出口即修复：坏字符一旦进入行流就会被拼进交付 JSON（见 repair_extracted_text）
                text = repair_extracted_text(s.get("text") or "", s.get("font") or "")
                if not text.strip():
                    continue
                raw.append((tuple(s["bbox"]), text, float(s.get("size") or 0)))
    median = _median([sz for _, _, sz in raw]) if faint else 0.0
    spans: list[tuple[float, float, float, float, str]] = []
    for (x0, y0, x1, y1), text, size in raw:
        if watermark.is_watermark_span(text, size, (x0, y0, x1, y1), faint, median):
            continue  # 水印自身（与水印重叠的正文不受影响，按文本+字号判定）
        spans.append((y0, (y0 + y1) / 2, x0, x1, text))
    if not spans:
        return []
    out: list[tuple[float, str]] = []
    for col in _split_columns(spans, page.rect.width):
        out.extend(_cluster_lines(col))
    return out


def _split_columns(spans: list[tuple], width: float) -> list[list[tuple]]:
    """按竖直 gutter 把 span 分为 1~2 栏；无有效 gutter 或两侧过少则单栏。"""
    occupied = [(s[2], s[3]) for s in spans]
    edges = sorted({s[2] for s in spans} | {s[3] for s in spans})
    cands: list[tuple[float, float]] = []
    for i in range(len(edges) - 1):
        a, b = edges[i], edges[i + 1]
        if b - a < 18 or a < 0.25 * width or b > 0.80 * width:
            continue
        if any(x0 < b and x1 > a for x0, x1 in occupied):
            continue
        cands.append((a, b))
    if not cands:
        return [spans]
    a, b = max(cands, key=lambda t: t[1] - t[0])
    left = [s for s in spans if (s[2] + s[3]) / 2 <= a]
    right = [s for s in spans if (s[2] + s[3]) / 2 >= b]
    rest = [s for s in spans if a < (s[2] + s[3]) / 2 < b]
    need = max(3, int(0.15 * len(spans)))
    if len(left) < need or len(right) < need:
        return [spans]
    return [left + rest, right]


def _cluster_lines(spans: list[tuple]) -> list[tuple[float, str]]:
    """同一栏内：按垂直中心聚类成行，行内按 x 排序并按水平间距补空格。"""
    spans = sorted(spans, key=lambda t: (t[1], t[2]))
    clusters: list[list[tuple]] = []
    for s in spans:
        if clusters and abs(s[1] - clusters[-1][-1][1]) <= 6.0:
            clusters[-1].append(s)
        else:
            clusters.append([s])
    out: list[tuple[float, str]] = []
    for cl in clusters:
        cl.sort(key=lambda t: (t[2], t[3]))
        parts: list[str] = []
        prev_end: float | None = None
        for s in cl:
            if prev_end is not None and s[2] - prev_end > 1.5:
                parts.append(" " * max(1, min(6, int((s[2] - prev_end) / 3))))
            parts.append(s[4])
            prev_end = s[3]
        merged = "".join(parts).strip()
        if merged:
            out.append((min(s[0] for s in cl), merged))
    return out


def build_doc_text_from_layout(pdf: Path, figs: list[dict]) -> str:
    """文本型 PDF → 全卷文本（fitz 行流，图片锚点在真实版面位置）。

    跨页重复出现的行（页眉/页脚，如「第 N 页，共 M 页」）不计入正文——它们会打断
    跨页代码块，导致模型整段漏抽。
    """
    import fitz  # PyMuPDF

    by_page = _page_fig_lines(figs)
    doc = fitz.open(str(pdf))
    pages_items: dict[int, list[tuple[float, str]]] = {}
    try:
        for page_no, page in enumerate(doc, 1):
            items: list[tuple[float, str]] = []
            for f in figs:
                if f.get("page") != page_no or not f.get("pos"):
                    continue
                _x0, y0, _x1, y1 = (int(v) for v in f["pos"])
                items.append((float(y0), f"\n[IMG_{f['n']}｜y={y0}-{y1}]\n"))
            items.extend(page_lines(page))
            pages_items[page_no] = items
    finally:
        doc.close()

    # 页眉/页脚检测：数字归一后出现在 ≥半数页的行不计入正文（页码变体也能命中）
    repeated = _repeated_margin_lines(pages_items)
    parts: list[str] = []
    for page_no in sorted(pages_items):
        items = [(y, t) for y, t in pages_items[page_no]
                 if _is_img_anchor(t) or _norm_margin(t) not in repeated]
        items.sort(key=lambda t: (t[0], 1 if _is_img_anchor(t[1]) else 0))
        page_figs = " ".join(f"IMG_{n}" for n in by_page.get(page_no, []))
        body = "\n\n".join(t for _, t in items)
        parts.append(f"===== 第 {page_no} 页 =====\n{body}\n\n[本页附图：{page_figs}]")
    return "\n\n".join(parts)


def _is_img_anchor(text: str) -> bool:
    return text.strip().startswith("[IMG_")


def _norm_margin(text: str) -> str:
    """页眉/页脚归一：数字→#、去空白，用于跨页重复检测。"""
    return re.sub(r"\s+", "", re.sub(r"\d+", "#", text.strip()))


def _repeated_margin_lines(pages_items: dict[int, list[tuple[float, str]]]) -> set[str]:
    """返回跨页重复的行（归一后 ≥半数页出现且至少 2 页）；页数 <3 不做判定。"""
    from collections import Counter

    page_count = len(pages_items)
    if page_count < 3:
        return set()
    counter: Counter = Counter()
    for items in pages_items.values():
        seen = set()
        for _, t in items:
            if _is_img_anchor(t):
                continue
            norm = _norm_margin(t)
            if not norm or set(norm) <= {"#"}:
                continue  # 纯数字行（代码行号/页码）不参与页眉页脚判定
            if norm not in seen:
                counter[norm] += 1
                seen.add(norm)
    return {t for t, c in counter.items() if c >= max(2, page_count * 0.5)}


_CODE_LINE_RE = re.compile(r"(?m)^\s*\d{2,3}\s")


def _ends_in_code(text: str) -> bool:
    """块尾最后一个内容行是否仍是代码行（fitz 文本的代码行带 `NN ` 行号前缀）。"""
    for line in reversed(text.rstrip().splitlines()):
        s = line.strip()
        if not s or s.startswith(("[本页附图", "=====")):
            continue
        return bool(_CODE_LINE_RE.match(line))
    return False


def split_doc_text(text: str, max_chars: int = 16000) -> list[str]:
    """按页标记切块；块尾仍在代码中（围栏未闭合或末行是代码行）时并入下一页。

    分块边界切进程序中间会导致：代码截断 + 同一批子问被两个块各抽一遍。
    """
    segments = [s for s in re.split(r"(?=^===== 第 \d+ 页 =====)", text,
                                    flags=re.MULTILINE) if s.strip()]
    chunks: list[str] = []
    cur = ""
    for seg in segments:
        if cur and len(cur) + len(seg) > max_chars:
            in_code = cur.count("```") % 2 == 1 or _ends_in_code(cur)
            if in_code and len(cur) < max_chars * 2:  # 安全上限，防止无限并块
                cur += "\n\n" + seg
                continue
            chunks.append(cur)
            cur = seg
        else:
            cur = f"{cur}\n\n{seg}" if cur else seg
    if cur:
        chunks.append(cur)
    return chunks


def _first_page(chunk: str) -> int | None:
    m = _PAGE_MARK_RE.search(chunk)
    return int(m.group(1)) if m else None


def extract_document_vision(client, rules: str, pages: dict[int, Path], figs: list[dict],
                            max_tokens: int = 32000) -> list[dict]:
    """整篇页面图像一次调用：全局编号画框 → 模型写 `[[box:n]]` → 按 question.page 分桶。"""
    from PIL import Image

    from pdf_tool.extract.vision_extract import draw_numbered, parse_page_result

    by_page: dict[int, list[dict]] = {}
    for f in figs:
        by_page.setdefault(f["page"], []).append(f)
    images = []
    for pno in sorted(pages):
        with Image.open(pages[pno]) as im:
            img = im.convert("RGB").copy()
        boxes = [(f["n"], tuple(int(v) for v in f["rect2x"]))
                 for f in by_page.get(pno, []) if f.get("rect2x")]
        labeled, _ = draw_numbered(img, boxes)
        images.append(labeled)
    prompt = f"{rules}\n\n# 试卷共 {len(pages)} 页，按页序附上。"
    raw, _usage = client.extract_json(prompt, images, tag="doc_vision",
                                      max_tokens=max_tokens, retries=2,
                                      required_keys=("questions",))
    parsed = parse_page_result(raw, {f["n"]: f["n"] for f in figs})

    fig_page = {f["n"]: f["page"] for f in figs}
    results: list[dict] = []
    for i, q in enumerate(parsed["questions"]):
        page = q.get("page")
        results.append({"page": page if isinstance(page, int) else None,
                        "questions": [q], "unattributed": [], "warnings": [],
                        "categories": parsed.get("categories", []) if i == 0 else [],
                        "exam_info": parsed.get("exam_info", {}) if i == 0 else {},
                        "notes": parsed.get("notes", []) if i == 0 else []})
    if not results:
        results = [{"page": None, "questions": [], "unattributed": [], "warnings": [],
                    "categories": parsed.get("categories", []),
                    "exam_info": parsed.get("exam_info", {}),
                    "notes": parsed.get("notes", [])}]
    for n in parsed.get("unattributed", []):
        target = next((r for r in results if r["page"] == fig_page.get(n)), results[0])
        target["unattributed"].append(n)
    return results


def extract_document(client, rules: str, doc_text: str, fig_ns: set[int],
                     max_chars: int = 16000, max_tokens: int = 32000) -> list[dict]:
    """分块调用文本模型；每块结果按 vision 页结果形状解析（占位号为全局图号）。"""
    from pdf_tool.extract.vision_extract import parse_page_result

    chunks = split_doc_text(doc_text, max_chars=max_chars)
    local_map = {n: n for n in fig_ns}
    results: list[dict] = []
    for i, chunk in enumerate(chunks, 1):
        prompt = f"{rules}\n\n# 试卷文本（第 {i}/{len(chunks)} 段）\n\n{chunk}"
        raw, _usage = client.extract_json(prompt, [], tag=f"doc_{i:02d}",
                                          max_tokens=max_tokens, retries=2,
                                          required_keys=("questions",))
        parsed = parse_page_result(raw, local_map)
        results.append({"page": _first_page(chunk), **parsed})
    return results

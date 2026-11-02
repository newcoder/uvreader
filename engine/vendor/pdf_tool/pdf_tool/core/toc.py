"""目录/索引条目的纯解析与层级推断（MinerU `index` 块、文本目录共用）。

本模块只做字符串处理，不依赖 MinerU / PyMuPDF，便于单测：

- `parse_index_item()`：解析 MinerU v1 的 `list_items` 字符串（可带缩进、
  `-` 列表符号、Markdown 内链）或 v2 的 span/dict，得到 `{title, page, indent}`；
- `infer_levels()`：对**一整组**连续目录条目做层级推断。跨页目录必须把各页
  条目拼起来再推断，否则每页第一条小节会被误判成一级；
- `classify_index_groups()`：把 `index` 块按页分组，选书前第一组为目录，
  书末字母索引/无法区分时不标目录。

页码语义：`page` 为印刷页码；罗马/中文数字或解析失败时为 0（保留条目）。
`level` 为 1–4 的整数。
"""
from __future__ import annotations

import html
import itertools
import re

MAX_LEVEL = 4

# 行首缩进 + 可选列表符号（MinerU v1 用 4 空格 * depth + "- "）
_BULLET_RE = re.compile(r"^(?P<indent>[ \t]*)(?:[-*•·▪◦‣]\s+)?(?P<body>.*)$")

# 标题 + 点线/tab/连续空格 + 页码（1–4 位，可带范围；罗马/中文数字也接住）
_INDEX_PAGE_RE = re.compile(
    r"^(?P<title>.*?)\s*"
    r"(?P<lead>[.．·•・…‥⋯]{2,}|[ \t]{2,}|　{2,}|\t+)\s*"
    r"(?P<page>(?:\d{1,4}(?:\s*[-–—－~至]\s*\d{1,4})?"
    r"|[ivxlcdmIVXLCDM]+|[一二三四五六七八九十百零〇]+))"
    r"[.．。]?\s*$",
)

_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*|__([^_]+)__")
_CODE_SPAN_RE = re.compile(r"`([^`]+)`")

_PART_RE = re.compile(r"^第\s*[一二三四五六七八九十百零〇\d]+\s*(?:部分|编|篇|部|卷)")
_CHAPTER_RE = re.compile(r"^第\s*[一二三四五六七八九十百零〇\d]+\s*(?:章|回)")
_SECTION_RE = re.compile(r"^第\s*[一二三四五六七八九十百零〇\d]+\s*节")
_NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)*)[.、\s]")
_APPENDIX_RE = re.compile(r"^附[录錄](?:\s|$|[：:])")
_APPENDIX_SUB_RE = re.compile(
    r"^附[录錄]\s*(?:[一二三四五六七八九十百零〇\d]+|[A-Za-z])"
    r"(?:\s|$|[：:．.、])")
_FRONT_MATTER_RE = re.compile(
    r"^(?:第\s*[一二三四五六七八九十百零〇\d]+\s*版)?\s*"
    r"(?:前言|序言|序|致谢|出版说明|译者序|译者的话|内容简介|作者简介|"
    r"参考书目|参考文献|索引|后记|跋|结语|导论|绪论|引言)"
    r"(?:\s|$|[：:（(])")

# 英文目录（避免 "Chapter 1" 被书末索引启发式误判）
_EN_PART_RE = re.compile(r"^(?:part|book)\s+[IVXLCDM\d]+", re.IGNORECASE)
_EN_CHAPTER_RE = re.compile(r"^(?:chapter|chap\.?)\s+[IVXLCDM\d]+", re.IGNORECASE)
_EN_SECTION_RE = re.compile(r"^(?:section|§)\s*[IVXLCDM\d]+", re.IGNORECASE)
_EN_FRONT_RE = re.compile(
    r"^(?:preface|foreword|acknowledg(?:e?ments?)?|contents|"
    r"list of (?:figures|tables)|bibliography|references|index|appendix)\b",
    re.IGNORECASE)


def _span_text(value) -> str:
    """把 MinerU v2 的 span / list / dict 统一成文本。"""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(_span_text(x) for x in value)
    if isinstance(value, dict):
        for key in ("content", "text", "item_content"):
            if key in value:
                return _span_text(value[key])
        if isinstance(value.get("children"), list):
            return "".join(_span_text(x) for x in value["children"])
    return ""


def index_item_text(item) -> str:
    """MinerU v1 字符串 / v2 `item_content` span → 原始一行文本。"""
    return _span_text(item)


def _clean_title(text: str) -> str:
    """去 Markdown 内链/粗体/行内代码，压缩空白；保留章节编号与公式。"""
    text = html.unescape(str(text or ""))
    text = _LINK_RE.sub(r"\1", text)
    text = _BOLD_RE.sub(lambda m: m.group(1) or m.group(2) or "", text)
    text = _CODE_SPAN_RE.sub(r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def _page_number(token: str) -> int:
    """`12` / `12–15` → 12；罗马/中文数字/异常 → 0。"""
    token = str(token or "").strip().rstrip(".．。")
    m = re.match(r"^(\d{1,4})", token)
    return int(m.group(1)) if m else 0


def _title_ok(title: str) -> bool:
    """过滤空行、纯页码行、纯点线行。"""
    if not title:
        return False
    return not re.fullmatch(r"[\d\s.．·•・…‥⋯\-–—]+", title)


def parse_index_item(raw) -> dict | None:
    """解析一条目录项 → `{title, page, indent}`；不像目录项返回 None。

    - v1：`"    - 第一章 内务府 …… 1"`；
    - v2：`{"item_type": "text", "item_content": [{"type": "text", "content": "..."}]}`；
    - 无页码时 `page=0`，条目保留；
    - `indent` 为行首缩进（tab 按 4 列展开），供层级推断。
    """
    text = index_item_text(raw)
    if not str(text).strip():
        return None
    lines = [ln for ln in str(text).splitlines() if ln.strip()]
    if not lines:
        return None
    first = lines[0]
    m = _BULLET_RE.match(first)
    if not m:
        return None
    indent = len(m.group("indent").expandtabs(4))
    body = "\n".join([m.group("body"), *lines[1:]])
    body = re.sub(r"\s*\n\s*", " ", body).strip()
    if not body:
        return None

    pm = _INDEX_PAGE_RE.match(body)
    if pm:
        title = _clean_title(pm.group("title"))
        page = _page_number(pm.group("page"))
    else:
        title = _clean_title(body)
        page = 0
    if not _title_ok(title):
        return None
    return {"title": title, "page": page, "indent": indent}


def _number_depth(title: str) -> int:
    m = _NUMBER_RE.match(title)
    if not m:
        return 1
    return min(MAX_LEVEL, m.group(1).count(".") + 1)


def _is_numbered(title: str) -> bool:
    return bool(_PART_RE.match(title) or _CHAPTER_RE.match(title)
                or _SECTION_RE.match(title) or _NUMBER_RE.match(title)
                or _APPENDIX_RE.match(title) or _APPENDIX_SUB_RE.match(title)
                or _FRONT_MATTER_RE.match(title)
                or _EN_PART_RE.match(title) or _EN_CHAPTER_RE.match(title)
                or _EN_SECTION_RE.match(title) or _EN_FRONT_RE.match(title))


def _infer_levels_by_numbering(entries: list[dict]) -> None:
    """按编号/上下文推断层级（整组连续调用）。"""
    part_seen = False
    appendix_parent = False
    section_base = 0
    prev_level = 0
    prev_kind = ""

    for e in entries:
        title = str(e.get("title") or "").strip()
        level, kind = 1, "other"
        if _PART_RE.match(title):
            level, kind = 1, "part"
            part_seen = True
            section_base = 1
        elif _CHAPTER_RE.match(title):
            level, kind = (2 if part_seen else 1), "chapter"
            section_base = level
        elif _SECTION_RE.match(title) or _EN_SECTION_RE.match(title):
            # 同一章下的多个小节要同层：用章级基准，而不是上一条的 level
            level = min(MAX_LEVEL, max(2, (section_base or 1) + 1))
            kind = "section"
        elif _EN_PART_RE.match(title):
            level, kind = 1, "part"
            part_seen = True
            section_base = 1
        elif _EN_CHAPTER_RE.match(title):
            level, kind = (2 if part_seen else 1), "chapter"
            section_base = level
        elif _EN_FRONT_RE.match(title):
            level, kind = 1, "front"
        elif _APPENDIX_RE.match(title):
            level, kind = 1, "appendix"
            appendix_parent = True
        elif _APPENDIX_SUB_RE.match(title):
            level, kind = (2 if appendix_parent else 1), "appendix-sub"
        elif _NUMBER_RE.match(title):
            level, kind = _number_depth(title), "number"
        elif _FRONT_MATTER_RE.match(title):
            level, kind = 1, "front"
        elif prev_kind in ("part", "chapter") and len(title) <= 40:
            # 章级条目之后、没有编号的短条目 → 2（不是 1）
            level, kind = 2, "other"
        elif prev_level >= 2:
            # 不往上猜 3/4 级；沿用上一层
            level, kind = prev_level, "other"
        else:
            level, kind = 1, "other"
        e["level"] = min(MAX_LEVEL, max(1, int(level)))
        prev_level, prev_kind = e["level"], kind


def infer_levels(entries: list[dict]) -> list[dict]:
    """原地补齐 `level`；MinerU 缩进优先，否则按编号/上下文。

    注意：必须传入**整个目录组**的条目（跨页拼接），不能逐页调用。
    """
    entries = [e for e in entries if isinstance(e, dict)]
    if not entries:
        return entries

    indents = [int(e.get("indent") or 0) for e in entries]
    positive = [v for v in indents if v > 0]
    if positive and max(indents) > min(indents):  # 所有条目同缩进 = 没有层级信息
        base = min(indents)
        unit = max(1, min(positive))
        for e, ind in zip(entries, indents, strict=False):
            depth = max(0, (ind - base) // unit)
            e["level"] = min(MAX_LEVEL, depth + 1)
        return entries

    _infer_levels_by_numbering(entries)
    return entries


def normalize_entries(entries) -> list[dict]:
    """把内部条目收敛成 Doc 契约 `{title, page, level}`（去 indent 等临时字段）。"""
    out: list[dict] = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        title = str(e.get("title") or "").strip()
        if not title:
            continue
        try:
            page = int(e.get("page") or 0)
        except (TypeError, ValueError):
            page = 0
        try:
            level = int(e.get("level") or 1)
        except (TypeError, ValueError):
            level = 1
        out.append({"title": title, "page": page,
                    "level": min(MAX_LEVEL, max(1, level))})
    return out


def toc_signal_ratio(entries: list[dict]) -> float:
    """条目里带章节/编号/附录/前言等目录特征的比例。"""
    items = [e for e in entries if e.get("title")]
    if not items:
        return 0.0
    hits = sum(1 for e in items if _is_numbered(str(e["title"])))
    return hits / len(items)


def looks_like_back_index(entries: list[dict], total_pages: int = 0) -> bool:
    """书末字母索引特征：A–Z 开头多、无章节编号、页码跨度大/非单调。"""
    items = [e for e in entries if e.get("title")]
    if not items:
        return False
    n = len(items)
    latin = sum(1 for e in items if re.match(r"^[A-Za-z]", str(e["title"]))) / n
    numbered = sum(1 for e in items if _is_numbered(str(e["title"]))) / n
    pages: list[int] = []
    for e in items:
        try:
            p = int(e.get("page") or 0)
        except (TypeError, ValueError):
            p = 0
        if p > 0:
            pages.append(p)
    span = (max(pages) - min(pages)) if len(pages) >= 2 else 0
    nonmono = any(b < a for a, b in itertools.pairwise(pages))
    big_span = span >= max(20, int(total_pages * 0.3)) if total_pages else span >= 50
    return latin >= 0.6 and numbered <= 0.2 and (big_span or nonmono)


def looks_like_figure_list(entries: list[dict]) -> bool:
    """图表目录（插图/表格索引）特征：条目以图/表编号开头，缺章节编号。"""
    items = [e for e in entries if e.get("title")]
    if not items:
        return False
    fig = sum(1 for e in items
              if re.match(r"^(?:图|表|figure|table)\s*[\d一二三四五六七八九十]",
                          str(e["title"]), re.IGNORECASE))
    return fig >= 0.6 * len(items) and toc_signal_ratio(entries) < 0.2


def group_index_blocks(blocks: list[dict]) -> list[dict]:
    """把 index 块按页分组：相邻页差 ≤2 视为同一组（容忍一张空白页）。"""
    ordered = sorted((b for b in blocks if isinstance(b, dict)),
                     key=lambda b: (int(b.get("page") or 0), int(b.get("idx") or 0)))
    groups: list[dict] = []
    for b in ordered:
        page = int(b.get("page") or 0)
        if groups and page - int(groups[-1]["end_page"]) <= 2:
            g = groups[-1]
            g["blocks"].append(b)
            g["end_page"] = max(int(g["end_page"]), page)
            g["entries"].extend(b.get("entries") or [])
        else:
            groups.append({"blocks": [b], "start_page": page, "end_page": page,
                           "entries": list(b.get("entries") or [])})
    return groups


def classify_index_groups(blocks: list[dict], total_pages: int = 0) -> list[dict]:
    """标注每组是否为目录：只取书前第一组，且要排除书末字母索引。

    返回的 group 带 `is_toc`；后续组一律 false（书末索引/图表目录不污染导航）。
    """
    groups = group_index_blocks(blocks)
    if not groups:
        return groups
    total = max(0, int(total_pages or 0))
    front_limit = max(12, int(total * 0.25)) if total else 12
    if total:  # 小文档不能把最后一页也当前部（书末索引会在末页）
        front_limit = min(front_limit, max(2, int(total * 0.5)))
        front_limit = min(front_limit, max(1, total - 1))
    first = groups[0]
    entries = first.get("entries") or []
    start_page = int(first.get("start_page") or 0)
    # 内容启发式只用于后半部分；书前第一组优先按目录处理（英文 TOC 常无「Chapter」）
    back = (start_page > total * 0.5 if total else True) \
        and looks_like_back_index(entries, total)
    figure_list = looks_like_figure_list(entries)
    strong = toc_signal_ratio(entries) >= 0.2
    in_front = start_page <= front_limit
    mid = bool(total) and start_page <= total * 0.5
    is_toc = (bool(entries) and not back and not figure_list
              and (in_front or (mid and strong)))
    for i, g in enumerate(groups):
        g["is_toc"] = bool(is_toc and i == 0)
    return groups

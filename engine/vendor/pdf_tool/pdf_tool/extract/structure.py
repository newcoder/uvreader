"""结构信息补全（Doc 层）：目录页（`page_role`/`toc_entries`）与跨页续行（`continuation`）。

对应 reader 需求 `reader-request-structure-2026-10-14.md` §1/§2/§3：
- **只做「要看页面才知道的」判断**：目录页的版式特征（条目行密度 + 点线 + 页码单调）
  与页边界（上一页最后一个正文块未收句 + 本页第一个正文块是文字）在这里完成；
  书级策略（导航来源、去重、校验、打包）留给 reader；
- **保守优先**：宁可漏判（reader 侧有兜底），不可误判（假标题进目录 / 错误合并）。

产出（就地写进 Doc）：
- `doc["pages"][i]["page_role"] = "toc"`、`["toc_entries"] = [{title, page, level}]`
  （`page` 为**印刷页码**，原样取目录行尾的数字）；
- 续行块的 `{"continuation": true}`（仅 `type == "text"` 的块，且为本页第一个正文块）。

`annotate_doc()` 返回统计：`{"toc_pages": [...], "toc_entries": N, "continuations": N}`。
"""
from __future__ import annotations

import itertools
import logging
import re

log = logging.getLogger("qb.structure")

# 目录条目行：标题 + 点线（或 ≥2 空格）+ 印刷页码
_TOC_LINE_RE = re.compile(
    r"^(?P<title>.+?)\s*(?P<lead>[.．·•・…‥⋯]{2,}| {2,}|　{2,})\s*(?P<page>\d{1,4})\s*$")

# 层级：第X章/篇/部 → 1，第X节 → 2；1.2.3 → 3；一、 → 1；其余沿用上一条
_LEVEL_CHAPTER_RE = re.compile(r"^第\s*[一二三四五六七八九十百零〇\d]+\s*([章篇部节])")
_LEVEL_NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)*)[.、\s]")
_LEVEL_CN_RE = re.compile(r"^[一二三四五六七八九十]+、")

# 句子收尾标点：出现即视为「已收句」，不是续行
_TERMINAL = "。．.!！?？;；:：)]）》」』】\"”’…"

# 像标题/编号的行（本页首块若像标题，不判为续行——reader 的已知误伤：译者序/目录/…）
_HEADING_LIKE_RE = re.compile(
    r"^(?:第\s*[一二三四五六七八九十百零〇\d]+\s*[章篇部节]|"
    r"\d+(?:\.\d+)*[.、\s]|[一二三四五六七八九十]+、)")

# 页首「新块」标记：题号 / 选项 / Markdown 标题 / 页标记——不能当上一页的续行
# （reader 2026-10-21：CSP2020 q5 以 `5）` 开头却被标 continuation）
_NEW_BLOCK_START_RE = re.compile(
    r"^\s*(?:\d{1,3}\s*[.、．)）]\s*\S|"
    r"[A-H]\s*[.、．)）]\s*\S|"
    r"#{1,6}\s|"
    r"<!--\s*page[:：])")

# 正文块类型（判断页边界时忽略页眉/页脚/页码等家具）
_BODY_TYPES = ("text", "heading", "code", "table", "image", "equation", "page_footnote")

_SHORT = 15  # 短文本且未收句 → 更像标题，不判续行

# 页首「被截断的半句」被 MinerU 误标成标题时的线索（reader R2）：
# 短、非标签式标题、与印刷目录对不上，且「以句末标点结尾」或「以续接虚词开头」
_CONT_PARTICLES = tuple("的地得了也而并但则就又还却且或把被使让令由给")
_SHORT_HEADING = 24

# 被拆开的标题（reader P1-b）：标题只剩「第 / 第1 / 第1章」这类残缺部分，
# 完整标题的其余文字跑到了下一块的首行
_INCOMPLETE_TITLE_RE = re.compile(r"^第\s*[\d一二三四五六七八九十百零〇]{0,3}\s*[章节篇部]?$")
_TITLE_TAIL_RE = re.compile(r"^\d+\.\d")            # 1.2 …（小节号，不是标题续行）
_TITLE_REJECT_RE = re.compile(r"^(?:图|表|式|例|注)\s*\d|^\d+[.、]\s")

# 前置页角色（reader R4）：版权页关键词（收窄到强特征，避免作者简介页误判）
_FRONT_COPYRIGHT_RE = re.compile(
    r"图书在版编目|CIP\s*数据|ISBN\s*[\d-]|版权所有|定价[:：]?\s*\d|开本[:：]?\s*\d")


def _detect_front_roles(pages, toc_pages, stats) -> None:
    """前置页角色：cover / copyright / title / frontmatter（reader R4，保守）。

    - 判定范围只到「正文起点」：首个 `printed_page==1` 的页（P2 插值后）；否则目录页之前；
      都拿不到时只看前 6 页（只做 cover/copyright/title 的强规则，不标 frontmatter）；
    - cover：第 1 页且文字很少；copyright：CIP/ISBN/定价等关键词；title：文字很短的书名页；
      frontmatter：范围内其余有内容的页（译者序/序/前言等）；
    - 已有角色（如 `toc`）的页不覆盖。
    """
    if not pages:
        return
    body = next((pg.get("page") for pg in pages if pg.get("printed_page") == 1), None)
    limit = min(toc_pages) if toc_pages else body  # 目录页之前即前置区（目录常是前置的最后一页）
    if limit:
        front = [pg for pg in pages if pg.get("page") < limit]
    else:
        front = [pg for pg in pages if pg.get("page") <= 6]
    counts = stats.setdefault("page_roles", {})
    for pg in front:
        if pg.get("page_role"):
            continue
        text = "\n".join(str(b.get("text") or "") for b in (pg.get("blocks") or [])
                         if b.get("type") in ("text", "heading")).strip()
        role = None
        if pg.get("page") == 1 and len(text) < 120:
            role = "cover"
        elif _FRONT_COPYRIGHT_RE.search(text):
            role = "copyright"
        elif text and len(text) < 80:
            role = "title"
        elif text and limit:
            role = "frontmatter"
        if role:
            pg["page_role"] = role
            counts[role] = counts.get(role, 0) + 1


def _title_tail(text) -> str | None:
    """下一块首行若是「标题的续行」返回该行（清理后），否则 None。"""
    lines = str(text or "").splitlines()
    first = lines[0].strip() if lines else ""
    if not first or len(first) > 32:
        return None
    if _TITLE_TAIL_RE.match(first) or _TITLE_REJECT_RE.match(first):
        return None
    if first[-1] in "。！？;；":
        return None
    return first


def _merge_split_titles(pages) -> int:
    """被拆开的标题行合并（残缺标题 + 紧随其后的行首）——reader P1-b。"""
    merged = 0
    for pg in pages:
        blocks = pg.get("blocks") or []
        i = 0
        while i < len(blocks) - 1:
            b, nxt = blocks[i], blocks[i + 1]
            if (b.get("type") == "heading"
                    and _INCOMPLETE_TITLE_RE.match(str(b.get("text") or "").strip())
                    and nxt.get("type") in ("text", "heading")):
                tail = _title_tail(nxt.get("text"))
                if tail:
                    head = str(b.get("text")).strip()
                    sep = "" if head[-1] in "第0123456789一二三四五六七八九十" else " "
                    b["text"] = (head + ("" if tail.startswith(" ") else sep) + tail).strip()
                    rest = "\n".join(str(nxt.get("text")).splitlines()[1:]).strip()
                    if rest:
                        nxt["text"] = rest
                    else:
                        blocks.pop(i + 1)
                    merged += 1
                    continue
            i += 1
    return merged


def _interpolate_printed(pages, known: dict) -> int:
    """按相邻页 (PDF 页 − 印刷页) 偏移补齐缺失的印刷页码（reader P2）。

    - 已知页之间的空洞：两侧偏移一致才补（跨前置页/正文重编号的断点不补）；
    - 前后延伸：仅当最近两个已知页偏移一致、延伸 ≤5 页且印刷页 ≥1；
    - 就地更新 `known`，返回补出的页数。
    """
    total = {int(pg.get("page") or 0) for pg in pages}
    vals: dict[int, int] = {}
    for k, v in (known or {}).items():
        try:
            vals[int(k)] = int(v)
        except (TypeError, ValueError):
            continue
    if not vals:
        return 0
    order = sorted(vals)
    filled = 0

    def _fill(p: int, printed: int) -> bool:
        nonlocal filled
        if p in vals or p not in total or printed < 1:
            return False
        vals[p] = printed
        filled += 1
        return True

    for a, b in itertools.pairwise(order):
        if b - a <= 1 or (a - vals[a]) != (b - vals[b]):
            continue
        offset = a - vals[a]
        for p in range(a + 1, b):
            _fill(p, p - offset)
    if len(order) >= 2:
        offset = order[0] - vals[order[0]]
        if order[1] - vals[order[1]] == offset:  # 左侧延伸（≤5 页、印刷页 ≥1）
            for p in range(order[0] - 1, max(order[0] - 6, 0), -1):
                if not _fill(p, p - offset):
                    break
        offset = order[-1] - vals[order[-1]]
        if order[-2] - vals[order[-2]] == offset:  # 右侧延伸（≤5 页）
            for p in range(order[-1] + 1, order[-1] + 6):
                if not _fill(p, p - offset):
                    break
    known.clear()
    known.update(vals)
    return filled


def _norm_title(text: str) -> str:
    """标题归一：去脚注标记（$^{①}$）、空白与标点，用于与目录条目比对。"""
    t = re.sub(r"\$?\^\{[^}]*\}\$?", "", str(text or ""))
    return re.sub(r"[\s\W_]+", "", t, flags=re.UNICODE)


def _heading_fragment(text: str, toc_titles: set[str]) -> bool:
    """页首标题是否「其实是被截断的正文」（只有 pdf_tool 这层能判断的一类）。"""
    t = str(text).strip()
    n = _norm_title(t)
    if not n or len(t) > _SHORT_HEADING:
        return False
    if _HEADING_LIKE_RE.match(t) or _TOC_LINE_RE.match(t):
        return False  # 标签式标题（第 N 章 / § / 1.2 / 一、）或目录行
    if n in toc_titles or any(m.startswith(n) for m in toc_titles if len(n) >= 4):
        return False  # 与印刷目录对得上 → 真标题
    if t[-1] in "。！？…":
        return True  # 短、带句末标点 → 更像半句
    return t[:1] in _CONT_PARTICLES  # 以续接虚词开头（的/得/了/也/而/并/但/…）


def _entry_level(title: str, prev: int) -> int:
    m = _LEVEL_CHAPTER_RE.match(title)
    if m:
        return 1 if m.group(1) in "章篇部" else 2
    m = _LEVEL_NUMBER_RE.match(title)
    if m:
        return min(4, m.group(1).count(".") + 1)
    if _LEVEL_CN_RE.match(title):
        return 1
    return prev or 1


def parse_toc_lines(lines) -> list[dict]:
    """一页的文本行 → 目录条目 `[{title, page, level}]`；不像目录则返回 []。

    保守判据：≥3 条、条目行占比 ≥50%、印刷页码不回退（都是实书验证过的特征）。
    """
    lines = [str(x) for x in lines]
    entries: list[dict] = []
    for ln in lines:
        m = _TOC_LINE_RE.match(ln.strip())
        if not m:
            continue
        title = m.group("title").strip()
        if len(title) < 2:
            continue
        entries.append({"title": title, "page": int(m.group("page"))})
    if len(entries) < 3 or len(entries) < 0.5 * max(1, len(lines)):
        return []
    nums = [e["page"] for e in entries]
    if any(b < a for a, b in itertools.pairwise(nums)):
        return []
    level = 0
    for e in entries:
        level = _entry_level(e["title"], level)
        e["level"] = level
    return entries


def _is_open_ended(text: str) -> bool:
    t = str(text).rstrip()
    return bool(t) and t[-1] not in _TERMINAL


def _fragment_ok(text: str) -> bool:
    """本页首块是否「像被截断的正文」（而不是标题/目录行）。"""
    t = str(text).strip()
    if not t or _HEADING_LIKE_RE.match(t) or _TOC_LINE_RE.match(t):
        return False
    # 短且未收句 → 更像标题（译者序/目录/前言…）；其余视为被截断的正文
    return not (len(t) < _SHORT and t[-1] not in _TERMINAL)


def _starts_new_block(text) -> bool:
    """页首是否题号/选项/标题/页标记开头——这些是明确的新块，不能接上一页。"""
    return bool(_NEW_BLOCK_START_RE.match(str(text or "").strip()))


# ---------------- 目录层级：几何（缩进/位置）优先 ----------------

def _fitz_lines(pdf, page_no: int) -> list[dict]:
    """文字层行（fitz）：[{text, x0, y0, x1, w}]；扫描页返回 []。"""
    import fitz

    doc = fitz.open(str(pdf))
    try:
        if not (1 <= int(page_no) <= doc.page_count):
            return []
        page = doc[int(page_no) - 1]
        w = float(page.rect.width)
        out: list[dict] = []
        for blk in page.get_text("dict").get("blocks") or []:
            for ln in blk.get("lines") or []:
                spans = ln.get("spans") or []
                text = "".join(s.get("text") or "" for s in spans).strip()
                if not text:
                    continue
                x0, y0, x1, _y1 = ln.get("bbox") or (0.0, 0.0, 0.0, 0.0)
                out.append({"text": text, "x0": float(x0), "y0": float(y0),
                            "x1": float(x1), "w": w})
        return out
    finally:
        doc.close()


def _ocr_lines(pdf, page_no: int, *, dpi: int = 200) -> list[dict]:
    """扫描页没有文字层：用本仓 OCR 后端取行框（不可用/失败返回 []）。"""
    try:
        import io

        import fitz
        import numpy as np
        from PIL import Image

        from pdf_tool.ocr.backends import make_backend

        doc = fitz.open(str(pdf))
        try:
            page = doc[int(page_no) - 1]
            pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72))
        finally:
            doc.close()
        img = np.array(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
        lines = make_backend("rapid").ocr(img)
        out: list[dict] = []
        for ln in lines:
            text = str(getattr(ln, "text", "") or "").strip()
            quad = getattr(ln, "quad", None) or []
            if not text or not quad:
                continue
            xs = [float(p[0]) for p in quad]
            ys = [float(p[1]) for p in quad]
            out.append({"text": text, "x0": min(xs), "y0": min(ys),
                        "x1": max(xs), "w": float(img.shape[1])})
        return out
    except Exception as e:
        log.info("[structure] 页 %s OCR 不可用（%s）：目录层级退回编号规则", page_no, e)
        return []


def make_line_provider(pdf):
    """返回 `(page_no) -> lines` 的几何行提供者：先文字层（fitz），再 OCR（扫描件）。"""
    def provider(page_no: int) -> list[dict]:
        lines = _fitz_lines(pdf, page_no)
        return lines or _ocr_lines(pdf, page_no)

    return provider


def _toc_candidates(lines) -> list[tuple]:
    """几何行 → [(title, page, x0)]（与 parse_toc_lines 同一行规则）。"""
    out: list[tuple] = []
    for ln in lines:
        m = _TOC_LINE_RE.match(str(ln.get("text") or "").strip())
        if not m:
            continue
        title = m.group("title").strip()
        if len(title) >= 2:
            out.append((title, int(m.group("page")), float(ln.get("x0") or 0.0)))
    return out


def _match_entries(entries, cand) -> list[float] | None:
    """条目 ↔ 几何候选行：顺序+页码一致直接映射；否则按页码一一对应；失败 None。"""
    if len(cand) == len(entries) and all(
            e["page"] == c[1] for e, c in zip(entries, cand, strict=False)):
        return [c[2] for c in cand]
    by_page: dict[int, list[float]] = {}
    for _t, page, x0 in cand:
        by_page.setdefault(page, []).append(x0)
    xs: list[float] = []
    for e in entries:
        v = by_page.get(e["page"])
        if not v:
            return None
        xs.append(v.pop(0))
    return xs


_PAGE_ONLY_RE = re.compile(r"^[^\d]{0,4}(\d{1,4})$")  # 纯页码行（OCR 常见：页码与标题分行）


def _page_rows(lines) -> dict[int, float]:
    """把「页码行」与同行左侧的「标题行」配对：{印刷页码: 标题行 x0}。

    扫描件的目录点线常让 OCR 把页码识别成独立一行（右对齐）；按 y0 邻近配对。
    """
    items = sorted((ln for ln in lines if str(ln.get("text") or "").strip()),
                   key=lambda x: (float(x.get("y0") or 0), float(x.get("x0") or 0)))
    ys = sorted({float(ln.get("y0") or 0) for ln in items})
    gaps = [b - a for a, b in itertools.pairwise(ys) if b > a]
    tol = (sorted(gaps)[len(gaps) // 2] * 0.6) if gaps else 12.0
    rows: dict[int, float] = {}
    for ln in items:
        m = _PAGE_ONLY_RE.match(str(ln.get("text") or "").strip())
        if not m:
            continue
        page, x_num = int(m.group(1)), float(ln.get("x0") or 0)
        best = None
        for other in items:
            if other is ln:
                continue
            ot = str(other.get("text") or "").strip()
            if not ot or re.fullmatch(r"[\d.．·•・…‥⋯]+", ot):
                continue
            if float(other.get("x0") or 0) >= x_num:
                continue
            gap = abs(float(other.get("y0") or 0) - float(ln.get("y0") or 0))
            if gap <= tol and (best is None or gap < best[0]):
                best = (gap, float(other.get("x0") or 0))
        if best is not None:
            rows.setdefault(page, best[1])
    return rows


def _match_entries_by_page(entries, lines) -> list[float | None] | None:
    """按印刷页码配对标题行；匹配不足 60% 返回 None；未匹配条目给 None（保留编号层级）。"""
    rows = _page_rows(lines)
    if not rows:
        return None
    xs: list[float | None] = [rows.get(e["page"]) for e in entries]
    if sum(1 for x in xs if x is not None) < max(2, int(len(entries) * 0.6)):
        return None
    return xs


def levels_from_geometry(entries, lines) -> bool:
    """按**缩进/位置**（x0 聚类）给 entries 赋 level；数据不足返回 False（不改动）。

    两级匹配：① 整行条目（文字层 / 单行目录）→ 行内页码；
    ② 页码独立成行（扫描件 OCR 常见）→ 同 y0 配对标题行；未匹配的条目保留编号层级。
    容差 = 页宽的 0.5%（下限 3 单位）；x0 越小层级越高；最多 4 级。
    reader 2026-10-14 Q1：层级用目录页缩进判断，编号只作兜底。
    """
    cand = _toc_candidates(lines)
    xs: list[float | None] | None = _match_entries(entries, cand) if cand else None
    if xs is None:
        xs = _match_entries_by_page(entries, lines)
    if xs is None or all(x is None for x in xs):
        return False
    width = float((lines[0] or {}).get("w") or 0.0) if lines else 0.0
    tol = max(3.0, width * 0.005)
    values = [x for x in xs if x is not None]
    clusters: list[list[float]] = []
    for x in sorted(set(values)):
        if clusters and x - clusters[-1][-1] <= tol:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    centers = [sum(c) / len(c) for c in clusters]
    for e, x in zip(entries, xs, strict=False):
        if x is None:
            continue  # 未匹配到几何行：保留编号层级
        idx = min(range(len(centers)), key=lambda i: abs(centers[i] - x))
        e["level"] = min(4, idx + 1)
    return True


def annotate_doc(doc: dict, *, line_provider=None, printed_pages: dict | None = None) -> dict:
    """就地给 Doc 补目录页 / 跨页续行 / 印刷页码；返回统计。

    line_provider：可选 `(page_no) -> [{text, x0, w}]`——目录层级优先按**缩进/位置**
    判断（reader 2026-10-14 Q1）；拿不到几何行时退回编号规则（页上记 `toc_level_source`）。
    printed_pages：可选 `{PDF 页号: 印刷页码}`（来自 MinerU 的 `page_number` 家具项，
    reader 2026-10-15 R1）——逐页写入 `page["printed_page"]`。
    """
    stats: dict = {"toc_pages": [], "toc_entries": 0, "continuations": 0,
                   "toc_levels": {"geometry": 0, "numbering": 0},
                   "printed_pages": 0, "printed_interpolated": 0,
                   "heading_demoted": 0, "titles_merged": 0, "page_roles": {}}
    pages = doc.get("pages") or []

    stats["titles_merged"] = _merge_split_titles(pages)  # P1-b：拆开的标题行合并

    if printed_pages:  # R1：印刷页码（页码家具已识别）；P2：相邻页偏移插值补齐
        stats["printed_interpolated"] = _interpolate_printed(pages, printed_pages)
        for pg in pages:
            v = printed_pages.get(pg.get("page"))
            if v:
                pg["printed_page"] = int(v)
        stats["printed_pages"] = sum(1 for pg in pages
                                     if pg.get("printed_page") is not None)

    for pg in pages:  # ① 目录页
        lines = [ln for b in (pg.get("blocks") or [])
                 if b.get("type") in ("text", "heading")
                 for ln in str(b.get("text") or "").splitlines() if ln.strip()]
        entries = parse_toc_lines(lines) if lines else []
        if not entries:
            continue
        source = "numbering"
        if line_provider is not None:
            try:
                geo = line_provider(pg.get("page") or 0) or []
            except Exception as e:
                log.warning("[structure] 目录页 %s 几何行获取失败：%s", pg.get("page"), e)
                geo = []
            if geo and levels_from_geometry(entries, geo):
                source = "geometry"
        pg["page_role"] = "toc"
        pg["toc_entries"] = entries
        pg["toc_level_source"] = source
        stats["toc_pages"].append(pg.get("page"))
        stats["toc_entries"] += len(entries)
        stats["toc_levels"][source] += 1

    _detect_front_roles(pages, stats["toc_pages"], stats)  # R4：前置页角色

    toc_titles = {_norm_title(e["title"]) for pg in pages
                  for e in (pg.get("toc_entries") or [])}
    prev_page, prev_last = None, None  # ② 跨页续行（页边界判断）
    for pg in pages:
        body = [b for b in (pg.get("blocks") or []) if b.get("type") in _BODY_TYPES
                and (b.get("type") != "text" or str(b.get("text") or "").strip())]
        cur = body[0] if body else None
        if cur is not None and _starts_new_block(cur.get("text")):
            cur.pop("continuation", None)  # 重复 annotate 时清掉旧标记
        if (cur is not None and prev_last is not None
                and pg.get("page") == (prev_page or 0) + 1
                and prev_last.get("type") == "text"
                and _is_open_ended(prev_last.get("text"))
                and not _starts_new_block(cur.get("text"))):
            if cur.get("type") == "text" and _fragment_ok(cur.get("text")):
                cur["continuation"] = True
                stats["continuations"] += 1
            elif cur.get("type") == "heading" and _heading_fragment(
                    cur.get("text"), toc_titles):
                # MinerU 把页首截断半句误标成标题：降级为正文 + 续行标记（reader R2）
                cur["type"] = "text"
                cur.pop("level", None)
                cur["continuation"] = True
                stats["continuations"] += 1
                stats["heading_demoted"] += 1
        if body:
            prev_page, prev_last = pg.get("page"), body[-1]

    return stats

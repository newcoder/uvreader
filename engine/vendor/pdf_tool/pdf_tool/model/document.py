"""规范文档模型 v1：blocks（现有抽取产物）↔ Doc（页/块/稳定 ID，版本化契约）。

Doc 结构（对外契约，`schema_version` 变更才不兼容）::

    {"schema_version": 1,
     "source": {"path": ..., "fingerprint": ..., "pages": N, "engine": ...},
     "pages": [{"page": 12, "blocks": [
         {"id": "p12-b3", "type": "table", "page": 12, "headers": [...], ...}]}]}

现有抽取产物是扁平的 `{"blocks": [{"type", "position": "Page N", ...}]}`，
`blocks_to_doc` / `doc_to_blocks` 在两种形态间无损转换（ID/页码为新增字段）。
"""
from __future__ import annotations

import re
from collections import Counter

SCHEMA_VERSION = 1

_PAGE_RE = re.compile(r"(?i)page\s*(\d+)")


def page_of(position) -> int:
    """`Page 12` / `12` → 12；取不到返回 0（未知页）。"""
    text = str(position or "")
    m = _PAGE_RE.search(text) or re.search(r"(\d+)", text)
    return int(m.group(1)) if m else 0


def block_id(page: int, index: int) -> str:
    return f"p{page}-b{index}"


def blocks_to_doc(blocks, *, source: dict | None = None,
                  page_count: int | None = None) -> dict:
    """扁平 blocks → 规范 Doc：按页分组、补 `id`/`page`、块内保持原顺序。

    page_count：源 PDF 总页数；给出时为缺块页补空页（`pages` 与源文档对齐，
    便于核对页数并让审计的空页告警有意义）。
    """
    pages: dict[int, list[dict]] = {}
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        item = {k: v for k, v in b.items() if k != "position"}
        pages.setdefault(page_of(b.get("position")), []).append(item)
    if page_count and pages and max(pages) < page_count:
        for page in range(max(pages) + 1, page_count + 1):
            pages[page] = []
    out_pages = []
    for page in sorted(pages):
        items = pages[page]
        for i, item in enumerate(items, 1):
            item["id"] = item.get("id") or block_id(page, i)
            item["page"] = page
        out_pages.append({"page": page, "blocks": items})
    return {"schema_version": SCHEMA_VERSION, "source": dict(source or {}),
            "pages": out_pages}


def doc_to_blocks(doc: dict) -> list[dict]:
    """规范 Doc → 扁平 blocks（补回 `position`，供渲染/导出复用）。"""
    out: list[dict] = []
    for pg in doc.get("pages") or []:
        for b in pg.get("blocks") or []:
            item = dict(b)
            item["position"] = f"Page {pg.get('page')}"
            item.pop("page", None)
            out.append(item)
    return out


def iter_blocks(doc: dict):
    """逐 (页号, 块) 产出（阅读顺序）。"""
    for pg in doc.get("pages") or []:
        for b in pg.get("blocks") or []:
            yield pg.get("page"), b


def select_pages(doc: dict, pages) -> dict:
    """保留指定页（1-based 列表），其余原样。"""
    keep = {int(p) for p in pages}
    return {**doc, "pages": [pg for pg in doc.get("pages") or [] if pg.get("page") in keep]}


def doc_stats(doc: dict) -> dict:
    counter: Counter = Counter(b.get("type") for _, b in iter_blocks(doc))
    return {"pages": len(doc.get("pages") or []), "blocks": sum(counter.values()),
            "by_type": dict(sorted(counter.items(), key=lambda kv: str(kv[0])))}

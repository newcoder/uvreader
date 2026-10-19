"""DOCX → Doc v1 blocks + 图片资产（按文档顺序，供题目文本抽取）。

- 段落：Heading → heading；`HTML Preformatted`/等宽字体 → code（相邻合并）；其余 text；
- 表格：`w:tbl` → table（首行作表头）；
- 图片：`a:blip` 按原位置内联为 `[IMG_n]` 锚点，资产落 `assets/imgs/`；
- 输出：blocks（position=伪页）、figs（n/page/rel/file）、doc_text（带页标记与附图清单，
  直接喂 `text_extract.md` 文本抽取）。
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

log = logging.getLogger("pdf_tool.ingest.docx")

_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_CODE_STYLE_HINTS = ("html preformatted", "preformatted", "code", "sourcecode",
                     "macro text", "代码", "程序")
_MONO_FONT_HINTS = ("consolas", "courier", "mono", "menlo", "source code", "fira")
_HEADING_RE = re.compile(r"^(?:heading|标题)\s*([1-6])", re.IGNORECASE)


def _xpath(el, path: str) -> list:
    return el.xpath(path)  # python-docx ???? nsmap


def _style_name(p_el) -> str:
    vals = _xpath(p_el, "w:pPr/w:pStyle/@w:val")
    return str(vals[0]) if vals else ""


def _is_code_paragraph(p_el) -> bool:
    if any(h in _style_name(p_el).lower() for h in _CODE_STYLE_HINTS):
        return True
    fonts = [str(f).lower() for f in _xpath(p_el, ".//w:rFonts/@w:ascii")
             + _xpath(p_el, ".//w:rFonts/@w:hAnsi")]
    return any(any(h in f for h in _MONO_FONT_HINTS) for f in fonts)


def _heading_level(p_el) -> int | None:
    m = _HEADING_RE.match(_style_name(p_el).strip())
    return int(m.group(1)) if m else None


def _paragraph_items(p_el):
    """按文档顺序取段落内容：[(kind, value)]，kind ∈ text/img/nl。"""
    items: list[tuple[str, str]] = []
    for node in p_el.iter():
        tag = node.tag
        if tag.endswith("}t") and node.text:
            items.append(("text", node.text))
        elif tag.endswith(("}br", "}cr")):
            items.append(("nl", "\n"))
        elif tag.endswith("}tab"):
            items.append(("text", "    "))
        elif tag.endswith("}blip"):
            rid = node.get("{" + _R_NS + "}embed")
            if rid:
                items.append(("img", rid))
    return items


def _save_image(doc, rid: str, assets_dir: Path, n: int, out_root: Path):
    """保存 rel 指向的图片，返回 (path, rel) 或 None。"""
    part = doc.part.related_parts.get(rid)
    if part is None:
        return None
    ext = Path(str(part.partname)).suffix.lower() or ".png"
    if ext in (".emf", ".wmf"):  # 浏览器/viewer 不能显示，跳过并告警
        log.warning("跳过 EMF/WMF 图片（不支持预览）: %s", part.partname)
        return None
    dest = assets_dir / f"IMG_{n:03d}{ext}"
    dest.write_bytes(part.blob)
    return dest, dest.relative_to(out_root).as_posix()


def _cell_text(tc_el) -> str:
    lines = []
    for p in _xpath(tc_el, "w:p"):
        txt = "".join(t for k, t in _paragraph_items(p) if k == "text")
        if txt.strip():
            lines.append(txt.strip())
    return " ".join(lines)


def _table_block(tbl_el) -> dict:
    rows = []
    for tr in _xpath(tbl_el, "w:tr"):
        cells = [_cell_text(tc) for tc in _xpath(tr, "w:tc")]
        if any(c.strip() for c in cells):
            rows.append(cells)
    if not rows:
        return {"type": "text", "text": ""}
    return {"type": "table", "headers": rows[0], "rows": rows[1:]}


def to_blocks(docx_path: Path, out_dir: Path, out_root: Path) -> tuple[list[dict], list[dict]]:
    """DOCX → (blocks, figs)。blocks 的 position 先置 Page 1，由 paginate 重标。"""
    from docx import Document

    doc = Document(str(docx_path))
    assets_dir = out_dir / "assets" / "imgs"
    assets_dir.mkdir(parents=True, exist_ok=True)
    blocks: list[dict] = []
    figs: list[dict] = []
    n_img = 0
    pending_code: list[str] = []

    def flush_code() -> None:
        nonlocal pending_code
        if pending_code:
            blocks.append({"type": "code", "content": "\n".join(pending_code).rstrip()})
            pending_code = []

    for child in doc.element.body.iterchildren():
        tag = child.tag
        if tag.endswith("}p"):
            items = _paragraph_items(child)
            if _is_code_paragraph(child):
                text = "".join(t for k, t in items if k in ("text", "nl"))
                if text.strip():
                    pending_code.append(text.rstrip("\n"))
                continue
            flush_code()
            parts: list[str] = []
            for kind, value in items:
                if kind == "img":
                    n_img += 1
                    saved = _save_image(doc, value, assets_dir, n_img, out_root)
                    if saved is not None:
                        path, rel = saved
                        figs.append({"n": n_img, "page": 1, "key": path.name,
                                     "rel": rel, "file": path})
                        parts.append(f"[IMG_{n_img}]")
                    else:
                        n_img -= 1
                else:
                    parts.append(value)
            text = "".join(parts).strip()
            if not text:
                continue
            level = _heading_level(child)
            if level:
                blocks.append({"type": "heading", "level": level, "text": text})
            else:
                blocks.append({"type": "text", "text": text})
        elif tag.endswith("}tbl"):
            flush_code()
            block = _table_block(child)
            if block.get("headers") or str(block.get("text") or "").strip():
                blocks.append(block)
    flush_code()
    return blocks, figs


def paginate(blocks: list[dict], max_chars: int = 4000) -> list[list[dict]]:
    """把 blocks 编成伪页（供 text_extract 的页标记与分块）；代码块不拆。"""
    pages: list[list[dict]] = []
    cur: list[dict] = []
    size = 0
    for b in blocks:
        blen = len(b.get("text") or b.get("content") or "") + 20
        if cur and size + blen > max_chars and b.get("type") != "code":
            pages.append(cur)
            cur, size = [], 0
        cur.append(b)
        size += blen
    if cur:
        pages.append(cur)
    return pages or [[]]


def build_doc_text(blocks: list[dict], figs: list[dict],
                   max_chars: int = 4000) -> tuple[str, list[dict]]:
    """伪分页 → 带 `===== 第 N 页 =====`、`[IMG_n]` 锚点与附图清单的文本。"""
    pages = paginate(blocks, max_chars)
    for f in figs:  # ??? = ??????
        f["page"] = 1
    by_page: dict[int, list[int]] = {}
    for i, page_blocks in enumerate(pages, 1):
        for b in page_blocks:
            b["position"] = f"Page {i}"
            text = str(b.get("text") or "")
            for f in figs:
                if f"[IMG_{f['n']}]" in text:
                    f["page"] = i
        by_page.setdefault(i, [])
    for f in figs:
        by_page.setdefault(f["page"], []).append(f["n"])
    parts: list[str] = []
    for i, page_blocks in enumerate(pages, 1):
        body: list[str] = []
        for b in page_blocks:
            t = b.get("type")
            if t == "heading":
                body.append(str(b.get("text") or ""))
            elif t == "code":
                body.append(str(b.get("content") or ""))
            elif t == "table":  # 转 Markdown 表格（表头行 + 分隔行 + 数据行）
                head = [str(h) for h in b.get("headers") or []]
                lines = ["| " + " | ".join(head) + " |",
                         "| " + " | ".join("---" for _ in head) + " |"]
                lines += ["| " + " | ".join(str(c) for c in r) + " |"
                          for r in b.get("rows") or []]
                body.append("\n".join(lines))
            else:
                body.append(str(b.get("text") or ""))
        page_imgs = " ".join(f"IMG_{n}" for n in sorted(by_page.get(i, [])))
        parts.append(f"===== 第 {i} 页 =====\n" + "\n\n".join(p for p in body if p.strip())
                     + f"\n\n[本页附图：{page_imgs}]")
    # figs 的 page 需要与伪页一致：按块顺序回填（图片出现的伪页）
    for i, page_blocks in enumerate(pages, 1):
        for b in page_blocks:
            for f in figs:
                if f["page"] == 1 and f"[IMG_{f['n']}]" in str(b.get("text") or ""):
                    f["page"] = i
    return "\n\n".join(parts), pages

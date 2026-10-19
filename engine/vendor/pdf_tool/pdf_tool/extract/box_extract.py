#!/usr/bin/env python3
"""框编号协议抽取：本地版面框 → 页面画编号红框 → API 输出 `[[box:n]]` → 精确挂图。

保证「本地精确位置」与「模型引用」一一对应：不错位、不遗漏。
未被引用的框会确定性兜底挂到同页首个 question 并告警（不静默丢图）。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from PIL import Image

from pdf_tool.assets.crops import stage2_local
from pdf_tool.extract.vision_extract import draw_numbered, render_pages

log = logging.getLogger("qb.box")

BOX_REF_RE = re.compile(r"\[\[box:(\d+)\]\]")
POS_RE = re.compile(r"Page\s+(\d+)(?:\s*-\s*(\d+))?")


def _pages_of(pos) -> set[int]:
    return {int(v) for v in re.findall(r"\d+", str(pos or ""))}


def parse_box_refs(data) -> set[int]:
    """收集输出 JSON 中所有 `[[box:n]]` 引用编号。"""
    refs: set[int] = set()

    def walk(obj) -> None:
        if isinstance(obj, dict):
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for v in obj:
                walk(v)
        elif isinstance(obj, str):
            refs.update(int(m.group(1)) for m in BOX_REF_RE.finditer(obj))

    walk(data)
    return refs


def _append_box_ref(target: dict, n: int) -> bool:
    """把兜底引用追加到目标块合适的文本字段；表格/图片等无文本字段的块返回 False。"""
    t = target.get("type")
    if t == "table":
        return False
    key = {"question": "stem", "code": "content"}.get(t, "text")
    target[key] = (target.get(key) or "") + f" [[box:{n}]]"
    return True


def backstop_unreferenced(data: dict, figs: list[dict], refs: set[int]) -> list[int]:
    """未被引用的框兜底挂载，返回兜底编号。

    优先同页 question（保持考题路径行为不变），其次同页 text；再退到首个
    question/text；都没有时新建一个 text 块，保证不静默丢图。
    """
    blocks = data.setdefault("blocks", [])
    texts = [b for b in blocks if b.get("type") in ("question", "text")]
    fixed: list[int] = []
    for f in figs:
        n = f["n"]
        if n in refs:
            continue
        page = f["page"]
        target = (
            next((b for b in texts if b.get("type") == "question"
                  and page in _pages_of(b.get("position"))), None)
            or next((b for b in texts if page in _pages_of(b.get("position"))), None)
            or (texts[0] if texts else None)
        )
        if target is None or not _append_box_ref(target, n):
            blocks.append({"type": "text", "position": f"Page {page}",
                           "text": f"[[box:{n}]]"})
        fixed.append(n)
        log.warning("[box] 图 IMG_%d（第 %d 页）未被引用，已兜底挂载", n, page)
    return fixed


def _replace_refs(obj, mapping: dict[int, str]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str):
                obj[k] = BOX_REF_RE.sub(
                    lambda m: mapping.get(int(m.group(1)), m.group(0)), v)
            else:
                _replace_refs(v, mapping)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                obj[i] = BOX_REF_RE.sub(
                    lambda m: mapping.get(int(m.group(1)), m.group(0)), v)
            else:
                _replace_refs(v, mapping)


def resolve_box_refs(data: dict, figs: list[dict], *, inline: bool = False) -> int:
    """把 `[[box:n]]` 就地替换为图片链接（`![插图n](rel)`）或 base64 data URI。"""
    import base64
    import mimetypes

    from pdf_tool.core.paths import OUT_ROOT

    mapping: dict[int, str] = {}
    for f in figs:
        if inline:
            p = OUT_ROOT / f["rel"]
            if not p.exists():
                continue
            mime = mimetypes.guess_type(p.name)[0] or "image/jpeg"
            b64 = base64.b64encode(p.read_bytes()).decode()
            mapping[f["n"]] = f"![插图{f['n']}](data:{mime};base64,{b64})"
        else:
            mapping[f["n"]] = f"![插图{f['n']}]({f['rel']})"
    _replace_refs(data, mapping)
    return len(mapping)


def extract_with_boxes(pdf: Path, client, prompt: str, out_dir: Path, work_dir: Path,
                       *, max_tokens: int = 32000) -> dict:
    """完整流程：本地框 → 画编号 → API → 引用统计 + 兜底；返回 {"data","figs","stats"}。"""
    work_dir.mkdir(parents=True, exist_ok=True)
    figs = stage2_local(pdf, out_dir / "assets" / "imgs", work_dir / "figs.json")
    pages = render_pages(pdf, work_dir / "pages", zoom=2.0)
    by_page: dict[int, list[dict]] = {}
    for f in figs:
        by_page.setdefault(f["page"], []).append(f)
    images: list[Image.Image] = []
    for pno in sorted(pages):
        with Image.open(pages[pno]) as im:
            img = im.convert("RGB").copy()
        boxes = [(f["n"], tuple(int(v) for v in f["rect2x"]))
                 for f in by_page.get(pno, []) if f.get("rect2x")]
        labeled, _ = draw_numbered(img, boxes)
        images.append(labeled)
    data, _usage = client.extract_json(prompt, images, tag=pdf.stem,
                                       max_tokens=max_tokens, retries=1)
    refs = parse_box_refs(data)
    fixed = backstop_unreferenced(data, figs, refs)
    box_ns = {f["n"] for f in figs}
    known = refs & box_ns
    unknown = sorted(refs - box_ns)
    stats = {
        "pages": len(pages),
        "boxes": len(figs),
        "referenced": len(known),
        "unknown_refs": unknown,
        "backstopped": fixed,
        "ok": not unknown and len(known) == len(figs),
    }
    return {"data": data, "figs": figs, "stats": stats}


def save_result(result: dict, out_json: Path, *, inline: bool = False) -> dict:
    """落盘结果 JSON（可内联 base64）。返回 stats。"""
    data = result["data"]
    resolve_box_refs(data, result["figs"], inline=inline)
    data["_box_stats"] = result["stats"]
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return result["stats"]


# ---------- 大文档分卷（断点续跑 + 合并） ----------

def offset_position(pos, offset: int, chunk_pages: int = 0) -> str:
    """把分卷页码平移到全文档页码。

    模型可能给「分卷内页码」（1..chunk_pages，需平移），也可能直接沿用原文页码
    （> chunk_pages，已是全文档页码，不再平移）。
    """
    def f(m: re.Match) -> str:
        a = int(m.group(1))
        b = int(m.group(2)) if m.group(2) else None
        if a <= chunk_pages:  # 以首个页码判定编号体系：分卷内 → 整体平移
            a += offset
            if b is not None:
                b += offset
        return f"Page {a}-{b}" if b is not None else f"Page {a}"

    return POS_RE.sub(f, str(pos or ""))


def _offset_block(block: dict, offset: int, chunk_pages: int) -> None:
    if block.get("position"):
        block["position"] = offset_position(block["position"], offset, chunk_pages)
    im = block.get("image")
    if isinstance(im, dict) and im.get("position"):
        im["position"] = offset_position(im["position"], offset, chunk_pages)


def merge_split_results(items: list[tuple[int, dict, dict]]) -> tuple[dict, dict]:
    """合并分卷：items = [(page_offset, chunk_json, chunk_stats)]，页码平移为全文档页码。"""
    blocks: list[dict] = []
    failed: list[str] = []
    chunk_stats: list[dict] = []
    boxes = refs = back = 0
    unknown: set[int] = set()
    for offset, data, stats in items:
        chunk_pages = int(stats.get("pages") or 0)
        for b in data.get("blocks") or []:
            _offset_block(b, offset, chunk_pages)
            blocks.append(b)
        boxes += stats.get("boxes", 0)
        refs += stats.get("referenced", 0)
        back += len(stats.get("backstopped") or [])
        unknown.update(stats.get("unknown_refs") or [])
        if not stats.get("ok"):
            failed.append(str(stats.get("chunk") or offset))
        chunk_stats.append(stats)
    merged_stats = {
        "pages": sum(s.get("pages", 0) for _, _, s in items),
        "chunks": len(items),
        "boxes": boxes,
        "referenced": refs,
        "unknown_refs": sorted(unknown),
        "backstopped": back,
        "failed_chunks": failed,
        "chunk_stats": chunk_stats,
        "ok": not failed,
    }
    return {"blocks": blocks}, merged_stats


def extract_split(pdf: Path, client, prompt: str, out_dir: Path, work_dir: Path,
                  *, split: int = 20, force: bool = False, inline: bool = False,
                  max_tokens: int = 32000) -> tuple[dict, dict]:
    """按 split 页分卷抽取后合并；已完成分卷默认跳过（断点续跑）。"""
    import fitz

    src = fitz.open(pdf)
    total = src.page_count
    items: list[tuple[int, dict, dict]] = []
    for start in range(0, total, split):
        end = min(start + split, total)
        tag = f"{start + 1:04d}-{end:04d}"
        cdir = out_dir / "split" / f"chunk_{tag}"
        cjson = cdir / "chunk.json"
        if cjson.exists() and not force:
            log.info("[split] 跳过已完成分卷 %s", tag)
            data = json.loads(cjson.read_text(encoding="utf-8"))
            stats = data.pop("_box_stats", {}) or {}
            stats.setdefault("chunk", tag)
            items.append((start, data, stats))
            continue
        chunk_pdf = work_dir / "chunks" / f"chunk_{tag}.pdf"
        chunk_pdf.parent.mkdir(parents=True, exist_ok=True)
        part = fitz.open()
        part.insert_pdf(src, from_page=start, to_page=end - 1)
        part.save(chunk_pdf)
        part.close()
        try:
            result = extract_with_boxes(chunk_pdf, client, prompt, cdir,
                                        work_dir / f"chunk_{tag}", max_tokens=max_tokens)
            save_result(result, cjson, inline=inline)
            stats = dict(result["stats"], chunk=tag)
            log.info("[split] 分卷 %s 完成: %s", tag, result["stats"])
        except Exception as e:  # 单卷失败不阻断整本，可重跑补卷
            log.error("[split] 分卷 %s 失败: %s", tag, e)
            items.append((start, {"blocks": []},
                          {"chunk": tag, "ok": False, "pages": end - start,
                           "boxes": 0, "referenced": 0, "backstopped": []}))
            continue
        items.append((start, result["data"], stats))
    src.close()
    data, stats = merge_split_results(items)
    log.info("[split] 合并完成: %s", stats)
    return data, stats

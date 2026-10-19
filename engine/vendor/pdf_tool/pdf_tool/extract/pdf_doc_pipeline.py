#!/usr/bin/env python3
"""两遍式大文档转换：本地筛查 + 文本转写 + 只对候选页做 box 精确挂图。

- Pass 0 本地筛查（triage）：PyMuPDF 毫秒级找出含图片/矢量图的候选页（~2ms/页）；
- Pass 1 文本转写（两种通道）：
    browser: 按 chunk_pages 分卷整份 PDF 直传（每卷新会话），输出文本 blocks；
    api:     纯文字页本地取文本（带页码标记），按 max_chars 分块交文本模型（无图片 token）；
- Pass 2 精确挂图：只对候选页分批（box 协议）抽插图，按页码锚点插入；
- 中间产物落盘 `out_dir/split/`，支持断点续跑（`force=True` 重跑）。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from pdf_tool.core.paths import PROMPTS_DIR
from pdf_tool.core.pdfops import make_chunk_pdf
from pdf_tool.extract.box_extract import (
    _offset_block,
    extract_with_boxes,
    offset_position,
    resolve_box_refs,
)

log = logging.getLogger("qb.pdfdoc")

PAGE_RE = re.compile(r"(\d+)")

# 文本块缓存前缀（v1=普通 get_text；v2=行流；v3=文本页含候选页，缓存不兼容）
TEXT_CACHE_PREFIX = "text3"


def page_of(pos) -> int:
    """从 `Page 12` / `Page 12-13` 取起始页码；取不到返回 0。"""
    m = PAGE_RE.search(str(pos or ""))
    return int(m.group(1)) if m else 0


def insert_figure_blocks(blocks: list[dict],
                         page_figures: dict[int, list[dict]]) -> list[dict]:
    """把每页插图块插到该页最后一个 block 之后；无匹配页的图按页码顺序追加末尾。"""
    remaining = {p: list(figs) for p, figs in page_figures.items() if figs}
    out: list[dict] = []
    pages = [page_of(b.get("position")) for b in blocks]
    for i, b in enumerate(blocks):
        out.append(b)
        p = pages[i]
        nxt = pages[i + 1] if i + 1 < len(blocks) else None
        if p in remaining and (nxt is None or nxt != p):
            for fig in remaining.pop(p):
                out.append({"type": "image", "position": f"Page {p}", "image": fig})
    for p in sorted(remaining):
        for fig in remaining[p]:
            out.append({"type": "image", "position": f"Page {p}", "image": fig})
    return out


_make_chunk_pdf = make_chunk_pdf  # ???????? monkeypatch ??


def build_page_text(pdf: Path, pages: list[int]) -> str:
    """本地取纯文字页文本（fitz 行流 + 页眉页脚剔除；带 `===== 第 N 页 =====` 标记）。

    行流（span 中心聚类 + 栏检测 + 间距补空格）能把目录的「1 / Introduction / 19」
    并回同一行，比 `get_text("text")` 的块序更接近阅读顺序。
    """
    import fitz

    from pdf_tool.extract.doc_mode import (
        _norm_margin,
        _repeated_margin_lines,
        page_lines,
    )

    doc = fitz.open(pdf)
    pages_items: dict[int, list[tuple[float, str]]] = {}
    for p in pages:
        pages_items[p] = page_lines(doc[p - 1])
    doc.close()

    repeated = _repeated_margin_lines(pages_items)
    parts: list[str] = []
    for p in pages:
        body = "\n".join(t for _, t in sorted(pages_items[p])
                         if _norm_margin(t) not in repeated)
        parts.append(f"===== 第 {p} 页 =====\n{body}")
    return "\n\n".join(parts)


def _collect_figures(data: dict, batch: list[int],
                     page_figures: dict[int, list[dict]]) -> None:
    for b in data.get("blocks") or []:
        if b.get("type") != "image":
            continue
        local = page_of(b.get("position"))
        abs_page = batch[local - 1] if 1 <= local <= len(batch) else batch[0]
        im = b.get("image") or {}
        page_figures.setdefault(abs_page, []).append({
            "id": im.get("id") or f"fig-p{abs_page}-{len(page_figures[abs_page]) + 1}",
            "src": im.get("src"),
            "alt": im.get("alt") or "",
        })


def _run_fig_pass(src, client, fig_prompt: str, doc_prompt: str, candidates: list[int],
                  out_dir: Path, work_dir: Path, *, fig_batch: int, fresh_session: bool,
                  force: bool, inline: bool,
                  ) -> tuple[dict[int, list[dict]], list[dict], int, list[str]]:
    """候选页挂图（分批 + 断点续跑）。返回 (page_figures, extra_blocks, batches, failed)。

    - 有文本层的候选页：用「图片 box 协议」提示词（只抽图，文字由文本 Pass 提供）；
    - 无文本层的候选页（扫描页）：用「通用文档 box 协议」提示词（文字+图片一起抽），
      否则扫描件的文字会全部丢失。批内含扫描页时整批走该协议，但只有**确实无文本层**
      的页的文字块会保留（有文本层的页由文本 Pass 提供，避免重复），且页码按 batch
      平移到全文档（模型只可能给分卷内页码，图片走的也是同一映射）。
    """
    page_figures: dict[int, list[dict]] = {}
    extra_blocks: list[dict] = []
    batches = 0
    failed: list[str] = []
    split_dir = out_dir / "split"
    for i in range(0, len(candidates), fig_batch):
        batch = candidates[i:i + fig_batch]
        tag = f"fig_{batch[0]:04d}-{batch[-1]:04d}"
        scanned = any(_page_text_len(src, p) < 20 for p in batch)
        bjson = split_dir / f"{tag}.json"
        if bjson.exists() and not force:
            log.info("[pass2] 跳过已完成批次 %s", tag)
            data = json.loads(bjson.read_text(encoding="utf-8"))
        else:
            batch_pdf = work_dir / "figchunks" / f"{tag}.pdf"
            _make_chunk_pdf(src, batch, batch_pdf)
            prompt = doc_prompt if scanned else fig_prompt
            try:
                if fresh_session and hasattr(client, "new_session"):
                    client.new_session()
                result = extract_with_boxes(batch_pdf, client, prompt,
                                            split_dir / tag, work_dir / tag)
                resolve_box_refs(result["data"], result["figs"], inline=inline)
                bjson.write_text(json.dumps(result["data"], ensure_ascii=False, indent=2),
                                 encoding="utf-8")
                data = result["data"]
                log.info("[pass2] %s 完成（%s）: %s", tag,
                         "扫描页→通用文档" if scanned else "图片协议", result["stats"])
            except Exception as e:
                log.error("[pass2] %s 失败: %s", tag, e)
                failed.append(tag)
                continue
        if scanned:  # 扫描批次：图片进 page_figures，其余（文字/表格/代码）保留
            scanned_abs = {p for p in batch if _page_text_len(src, p) < 20}
            for b in data.get("blocks") or []:
                if b.get("type") == "image":
                    _collect_figures({"blocks": [b]}, batch, page_figures)
                elif b.get("position"):
                    _offset_block(b, batch[0] - 1, len(batch))  # 分卷页码 → 全文档页码
                    if page_of(b.get("position")) in scanned_abs:  # 只留无文本层页，防与 Pass1 重复
                        extra_blocks.append(b)
        else:
            _collect_figures(data, batch, page_figures)
        batches += 1
    return page_figures, extra_blocks, batches, failed


def _split_chunk_in_half(chunk: str) -> list[str] | None:
    """按页标记把文本块二分（找中点最近的页标记）；不足两页返回 None。"""
    marks = [m.start() for m in re.finditer(r"(?m)^===== 第 \d+ 页 =====", chunk)]
    if len(marks) < 2:
        return None
    mid = len(chunk) // 2
    idx = min(range(1, len(marks)), key=lambda i: abs(marks[i] - mid))
    return [chunk[:marks[idx]].strip(), chunk[marks[idx]:].strip()]


def _page_text_len(pdf: Path, page_no: int) -> int:
    """页内文本层字符数（用于判断该页是否需要 OCR/读图）。"""
    import fitz

    doc = fitz.open(pdf)
    try:
        return len(doc[page_no - 1].get_text().strip())
    finally:
        doc.close()


def _text_pages(pdf: Path, total: int, min_chars: int = 20) -> list[int]:
    """有文本层的页（文本 Pass 的输入）：与 triage 候选页无关，避免候选页文字丢失。"""
    import fitz

    doc = fitz.open(pdf)
    out: list[int] = []
    try:
        for p in range(1, total + 1):
            if len(doc[p - 1].get_text().strip()) >= min_chars:
                out.append(p)
    finally:
        doc.close()
    return out


def _extract_text_chunk(client, text_prompt: str, chunk: str, tag: str,
                        split_dir: Path, force: bool, depth: int = 0) -> list[dict]:
    """处理一个文本块；输出截断时按页二分重试（最多 2 层）。"""
    cjson = split_dir / f"{tag}.json"
    if cjson.exists() and not force:
        log.info("[pass1] 跳过已完成文本块 %s", tag)
        data = json.loads(cjson.read_text(encoding="utf-8"))
        return data.get("blocks") or []
    prompt = f"{text_prompt}\n\n# 文档文本（{tag}）\n\n{chunk}"
    try:
        data, _ = client.extract_json(prompt, [], tag=tag, max_tokens=32000,
                                      retries=2, required_keys=("blocks",))
        if not (data.get("blocks") or []):
            # 空 blocks 视为退化响应（不落缓存，走重试/兜底）
            raise ValueError("空 blocks 响应（模型退化）")  # noqa: TRY301
        cjson.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        log.info("[pass1] %s 完成: %d blocks", tag, len(data.get("blocks") or []))
        return data.get("blocks") or []
    except Exception as e:
        halves = _split_chunk_in_half(chunk) if depth < 2 and "truncated" in str(e) else None
        if halves:
            log.warning("[pass1] %s 输出截断，二分重试（depth=%d）", tag, depth)
            out: list[dict] = []
            for j, half in enumerate(halves, 1):
                out += _extract_text_chunk(client, text_prompt, half, f"{tag}_{j}",
                                           split_dir, force, depth + 1)
            return out
        raise


def _fallback_blocks(chunk: str) -> list[dict]:
    """模型反复截断/重复时的确定性兜底：按页标记输出原始文本块（保内容不丢）。"""
    out: list[dict] = []
    parts = re.split(r"(?m)^===== 第 (\d+) 页 =====\s*", chunk)
    for i in range(1, len(parts), 2):
        page = parts[i]
        text = parts[i + 1].strip() if i + 1 < len(parts) else ""
        if text:
            out.append({"type": "text", "position": f"Page {page}", "text": text})
    return out


def convert_pdf(pdf: Path, client, out_dir: Path, work_dir: Path, *,
                chunk_pages: int = 40, triage: bool = True, min_drawings: int = 20,
                fig_batch: int = 10, fresh_session: bool = True, force: bool = False,
                inline: bool = False) -> tuple[dict, dict]:
    """浏览器通道：整份 PDF 直传分卷文本转写 + 候选页挂图。"""
    import fitz

    from pdf_tool.extract.triage import flag_pages

    text_prompt = (PROMPTS_DIR / "doc_extract_pdf.md").read_text(encoding="utf-8")
    fig_prompt = (PROMPTS_DIR / "fig_extract_box.md").read_text(encoding="utf-8")

    split_dir = out_dir / "split"
    split_dir.mkdir(parents=True, exist_ok=True)
    src = fitz.open(pdf)
    total = src.page_count

    candidates = (flag_pages(pdf, min_drawings=min_drawings) if triage
                  else list(range(1, total + 1)))
    log.info("[pass0] 候选页 %d/%d", len(candidates), total)

    blocks: list[dict] = []
    text_chunks = 0
    failed_text: list[str] = []
    for start in range(0, total, chunk_pages):
        end = min(start + chunk_pages, total)
        tag = f"text_{start + 1:04d}-{end:04d}"
        cjson = split_dir / f"{tag}.json"
        if cjson.exists() and not force:
            log.info("[pass1] 跳过已完成分卷 %s", tag)
            data = json.loads(cjson.read_text(encoding="utf-8"))
        else:
            chunk_pdf = work_dir / "chunks" / f"{tag}.pdf"
            _make_chunk_pdf(src, list(range(start + 1, end + 1)), chunk_pdf)
            try:
                data, _ = client.extract_json_pdf(text_prompt, chunk_pdf, tag=tag,
                                                  fresh_session=fresh_session)
                cjson.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                                 encoding="utf-8")
                log.info("[pass1] %s 完成: %d blocks", tag, len(data.get("blocks") or []))
            except Exception as e:
                log.error("[pass1] %s 失败: %s", tag, e)
                failed_text.append(tag)
                continue
        for b in data.get("blocks") or []:
            if b.get("position"):
                b["position"] = offset_position(b["position"], start, end - start)
            blocks.append(b)
        text_chunks += 1

    doc_prompt = (PROMPTS_DIR / "doc_extract_box.md").read_text(encoding="utf-8")
    page_figures, extra_blocks, fig_batches, failed_figs = _run_fig_pass(
        src, client, fig_prompt, doc_prompt, candidates, out_dir, work_dir,
        fig_batch=fig_batch, fresh_session=fresh_session, force=force, inline=inline)
    src.close()

    if extra_blocks:  # 扫描批次的文字块与文本 Pass 结果按页码合并
        blocks = sorted([*blocks, *extra_blocks],
                        key=lambda b: page_of(b.get("position")))
    merged_blocks = insert_figure_blocks(blocks, page_figures)
    stats = {
        "pages": total,
        "text_chunks": text_chunks,
        "failed_text_chunks": failed_text,
        "candidate_pages": len(candidates),
        "fig_batches": fig_batches,
        "failed_fig_batches": failed_figs,
        "figures": sum(len(v) for v in page_figures.values()),
        "scanned_text_blocks": len(extra_blocks),
        "blocks": len(merged_blocks),
        "ok": not failed_text and not failed_figs,
    }
    log.info("[pdfdoc] 完成: %s", stats)
    return {"blocks": merged_blocks}, stats


def convert_pdf_api(pdf: Path, client, out_dir: Path, work_dir: Path, *,
                    triage: bool = True, min_drawings: int = 20, fig_batch: int = 10,
                    max_chars: int = 16000, force: bool = False,
                    inline: bool = False) -> tuple[dict, dict]:
    """API 通道：纯文字页本地取文本交文本模型（无图片 token）+ 候选页挂图。"""
    import fitz

    from pdf_tool.extract.doc_mode import split_doc_text
    from pdf_tool.extract.triage import flag_pages

    text_prompt = (PROMPTS_DIR / "doc_extract_text.md").read_text(encoding="utf-8")
    fig_prompt = (PROMPTS_DIR / "fig_extract_box.md").read_text(encoding="utf-8")
    doc_prompt = (PROMPTS_DIR / "doc_extract_box.md").read_text(encoding="utf-8")

    split_dir = out_dir / "split"
    split_dir.mkdir(parents=True, exist_ok=True)
    src = fitz.open(pdf)
    total = src.page_count

    candidates = (flag_pages(pdf, min_drawings=min_drawings) if triage
                  else list(range(1, total + 1)))
    # 文本 Pass 覆盖所有有文本层的页（含候选页），否则候选页的文字会丢
    text_pages = _text_pages(pdf, total)
    log.info("[pass0] 候选页 %d / 有文本层页 %d / 共 %d", len(candidates),
             len(text_pages), total)

    doc_text = build_page_text(pdf, text_pages) if text_pages else ""
    chunks = split_doc_text(doc_text, max_chars=max_chars) if doc_text else []
    blocks: list[dict] = []
    text_chunks = 0
    failed_text: list[str] = []
    fallback_chunks: list[str] = []
    for i, chunk in enumerate(chunks, 1):
        tag = f"{TEXT_CACHE_PREFIX}_{i:03d}"
        try:
            chunk_blocks = _extract_text_chunk(client, text_prompt, chunk, tag,
                                               split_dir, force)
        except Exception as e:
            chunk_blocks = _fallback_blocks(chunk)
            if chunk_blocks:
                log.error("[pass1] %s 失败，改用本地原文兜底（%d blocks）: %s",
                          tag, len(chunk_blocks), e)
                fallback_chunks.append(tag)
            else:
                log.error("[pass1] %s 失败且无法兜底: %s", tag, e)
                failed_text.append(tag)
                continue
        blocks.extend(chunk_blocks)
        text_chunks += 1

    page_figures, extra_blocks, fig_batches, failed_figs = _run_fig_pass(
        src, client, fig_prompt, doc_prompt, candidates, out_dir, work_dir,
        fig_batch=fig_batch, fresh_session=False, force=force, inline=inline)
    src.close()

    if extra_blocks:  # 扫描批次的文字块与文本 Pass 结果按页码合并
        blocks = sorted([*blocks, *extra_blocks],
                        key=lambda b: page_of(b.get("position")))
    merged_blocks = insert_figure_blocks(blocks, page_figures)
    stats = {
        "pages": total,
        "text_chunks": text_chunks,
        "failed_text_chunks": failed_text,
        "fallback_chunks": fallback_chunks,
        "candidate_pages": len(candidates),
        "fig_batches": fig_batches,
        "failed_fig_batches": failed_figs,
        "figures": sum(len(v) for v in page_figures.values()),
        "blocks": len(merged_blocks),
        "ok": not failed_text and not failed_figs,
    }
    log.info("[pdfdoc-api] 完成: %s", stats)
    return {"blocks": merged_blocks}, stats

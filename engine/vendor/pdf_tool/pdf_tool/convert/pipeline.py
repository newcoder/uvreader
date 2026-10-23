"""PDF → Doc 转换管线：模式路由 / 抽取复用 / 导出（json/md/html）/ 分元素审计。

模式：
  auto    按文档特征与可用凭据选路（mineru > text > vision）
  blocks  直接读已有 blocks JSON（离线；阅读器预览已转换文档也用这个）
  mineru  MinerU 云端解析（content_list → blocks，公式 LaTeX/表格 HTML）
  text    文本型 PDF 两遍式（本地取文本 + 文本模型，无图片 token）
  vision  整份页面图一次调用（box 协议，扫描件通用文档）

产物（out_dir，默认 `pdf_tool/output/{stem}/convert/`）：
  {stem}_doc.json（规范 Doc v1）/ {stem}_doc.md / {stem}_doc.html / {stem}_audit.json
"""
from __future__ import annotations

import logging
from pathlib import Path

from pdf_tool.core.io import load_json, save_json
from pdf_tool.core.paths import OUT_ROOT, PROMPTS_DIR, WORK_ROOT
from pdf_tool.model.audit import audit_doc
from pdf_tool.model.document import (
    blocks_to_doc,
    doc_stats,
    doc_to_blocks,
    select_pages,
)

log = logging.getLogger("pdf_tool.convert")

MODES = ("auto", "blocks", "mineru", "text", "vision")
DEFAULT_FORMATS = ("json", "md", "html")


def route_mode(pdf, *, can_llm: bool = False, can_mineru: bool = False) -> str:
    """自动选路：MinerU 可用优先；文本型 PDF 走 text；其余扫描件走 vision。"""
    from pdf_tool.assets.crops import detect_engine

    if can_mineru:
        return "mineru"
    engine = detect_engine(Path(pdf))
    if engine == "layout" and can_llm:
        return "text"
    return "vision"


def make_llm_client(*, via: str = "api", model: str = "deepseek-flash"):
    """按通道创建模型客户端（api=DeepSeek API；browser=deepseek_tool 网页会话）。"""
    if via == "browser":
        from pdf_tool.llm.browser_client import BrowserVisionClient

        return BrowserVisionClient()
    from pdf_tool.llm.vision_client import VisionClient

    return VisionClient(model=model)


def _blocks_from_blocks_json(pdf: Path, blocks_path: Path | None) -> list[dict]:
    path = Path(blocks_path) if blocks_path else (OUT_ROOT / pdf.stem / f"{pdf.stem}_doc.json")
    if not path.exists():
        raise FileNotFoundError(f"blocks JSON 不存在: {path}（--blocks 指定或先跑抽取）")
    data = load_json(path)
    return [b for b in (data.get("blocks") or []) if isinstance(b, dict)]


def _blocks_from_mineru(pdf: Path, token: str, out_dir: Path, *,
                        model: str = "vlm", max_pages: int = 200,
                        force: bool = False, mineru_client=None,
                        on_chunk=None, mineru_source: str = "auto",
                        mineru_tier: str = "", mineru_cmd: str = "",
                        mineru_url: str = "", pages=None,
                        cancelled=None, footnotes: bool = True) -> tuple[list[dict], dict]:
    """MinerU 解析（>max_pages 自动分卷合并）；mineru_client 仅测试注入。

    mineru_source：auto=有 LOCAL_URL 走本地服务、有 token 走云端、否则本地 CLI；
    cloud/local 显式选择（显式 local 不静默回退，不可用时由客户端给可操作报错）。
    mineru_url：本地常驻服务地址（默认 env MINERU_LOCAL_URL）。
    pages：只解析这些页（可选）；cancelled：可调用（返回 True=取消，本地后端抛 MineruCancelled）；
    footnotes：是否保留脚注块（默认 True）。
    """
    from pdf_tool.mineru.client import parse_to_blocks
    from pdf_tool.mineru.local import make_mineru_client

    client = mineru_client or make_mineru_client(
        mineru_source, token=token, model=model,
        tier=mineru_tier or None, cmd=mineru_cmd or None,
        url=mineru_url or None)
    blocks, stats = parse_to_blocks(client, pdf, out_dir, max_pages=max_pages,
                                    force=force, on_chunk=on_chunk, pages=pages,
                                    cancelled=cancelled, footnotes=footnotes)
    log.info("[convert] mineru: %s", stats)
    return blocks, stats


def _blocks_from_text(pdf: Path, client, out_dir: Path, work_dir: Path, *,
                      max_chars: int = 16000, force: bool = False) -> tuple[list[dict], dict]:
    from pdf_tool.extract.pdf_doc_pipeline import convert_pdf_api

    data, stats = convert_pdf_api(pdf, client, out_dir, work_dir,
                                  triage=True, max_chars=max_chars, force=force)
    return [b for b in (data.get("blocks") or []) if isinstance(b, dict)], stats


def _blocks_from_vision(pdf: Path, client, out_dir: Path, work_dir: Path, *,
                        inline: bool = False) -> tuple[list[dict], dict]:
    from pdf_tool.extract.box_extract import extract_with_boxes, resolve_box_refs

    rules = (PROMPTS_DIR / "doc_extract_box.md").read_text(encoding="utf-8")
    result = extract_with_boxes(pdf, client, rules, out_dir, work_dir)
    resolve_box_refs(result["data"], result["figs"], inline=inline)
    blocks = [b for b in (result["data"].get("blocks") or []) if isinstance(b, dict)]
    return blocks, result["stats"]


def write_doc(doc: dict, out_dir: Path, stem: str,
              formats=DEFAULT_FORMATS) -> tuple[dict[str, str], dict]:
    """写 Doc JSON + md/html + 审计；返回 (files, audit)。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    if "json" in formats:
        p = out_dir / f"{stem}_doc.json"
        save_json(p, doc)
        files["json"] = str(p)
    if "md" in formats or "html" in formats:
        blocks = doc_to_blocks(doc)
        printed = {pg.get("page"): pg.get("printed_page")
                   for pg in doc.get("pages") or [] if pg.get("printed_page")}
        if "md" in formats:
            from pdf_tool.render.md import render_md_blocks

            p = out_dir / f"{stem}_doc.md"
            p.write_text("\n\n".join(render_md_blocks(blocks, printed=printed)) + "\n",
                         encoding="utf-8")
            files["md"] = str(p)
        if "html" in formats:
            from pdf_tool.render.md import render_html

            p = out_dir / f"{stem}_doc.html"
            p.write_text(render_html(blocks, title=stem), encoding="utf-8")
            files["html"] = str(p)
    audit = audit_doc(doc, base=out_dir)
    p = out_dir / f"{stem}_audit.json"
    save_json(p, audit)
    files["audit"] = str(p)
    return files, audit


def convert(pdf, *, mode: str = "auto", pages=None, blocks_path=None, client=None,
            mineru_token: str = "", mineru_model: str = "vlm",
            mineru_source: str = "auto", mineru_tier: str = "", mineru_cmd: str = "",
            mineru_url: str = "",
            mineru_max_pages: int = 200, mineru_client=None, out_dir=None,
            work_dir=None, formats=DEFAULT_FORMATS, max_chars: int = 16000,
            force: bool = False, inline: bool = False,
            source_extra: dict | None = None, on_page=None,
            cancelled=None, footnotes: bool = True,
            structure: bool = True) -> dict:
    """PDF → Doc：返回 {"doc", "files", "audit", "stats", "mode"}。

    cancelled：可调用（返回 True=取消，仅本地 MinerU 后端支持）；取消时抛
    `pdf_tool.mineru.MineruCancelled`（宿主据此标记「已取消」而非失败）。
    footnotes：MinerU 模式下是否保留 `page_footnote` 脚注块（默认 True）。
    structure：是否补结构信息——目录页 `page_role`/`toc_entries` 与跨页续行
    `continuation`（默认 True，见 `extract/structure.py`）。
    """
    pdf = Path(pdf)
    if mode not in MODES:
        raise ValueError(f"未知模式 {mode}（可选 {MODES}）")
    out_dir = Path(out_dir) if out_dir else (OUT_ROOT / pdf.stem / "convert")
    work_dir = Path(work_dir) if work_dir else (WORK_ROOT / pdf.stem / "convert")

    if mode == "auto":
        from pdf_tool.mineru.local import local_available, local_url

        src = (mineru_source or "auto").lower()
        if mineru_client is not None:
            can_mineru = True
        elif src == "local":
            can_mineru = True  # 显式 local：不静默回退，由客户端给可操作报错
        elif src == "cloud":
            can_mineru = bool(mineru_token)
        else:  # auto：LOCAL_URL 本地服务 > token 云端 > 本地 CLI
            can_mineru = bool(mineru_url or local_url()) or bool(mineru_token) \
                or bool(local_available(mineru_cmd or None))
        mode = route_mode(pdf, can_llm=client is not None, can_mineru=can_mineru)
        log.info("[convert] auto -> %s", mode)

    if mode == "blocks":
        blocks = _blocks_from_blocks_json(pdf, blocks_path)
        stats = {"mode": mode, "blocks": len(blocks)}
    elif mode == "mineru":
        if mineru_client is None:
            from pdf_tool.mineru.local import local_available, local_url

            src = (mineru_source or "auto").lower()
            if src == "cloud" and not mineru_token:
                raise ValueError("--mineru-source cloud 需要 mineru token"
                                 "（--mineru-token 或 MINERU_TOKEN / MINERU_API_KEY）")
            if (src == "auto" and not mineru_token and not (mineru_url or local_url())
                    and not local_available(mineru_cmd or None)):
                raise ValueError(
                    "mode=mineru：无 token 且本地 MinerU 不可用。请设置 MINERU_API_KEY"
                    "（云端）、安装本地 mineru 并配置 MINERU_LOCAL_CMD，或启动常驻服务并"
                    "配置 MINERU_LOCAL_URL（见 docs/plan-mineru-local-2026-10-12.md）")
        blocks, mstats = _blocks_from_mineru(
            pdf, mineru_token, out_dir, model=mineru_model,
            max_pages=mineru_max_pages, force=force, mineru_client=mineru_client,
            mineru_source=mineru_source, mineru_tier=mineru_tier, mineru_cmd=mineru_cmd,
            mineru_url=mineru_url, pages=pages, cancelled=cancelled, footnotes=footnotes,
            on_chunk=(lambda tag, done, total: on_page(done, done, total))
            if on_page is not None else None)
        stats = {"mode": mode, "blocks": len(blocks), **mstats}
    elif mode == "text":
        if client is None:
            raise ValueError("mode=text 需要模型客户端（client）")
        blocks, stats = _blocks_from_text(pdf, client, out_dir, work_dir,
                                          max_chars=max_chars, force=force)
        stats = {"mode": mode, **stats}
    else:  # vision
        if client is None:
            raise ValueError("mode=vision 需要模型客户端（client）")
        blocks, stats = _blocks_from_vision(pdf, client, out_dir, work_dir, inline=inline)
        stats = {"mode": mode, **stats}

    # 通用页面装饰剔除（水印/页眉/页脚/页码；text/vision/mineru/blocks 全模式生效）
    from pdf_tool.extract import furniture as furniture_mod

    blocks, fstats = furniture_mod.filter_blocks(blocks, furniture_mod.scan_pdf(pdf))
    dropped_images = list(stats.get("furniture_images") or [])
    figure_overlaps = list(stats.get("figure_text_overlaps") or [])
    fstats = {**fstats, "images_dropped": int(stats.get("images_dropped") or 0),
              "furniture_images": dropped_images,
              "figure_text_removed": int(stats.get("figure_text_removed") or 0),
              "figure_text_overlap": int(stats.get("figure_text_overlap") or 0),
              "figure_text_overlaps": figure_overlaps}
    stats = {**stats, "furniture": fstats, "blocks": len(blocks)}

    import fitz

    with fitz.open(pdf) as _d:
        page_count = _d.page_count
    source = {"path": str(pdf), "stem": pdf.stem, "mode": mode,
              "pages": page_count, **dict(source_extra or {})}
    if dropped_images:  # 供 audit 记录被丢图片的页码/bbox（reader 2026-10-21）
        source["furniture_images"] = dropped_images
    if figure_overlaps:  # 无法安全切分的图内文字重叠（reader 2026-10-22）
        source["figure_text_overlaps"] = figure_overlaps
    doc = blocks_to_doc(blocks, source=source, page_count=page_count)
    if pages:
        doc = select_pages(doc, pages)
    printed = stats.pop("page_numbers", None) if isinstance(stats, dict) else None
    if structure:  # 结构信息：目录页 + 跨页续行（reader 需求 2026-10-14）
        from pdf_tool.extract import structure as structure_mod

        provider = structure_mod.make_line_provider(pdf)
        stats = {**stats, "structure": structure_mod.annotate_doc(
            doc, line_provider=provider, printed_pages=printed)}
    files, audit = write_doc(doc, out_dir, pdf.stem, formats)
    if on_page is not None:
        on_page(1, 1, 1)
    result = {"doc": doc, "files": files, "audit": audit,
              "stats": {**stats, **doc_stats(doc)}, "mode": mode}
    log.info("[convert] %s: %s", mode, result["stats"])
    return result


def convert_page(pdf, page: int, *, mode: str = "blocks", blocks_path=None, client=None,
                 mineru_token: str = "", mineru_model: str = "vlm",
                 mineru_source: str = "auto", mineru_tier: str = "",
                 mineru_url: str = "",
                 mineru_max_pages: int = 200, mineru_client=None, out_dir=None,
                 work_dir=None, max_chars: int = 16000, footnotes: bool = True) -> dict:
    """单页预览：{"page", "doc", "markdown", "mode"}（阅读器“这页转出来什么样”）。"""
    pdf = Path(pdf)
    out_dir = Path(out_dir) if out_dir else (OUT_ROOT / pdf.stem / "convert")
    work_dir = Path(work_dir) if work_dir else (WORK_ROOT / pdf.stem / "convert")

    if mode == "blocks":
        blocks = _blocks_from_blocks_json(pdf, blocks_path)
    elif mode == "mineru":
        if not mineru_token and mineru_client is None and mineru_source != "local":
            raise ValueError("mode=mineru 需要 mineru_token 或本地 MinerU"
                             "（--mineru-source local）")
        blocks, _mstats = _blocks_from_mineru(
            pdf, mineru_token, out_dir, model=mineru_model,
            max_pages=mineru_max_pages, mineru_client=mineru_client,
            mineru_source=mineru_source, mineru_tier=mineru_tier,
            mineru_url=mineru_url, pages=[page], footnotes=footnotes)
    elif mode == "text":
        if client is None:
            raise ValueError("mode=text 需要模型客户端（client）")
        from pdf_tool.extract.pdf_doc_pipeline import build_page_text

        text = build_page_text(pdf, [page])
        prompt = ((PROMPTS_DIR / "doc_extract_text.md").read_text(encoding="utf-8")
                  + f"\n\n# 文档文本（Page {page}）\n\n{text}")
        data, _usage = client.extract_json(prompt, [], tag=f"convert_p{page}",
                                           max_tokens=32000, retries=2,
                                           required_keys=("blocks",))
        blocks = [{"position": f"Page {page}", **b}
                  for b in (data.get("blocks") or [])]
    else:  # vision：单页分卷走 box 协议（本地画框 + 引用）
        if client is None:
            raise ValueError("mode=vision 需要模型客户端（client）")
        import tempfile

        from pdf_tool.extract.box_extract import (
            _offset_block,
            extract_with_boxes,
            resolve_box_refs,
        )
        from pdf_tool.extract.pdf_doc_pipeline import _make_chunk_pdf

        with tempfile.TemporaryDirectory(prefix="pdf_tool_page_") as td:
            chunk = Path(td) / f"page_{page}.pdf"
            import fitz

            src = fitz.open(pdf)
            try:
                _make_chunk_pdf(src, [page], chunk)
            finally:
                src.close()
            rules = (PROMPTS_DIR / "doc_extract_box.md").read_text(encoding="utf-8")
            result = extract_with_boxes(chunk, client, rules, out_dir, work_dir)
            resolve_box_refs(result["data"], result["figs"], inline=False)
            blocks = [b for b in (result["data"].get("blocks") or [])
                      if isinstance(b, dict)]
            for b in blocks:
                _offset_block(b, page - 1, 1)

    from pdf_tool.extract import furniture as furniture_mod

    blocks, _fstats = furniture_mod.filter_blocks(blocks, furniture_mod.scan_pdf(pdf))
    doc = blocks_to_doc(blocks, source={"path": str(pdf), "mode": mode})
    doc = select_pages(doc, [page])
    blocks_page = doc_to_blocks(doc)
    from pdf_tool.render.md import render_md_blocks

    markdown = "\n\n".join(render_md_blocks(blocks_page)) + "\n" if blocks_page else ""
    return {"page": page, "doc": doc, "markdown": markdown, "mode": mode}

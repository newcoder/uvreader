"""PDF → 题目/文档 抽取主流程（CLI：pdf_tool/pdf_to_questions.py）。

Stage1 PaddleOCR 在线解析（仅需要时）→ Stage2 图片资产 → Stage3 模型抽取 → Stage4 组装 + 审计。
各 Stage 的实现在 pdf_tool/assets 与 pdf_tool/extract 的对应模块。
"""
from __future__ import annotations

import argparse
import logging
import os
import re
from pathlib import Path

from pdf_tool.assets.crops import detect_engine, stage2_crops
from pdf_tool.assets.paddle import TIMING, stage1_pp
from pdf_tool.core.io import load_json as _load
from pdf_tool.core.io import save_json as _save
from pdf_tool.core.paths import OUT_ROOT, PROMPTS_DIR, ROOT, WORK_ROOT

log = logging.getLogger("qb")


# ---------- stage 4 ----------
_IMG_MD_RE = re.compile(r"!\[插图(\d+)\]\([^)]*\)")


def report_vx(page_results: list[dict], figs: list[dict], data: dict) -> None:
    n_q = sum(len(r.get("questions", [])) for r in page_results)
    refs = {f["box"] for r in page_results for q in r.get("questions", [])
            for f in q.get("figures") or []}
    missing = [f["n"] for f in figs if f["n"] not in refs]
    log.info("vision: %d 页 / %d 题 / %d 图引用", len(page_results), n_q, len(refs))
    if missing:
        # 这些图模型未在 figures[] 里归属；其中一部分可能已被兜底挂到题目上
        log.warning("模型未归属（如已由兜底挂载则见产物）: %s", missing)

    # 每图恰好挂载一次的交付不变量：按产物里的 ![插图N] 计数核对（≠1 即失守）
    counts: dict[int, int] = {}

    def _walk(obj) -> None:
        if isinstance(obj, str):
            for m in _IMG_MD_RE.finditer(obj):
                counts[int(m.group(1))] = counts.get(int(m.group(1)), 0) + 1
        elif isinstance(obj, dict):
            for v in obj.values():
                _walk(v)
        elif isinstance(obj, list):
            for v in obj:
                _walk(v)

    _walk(data)
    off = {n: counts.get(n, 0) for n in (f["n"] for f in figs) if counts.get(n, 0) != 1}
    if off:
        log.warning("每图恰好挂载一次失守（编号: 产物内引用次数）: %s", off)


_IMG_LINK_RE = re.compile(r"!\[(插图\d+)\]\(([^)]+)\)")


def _inline_images(data: dict, out_root: Path) -> int:
    """把 `![插图n](rel)` 就地替换为 data URI（base64）；rel 相对 out_root。"""
    import base64
    import mimetypes

    count = 0

    def _repl(text: str) -> str:
        def sub(m):
            nonlocal count
            p = out_root / m.group(2)
            if not p.exists():
                return m.group(0)
            mime = mimetypes.guess_type(p.name)[0] or "image/jpeg"
            count += 1
            b64 = base64.b64encode(p.read_bytes()).decode()
            return f"![{m.group(1)}](data:{mime};base64,{b64})"
        return _IMG_LINK_RE.sub(sub, text)

    def walk(obj) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, str):
                    obj[k] = _repl(v)
                else:
                    walk(v)
        elif isinstance(obj, list):
            for i, v in enumerate(obj):
                if isinstance(v, str):
                    obj[i] = _repl(v)
                else:
                    walk(v)

    walk(data)
    return count


DEFAULT_VISION_MODEL = "deepseek-flash"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--token", default="")
    parser.add_argument("--engine", default="auto", choices=["auto", "pp", "layout"])
    parser.add_argument("--only", default="", help="stage 子集，如 1,2")
    parser.add_argument("--mode", default="vision",
                        choices=["vision", "vision-doc", "text", "box", "doc", "mineru"],
                        help="vision=逐页读图；vision-doc=整份页面图像一次抽取；text=整份文档文本；"
                             "box=本地版面框编号 + 整份页面图像（精确挂图）；"
                             "doc=同 box 但用通用文档 prompt（扫描件转 markdown/HTML）；"
                             "mineru=MinerU 云端解析（content_list → blocks，公式为 LaTeX）")
    parser.add_argument("--pp-source", default="local", choices=["local", "online"],
                        help="扫描件图片定位：local=本地 PP-DocLayoutV2（默认，免 token）；"
                             "online=在线 PaddleOCR doc_parsing")
    parser.add_argument("--model", default=DEFAULT_VISION_MODEL)
    parser.add_argument("--via", default="api", choices=["api", "browser"],
                        help="视觉抽取通道：api=DeepSeek API（计费）；"
                             "browser=deepseek_tool 驱动真实浏览器（网页会话，免 API 费）")
    parser.add_argument("--browser-timeout", type=int, default=0,
                        help="浏览器通道单次等待上限秒数（0=自动：90s/页，600~3600）")
    parser.add_argument("--browser-retries", type=int, default=2,
                        help="浏览器通道失败重试次数（默认 2）")
    parser.add_argument("--split", type=int, default=0,
                        help="按 N 页分卷抽取后合并（0=不分卷；大文档建议 20-30 页）")
    parser.add_argument("--split-force", action="store_true",
                        help="重跑已完成分卷（默认跳过，支持断点续跑）")
    parser.add_argument("--pdf-chunks", type=int, default=0,
                        help="PDF 直传两遍式转换的分卷页数（仅 --mode doc --via browser）："
                             "每卷整份 PDF 上传 + 新会话；0=关闭")
    parser.add_argument("--no-triage", action="store_true",
                        help="关闭候选页筛查（默认只对含图片/矢量图的页做 box 精确挂图）")
    parser.add_argument("--doc-chars", type=int, default=16000,
                        help="--pdf-chunks 且 --via api 时文本分块字符数（默认 16000）")
    parser.add_argument("--mineru-token", default="",
                        help="MinerU token（--mode mineru；默认读环境变量 "
                             "MINERU_TOKEN / MINERU_API_KEY）")
    parser.add_argument("--mineru-model", default="vlm", choices=["vlm", "pipeline"],
                        help="MinerU 模型版本（默认 vlm：公式/表格更好）")
    parser.add_argument("--mineru-source", default=os.environ.get("MINERU_SOURCE", "auto"),
                        choices=["auto", "cloud", "local"],
                        help="MinerU 后端：auto=LOCAL_URL 本地服务 > token 云端 > 本地 CLI；"
                             "cloud/local 显式选择")
    parser.add_argument("--mineru-tier", default=os.environ.get("MINERU_TIER", "standard"),
                        choices=["basic", "standard", "advanced", "flash"],
                        help="本地 MinerU 档位（env MINERU_TIER，默认 standard）")
    parser.add_argument("--mineru-url", default=os.environ.get("MINERU_LOCAL_URL", ""),
                        help="本地 MinerU 常驻服务地址（env MINERU_LOCAL_URL）")
    parser.add_argument("--no-footnotes", action="store_true",
                        help="--mode mineru：不保留脚注块（page_footnote）；默认保留")
    parser.add_argument("--mineru-max-pages", type=int, default=200,
                        help="MinerU 单文件页数上限；超过自动分卷解析并合并（默认 200）")
    parser.add_argument("--mineru-reflow", default="off", choices=["off", "api", "ollama"],
                        help="MinerU 结果再加工：把文字合并后交 LLM 重新切分"
                             "（修复跨页代码；api=DeepSeek，ollama=本地模型）")
    parser.add_argument("--ollama-model", default="glm-4.7-flash",
                        help="--mineru-reflow ollama 使用的本地模型")
    parser.add_argument("--ollama-url", default="http://localhost:11434/v1")
    parser.add_argument("--doc-model", default="deepseek-flash",
                        help="--mode text 使用的文本模型")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--inline-images", action="store_true",
                        help="另存 {stem}_questions_b64.json，图片以 base64 内联")
    parser.add_argument("--tile", action="store_true",
                        help="（预留）密集页分块精细模式；v1 未实现，设置后忽略并告警")
    args = parser.parse_args()

    pdf = (ROOT / args.pdf).resolve()
    stem = pdf.stem
    engine = detect_engine(pdf) if args.engine == "auto" else args.engine
    log.info("engine=%s (pdf=%s)", engine, pdf.name)
    work = WORK_ROOT / stem
    work.mkdir(parents=True, exist_ok=True)
    result_json, _imgs_dir, meta = (
        work / "pp_result.json", work / "imgs", work / "figs.json")
    out_dir = OUT_ROOT / stem
    out_assets = out_dir / "assets" / "imgs"
    out_json = out_dir / f"{stem}_questions.json"
    stages = {int(x) for x in args.only.split(",")} if args.only else {1, 2, 3, 4}

    if args.mode == "mineru":  # MinerU（云端/本地；>max_pages 自动分卷）：content_list → blocks
        from pdf_tool.mineru.client import parse_to_blocks
        from pdf_tool.mineru.local import make_mineru_client

        token = (args.mineru_token or os.environ.get("MINERU_TOKEN")
                 or os.environ.get("MINERU_API_KEY", ""))
        client = make_mineru_client(args.mineru_source, token=token,
                                    model=args.mineru_model,
                                    tier=args.mineru_tier or None,
                                    url=args.mineru_url or None)
        blocks, bstats = parse_to_blocks(client, pdf, out_dir,
                                         max_pages=args.mineru_max_pages,
                                         force=args.split_force,
                                         footnotes=not args.no_footnotes)
        if args.mineru_reflow != "off":  # 合并文字 → LLM 重新切分（修复跨页代码）
            from pdf_tool.mineru.client import reflow_text_blocks
            text_prompt = (PROMPTS_DIR / "doc_extract_text.md").read_text(encoding="utf-8")
            if args.mineru_reflow == "ollama":
                from pdf_tool.llm.text_client import OllamaTextClient
                rclient = OllamaTextClient(model=args.ollama_model, base_url=args.ollama_url)
            else:
                from pdf_tool.llm.vision_client import VisionClient
                rclient = VisionClient(model=args.model)
            try:
                blocks, rstats = reflow_text_blocks(blocks, rclient, text_prompt)
                bstats = {**bstats, **rstats}
                log.info("%s", rclient.usage_report())
            finally:
                close = getattr(rclient, "close", None)
                if close is not None:
                    close()
        data = {"blocks": blocks, "_mineru_stats": {**bstats, "model": args.mineru_model}}
        out_json = out_dir / f"{stem}_doc.json"
        _save(out_json, data)
        _save(out_dir / f"{stem}_doc_audit.json", bstats)
        log.info("mineru: %s -> %s", bstats, out_json.name)
        return 0

    if args.mode in ("box", "doc"):  # 框编号协议：本地框 → 画编号 → API → 精确挂图
        from pdf_tool.extract.box_extract import (
            extract_split,
            extract_with_boxes,
            save_result,
        )
        from pdf_tool.llm.vision_client import VisionClient
        if args.mode == "doc":  # 通用文档抽取（标题/正文/表格/代码/图片）
            rules = (PROMPTS_DIR / "doc_extract_box.md").read_text(encoding="utf-8")
            suffix = "doc"
        else:  # 考题抽取
            rules = ((PROMPTS_DIR / "exam_extract.md").read_text(encoding="utf-8") + "\n\n"
                     + (PROMPTS_DIR / "exam_extract_box.md").read_text(encoding="utf-8"))
            suffix = "box"
        if args.via == "browser":
            from pdf_tool.llm.browser_client import BrowserVisionClient
            client = BrowserVisionClient(timeout=(args.browser_timeout or None),
                                         retries=args.browser_retries)
        else:
            client = VisionClient(model=args.model)
        try:
            import fitz

            with fitz.open(pdf) as _doc:
                pages = _doc.page_count
            out_json = out_dir / f"{stem}_{suffix}.json"
            if args.pdf_chunks and args.mode == "doc":
                if args.via == "browser":
                    from pdf_tool.extract.pdf_doc_pipeline import convert_pdf
                    data, stats = convert_pdf(pdf, client, out_dir, work,
                                              chunk_pages=args.pdf_chunks,
                                              triage=not args.no_triage,
                                              force=args.split_force,
                                              inline=args.inline_images)
                else:
                    from pdf_tool.extract.pdf_doc_pipeline import convert_pdf_api
                    data, stats = convert_pdf_api(pdf, client, out_dir, work,
                                                  triage=not args.no_triage,
                                                  max_chars=args.doc_chars,
                                                  force=args.split_force,
                                                  inline=args.inline_images)
                _save(out_json, data)
                _save(out_dir / f"{stem}_{suffix}_audit.json", stats)
            elif args.split and pages > args.split:
                data, stats = extract_split(pdf, client, rules, out_dir, work,
                                            split=args.split, force=args.split_force,
                                            inline=args.inline_images)
                _save(out_json, data)
                _save(out_dir / f"{stem}_{suffix}_audit.json", stats)
            else:
                result = extract_with_boxes(pdf, client, rules, out_dir, work)
                stats = result["stats"]
                save_result(result, out_json, inline=args.inline_images)
                _save(out_dir / f"{stem}_{suffix}_audit.json", stats)
            log.info("%s: %s -> %s", args.mode, stats, out_json.name)
            if not stats.get("ok", True):
                log.warning("抽取不完整: unknown=%s referenced=%s/%s failed=%s",
                            stats.get("unknown_refs"), stats.get("referenced"),
                            stats.get("boxes"),
                            stats.get("failed_text_chunks") or stats.get("failed_chunks"))
            log.info("%s", client.usage_report())
        finally:
            close = getattr(client, "close", None)
            if close is not None:
                close()
        return 0

    figs: list[dict] = []
    if args.tile:
        log.warning("--tile 尚未实现（v1 留位），按整页模式继续")
    need_pp_text = args.mode == "text"
    if engine == "pp" and 1 in stages and (need_pp_text or args.pp_source == "online"):
        stage1_pp(pdf, args.token, result_json)
    if 2 in stages:
        figs = stage2_crops(pdf, engine, result_json, out_assets, meta,
                            pp_source=args.pp_source)
    else:
        figs = _load(meta) if meta.exists() else []
        for f in figs:
            f["file"] = out_assets / Path(f["rel"]).name
    if not figs:
        log.warning("未收集到任何裁剪图")
    from pdf_tool.extract import vision_extract as vx
    from pdf_tool.extract.audit import audit_result
    from pdf_tool.llm.vision_client import VisionClient
    results_file = work / {"text": "doc_results.json",
                           "vision-doc": "vision_doc_results.json"}.get(
                               args.mode, "vision_results.json")
    if 3 in stages:
        if args.mode == "text":
            from pdf_tool.extract.doc_mode import (
                build_doc_text_from_layout,
                build_doc_text_from_pp,
                extract_document,
            )
            doc_text = (build_doc_text_from_pp(result_json, figs) if engine == "pp"
                        else build_doc_text_from_layout(pdf, figs))
            rules = (PROMPTS_DIR / "text_extract.md").read_text(encoding="utf-8")
            client = VisionClient(model=args.doc_model)
            page_results = extract_document(client, rules, doc_text,
                                            {f["n"] for f in figs})
        elif args.mode == "vision-doc":
            from pdf_tool.extract.doc_mode import extract_document_vision
            rules = (PROMPTS_DIR / "vision_doc_extract.md").read_text(encoding="utf-8")
            client = VisionClient(model=args.model)
            pages = vx.render_pages(pdf, work / "pages", zoom=2.0)
            page_results = extract_document_vision(client, rules, pages, figs)
        else:
            rules = (PROMPTS_DIR / "vision_extract.md").read_text(encoding="utf-8")
            client = VisionClient(model=args.model)
            page_results = vx.run_extraction(pdf, client, rules, figs, work,
                                             strict=args.strict)
        _save(results_file, {"pages": page_results})
        log.info("%s", client.usage_report())
    else:
        page_results = _load(results_file)["pages"]
    if 4 in stages:
        import fitz

        with fitz.open(pdf) as _doc:
            _pages = _doc.page_count
        data = vx.assemble(page_results, figs, out_json,
                           source={"file": pdf.name, "pages": _pages, "engine": args.mode})
        report_vx(page_results, figs, data)
        audit = audit_result(pdf, page_results, figs, data,
                             check_page_coverage=args.mode == "vision")
        audit_path = out_dir / f"{stem}_audit.json"
        _save(audit_path, audit)
        log.info("audit: ok=%s issues=%d -> %s", audit["ok"], len(audit["issues"]),
                 audit_path.name)
        if not audit["ok"]:
            for issue in audit["issues"]:
                log.warning("audit: %s", issue)
        for w in audit.get("warnings", []):
            log.warning("audit: %s", w)
        if args.inline_images:
            b64_path = out_dir / f"{stem}_questions_b64.json"
            n_img = _inline_images(data, OUT_ROOT)
            _save(b64_path, data)
            log.info("inlined %d image(s) as base64 -> %s", n_img, b64_path.name)
    log.info("timing: %s", {k: round(v, 1) for k, v in TIMING.items()})
    return 0

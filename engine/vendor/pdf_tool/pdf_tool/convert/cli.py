#!/usr/bin/env python3
"""CLI：PDF → Doc（规范文档模型 v1；实现见 pdf_tool/convert/pipeline.py）。"""
import argparse
import logging
import os
from pathlib import Path

from pdf_tool.convert.pipeline import DEFAULT_FORMATS, MODES, convert, make_llm_client
from pdf_tool.core.pages import parse_pages


def main() -> int:
    ap = argparse.ArgumentParser(description="PDF → Doc（json/md/html + 分元素审计）")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--mode", default="auto", choices=list(MODES))
    ap.add_argument("--pages", default="", help="页码范围，如 1-10,20（默认全部）")
    ap.add_argument("--blocks", default="", help="mode=blocks 的 blocks JSON 路径")
    ap.add_argument("--formats", default=",".join(DEFAULT_FORMATS))
    ap.add_argument("--out-dir", default="", help="产物目录（默认 output/{stem}/convert）")
    ap.add_argument("--doc-chars", type=int, default=16000, help="text 模式文本分块字符数")
    ap.add_argument("--model", default="deepseek-flash")
    ap.add_argument("--via", default="api", choices=["api", "browser"])
    ap.add_argument("--mineru-token",
                    default=os.environ.get("MINERU_TOKEN")
                    or os.environ.get("MINERU_API_KEY", ""),
                    help="mode=mineru 的 token（默认读环境变量 MINERU_TOKEN / MINERU_API_KEY）")
    ap.add_argument("--mineru-model", default="vlm", choices=["vlm", "pipeline"])
    ap.add_argument("--mineru-source", default=os.environ.get("MINERU_SOURCE", "auto"),
                    choices=["auto", "cloud", "local"],
                    help="MinerU 后端：auto=LOCAL_URL 本地服务 > token 云端 > 本地 CLI；"
                         "cloud/local 显式选择")
    ap.add_argument("--mineru-tier", default=os.environ.get("MINERU_TIER", "standard"),
                    choices=["basic", "standard", "advanced", "flash"],
                    help="本地 MinerU 档位（env MINERU_TIER，默认 standard）")
    ap.add_argument("--mineru-url", default=os.environ.get("MINERU_LOCAL_URL", ""),
                    help="本地 MinerU 常驻服务地址（env MINERU_LOCAL_URL，如 "
                         "http://127.0.0.1:8000；设置后本地解析走 HTTP，免每次启动模型）")
    ap.add_argument("--mineru-max-pages", type=int, default=200,
                    help="MinerU 单文件页数上限；超过自动分卷（默认 200）")
    ap.add_argument("--no-footnotes", action="store_true",
                    help="mode=mineru：不保留脚注块（page_footnote）；默认保留")
    ap.add_argument("--no-structure", action="store_true",
                    help="不补结构信息（目录页 page_role/toc_entries 与跨页续行 continuation）")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s")
    pdf = Path(args.pdf).resolve()
    formats = tuple(f.strip() for f in args.formats.split(",") if f.strip())
    from pdf_tool.mineru.local import local_available, local_url

    src = (args.mineru_source or "auto").lower()
    if src == "cloud" and not args.mineru_token:
        raise ValueError("--mineru-source cloud 需要 mineru token"
                         "（--mineru-token 或 MINERU_TOKEN / MINERU_API_KEY）")
    if src == "local":
        mineru_ready = True  # 显式 local：交给客户端报可操作错误（不静默回退）
    elif src == "cloud":
        mineru_ready = True  # token 已在上方校验
    else:  # auto：LOCAL_URL 本地服务 > token 云端 > 本地 CLI
        mineru_ready = (bool(args.mineru_url or local_url())
                        or bool(args.mineru_token) or bool(local_available()))
    need_llm = args.mode in ("text", "vision") or (
        args.mode == "auto" and not mineru_ready)
    client = make_llm_client(via=args.via, model=args.model) if need_llm else None

    pages = None
    if args.pages:
        import fitz

        doc = fitz.open(pdf)
        try:
            pages = parse_pages(args.pages, doc.page_count)
        finally:
            doc.close()

    result = convert(pdf, mode=args.mode, pages=pages,
                     blocks_path=args.blocks or None, client=client,
                     mineru_token=args.mineru_token,
                     mineru_model=args.mineru_model,
                     mineru_source=args.mineru_source,
                     mineru_tier=args.mineru_tier,
                     mineru_url=args.mineru_url,
                     mineru_max_pages=args.mineru_max_pages,
                     footnotes=not args.no_footnotes,
                     structure=not args.no_structure,
                     out_dir=args.out_dir or None, formats=formats,
                     max_chars=args.doc_chars, force=args.force)
    print(f"mode={result['mode']} {result['stats']} audit_ok={result['audit']['ok']}")
    for kind, path in result["files"].items():
        print(f"  {kind:6} {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

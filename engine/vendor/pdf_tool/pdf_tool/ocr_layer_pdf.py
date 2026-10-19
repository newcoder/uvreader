#!/usr/bin/env python3
"""CLI：扫描 PDF → 可搜索双层 PDF（实现见 pdf_tool/ocr/）。"""
import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # 支持直接以脚本运行
    sys.path.insert(0, str(ROOT))

from pdf_tool.core.paths import OUT_ROOT  # noqa: E402
from pdf_tool.ocr.backends import BACKEND_NAMES  # noqa: E402
from pdf_tool.ocr.build import DEFAULT_DPI, build  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="扫描 PDF → 可搜索双层 PDF（像素级不变）")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True, help="输出 PDF")
    ap.add_argument("--ocr", default="rapid", choices=sorted(BACKEND_NAMES),
                    help="OCR 后端：rapid=质量优先（3.5s/页）；windows=极速（0.2s/页）")
    ap.add_argument("--dpi", type=float, default=DEFAULT_DPI)
    ap.add_argument("--pages", default="", help="页码范围，如 1-100,105（默认全部）")
    ap.add_argument("--min-score", type=float, default=0.5,
                    help="RapidOCR 置信度阈值（低于此值不写层）")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--intra-op", type=int, default=2,
                    help="每 OCR 进程 ONNX 线程数（默认 2：多进程下避免抢核，0=RapidOCR 默认全核）")
    ap.add_argument("--force", action="store_true", help="忽略页级缓存重跑 OCR")
    ap.add_argument("--skip-text-chars", type=int, default=200,
                    help="页内已有文字超过该长度则跳过（原生文本 PDF 无需叠加，0=不跳过）")
    ap.add_argument("--source", default="ocr", choices=["ocr", "mineru", "hybrid"],
                    help="文字来源：ocr=本地 OCR；mineru=MinerU layout.json（公式 LaTeX）；"
                         "hybrid=rapid 行级位置 + MinerU 文本（块内对齐）")
    ap.add_argument("--layout", default="",
                    help="--source mineru/hybrid 的文本源 JSON：MinerU layout.json /"
                         " vision_results.json / blocks JSON（默认 output/{stem}/mineru/）")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    pdf = Path(args.pdf).resolve()
    if args.layout:
        layout_path = Path(args.layout).resolve()
    else:  # MinerU 各版本命名不一：layout.json / *_layout.json / *_middle.json
        mineru_dir = OUT_ROOT / pdf.stem / "mineru"
        layout_path = next(
            (p for pat in ("layout.json", "*layout.json", "*middle.json")
             for p in sorted(mineru_dir.glob(pat))), mineru_dir / "layout.json")
    stats = build(pdf, Path(args.out).resolve(), ocr=args.ocr,
                  dpi=args.dpi, pages_spec=args.pages, min_score=args.min_score,
                  workers=args.workers, force=args.force,
                  skip_text_chars=args.skip_text_chars,
                  source=args.source, layout_path=layout_path,
                  intra_op=args.intra_op or None)
    print(f"written {args.out} ({stats['size_kb']} KB, {stats['pages']} pages, "
          f"{stats['lines_inserted']} lines, ocr {stats['ocr_seconds']}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

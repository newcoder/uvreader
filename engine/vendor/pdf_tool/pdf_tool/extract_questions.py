#!/usr/bin/env python3
"""CLI：题目抽取（P1）——PDF / 照片 / DOCX → 结构化题目 JSON + 审计。

用法:
  python pdf_tool/extract_questions.py --input pdf_tool/test-docs/xxx.docx
  python pdf_tool/extract_questions.py --input pdf_tool/test-docs        # 整目录批量
  python pdf_tool/extract_questions.py --input x.pdf --via browser       # 网页会话免 API 费
"""
import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # 支持直接以脚本运行
    sys.path.insert(0, str(ROOT))

from pdf_tool.ingest.run import extract_many, list_inputs  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="题目抽取：PDF / 照片 / DOCX → 题目 JSON + 审计")
    ap.add_argument("--input", required=True, help="文件或目录")
    ap.add_argument("--via", default="api", choices=["api", "browser"],
                    help="模型通道：api=DeepSeek API；browser=deepseek_tool 网页会话")
    ap.add_argument("--model", default="deepseek-flash", help="视觉/通用模型")
    ap.add_argument("--doc-model", default="deepseek-flash", help="DOCX 文本抽取模型")
    ap.add_argument("--force", action="store_true", help="忽略已有产物重跑")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    src = Path(args.input).resolve()
    if not src.exists():
        print(f"输入不存在: {src}")
        return 1
    paths = list_inputs(src) if src.is_dir() else [src]
    if not paths:
        print(f"目录中没有支持的文件: {src}")
        return 1
    results = extract_many(paths, via=args.via, model=args.model,
                           doc_model=args.doc_model, force=args.force)

    print(f"{'file':44} {'mode':10} {'题数':>5} {'审计':>4}  耗时")
    bad = 0
    for r in results:
        err = r.get("error")
        if err:
            bad += 1
            print(f"{r['file'][:44]:44} {'-':10} {'-':>5} {'ERR':>4}  {err[:60]}")
            continue
        audit = r.get("audit") or {}
        ok = audit.get("ok")
        ok_s = "ok" if ok else ("FAIL" if ok is False else "-")
        print(f"{r['file'][:44]:44} {r.get('mode')!s:10} "
              f"{r.get('questions', '-'):>5} {ok_s:>4}  {r.get('elapsed_s', '?')}s")
        if ok is False:
            for issue in audit.get("issues") or []:
                print(f"      ! {issue}")
    print(f"\n共 {len(results)} 个文件，失败 {bad} 个；报告: "
          f"pdf_tool/output/_p1_report.json")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""CLI：PDF → 题目/文档 JSON（实现见 pdf_tool/extract/pipeline.py）。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # 支持直接以脚本运行
    sys.path.insert(0, str(ROOT))

from pdf_tool.extract.pipeline import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())

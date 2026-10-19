#!/usr/bin/env python3
"""CLI：blocks JSON → Markdown / HTML（实现见 pdf_tool/render/md.py）。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # 支持直接以脚本运行
    sys.path.insert(0, str(ROOT))

from pdf_tool.render.md import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())

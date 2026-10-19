#!/usr/bin/env python3
"""阅读器 sidecar 打包入口（PyInstaller；见 pdf_tool/reader/README.md §7）。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # 支持直接以脚本运行
    sys.path.insert(0, str(ROOT))

from pdf_tool.reader.server import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())

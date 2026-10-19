"""pdf_tool 公用路径（仓库根 / 包根 / 产物 / 缓存）。"""
from __future__ import annotations

import os
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent  # pdf_tool/
ROOT = PKG.parent                             # 仓库根
PROMPTS_DIR = PKG / "prompts"
OUT_ROOT = PKG / "output"
WORK_ROOT = ROOT / "temp_output" / "qb_work"
OCR_CACHE_ROOT = Path(os.environ.get("PDF_TOOL_OCR_CACHE",
                                    ROOT / "temp_output" / "ocr_layer"))
BROWSER_UPLOAD_DIR = ROOT / "temp_output" / "browser_uploads"

"""文字层页级缓存：目录命名（键含 backend/dpi/min_score/版本）与覆盖根。"""
from __future__ import annotations

from pathlib import Path

from pdf_tool.core.paths import OCR_CACHE_ROOT

# 缓存版本：OCR 逻辑/跳页规则/缓存键结构变更时递增，旧缓存自动失效
CACHE_VERSION = 3


def cache_dir(name: str, ocr: str = "rapid", dpi: float = 200.0,
              min_score: float = 0.5, cache_root: Path | None = None) -> Path:
    """文档缓存目录。name 用 file stem（批处理）或内容指纹（阅读器）。

    键含 ocr/dpi/min_score：任一变化都重新 OCR（旧键缓存不匹配即失效）。
    """
    root = Path(cache_root) if cache_root is not None else OCR_CACHE_ROOT
    return root / name / f"{ocr}_{int(dpi)}_s{min_score:g}_v{CACHE_VERSION}"


def page_cache_file(name: str, page_no: int, ocr: str = "rapid", dpi: float = 200.0,
                    min_score: float = 0.5, cache_root: Path | None = None) -> Path:
    return cache_dir(name, ocr, dpi, min_score, cache_root) / f"page_{page_no:04d}.json"

"""PaddleOCR 在线 doc_parsing（stage1：扫描件的 markdown 与图片裁剪清单）。"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from pathlib import Path

log = logging.getLogger("qb.paddle")
TIMING: dict[str, float] = {}


# ---------- stage 1 ----------
def stage1_pp(pdf: Path, token: str, result_json: Path) -> None:
    cmd = [sys.executable, "-m", "paddleocr", "api", "--model_type", "doc_parsing",
           "--file_path", str(pdf), "--token", token, "--output", str(result_json)]
    t0 = time.time()
    log.info("[stage1] paddleocr doc_parsing ...")
    proc = subprocess.run(  # noqa: S603 - 本机 paddleocr CLI，非外部输入
        cmd, capture_output=True, timeout=900, check=False,
        env={**os.environ, "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True"},
    )
    TIMING["stage1_paddleocr"] = time.time() - t0
    if proc.returncode != 0 or not result_json.exists():
        tail = ((proc.stdout or b"") + (proc.stderr or b""))[-600:].decode("utf-8", "replace")
        raise RuntimeError(f"doc_parsing failed: {tail}")
    log.info("[stage1] done in %.0fs", TIMING["stage1_paddleocr"])

"""Validate the configured local mineru-kit executable.

A MinerU venv copied from another machine keeps a `pyvenv.cfg` pointing at the
old user's Python. The launcher still exists, so a file-existence check passes,
but every parse exits 103 with `No Python at ...`. Do not hand that path to
pdf_tool: run `mineru-kit --version` once per file revision and cache it.
"""
from __future__ import annotations

import subprocess
import sys
import time
import urllib.request
from pathlib import Path

_CHECK_TTL_SECONDS = 60
_CACHE: dict[str, tuple[float, str]] = {}


def local_kit_problem(exe: str, *, timeout: float = 15.0) -> str:
    """Return an actionable problem string, or "" when the executable works."""
    value = str(exe or "").strip()
    if not value:
        return "没有配置 mineru-kit 路径"
    if value in ("mineru-kit", "mineru-kit.exe"):
        return ""  # PATH lookup is left to the child process.
    path = Path(value)
    if not path.exists():
        return f"找不到 {value}"
    try:
        stat = path.stat()
    except OSError as exc:
        return str(exc)

    # Repairing a venv changes pyvenv.cfg without touching the launcher.
    cfg = path.parent.parent / "pyvenv.cfg"
    try:
        cfg_stat = cfg.stat()
        venv_stamp = f"{cfg_stat.st_mtime_ns}:{cfg_stat.st_size}"
    except OSError:
        venv_stamp = ""
    key = f"{value}|{stat.st_mtime_ns}:{stat.st_size}|{venv_stamp}"
    now = time.time()
    cached = _CACHE.get(key)
    if cached and now - cached[0] < _CHECK_TTL_SECONDS:
        return cached[1]

    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    problem = ""
    try:
        result = subprocess.run(
            [value, "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=flags,
        )
    except subprocess.TimeoutExpired:
        problem = f"启动超时({timeout:.0f}s)"
    except OSError as exc:
        problem = str(exc)
    else:
        if result.returncode != 0:
            text = " ".join(f"{result.stderr or ''} {result.stdout or ''}".split())[:240]
            problem = (
                f"venv 指向的 Python 不存在:{text}"
                if "No Python at" in text
                else f"退出码 {result.returncode}: {text}"
            )

    _CACHE[key] = (now, problem)
    if len(_CACHE) > 40:
        oldest = sorted(_CACHE.items(), key=lambda item: item[1][0])[: len(_CACHE) - 40]
        for name, _ in oldest:
            _CACHE.pop(name, None)
    return problem


def usable_local_kit(exe: str) -> bool:
    return bool(str(exe or "").strip()) and not local_kit_problem(exe)


def local_service_healthy(url: str, *, timeout: float = 2.0) -> bool:
    """Probe a configured MinerU HTTP service; loopback must ignore proxies."""
    value = str(url or "").strip().rstrip("/")
    if not value:
        return False
    try:
        request = urllib.request.Request(value + "/v1/health", method="GET")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=timeout) as response:  # noqa: S310
            return 200 <= int(getattr(response, "status", 0)) < 300
    except Exception:  # noqa: BLE001
        return False

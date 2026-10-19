"""能力检测:引擎自己探自己的环境(应用不再逐个探测)。

`/v1/health` 上报的就是这里的结果 —— 每项给 `{ok, detail}`:
- 内置能力(Python / PyMuPDF / Pillow / latex2mathml):直接看解释器里有没有;
- 外部组件(DocVortex / pdf_tool / MinerU / Calibre / boko):按配置路径 + PATH + 常见位置找,
  MinerU 本地服务还会真的打一次 `/v1/health`(短超时)。
结果带 TTL 缓存(默认 30s),避免应用轮询时反复做 IO。
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import time
from pathlib import Path

CACHE_TTL_SECONDS = 30
_cache: dict = {"at": 0.0, "config_key": "", "value": None}


def _has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:  # noqa: BLE001
        return False


def _which(value: str, names: list[str]) -> str:
    """配置给了就用配置;否则按名字在 PATH / 常见位置找。返回找到的路径(空 = 没找到)。"""
    if value:
        return value if Path(value).exists() else ""
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return ""


def _pdf_tool_capability(config: dict) -> dict:
    directory = str(config.get("pdfToolDir") or "").strip()
    if not directory:
        return {"ok": False, "detail": "没配置 pdf_tool 目录"}
    script = Path(directory) / "pdf_tool" / "pdf_to_doc.py"
    if not script.exists():
        return {"ok": False, "detail": f"目录里没有 pdf_tool/pdf_to_doc.py:{directory}"}
    return {"ok": True, "detail": f"pdf_tool · {Path(directory).name}"}


def _mineru_capability(config: dict) -> dict:
    token = str(config.get("mineruToken") or "").strip()
    url = str(config.get("mineruLocalUrl") or "").strip()
    if url:
        try:
            import urllib.request

            request = urllib.request.Request(url.rstrip("/") + "/v1/health", method="GET")
            with urllib.request.urlopen(request, timeout=2) as response:  # noqa: S310 —— 只连本机/用户配的地址
                body = response.read(2000).decode("utf-8", "ignore")
            return {"ok": True, "detail": f"本地服务在跑:{url}", "mode": "local", "body": body[:200]}
        except Exception as exc:  # noqa: BLE001 —— 连不上就退到云端/未配置
            if token:
                return {"ok": True, "detail": f"本地服务连不上({exc.__class__.__name__}),有云端 token", "mode": "cloud"}
            return {"ok": False, "detail": f"本地服务连不上:{url}"}
    if token:
        return {"ok": True, "detail": "云端 token 已配置", "mode": "cloud"}
    return {"ok": False, "detail": "没配置本地服务地址,也没有云端 token"}


def _probe(config: dict) -> dict:
    python = str(config.get("python") or "").strip()
    interpreter = python or sys.executable
    capabilities = {
        "python": {"ok": True, "detail": f"{sys.version.split()[0]} · {interpreter}"},
        "pymupdf": {"ok": _has_module("pymupdf") or _has_module("fitz"), "detail": "文字层 / 文本型提取 / 红标清理"},
        "pillow": {"ok": _has_module("PIL"), "detail": "图片 → 单页 PDF"},
        "latex2mathml": {"ok": _has_module("latex2mathml"), "detail": "LaTeX → MathML"},
        "pdfTool": _pdf_tool_capability(config),
        "docvortex": {
            "ok": _has_module("docvortex") or bool(_which(str(config.get("docvortexPath") or ""), ["docvortex"])),
            "detail": "文档互转(Office / OFD / HTML / EPUB)",
        },
        "mineru": _mineru_capability(config),
        "calibre": {
            "ok": bool(_which(str(config.get("calibrePath") or ""), ["ebook-convert", "ebook-convert.exe"])),
            "detail": "EPUB → AZW3 / MOBI(老格式)",
        },
        "boko": {
            "ok": bool(_which(str(config.get("bokoPath") or ""), ["boko", "boko.exe"])),
            "detail": "EPUB → AZW3 / KFX(+ 反向),轻量替代",
        },
    }
    return capabilities


def probe_all(config: dict, *, ttl: int = CACHE_TTL_SECONDS, force: bool = False) -> dict:
    key = "|".join(f"{name}={config.get(name)}" for name in sorted(config))
    now = time.time()
    if not force and _cache["value"] is not None and _cache["config_key"] == key and now - _cache["at"] < ttl:
        return _cache["value"]
    value = _probe(config)
    _cache.update({"at": now, "config_key": key, "value": value})
    return value


def reset_cache() -> None:
    _cache.update({"at": 0.0, "config_key": "", "value": None})


def summarize(capabilities: dict) -> list[str]:
    """给日志/状态行用:把能力压成 ['pymupdf ✓', 'pdfTool ✗', …]。"""
    return [f"{name} {'✓' if bool(info.get('ok')) else '✗'}" for name, info in capabilities.items() if isinstance(info, dict)]


def os_env_hint() -> dict:
    """部署提示:常见环境变量(排查用)。"""
    return {key: bool(os.environ.get(key)) for key in ("MINERU_LOCAL_URL", "MINERU_TOKEN", "MINERU_API_KEY")}

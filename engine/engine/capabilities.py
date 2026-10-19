"""能力检测:引擎自己探自己的环境(应用不再逐个探测)。

`/v1/health` 上报的就是这里的结果 —— 每项给 `{ok, detail, kind, optional, fix}`:
- `kind`: `bundled`(引擎包里自带)/ `external`(要用外部程序或服务);
- `optional`: 外部组件里「不装也能用其它功能」的那些(Calibre / boko);
- `fix`: 不可用时**具体怎么补**(应用直接把它显示给用户);
- 内置能力(Python / PyMuPDF / Pillow / latex2mathml / 自带 pdf_tool):直接看解释器里有没有;
- 外部组件(DocVortex / MinerU / Calibre / boko):按配置路径 + PATH 找,
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

# 「包里没带、要另外装」的组件怎么补 —— 这些字会直接显示在应用的引擎卡片里。
FIX_DOCVORTEX = (
    "没装 DocVortex:文档互转(Office / OFD / HTML / EPUB)与内容提取要用它。"
    "可以一键装到引擎自己的 Python 里(应用里点「装到引擎」,或引擎目录下执行 "
    "python -m pip install docvortex),也可以在引擎配置里填 docvortexPath。"
)
FIX_MINERU = (
    "没配本地 MinerU 地址,也没有云端 token:公式与视觉提取要用它。"
    "本地 MinerU 是可选的独立组件(模型首次使用时按需下载,几百 MB ~ GB):"
    "装好后把服务地址填进引擎配置(设置页的「引擎配置 → MinerU 服务地址」),或填云端 MinerU token。"
)
FIX_CALIBRE = (
    "没找到 Calibre(ebook-convert):EPUB → AZW3 / MOBI(老格式)要用它。"
    "装完在引擎配置里填 calibrePath,或让它出现在 PATH 里。"
)
FIX_BOKO = (
    "没找到 boko:EPUB → AZW3 / KFX 的轻量替代(可选)。"
    "装完在引擎配置里填 bokoPath,或让它出现在 PATH 里。"
)
FIX_BUNDLED_DEP = "引擎自带的 Python 里缺这个依赖:重装引擎包,或 pip 装到引擎的 Python 里。"


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
    """与 kinds._pdf_tool_script 同一套候选:配置目录 → 引擎自带的 pdf_tool/。"""
    directory = str(config.get("pdfToolDir") or "").strip()
    candidates = [Path(directory)] if directory else []
    bundled = Path(__file__).resolve().parents[1] / "pdf-tool"
    if bundled.exists():
        candidates.append(bundled)
    if not candidates:
        return {
            "ok": False,
            "kind": "bundled",
            "detail": "PDF → Markdown / 内容提取 / 公式链",
            "fix": "引擎包里没带 pdf_tool,配置里也没填 pdfToolDir:重装引擎包,或填 pdfToolDir。",
        }
    for candidate in candidates:
        for script in (candidate / "pdf_tool" / "pdf_to_doc.py", candidate / "pdf_to_doc.py"):
            if script.exists():
                where = "自带" if candidate == bundled else f"配置 · {candidate.name}"
                return {"ok": True, "kind": "bundled", "detail": f"pdf_tool({where})"}
    return {
        "ok": False,
        "kind": "bundled",
        "detail": "PDF → Markdown / 内容提取 / 公式链",
        "fix": f"目录里没有 pdf_tool/pdf_to_doc.py:{candidates[0]};改 pdfToolDir,或清空它用引擎自带的。",
    }


def _boko_available(config: dict) -> bool:
    """boko 是否存在:与 kinds.boko_command 同一套候选(配置 → PATH)。"""
    try:
        from .kinds import boko_command

        return boko_command(config) is not None
    except Exception:  # noqa: BLE001 —— 探测失败就当没有
        return bool(_which(str(config.get("bokoPath") or ""), ["boko", "boko.exe"]))


def _calibre_available(config: dict) -> bool:
    """Calibre 是否存在:与 kinds.calibre_command 同一套候选(配置 → 常见位置 → PATH)。"""
    try:
        from .kinds import calibre_command

        return calibre_command(config) is not None
    except Exception:  # noqa: BLE001 —— 探测失败就当没有
        return bool(_which(str(config.get("calibrePath") or ""), ["ebook-convert", "ebook-convert.exe"]))


def _mineru_capability(config: dict) -> dict:
    token = str(config.get("mineruToken") or "").strip()
    url = str(config.get("mineruLocalUrl") or "").strip()
    base = {"kind": "external", "detail": "公式 / 视觉提取(本地服务或云端)"}
    if url:
        try:
            import urllib.request

            request = urllib.request.Request(url.rstrip("/") + "/v1/health", method="GET")
            with urllib.request.urlopen(request, timeout=2) as response:  # noqa: S310 —— 只连本机/用户配的地址
                body = response.read(2000).decode("utf-8", "ignore")
            return {**base, "ok": True, "detail": f"本地服务在跑:{url}", "mode": "local", "body": body[:200]}
        except Exception as exc:  # noqa: BLE001 —— 连不上就退到云端/未配置
            if token:
                return {**base, "ok": True, "detail": f"本地服务连不上({exc.__class__.__name__}),有云端 token", "mode": "cloud"}
            return {**base, "ok": False, "detail": f"本地服务连不上:{url}", "fix": FIX_MINERU}
    if token:
        return {**base, "ok": True, "detail": "云端 token 已配置", "mode": "cloud"}
    return {**base, "ok": False, "fix": FIX_MINERU}


def _probe(config: dict) -> dict:
    python = str(config.get("python") or "").strip()
    interpreter = python or sys.executable
    pymupdf_ok = _has_module("pymupdf") or _has_module("fitz")
    pillow_ok = _has_module("PIL")
    latex_ok = _has_module("latex2mathml")
    docvortex_ok = bool(_which(str(config.get("docvortexPath") or ""), ["docvortex", "docvortex.exe"])) or _has_module("docvortex")
    calibre_ok = _calibre_available(config)
    boko_ok = _boko_available(config)
    capabilities = {
        "python": {"ok": True, "kind": "bundled", "detail": f"{sys.version.split()[0]} · {interpreter}"},
        "pymupdf": {"ok": pymupdf_ok, "kind": "bundled", "detail": "文字层 / 文本型提取 / 红标清理", **({} if pymupdf_ok else {"fix": FIX_BUNDLED_DEP})},
        "pillow": {"ok": pillow_ok, "kind": "bundled", "detail": "图片 → 单页 PDF", **({} if pillow_ok else {"fix": FIX_BUNDLED_DEP})},
        "latex2mathml": {"ok": latex_ok, "kind": "bundled", "detail": "LaTeX → MathML", **({} if latex_ok else {"fix": FIX_BUNDLED_DEP})},
        "pdfTool": _pdf_tool_capability(config),
        "docvortex": {
            # 能跑才算:CLI 在 PATH 上,或能 import(真装的包没有 __main__,见 kinds._docvortex_commands)
            "ok": docvortex_ok,
            "kind": "external",
            # 引擎能把它装进自己的 Python(components.py 的白名单):应用据此给「装到引擎」按钮。
            "installable": True,
            "component": "docvortex",
            "detail": "文档互转(Office / OFD / HTML / EPUB)",
            **({} if docvortex_ok else {"fix": FIX_DOCVORTEX}),
        },
        "mineru": _mineru_capability(config),
        "calibre": {
            "ok": calibre_ok,
            "kind": "external",
            "optional": True,
            "detail": "EPUB → AZW3 / MOBI(老格式)",
            **({} if calibre_ok else {"fix": FIX_CALIBRE}),
        },        "boko": {
            "ok": boko_ok,
            "kind": "external",
            "optional": True,
            # 实测 v0.5.0:EPUB/KFX/AZW3 读写、MOBI 只读;MOBI 输出会被 boko 自己拒绝。
            "detail": "EPUB / KFX / AZW3 互转(快,MOBI 只读)",
            **({} if boko_ok else {"fix": FIX_BOKO}),
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


def detected_config(config: dict) -> dict:
    """自动探测到的**有效值**(给界面当缺省/占位):配置里填了用配置,否则给探测结果;空 = 没找到。

    `*Source`:configured(配置里填的)/ bundled(引擎自带)/ path(PATH 上找到的)/
    engine(引擎自己的 Python)/ ""(没找到)。界面用 `值 + 来源` 显示,不把探测结果写回配置。
    """
    import shutil

    from .kinds import _pdf_tool_script, boko_command, calibre_command

    python = str(config.get("python") or "").strip()
    detected: dict = {
        "python": python or sys.executable,
        "pythonSource": "configured" if python else "engine",
        "pdfTool": "",
        "pdfToolSource": "",
        "docvortex": "",
        "docvortexSource": "",
        "calibre": "",
        "calibreSource": "",
        "boko": "",
        "bokoSource": "",
    }
    try:
        detected["pdfTool"] = str(_pdf_tool_script(config))
        detected["pdfToolSource"] = "configured" if str(config.get("pdfToolDir") or "").strip() else "bundled"
    except Exception:  # noqa: BLE001 —— 没有就是没有,界面显示空
        pass
    custom_docvortex = str(config.get("docvortexPath") or "").strip()
    if custom_docvortex:
        detected["docvortex"], detected["docvortexSource"] = custom_docvortex, "configured"
    else:
        found = shutil.which("docvortex") or shutil.which("docvortex.exe")
        if found:
            detected["docvortex"], detected["docvortexSource"] = found, "path"
        elif _has_module("docvortex"):
            detected["docvortex"], detected["docvortexSource"] = "(引擎的 Python 里 import 得到)", "engine"
    calibre = calibre_command(config)
    if calibre:
        detected["calibre"] = calibre[0]
        detected["calibreSource"] = "configured" if str(config.get("calibrePath") or "").strip() else "path"
    boko = boko_command(config)
    if boko:
        detected["boko"] = boko[0]
        detected["bokoSource"] = "configured" if str(config.get("bokoPath") or "").strip() else "path"
    return detected


def summarize(capabilities: dict) -> list[str]:
    """给日志/状态行用:把能力压成 ['pymupdf ✓', 'pdfTool ✗', …]。"""
    return [f"{name} {'✓' if bool(info.get('ok')) else '✗'}" for name, info in capabilities.items() if isinstance(info, dict)]


def os_env_hint() -> dict:
    """部署提示:常见环境变量(排查用)。"""
    return {key: bool(os.environ.get(key)) for key in ("MINERU_LOCAL_URL", "MINERU_TOKEN", "MINERU_API_KEY")}

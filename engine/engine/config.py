"""引擎自己的配置:路径、凭据、并发。

配置归引擎所有(单一来源),应用通过 `/v1/config` 读写 —— 界面与功能解耦:
应用不关心这些路径怎么用,引擎不关心谁在点按钮。

- 位置:`ENGINE_CONFIG` 环境变量,或 `~/.uvreader-engine/config.json`(跨平台,安装目录只读也能跑);
- 令牌类字段对外**只回 has 布尔**,不回原值;
- 未知字段一律忽略(版本差异不会把配置写坏)。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULTS: dict = {
    "pdfToolDir": "",      # pdf_tool checkout(内含 pdf_tool/pdf_to_doc.py)
    "python": "",          # 跑 pdf_tool / DocVortex 的解释器;留空用引擎自己的
    "docvortexPath": "",   # DocVortex CLI 路径;留空按引擎 Python / PATH 找
    "mineruLocalUrl": "",  # 本地 MinerU 服务地址(如 http://127.0.0.1:8000)
    "mineruToken": "",     # 云端 MinerU token(不回显)
    "mineruModel": "vlm",
    "mineruLocalExe": "",  # mineru-kit 可执行文件(pdf_tool 的 helper 靠它找 venv)
    "calibrePath": "",     # ebook-convert 路径;留空按 PATH / 常见位置找
    "bokoPath": "",        # boko 二进制路径
    "workers": 2,          # 同时运行的作业数
}

SECRET_KEYS = ("mineruToken",)


def config_path() -> Path:
    override = os.environ.get("ENGINE_CONFIG", "").strip()
    if override:
        return Path(override)
    return Path.home() / ".uvreader-engine" / "config.json"


def load_config() -> dict:
    config = dict(DEFAULTS)
    path = config_path()
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                for key, value in data.items():
                    if key in DEFAULTS:
                        config[key] = value
    except Exception:  # noqa: BLE001 —— 配置坏了就用默认值,不拦服务
        pass
    return config


def public_config(config: dict) -> dict:
    """对外视图:令牌只回 has,不回原值。"""
    view = {key: config.get(key, DEFAULTS[key]) for key in DEFAULTS}
    for key in SECRET_KEYS:
        view[f"has{key[0].upper()}{key[1:]}"] = bool(str(config.get(key) or "").strip())
        view[key] = ""
    return view


def save_config(patch: dict) -> dict:
    """部分更新:只认白名单字段;空字符串表示清空(令牌留空 = 不改,见调用方)。"""
    config = load_config()
    for key, value in (patch or {}).items():
        if key not in DEFAULTS:
            continue
        if key == "workers":
            try:
                config[key] = max(1, min(8, int(value)))
            except Exception:  # noqa: BLE001
                continue
            continue
        config[key] = str(value or "")
    path = config_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)
    except Exception:  # noqa: BLE001 —— 写不进去也不该 500;调用方看返回即可
        pass
    return config

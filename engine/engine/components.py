"""可选组件:引擎可以把它自己用到的外部组件**装进自己的 Python**(不碰系统 Python)。

目前只有 DocVortex(pip 包,依赖 onnxruntime 等,所以不随包发;见包内 README)。
白名单写死在这里 —— 应用只能按名字点「装到引擎」,不能塞任意包名。

装法:`<引擎的 Python> -m pip install --target <引擎的 site-packages> --upgrade <包>`
- 引擎包里带了 pip(打包时装的),所以 embeddable 版也能自己装;
- `--target` 指到解释器自己在用的 site-packages(Windows 是 <bundle>/site-packages,
  macOS/Linux 是 python/lib/python3.x/site-packages),装完 `import` 就能用。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# name -> {packages, label, need, size}
COMPONENTS: dict[str, dict] = {
    "docvortex": {
        "packages": ["docvortex"],
        "label": "DocVortex",
        "need": "文档互转(Office / OFD / HTML / EPUB)与内容提取",
        "size": "约 200 MB 下载(含 onnxruntime)",
    },
}


def component_list() -> list[dict]:
    return [{"name": name, **{key: value for key, value in info.items() if key != "packages"}} for name, info in COMPONENTS.items()]


def site_packages() -> Path:
    """解释器真正在用的 site-packages:先看 sys.path(embeddable 的 ._pth 会指到 <bundle>/site-packages),
    再退回 sysconfig 的 purelib。"""
    for entry in sys.path:
        if entry and str(entry).replace("\\", "/").endswith("site-packages") and Path(entry).exists():
            return Path(entry)
    import sysconfig

    return Path(sysconfig.get_paths()["purelib"])


def _run_pip(packages: list[str], target: Path, on_line, should_cancel=None) -> int:
    """真的跑 pip(单独一个函数,测试里好替换)。取消就 kill。"""
    command = [
        sys.executable, "-m", "pip", "install",
        "--upgrade", "--no-input", "--prefer-binary", "--disable-pip-version-check",
        "--target", str(target),
        *packages,
    ]
    process = subprocess.Popen(  # noqa: S603 —— 命令是白名单 + 固定参数拼的
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="ignore",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0,
    )
    assert process.stdout is not None
    for line in process.stdout:
        if should_cancel is not None and should_cancel():
            try:
                process.kill()
            except Exception:  # noqa: BLE001
                pass
            raise RuntimeError("已取消")
        on_line(line.rstrip())
    return process.wait()


def install_component(config: dict, name: str, report=None, run_pip=None, should_cancel=None) -> dict:
    """装一个白名单组件;返回 {name, installed, log}。report({label}) 用来报进度。

    run_pip 不传就用真的 _run_pip(调用时解析,测试里 monkeypatch 得动)。
    """
    run_pip = run_pip or _run_pip
    key = str(name or "").strip().lower()
    info = COMPONENTS.get(key)
    if info is None:
        raise ValueError(f"未知组件:{name or '(空)'};可装的是:{', '.join(COMPONENTS)}")
    target = site_packages()
    report = report or (lambda _row: None)
    report({"label": f"准备装 {info['label']}({info['size']})…"})
    lines: list[str] = []

    def on_line(line: str) -> None:
        if not line:
            return
        lines.append(line)
        if len(lines) > 200:
            del lines[:100]
        lowered = line.lower()
        if lowered.startswith("collecting") or lowered.startswith("downloading") or lowered.startswith("installing"):
            report({"label": f"装 {info['label']}:{line[:120]}"})

    report({"label": f"正在装 {info['label']}(下载后会自动装进引擎的 Python)…"})
    code = run_pip(list(info["packages"]), target, on_line, should_cancel)
    if code != 0:
        tail = " / ".join(lines[-6:]) or f"pip 退出码 {code}"
        raise RuntimeError(f"{info['label']} 安装失败:{tail[:400]}")
    report({"label": f"{info['label']} 装好了,正在重探能力…"})
    return {"name": key, "installed": list(info["packages"]), "target": str(target), "log": lines[-20:]}

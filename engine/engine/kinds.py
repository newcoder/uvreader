"""引擎的作业类型与同步接口实现。

E1 先搬两样(证明契约能跑通):
- `/v1/math`(同步):LaTeX → MathML,从应用的 math-render.py helper 原样搬过来;
- `/v1/jobs kind=text-layer`:PDF → 每页纯文本(PyMuPDF),给「文字层 / 可搜索 PDF」用。
E2 再把 extract / convert / pdf-text / outline / redact / images-to-pdf / ebook-convert 搬进来。
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

from .jobs import Job, report_progress

# ── LaTeX → MathML(同步接口)──────────────────────────────────────────

_TAG_RE = re.compile(r"\\tag\{[^}]*\}")
_ENV_RE = re.compile(r"\\(begin|end)\{(aligned|align|array|matrix|pmatrix|bmatrix|cases)\}")
_EMPTY_FONT_RE = re.compile(r"\\(mathbb|mathcal|mathfrak|mathbf|mathsf|mathtt|mathit|mathrm)\s*\{\s*\}")
_DANGLING_AFTER_GROUP_RE = re.compile(r"}\s*(?=[_^]\s*\{)")
_DANGLING_SCRIPT_RE = re.compile(r"(?<![\\\w}\]])[_^]\s*\{([^{}]*)\}")
_LEADING_SCRIPT_RE = re.compile(r"^\s*[_^]\s*\{([^{}]*)\}\s*")


def clean_latex(latex: str) -> str:
    """与应用的 Python helper 一致:去掉 \\tag 与环境外壳、清掉 &。"""
    text = _TAG_RE.sub("", str(latex or ""))
    text = _ENV_RE.sub("", text)
    return text.replace("&", "").strip()


def repair_latex(cleaned: str) -> str:
    """上游把字体命令的字母丢成空壳(\\mathbb { })时,补方块并清悬空上下标(重试路径)。"""
    text = _EMPTY_FONT_RE.sub(r"\\square", cleaned)
    text = _DANGLING_AFTER_GROUP_RE.sub("", text)
    text = _DANGLING_SCRIPT_RE.sub("", text)
    return _LEADING_SCRIPT_RE.sub("", text).strip()


def render_math(items: list[str]) -> dict[str, str]:
    """逐条转 MathML;失败时重试一次(修复),再失败给空串(应用侧回退原文)。"""
    from latex2mathml.converter import convert

    out: dict[str, str] = {}
    for latex in items or []:
        cleaned = clean_latex(latex)
        try:
            out[latex] = convert(cleaned)
            continue
        except Exception:  # noqa: BLE001 —— 换修复后的写法再试一次
            pass
        try:
            out[latex] = convert(repair_latex(cleaned))
        except Exception:  # noqa: BLE001 —— 两条都失败:交给应用回退
            out[latex] = ""
    return out


# ── 文字层(PDF → 每页纯文本)──────────────────────────────────────────

def run_text_layer(job: Job) -> dict:
    """与应用的 text-layer 脚本一致:PyMuPDF 逐页取文本,写成 JSON 文件。"""
    import fitz

    source = str(job.args.get("source") or "")
    if not source or not Path(source).exists():
        raise FileNotFoundError(f"找不到 PDF:{source}")
    out_path = str(job.args.get("out") or "").strip() or str(Path(source).with_suffix(".text-layer.json"))
    report_progress(job, label="读取文字层…")
    doc = fitz.open(source)
    try:
        total = doc.page_count
        pages: list[str] = []
        for index, page in enumerate(doc, start=1):
            if job.cancelled():
                raise RuntimeError("已取消")
            pages.append(page.get_text())
            report_progress(job, done=index, total=total)
    finally:
        doc.close()
    target = Path(out_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    return {"pages": len(pages), "path": str(target), "chars": sum(len(page) for page in pages)}


# ── PDF 自带大纲(/v1/jobs kind=outline)────────────────────────────────

def run_outline(job: Job) -> dict:
    """PDF 书签:[{level, title, page}];扫描件也常带(与有没有文字层无关)。"""
    import fitz

    source = str(job.args.get("source") or "")
    if not source or not Path(source).exists():
        raise FileNotFoundError(f"找不到 PDF:{source}")
    report_progress(job, label="读取大纲…")
    doc = fitz.open(source)
    try:
        entries: list[dict] = []
        for item in doc.get_toc(simple=True):
            try:
                level, title, page = int(item[0]), str(item[1]).strip(), int(item[2])
            except Exception:  # noqa: BLE001 —— 单条坏了跳过,别丢整份大纲
                continue
            if title:
                entries.append({"level": level, "title": title, "page": page})
    finally:
        doc.close()
    return {"count": len(entries), "entries": entries}


# ── 图片 → PDF(/v1/jobs kind=images-to-pdf)────────────────────────────

def run_images_to_pdf(job: Job) -> dict:
    """每张图一页,尺寸按 150dpi 换算(不重采样;与应用里的脚本一致)。"""
    from PIL import Image

    images = [str(item) for item in (job.args.get("images") or []) if str(item).strip()]
    out_path = str(job.args.get("out") or "").strip()
    if not images:
        raise ValueError("没有图片")
    if not out_path:
        raise ValueError("没有输出路径")
    pages = []
    total = len(images)
    for index, path in enumerate(images, start=1):
        if job.cancelled():
            raise RuntimeError("已取消")
        report_progress(job, done=index - 1, total=total, label=f"读图 {index}/{total}")
        image = Image.open(path)
        if image.mode != "RGB":
            image = image.convert("RGB")
        image.info["dpi"] = (150, 150)
        pages.append(image)
    target = Path(out_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    pages[0].save(str(target), "PDF", save_all=True, append_images=pages[1:], dpi=(150, 150), resolution=150.0)
    report_progress(job, done=total, total=total)
    return {"path": str(target), "pages": len(pages)}


# ── 通用:跑外部命令(进度心跳 / 取消 / 超时)──────────────────────────

def run_process(job: Job, command: str, args: list[str], *, cwd: str | None = None,
                env: dict | None = None, timeout: float = 1800.0, label: str = "") -> tuple[int, str]:
    """跑一个外部命令:每隔一会儿检查取消并报进度,取消/超时都 kill。返回 (退出码, 输出尾部)。"""
    import subprocess

    report_progress(job, label=label or "运行中…")
    try:
        child = subprocess.Popen(  # noqa: S603 —— 命令与参数都由引擎自己构造
            [command, *args], cwd=cwd or None, env=env or None,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"找不到命令:{command}({exc})") from exc
    deadline = time.time() + max(5.0, float(timeout))
    output = ""
    try:
        while True:
            if job.cancelled():
                child.kill()
                raise RuntimeError("已取消")
            if time.time() > deadline:
                child.kill()
                raise RuntimeError(f"命令超时:{command}")
            try:
                chunk, _ = child.communicate(timeout=1.0)
                output += chunk or ""
                break
            except subprocess.TimeoutExpired:
                continue
        return child.returncode or 0, output
    finally:
        if child.poll() is None:
            try:
                child.kill()
            except Exception:  # noqa: BLE001
                pass


# ── PDF 红标清理(/v1/jobs kind=redact)──────────────────────────────────

def run_redact(job: Job) -> dict:
    """按页面矩形擦除(文字 / 图片 / 矢量一起),产出干净副本;与应用里的脚本一致。"""
    import fitz

    source = str(job.args.get("source") or "")
    out_path = str(job.args.get("out") or "").strip()
    if not source or not Path(source).exists():
        raise FileNotFoundError(f"找不到 PDF:{source}")
    if not out_path:
        raise ValueError("没有输出路径")
    grouped: dict[int, list] = {}
    for item in job.args.get("rects") or []:
        try:
            page_number = int(item.get("page") or 0)
            box = [float(value) for value in (item.get("rect") or [])]
        except Exception:  # noqa: BLE001 —— 单条坏了跳过
            continue
        if page_number > 0 and len(box) == 4:
            grouped.setdefault(page_number, []).append(box)
    report_progress(job, label="擦除页眉页脚 / 水印…")
    doc = fitz.open(source)
    try:
        total = len(grouped)
        for index, (page_number, boxes) in enumerate(grouped.items(), start=1):
            if job.cancelled():
                raise RuntimeError("已取消")
            report_progress(job, done=index - 1, total=total)
            if not 1 <= page_number <= doc.page_count:
                continue
            page = doc[page_number - 1]
            for box in boxes:
                page.add_redact_annot(fitz.Rect(box))
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_PIXELS,
                graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                text=fitz.PDF_REDACT_TEXT_REMOVE,
            )
        target = Path(out_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(target), garbage=3, deflate=True)
    finally:
        doc.close()
    removed = sum(len(boxes) for boxes in grouped.values())
    report_progress(job, done=len(grouped), total=len(grouped))
    return {"path": str(target), "removed": removed}


# ── PDF → Doc JSON(pdf_tool;kind=extract)──────────────────────────────

def _pdf_tool_script(config: dict) -> Path:
    """pdf_tool 的位置:配置优先,没配就用引擎自带的(打包时放进 <engine_root>/pdf_tool)。"""
    directory = str(config.get("pdfToolDir") or "").strip()
    candidates = []
    if directory:
        candidates.append(Path(directory))
    bundled = Path(__file__).resolve().parents[1] / "pdf-tool"
    if bundled.exists():
        candidates.append(bundled)
    if not candidates:
        raise RuntimeError("没有 pdf_tool:引擎包里没带,配置里也没填 pdfToolDir")
    for candidate in candidates:
        script = candidate / "pdf_tool" / "pdf_to_doc.py"
        if script.exists():
            return script
        # 自带的可能是仓库根(pdf_tool/pdf_to_doc.py 的上一层就是根)
        script = candidate / "pdf_to_doc.py"
        if script.exists():
            return script
    raise RuntimeError(f"目录里没有 pdf_tool/pdf_to_doc.py:{candidates[0]}")


def run_extract(job: Job) -> dict:
    """跑 pdf_tool 的 `pdf_to_doc.py --mode mineru --formats json`(与应用同一套参数与环境)。"""
    from .config import load_config

    config = load_config()
    script = _pdf_tool_script(config)
    source = str(job.args.get("source") or "")
    out_dir = str(job.args.get("outDir") or "").strip()
    if not source or not Path(source).exists():
        raise FileNotFoundError(f"找不到 PDF:{source}")
    if not out_dir:
        raise ValueError("没有输出目录")
    # 产物目录先建出来(真 pdf_tool 会自建;这样 stub / 只读场景也稳)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    python = str(job.args.get("python") or config.get("python") or "").strip() or sys.executable
    mode = str(job.args.get("mode") or "mineru").strip() or "mineru"
    formats = str(job.args.get("formats") or "json").strip() or "json"
    args = [str(script), "--pdf", source, "--mode", mode, "--formats", formats, "--out-dir", out_dir]
    model = str(job.args.get("model") or config.get("mineruModel") or "").strip()
    if model:
        args.extend(["--mineru-model", model])
    mineru_source = str(job.args.get("mineruSource") or "").strip()
    if mineru_source and mineru_source != "auto":
        args.extend(["--mineru-source", mineru_source])
    pages = str(job.args.get("pages") or "").strip()
    if pages:
        args.extend(["--pages", pages])
    env = dict(os.environ)
    # 与应用的约定一致:地址 / 令牌 / 本地程序走环境;中文报错按 UTF-8 出来。
    env["MINERU_LOCAL_URL"] = str(config.get("mineruLocalUrl") or "")
    if str(config.get("mineruToken") or "").strip():
        env["MINERU_TOKEN"] = str(config["mineruToken"])
    if str(config.get("mineruLocalExe") or "").strip():
        env["MINERU_LOCAL_CMD"] = str(config["mineruLocalExe"])
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    code, output = run_process(job, python, args, cwd=str(config.get("pdfToolDir") or "").strip() or None,
                               env=env, timeout=float(job.args.get("timeoutMs") or 1800_000) / 1000.0,
                               label="pdf_tool 提取中…")
    if code != 0:
        raise RuntimeError(f"pdf_tool 退出码 {code}:{output.strip()[-300:]}")
    produced = sorted(str(path.name) for path in Path(out_dir).glob("*_doc.json"))
    return {"outDir": out_dir, "produced": produced, "log": output.strip()[-400:]}


# ── 文档互转(DocVortex;kind=convert)──────────────────────────────────

def _docvortex_commands(config: dict) -> list[list[str]]:
    """DocVortex 的调用方式(按可用性排序):配置路径 → PATH 上的 CLI → `python -c` 直接调入口。
    实测 `python -m docvortex` 会报 `No module named docvortex.__main__`(没有 __main__),
    而 console_scripts 入口是 `docvortex.cli:main` —— 打包版(embeddable python 没有 Scripts)
    就靠最后这条。"""
    import shutil

    custom = str(config.get("docvortexPath") or "").strip()
    python = str(config.get("python") or "").strip() or sys.executable
    commands: list[list[str]] = []
    if custom:
        commands.append([custom])
    found = shutil.which("docvortex") or shutil.which("docvortex.exe")
    if found:
        commands.append([found])
    commands.append([python, "-c", "import sys; from docvortex.cli import main; sys.exit(main())"])
    return commands


def run_convert(job: Job) -> dict:
    """跑 DocVortex 的 `convert <源> --format <目标> --output <产物> --overwrite`。"""
    from .config import load_config

    config = load_config()
    source = str(job.args.get("source") or "")
    out_path = str(job.args.get("out") or "").strip()
    target_format = str(job.args.get("format") or "markdown").strip()
    if not source or not Path(source).exists():
        raise FileNotFoundError(f"找不到源文件:{source}")
    if not out_path:
        raise ValueError("没有输出路径")
    parse_mode = str(job.args.get("parseMode") or "").strip()
    base = ["convert", source, "--format", target_format, "--output", out_path, "--overwrite"]
    if parse_mode:
        base.extend(["--parse-mode", parse_mode])
    last_error = ""
    for command in _docvortex_commands(config):
        code, output = run_process(job, command[0], [*command[1:], *base], timeout=1800.0, label="DocVortex 转换中…")
        if code == 0 and Path(out_path).exists():
            return {"out": out_path, "log": output.strip()[-400:]}
        last_error = f"退出码 {code}:{output.strip()[-300:]}"
    raise RuntimeError(f"DocVortex 转换失败:{last_error}")


# ── 文本型提取(kind=pdf-text)──────────────────────────────────────────

def run_pdf_text(job: Job) -> dict:
    """跑引擎自带的 pdf_text.py(与应用同一份脚本):结构化行 / 图区 / 家具判定都在里面。"""
    source = str(job.args.get("source") or "")
    if not source or not Path(source).exists():
        raise FileNotFoundError(f"找不到 PDF:{source}")
    base = Path(str(job.args.get("workDir") or Path(source).parent))
    base.mkdir(parents=True, exist_ok=True)
    out_file = base / "pdf-text.json"
    assets_dir = base / "assets"
    script = Path(__file__).with_name("scripts") / "pdf_text.py"
    code, output = run_process(
        job, sys.executable, [str(script), source, str(out_file), str(assets_dir)],
        timeout=float(job.args.get("timeoutMs") or 300_000) / 1000.0,
        label="读取文本结构…",
    )
    if code != 0:
        raise RuntimeError(f"文本型提取失败(退出码 {code}):{output.strip()[-300:]}")
    if not out_file.exists():
        raise RuntimeError("没有生成文本结构文件")
    pages = json.loads(out_file.read_text(encoding="utf-8"))
    if not isinstance(pages, list) or not pages:
        raise RuntimeError("PDF 没有文本页")
    return {"path": str(out_file), "pages": len(pages)}


# 作业类型注册表(**必须放文件末尾**:函数得先定义出来,否则 NameError)。
JOB_KINDS = {
    "text-layer": run_text_layer,
    "outline": run_outline,
    "images-to-pdf": run_images_to_pdf,
    "redact": run_redact,
    "extract": run_extract,
    "convert": run_convert,
    "pdf-text": run_pdf_text,
}

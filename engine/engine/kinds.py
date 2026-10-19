"""引擎的作业类型与同步接口实现。

E1 先搬两样(证明契约能跑通):
- `/v1/math`(同步):LaTeX → MathML,从应用的 math-render.py helper 原样搬过来;
- `/v1/jobs kind=text-layer`:PDF → 每页纯文本(PyMuPDF),给「文字层 / 可搜索 PDF」用。
E2 再把 extract / convert / pdf-text / outline / redact / images-to-pdf / ebook-convert 搬进来。
"""
from __future__ import annotations

import json
import re
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


JOB_KINDS = {
    "text-layer": run_text_layer,
}

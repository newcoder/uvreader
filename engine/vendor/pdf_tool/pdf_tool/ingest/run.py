"""P1 统一抽取入口：PDF / 照片 / DOCX → 题目 JSON + 审计 + 批量报告。

- PDF（文本型走 text、扫描件走 vision；`--via browser` 走 box 协议）复用现有流水线；
- 照片：包成单页 PDF 后同 PDF 流程；
- DOCX：自研适配 → blocks/doc_text → text_extract 文本抽取 → assemble + 审计；
- 已有产物默认复用（--force 重跑）；批量结果落 `output/_p1_report.json`。
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from pdf_tool.core.io import save_json
from pdf_tool.core.paths import OUT_ROOT, PROMPTS_DIR, ROOT, WORK_ROOT
from pdf_tool.extract import audit as audit_mod
from pdf_tool.extract import vision_extract as vx
from pdf_tool.extract.doc_mode import extract_document
from pdf_tool.ingest import docx as docx_ingest
from pdf_tool.ingest import photo
from pdf_tool.model.document import blocks_to_doc

log = logging.getLogger("pdf_tool.ingest")

SUPPORTED = {".pdf", ".docx", ".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
# 完整性启发式：行首「数字+点号」的题干样式行（代码行号/输出可能有噪声，仅作参考）
_QNO_RE = re.compile(r"(?m)^\s*\d{1,3}\s*[.、．]\s*\S")


def count_question_like(text: str) -> int:
    return len(_QNO_RE.findall(text or ""))


def _client(via: str, model: str):
    if via == "browser":
        from pdf_tool.llm.browser_client import BrowserVisionClient

        return BrowserVisionClient()
    from pdf_tool.llm.vision_client import VisionClient

    return VisionClient(model=model)


def _summarize_questions(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data.get("questions"), list):
        return {"questions": len(data["questions"])}
    blocks = data.get("blocks") or []
    return {"questions": sum(1 for b in blocks if b.get("type") == "question"),
            "blocks": len(blocks)}


def _audit_of(path: Path) -> dict:
    if not path.exists():
        return {}
    d = json.loads(path.read_text(encoding="utf-8"))
    return {"ok": d.get("ok"), "issues": d.get("issues") or [],
            "warnings": (d.get("warnings") or [])[:3]}


def _pdf_mode(pdf: Path, via: str) -> tuple[str, Path]:
    from pdf_tool.assets.crops import detect_engine

    stem = pdf.stem
    if via == "browser":
        return "box", OUT_ROOT / stem / f"{stem}_box.json"
    if detect_engine(pdf) == "pp":
        return "vision", OUT_ROOT / stem / f"{stem}_questions.json"
    return "text", OUT_ROOT / stem / f"{stem}_questions.json"


def _run_pdf(pdf: Path, *, via: str, model: str, force: bool, timeout: int = 7200) -> dict:
    mode, out_json = _pdf_mode(pdf, via)
    audit_json = out_json.with_name(out_json.name.replace("_box.json", "_box_audit.json")
                                    .replace("_questions.json", "_audit.json"))
    if out_json.exists() and not force:
        return {**_summarize_questions(out_json), "mode": mode, "cached": True,
                "out": str(out_json), "audit": _audit_of(audit_json)}
    cmd = [sys.executable, "pdf_tool/pdf_to_questions.py", "--pdf", str(pdf),
           "--mode", mode, "--via", via, "--model", model]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,  # noqa: S603
                          encoding="utf-8", errors="replace",
                          env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                          timeout=timeout, check=False)
    if proc.returncode != 0 or not out_json.exists():
        tail = ((proc.stdout or "") + (proc.stderr or ""))[-800:]
        return {"mode": mode, "error": f"exit={proc.returncode}", "log": tail,
                "elapsed_s": round(time.time() - t0, 1)}
    return {**_summarize_questions(out_json), "mode": mode, "cached": False,
            "out": str(out_json), "audit": _audit_of(audit_json),
            "elapsed_s": round(time.time() - t0, 1)}


def _run_docx(src: Path, *, via: str, model: str, doc_model: str, force: bool) -> dict:
    stem = src.stem
    out_dir = OUT_ROOT / stem
    work = WORK_ROOT / stem / "ingest"
    work.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    blocks, figs = docx_ingest.to_blocks(src, out_dir, OUT_ROOT)
    doc_text, pages = docx_ingest.build_doc_text(blocks, figs)
    (work / "doc_text.txt").write_text(doc_text, encoding="utf-8")
    save_json(out_dir / f"{stem}_doc.json",
              blocks_to_doc(blocks, source={"path": str(src), "kind": "docx",
                                            "pages": len(pages)},
                            page_count=len(pages)))
    results_file = work / "results.json"
    if results_file.exists() and not force:
        page_results = json.loads(results_file.read_text(encoding="utf-8"))["pages"]
        cached = True
    else:
        client = _client(via, doc_model)
        try:
            rules = (PROMPTS_DIR / "text_extract.md").read_text(encoding="utf-8")
            page_results = extract_document(client, rules, doc_text, {f["n"] for f in figs})
        finally:
            close = getattr(client, "close", None)
            if close is not None:
                close()
        save_json(results_file, {"pages": page_results})
        cached = False
    out_json = out_dir / f"{stem}_questions.json"
    data = vx.assemble(page_results, figs, out_json,
                       source={"file": src.name, "pages": len(pages), "engine": "text(docx)"})
    audit = audit_mod.audit_result(None, page_results, figs, data, check_page_coverage=False)
    save_json(out_dir / f"{stem}_audit.json", audit)
    log.info("[ingest] docx %s: %d 题 / %d 图 / 伪页 %d", src.name, len(data["questions"]),
             len(figs), len(pages))
    return {"mode": "text(docx)", "questions": len(data["questions"]), "images": len(figs),
            "pseudo_pages": len(pages), "cached": cached, "out": str(out_json),
            "audit": {"ok": audit["ok"], "issues": audit["issues"],
                      "warnings": audit["warnings"][:3]},
            "doc_text_chars": len(doc_text), "question_like_lines": count_question_like(doc_text),
            "elapsed_s": round(time.time() - t0, 1)}


def _run_image(src: Path, *, via: str, model: str, force: bool) -> dict:
    work = WORK_ROOT / src.stem / "ingest"
    work.mkdir(parents=True, exist_ok=True)
    pdf = photo.to_pdf(src, work / f"{src.stem}.pdf")
    return _run_pdf(pdf, via=via, model=model, force=force)


def extract_one(src, *, via: str = "api", model: str = "deepseek-flash",
                doc_model: str = "deepseek-flash", force: bool = False) -> dict:
    """单个文件 → 摘要 dict（含 questions/audit/error）。"""
    src = Path(src)
    suffix = src.suffix.lower()
    base = {"file": src.name, "stem": src.stem}
    if suffix not in SUPPORTED:
        return {**base, "error": f"不支持的格式 {suffix}"}
    try:
        if suffix == ".pdf":
            result = _run_pdf(src, via=via, model=model, force=force)
        elif suffix == ".docx":
            result = _run_docx(src, via=via, model=model, doc_model=doc_model, force=force)
        else:
            result = _run_image(src, via=via, model=model, force=force)
    except Exception as e:
        log.exception("[ingest] %s 失败", src.name)
        result = {"error": f"{type(e).__name__}: {e}"}
    return {**base, **result}


def extract_many(paths, *, via: str = "api", model: str = "deepseek-flash",
                 doc_model: str = "deepseek-flash", force: bool = False) -> list[dict]:
    """批量抽取；报告**增量合并**到 `output/_p1_report.json`（单文件重跑不丢其它条目）。

    返回本次处理的结果列表（报告里则包含历史全部条目）。
    """
    results = [extract_one(p, via=via, model=model, doc_model=doc_model, force=force)
               for p in paths]
    report_path = OUT_ROOT / "_p1_report.json"
    merged: dict[str, dict] = {}
    if report_path.exists():
        try:
            old = json.loads(report_path.read_text(encoding="utf-8"))
            for r in old.get("results") or []:
                if isinstance(r, dict) and (r.get("stem") or r.get("file")):
                    merged[r.get("stem") or r["file"]] = r
        except Exception:
            log.warning("旧 _p1_report.json 无法解析，按本次结果重建")
    for r in results:
        merged[r.get("stem") or r.get("file")] = r
    save_json(report_path, {"results": [merged[k] for k in sorted(merged)]})
    return results


def list_inputs(root: Path) -> list[Path]:
    """目录 → 支持的文件列表（跳过临时/隐藏）。"""
    out = []
    for p in sorted(Path(root).iterdir()):
        if p.name.startswith((".", "~$")):
            continue
        if p.is_file() and p.suffix.lower() in SUPPORTED:
            out.append(p)
    return out

"""Doc 模型的分元素审计：ID / 页覆盖 / 表格 / 代码 / 公式 / 图片。

与抽取流水线的 stats 审计（`extract/audit.py`、`extract/pdf_doc_pipeline.py` 的 stats）
不同：这里只针对规范 Doc 的结构质量，纯离线、不调模型。
"""
from __future__ import annotations

import logging
from pathlib import Path

from pdf_tool.model.document import SCHEMA_VERSION, doc_stats, iter_blocks

log = logging.getLogger("pdf_tool.audit")

_HEADING_LEVELS = (1, 2, 3, 4, 5, 6)


def audit_doc(doc: dict, *, base: Path | None = None,
              check_files: bool = True) -> dict:
    """返回 {"ok", "issues", "warnings", "stats", ...}；ok=False 表示结构失守。

    base：图片等相对路径的基准目录（存在性检查，缺失记 warning 而非 issue）。
    """
    issues: list[str] = []
    warnings: list[str] = []

    if doc.get("schema_version") != SCHEMA_VERSION:
        issues.append(f"schema_version 应为 {SCHEMA_VERSION}，实际 {doc.get('schema_version')}")

    seen_ids: set[str] = set()
    dup_ids: list[str] = []
    empty_pages: list[int] = []
    table_issues: list[str] = []
    code_empty: list[str] = []
    equation_bad: list[str] = []
    image_bad: list[str] = []
    image_missing: list[str] = []
    heading_bad: list[str] = []

    for page, b in iter_blocks(doc):
        bid = str(b.get("id") or "")
        if not bid:
            issues.append(f"第 {page} 页存在无 id 的块")
        elif bid in seen_ids:
            dup_ids.append(bid)
        else:
            seen_ids.add(bid)

        t = b.get("type")
        if t == "heading":
            level = b.get("level")
            text = str(b.get("text") or "").strip()
            if not text:
                heading_bad.append(f"{bid}(空标题)")
            elif level not in _HEADING_LEVELS:
                warnings.append(f"{bid}: heading level={level} 不在 1-6")
        elif t == "text":
            if not str(b.get("text") or "").strip():
                warnings.append(f"{bid}: 空文本块")
            if b.get("question_options_incomplete"):
                miss = "".join(b.get("options_missing") or [])
                qno = b.get("question_no")
                where = f"第 {qno} 题" if isinstance(qno, int) else "题目"
                warnings.append(f"{bid}: {where}选项不完整（缺 {miss or '未知'}）")
        elif t == "table":
            headers = b.get("headers") or []
            rows = b.get("rows") or []
            if not headers and not rows:
                table_issues.append(f"{bid}(空表)")
            else:
                widths = {len(r) for r in rows}
                if widths and len(widths) > 1:
                    table_issues.append(f"{bid}(行宽不一致 {sorted(widths)})")
                if headers and rows and len(headers) != len(rows[0]):
                    table_issues.append(
                        f"{bid}(表头 {len(headers)} 列/数据 {len(rows[0])} 列)")
        elif t == "code":
            if not str(b.get("content") or b.get("text") or "").strip():
                code_empty.append(bid)
            if b.get("incomplete") or b.get("code_gaps"):
                nums = [n for g in (b.get("code_gaps") or [])
                        for n in (g.get("expected") or [])]
                warnings.append(f"{bid}: 代码可能缺行（{nums or '未知'}）")
        elif t == "equation":
            if not str(b.get("latex") or b.get("text") or "").strip() \
                    and not b.get("image"):
                equation_bad.append(bid)
        elif t == "image":
            src = str(b.get("src") or (b.get("image") or {}).get("src") or "")
            if not src:
                image_bad.append(bid)
            elif check_files and base is not None:
                p = Path(base) / src
                if not p.exists():
                    image_missing.append(f"{bid}({src})")

    for pg in doc.get("pages") or []:
        if not pg.get("blocks"):
            empty_pages.append(pg.get("page"))

    if dup_ids:
        issues.append(f"重复 id: {sorted(set(dup_ids))}")
    if table_issues:
        issues.append(f"表格异常: {table_issues}")
    if code_empty:
        issues.append(f"空代码块: {code_empty}")
    if equation_bad:
        issues.append(f"公式缺 LaTeX 与图片: {equation_bad}")
    if image_bad:
        issues.append(f"图片缺 src: {image_bad}")
    if image_missing:
        warnings.append(f"图片文件不存在（基准 {base}）: {image_missing}")
    if heading_bad:
        warnings.append(f"空标题: {heading_bad}")
    if empty_pages:
        warnings.append(f"空页: {empty_pages}")

    stats = doc_stats(doc)
    return {"ok": not issues, "issues": issues, "warnings": warnings,
            "empty_pages": empty_pages, "dup_ids": sorted(set(dup_ids)),
            "stats": stats}

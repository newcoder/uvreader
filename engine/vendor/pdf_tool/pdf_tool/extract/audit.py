#!/usr/bin/env python3
"""确定性完整性审计：页覆盖 / 每大题题号重复 / 空题 / 每图恰好一次 / 失败页。

纯离线、无模型调用；产物为旁挂 JSON，不并入题目 schema。
"""
from __future__ import annotations

import logging
import re
from collections import Counter
from pathlib import Path

log = logging.getLogger("qb.audit")

_IMG_MD_RE = re.compile(r"!\[插图(\d+)\]")


def _count_images(obj, counts: dict[int, int]) -> None:
    """递归统计所有字符串字段里的 `![插图N]` 出现次数。"""
    if isinstance(obj, str):
        for m in _IMG_MD_RE.finditer(obj):
            n = int(m.group(1))
            counts[n] = counts.get(n, 0) + 1
    elif isinstance(obj, dict):
        for v in obj.values():
            _count_images(v, counts)
    elif isinstance(obj, list):
        for v in obj:
            _count_images(v, counts)


def audit_result(pdf: Path | None, page_results: list[dict], figures: list[dict],
                 data: dict, check_page_coverage: bool = True,
                 total_pages: int | None = None) -> dict:
    """逐卷体检：返回 {"ok": bool, ...}；ok=False 表示至少一项不变量失守。

    check_page_coverage=False 用于整篇调用（vision-doc/text）：全部页面已一并送入，
    页码只是模型给的提示，缺页检查会产生误报，故跳过页覆盖与失败页判定。
    pdf=None（如 DOCX 无页概念）时用 total_pages 参数（默认 0）替代。
    """
    from pdf_tool.extract.vision_extract import (
        HEADERLESS_TITLES,
        UNCATEGORIZED,
        normalize_numbering,
    )

    if pdf is not None:
        import fitz

        doc = fitz.open(str(pdf))
        try:
            total_pages = doc.page_count
        finally:
            doc.close()
    elif total_pages is None:
        total_pages = 0

    result_pages = {res.get("page") for res in page_results}
    raw = [(res.get("page"), q) for res in page_results
           for q in res.get("questions", [])]
    normalized, _ = normalize_numbering(raw)

    by_cat: dict[str, list[str]] = {}
    pages_with_questions: set[int] = set()
    last_cat = ""
    for page, q in normalized:
        title = (q.get("category_title") or "").strip()
        if title and title not in HEADERLESS_TITLES:
            last_cat = title
        no = str(q.get("no") or "")
        if no:
            by_cat.setdefault(last_cat or UNCATEGORIZED, []).append(no)
        if isinstance(page, int):
            pages_with_questions.add(page)

    duplicate_nos = {cat: sorted(n for n, c in Counter(nos).items() if c > 1)
                     for cat, nos in by_cat.items()}
    duplicate_nos = {cat: nos for cat, nos in duplicate_nos.items() if nos}

    empty_questions = [
        {"index": i, "question_no": q.get("question_no")}
        for i, q in enumerate(data.get("questions", []))
        if not (q.get("question_text") or "").strip()
        and not (q.get("options") or [])
        and not q.get("answer")
    ]

    counts: dict[int, int] = {}
    _count_images(data, counts)
    figure_counts = {f["n"]: counts.get(f["n"], 0) for f in figures}
    figure_issues = {n: c for n, c in figure_counts.items() if c != 1}

    if check_page_coverage:
        all_pages = set(range(1, total_pages + 1))
        missing_pages = sorted(all_pages - pages_with_questions)
        failed_pages = sorted(all_pages - {p for p in result_pages if isinstance(p, int)})
    else:
        missing_pages, failed_pages = [], []

    issues: list[str] = []
    if missing_pages:
        issues.append(f"缺页/无题页: {missing_pages}")
    if failed_pages:
        issues.append(f"抽取失败页: {failed_pages}")
    if empty_questions:
        issues.append(f"空题: {[e['question_no'] for e in empty_questions]}")
    if figure_issues:
        issues.append(f"图引用次数异常: {figure_issues}")

    # 题号重复只提示不判失败：卷面编号原样保留时（各大题/各程序内重新起编）属正常，
    # question_id 已保证唯一。
    warnings: list[str] = []
    if duplicate_nos:
        warnings.append(f"题号重复（按原样保留，question_id 仍唯一）: {duplicate_nos}")

    return {
        "ok": not issues,
        "warnings": warnings,
        "total_pages": total_pages,
        "pages_with_questions": sorted(pages_with_questions),
        "missing_pages": missing_pages,
        "failed_pages": failed_pages,
        "duplicate_nos": duplicate_nos,
        "empty_questions": empty_questions,
        "figure_counts": figure_counts,
        "figure_issues": figure_issues,
        "issues": issues,
    }

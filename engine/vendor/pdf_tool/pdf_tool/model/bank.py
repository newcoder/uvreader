"""题库导出（reader 契约 `uvreader.question-bank/v1`）。

把 `{stem}_questions.json`（`extract/vision_extract.assemble` 产物）映射成书坊
「题库模式」消费的 `{stem}_bank.json`；字段与映射规则见
`docs/reader-answers-open-questions-2026-10-14.md` Q6（含 reader 建议：
`program` 直出，不折算成 `calculation`）。

映射要点：
- 必填 `id`（沿用 `question_id`，如 `q1`）/`number`/`type`/`stem`；
- `type`：`multiple_choice_single→single_choice`、`multiple_choice_multiple→multiple_choice`、
  `program/true_false/fill_blank/short_answer/calculation/proof` 直出，其余 `unknown`；
- `options`（选择题才给）：`option_id` 归一成 A–H 单字母（缺失按顺序补），图片按位置汇总；
- `answer`/`analysis`：原文有就填，没有留空字符串（**不猜**）；
- `images`：题干里的图 `role=stem`、选项里的图 `role=option`、解析里的图 `role=figure`
  （题干/选项文本中的内联 md 链接**保留原样**，同时汇总进 `images`）；
- `source.page`：有页号就填（bbox 暂缺省）；`confidence` 省略（无可信信号）；
- 顶层 `schema/source{file,pages,engine,extracted_at}/questions/stats{questions,by_type}`。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "uvreader.question-bank/v1"

_TYPE_MAP = {
    "multiple_choice_single": "single_choice",
    "multiple_choice_multiple": "multiple_choice",
    "true_false": "true_false",
    "fill_blank": "fill_blank",
    "short_answer": "short_answer",
    "program": "program",
    "calculation": "calculation",
    "proof": "proof",
    "single_choice": "single_choice",
    "multiple_choice": "multiple_choice",
}
_LABELS = "ABCDEFGH"
_IMG_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")


def _type_of(raw) -> str:
    return _TYPE_MAP.get(str(raw or "").strip().lower(), "unknown")


def _label_of(option_id, index: int) -> str:
    s = re.sub(r"[^A-Za-z0-9]", "", str(option_id or "")).upper()
    if len(s) == 1 and s in _LABELS:
        return s
    if len(s) == 1 and s.isdigit() and 1 <= int(s) <= len(_LABELS):
        return _LABELS[int(s) - 1]
    return _LABELS[index] if index < len(_LABELS) else str(index + 1)


def _add_images(text, role: str, out: list[dict]) -> None:
    for src in _IMG_RE.findall(str(text or "")):
        item = {"src": src, "role": role}
        if item not in out:
            out.append(item)


def question_to_bank(q: dict, *, page=None, qid=None) -> dict:
    """单题映射（题目 dict → bank question）。"""
    stem = str(q.get("question_text") or "")
    images: list[dict] = []
    _add_images(stem, "stem", images)

    options: list[dict] = []
    for i, o in enumerate(q.get("options") or []):
        if isinstance(o, dict):
            text = str(o.get("option_text") or "")
            label = _label_of(o.get("option_id"), i)
        else:
            text, label = str(o), _label_of(None, i)
        _add_images(text, "option", images)
        options.append({"label": label, "text": text})

    answer = q.get("answer")
    answer = answer.strip() if isinstance(answer, str) else ("" if answer is None else str(answer))
    analysis = q.get("explanation")
    analysis = analysis.strip() if isinstance(analysis, str) else ""
    _add_images(analysis, "figure", images)

    item: dict = {
        "id": str(qid or q.get("question_id") or ""),
        "number": str(q.get("question_no") or ""),
        "type": _type_of(q.get("question_type")),
        "stem": stem,
    }
    if options:
        item["options"] = options
    item["answer"] = answer
    item["analysis"] = analysis
    if images:
        item["images"] = images
    try:
        if page is not None:
            item["source"] = {"page": int(page)}
    except (TypeError, ValueError):
        pass
    return item


def questions_to_bank(data: dict, *, source: dict | None = None,
                      pages: list | None = None) -> dict:
    """`{questions: [...]}`（assemble 产物）→ bank 文档。

    pages：与 questions 对齐的页码列表（assemble 内部的 `_page`，可选）。
    """
    questions = [q for q in (data.get("questions") or []) if isinstance(q, dict)]
    out: list[dict] = []
    for i, q in enumerate(questions):
        page = pages[i] if pages is not None and i < len(pages) else None
        out.append(question_to_bank(q, page=page))
    by_type: dict[str, int] = {}
    for q in out:
        by_type[q["type"]] = by_type.get(q["type"], 0) + 1
    src = dict(source or {})
    src.setdefault("file", "")
    src.setdefault("pages", None)
    src.setdefault("engine", None)
    src["extracted_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"schema": SCHEMA, "source": src, "questions": out,
            "stats": {"questions": len(out), "by_type": by_type}}


def bank_path(out_json: Path) -> Path:
    """`_{stem}_questions.json` → 同目录 `_{stem}_bank.json`（命名不匹配时加后缀）。"""
    out_json = Path(out_json)
    if "_questions.json" in out_json.name:
        return out_json.with_name(out_json.name.replace("_questions.json", "_bank.json"))
    return out_json.with_name(out_json.stem + "_bank.json")

#!/usr/bin/env python3
"""vision 抽取路径：页渲染、标号框、逐页调用编排、组装（详见 spec）。"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from pdf_tool.core import watermark

log = logging.getLogger("qb.vision")

BOX_RE = re.compile(r"\[\[box:(\d+)\]\]")
TOP_RATIO = 0.25
UNCATEGORIZED = "未分类"
# 与空标题同义的"没有大题头"写法：前者是历史合成桶，后者是模型实测自造词。
# 命中即走 last_category 继承。
HEADERLESS_TITLES = frozenset({UNCATEGORIZED, "（无明确大题标题）"})

_FONT_CANDIDATES: tuple[str, ...] = (
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
)
_LABEL_MIN_SIZE = 22
_LABEL_RATIO = 1 / 70


def _preview(text: str, limit: int = 60) -> str:
    """日志用的单行摘要。"""
    flat = " ".join((text or "").split())
    return flat if len(flat) <= limit else flat[:limit] + "…"


def render_pages(pdf: Path, out_dir: Path, zoom: float = 2.0) -> dict[int, Path]:
    """逐页渲染；zoom=2 与 PaddleOCR 页面渲染像素空间一致（A4→1190×1684）。"""
    import fitz
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(pdf))
    pages: dict[int, Path] = {}
    try:
        for i, page in enumerate(doc, 1):
            watermark.mask_page(page)  # 出生 PDF 的浅色水印先涂白（与正文重叠时自动跳过）
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            dest = out_dir / f"page_{i:02d}.png"
            pix.save(str(dest))
            pages[i] = dest
    finally:
        doc.close()
    log.info("[vision] rendered %d pages -> %s", len(pages), out_dir)
    return pages


def boxes_for_page(figs: list[dict], page_no: int, page_h: int,
                   top_ratio: float | None = None) -> list[tuple[int, tuple[int, int, int, int]]]:
    """该页的 (全局图号, rect2x)；top_ratio 时只保留框中心在顶部比例内的。"""
    out = []
    for f in figs:
        if f.get("page") != page_no or not f.get("rect2x"):
            continue
        x0, y0, x1, y1 = (int(v) for v in f["rect2x"])
        if top_ratio is not None and (y0 + y1) / 2 > top_ratio * page_h:
            continue
        out.append((f["n"], (x0, y0, x1, y1)))
    return out


def lookahead_crop(page_img: Image.Image,
                   boxes: list[tuple[int, tuple[int, int, int, int]]],
                   min_ratio: float = 0.35, margin: int = 40) -> Image.Image | None:
    """次页参考图：只裁含候选框的顶部条带；无候选框 → None（不发次页图）。"""
    if not boxes:
        return None
    h = page_img.size[1]
    y_cut = min(h, max(round(h * min_ratio), max(b[3] for _, b in boxes) + margin))
    return page_img.crop((0, 0, page_img.size[0], y_cut))


def lookahead_image(page_img: Image.Image,
                    boxes: list[tuple[int, tuple[int, int, int, int]]],
                    min_ratio: float = 0.35, margin: int = 40) -> Image.Image | None:
    """次页参考图：顶部条带 + 框外涂白（只留图形本体，不含次页任何文字）。

    条带本身仍带次页页首正文，模型会照读并抽题（越页幻影）；涂白后
    可读信息只剩图形，"本页题面是否引用该图"的归属判断不受影响。
    """
    band = lookahead_crop(page_img, boxes, min_ratio, margin)
    if band is None:
        return None
    out = Image.new("RGB", band.size, "white")
    for _, (x0, y0, x1, y1) in boxes:  # 框坐标即条带坐标（裁剪自 y=0 起）
        out.paste(band.crop((x0, y0, x1, y1)), (x0, y0))
    return out


def _default_loader(size: int):
    """按 QB_BOX_FONT → 平台候选路径依次尝试 TrueType；全失败退回 Pillow 默认字体。"""
    env = os.environ.get("QB_BOX_FONT")
    candidates = ([env] if env else []) + list(_FONT_CANDIDATES)
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, ValueError):
            continue
    return ImageFont.load_default()


def label_font(height: int, loader=_default_loader):
    """框号字号按页高缩放（下限 _LABEL_MIN_SIZE）；loader 可注入以便测试。"""
    return loader(max(_LABEL_MIN_SIZE, int(height * _LABEL_RATIO)))


def draw_labeled(image: Image.Image, boxes: list[tuple[int, tuple[int, int, int, int]]],
                 first_id: int = 1, font=None) -> tuple[Image.Image, dict[int, int]]:
    """在副本上画红框与连续编号；返回 (新图, {局部号: 全局图号})。

    编号默认用按页高缩放的真字体，并先垫白底再画红字（深色插图上也可读）。
    """
    out = image.copy()
    d = ImageDraw.Draw(out)
    if font is None:
        font = label_font(image.height)
    mapping: dict[int, int] = {}
    for k, (gid, (x0, y0, x1, y1)) in enumerate(boxes, first_id):
        d.rectangle([x0, y0, x1, y1], outline=(255, 0, 0), width=3)
        d.rectangle(d.textbbox((x0 + 4, y0 + 4), str(k), font=font), fill=(255, 255, 255))
        d.text((x0 + 4, y0 + 4), str(k), fill=(255, 0, 0), font=font)
        mapping[k] = gid
    return out, mapping


def draw_numbered(image: Image.Image, boxes: list[tuple[int, tuple[int, int, int, int]]],
                  font=None) -> tuple[Image.Image, dict[int, int]]:
    """按**全局编号**画红框与编号（编号即框自身 n，不重排）；返回 (新图, {n: n})。"""
    out = image.copy()
    d = ImageDraw.Draw(out)
    if font is None:
        font = label_font(image.height)
    mapping: dict[int, int] = {}
    for n, (x0, y0, x1, y1) in boxes:
        d.rectangle([x0, y0, x1, y1], outline=(255, 0, 0), width=3)
        d.rectangle(d.textbbox((x0 + 4, y0 + 4), str(n), font=font), fill=(255, 255, 255))
        d.text((x0 + 4, y0 + 4), str(n), fill=(255, 0, 0), font=font)
        mapping[n] = n
    return out, mapping


_OPTION_KEYS = ("A", "B", "C", "D", "E", "F")


def build_page_prompt(rules: str, page_no: int, total_pages: int, has_next: bool,
                      local_map: dict[int, int], skip_globals: set[int],
                      spill_note: str | None = None,
                      prev_tail: str | None = None) -> str:
    skip_locals = sorted(k for k, g in local_map.items() if g in skip_globals)
    if skip_locals:
        skip_note = ("以下编号的框已在前一页调用中归属，本次一律忽略："
                     + "、".join(f"编号 {k}" for k in skip_locals))
    else:
        skip_note = "本次没有需要忽略的框。"
    # 次页只给顶部条带，故提示词须如实说明；无条带时不得声称"次页是最后一页"
    next_clause = (f"与**次页（第 {page_no + 1} 页）的顶部条带裁剪图**（仅供判断跨页插图归属）"
                   if has_next else "（本次未附次页参考图，仅凭本页判断）")
    next_note = f"（次页为第 {page_no + 1} 页）" if has_next else "（未附次页参考图）"
    # 上一页页末的共用材料：其题目在本页，上一页无法并入任何题，只能顺延传递
    spill_text = ("上一页页末遗留的共用材料（请并入本页紧随其后的那道题的 stem，"
                  f"按原顺序逐字保留）：\n{spill_note}") if spill_note else "（无）"
    # 上一页末题若被页边界截断（代码块/开放语句），把收尾文本带进本页判断续写
    tail_text = ("上一页页末最后一题的收尾（仅供判断本页开头是否为它的续写，"
                 f"不要重复输出）：\n{prev_tail}") if prev_tail else "（无）"
    return (rules.replace("{PAGE}", str(page_no))
                 .replace("{TOTAL}", str(total_pages))
                 .replace("{NEXT}", str(page_no + 1))
                 .replace("{NEXT_CLAUSE}", next_clause)
                 .replace("{SKIP_NOTE}", skip_note)
                 .replace("{SPILL_NOTE}", spill_text)
                 .replace("{PREV_TAIL}", tail_text)
            + f"\n\n补充：本页是第 {page_no} 页{next_note}。"
            + ("请同时参考次页顶部条带图判断跨页插图归属，但严禁从次页图抽取题目。"
               if has_next else "")
            + f"输出必须为 json。{skip_note}")


_CODE_HINT_RE = re.compile(r"#include|using namespace|\bint\b|\bfor\s*\(|\bwhile\s*\(|\breturn\b")
_TAIL_STOP_CHARS = "。？！；）】》”\"'.!?"


def _continuation_tail(res: dict) -> str | None:
    """上一页最后一题若被页边界截断（未闭合代码围栏 / 代码风格开放语句），返回其收尾。

    供下一页提示词判断「本页开头是否为它的续写」；完整结束的题返回 None。
    """
    qs = res.get("questions") or []
    if not qs:
        return None
    q = qs[-1]
    stem = (q.get("stem") or "").rstrip()
    if not stem:
        return None
    if stem.count("```") % 2 == 0 and "```" in stem:
        return None  # 代码块已闭合：本题在本页结束
    open_fence = stem.count("```") % 2 == 1
    code_like = bool(_CODE_HINT_RE.search(stem)) and not stem.endswith(tuple(_TAIL_STOP_CHARS))
    if not (open_fence or code_like):
        return None
    return f"（上一页最后一题 no={q.get('no')!r}）\n{stem[-600:]}"


def _convert(text: str, local_map: dict[int, int], warnings: list[str]) -> str:
    def repl(m):
        k = int(m.group(1))
        if k not in local_map:
            warnings.append(f"占位符引用了未知框号 {k}，已移除")
            return ""
        return f"[[box:{local_map[k]}]]"
    return BOX_RE.sub(repl, text or "")


def _normalize_options(opts, local_map: dict[int, int], warnings: list[str]) -> list[dict]:
    """options 三形态（dict / list[dict] / list[str]）归一化；异常条目告警后跳过。"""
    if isinstance(opts, dict):
        return [{"option_id": k, "option_text": _convert(str(v), local_map, warnings)}
                for k, v in opts.items() if k in _OPTION_KEYS]
    if not isinstance(opts, list):
        warnings.append(f"options 形状异常（{type(opts).__name__}），已置空")
        return []
    out = []
    for i, o in enumerate(opts):
        if isinstance(o, dict):
            if "option_text" not in o:
                warnings.append(f"options 第 {i + 1} 项缺少 option_text，已跳过")
                continue
            out.append({"option_id": o.get("option_id") or chr(65 + i),
                        "option_text": _convert(str(o["option_text"]), local_map, warnings)})
        elif isinstance(o, str):
            out.append({"option_id": chr(65 + i), "option_text": _convert(o, local_map, warnings)})
        else:
            warnings.append(f"options 第 {i + 1} 项形状异常（{type(o).__name__}），已跳过")
    return out


def _box_ids(text) -> set[int]:
    """文本中的局部占位号集合；非字符串视为无占位（防异常形状中断整页）。"""
    return {int(m) for m in BOX_RE.findall(text)} if isinstance(text, str) else set()


def parse_page_result(raw: dict, local_map: dict[int, int]) -> dict:
    """局部号→全局号换算 + 一致性校验；返回 {questions, unattributed, warnings}。"""
    if not isinstance(raw, dict) or "questions" not in raw:
        raise ValueError("响应缺少 questions 键")
    warnings: list[str] = []
    questions = []
    for q in raw.get("questions") or []:
        if not isinstance(q, dict):
            warnings.append(f"questions 含非对象条目（{type(q).__name__}），已跳过")
            continue
        q = dict(q)
        for key in ("stem", "explanation", "answer"):
            if isinstance(q.get(key), str):
                q[key] = _convert(q[key], local_map, warnings)
        opts = q.get("options")
        if opts is not None:
            q["options"] = _normalize_options(opts, local_map, warnings)
        figs = []
        for f in q.get("figures") or []:
            if not isinstance(f, dict):
                warnings.append(f"figures 含非对象条目（{type(f).__name__}），已跳过")
                continue
            k = f.get("box")
            if not isinstance(k, (int, str)):
                warnings.append(f"figures 的 box 非标量（{type(k).__name__}），已剔除")
                continue
            if k in local_map:
                figs.append({"box": local_map[k], "desc": f.get("desc")})
            else:
                warnings.append(f"figures 引用了未知框号 {k}，已剔除")
        q["figures"] = figs
        # 同题内选项优先：某框同时出现在题干与选项时，题干里的重复占位删除
        # （模型常把选项图也在题干末尾罗列一遍；图的归属应落在选项里）
        opt_boxes = {n for o in q.get("options") or [] for n in _box_ids(o["option_text"])}
        stem_dup = _box_ids(q.get("stem")) & opt_boxes
        if stem_dup:
            dup_boxes = stem_dup

            def _drop_dup(m, dup_boxes=dup_boxes):
                return "" if int(m.group(1)) in dup_boxes else m.group(0)

            q["stem"] = BOX_RE.sub(_drop_dup, q["stem"]).strip()
            warnings.append(f"题 {q.get('no')}: 框 {sorted(stem_dup)} 同时在题干与选项，"
                            "已保留选项中的占位")
        # 占位与 figures 一致性：figures 里有、题面没有的框一律补占位到题干末尾
        # （占位是 assemble 的唯一挂载依据，只告警会让该图静默丢失）
        placed = _box_ids(q.get("stem"))
        for o in q.get("options") or []:
            placed |= _box_ids(o["option_text"])
        missing = sorted(f["box"] for f in figs if f["box"] not in placed)
        if missing:
            q["stem"] = (q["stem"] if isinstance(q.get("stem"), str) else "") \
                + "".join(f"[[box:{n}]]" for n in missing)
            placed |= set(missing)
            for n in missing:
                warnings.append(f"题 {q.get('no')}: figures 列了框 {n} 但题面无占位符，"
                                "已补占位到题干末尾")
        if placed != {f["box"] for f in figs}:
            warnings.append(f"题 {q.get('no')}: 占位集合 {sorted(placed)} 与 figures "
                            f"{sorted(f['box'] for f in figs)} 不一致")
        questions.append(q)
    unattributed = []
    for k in raw.get("unattributed_boxes") or []:
        if not isinstance(k, int):
            warnings.append(f"unattributed_boxes 含非编号条目（{type(k).__name__}），已跳过")
        elif k in local_map:
            unattributed.append(local_map[k])
        else:
            warnings.append(f"unattributed_boxes 含未知框号 {k}")
    # 页末共用材料：本页放不下（题目在次页）时由模型顺延，下一页提示词承接。
    # 占位符编号是**本页局部号**，此处即剥离（carry_forward 保留为幂等兜底），
    # 使落盘的 page_NN.json 与返回值都不含会跨页误解释的局部号。
    spill = raw.get("spill_material")
    if spill is not None and not isinstance(spill, str):
        warnings.append(f"spill_material 非字符串（{type(spill).__name__}），已置空")
        spill = None
    if spill:
        stripped = BOX_RE.sub("", spill).strip()
        if stripped != spill.strip():
            warnings.append("spill_material 含页内占位符，已剥离")
        spill = stripped or None

    # 大题说明文字（score_note）：模型写在 categories[] 里，交由 assemble 落到 schema
    categories = []
    for c in raw.get("categories") or []:
        if not isinstance(c, dict) or not isinstance(c.get("title"), str):
            warnings.append(f"categories 含异常条目（{type(c).__name__}），已忽略")
            continue
        note = c.get("score_note")
        if note is not None and not isinstance(note, str):
            warnings.append(f"categories 的 score_note 非字符串（{type(note).__name__}），已置空")
            note = None
        categories.append({"title": c["title"], "score_note": note})

    # 非题目说明文字：每项带 after_no（其前一道题的卷面编号；null=文档开头），
    # 交由 assemble 解析成 after_question_id。
    notes = []
    for n in raw.get("notes") or []:
        if not isinstance(n, dict) or not isinstance(n.get("text"), str):
            warnings.append(f"notes 含异常条目（{type(n).__name__}），已忽略")
            continue
        after = n.get("after_no")
        notes.append({"after_no": after if isinstance(after, (int, str)) else None,
                      "text": n["text"]})

    for w in warnings:
        log.warning("[vision] %s", w)
    return {"questions": questions, "unattributed": unattributed, "warnings": warnings,
            "exam_info": raw.get("exam_info") or {}, "spill_material": spill or None,
            "categories": categories, "notes": notes}


_BLANK_RE = re.compile(r"_{4,}")
_Q_FIELDS_DEFAULT = {
    "answer": None, "score": None, "difficulty": None, "explanation": None,
    "grading_criteria": None, "reference_code": None, "input_description": None,
    "output_description": None, "additional_tips": None,
}
# 模型可直供的可选文本字段（提示词要求编程题填 input/output_description）；
# assemble 不得用 None 覆盖已给出的字符串（浏览器基线保留它们）。
_MODEL_TEXT_FIELDS = ("grading_criteria", "reference_code", "input_description",
                      "output_description", "additional_tips")
# 卷面元信息（判题/OJ 需要）：试题编号、时间/内存限制
_META_FIELDS = ("source_id", "time_limit", "memory_limit")


def _text_or_none(v):
    if v is None:
        return None
    return v if isinstance(v, str) else str(v)


def _sample_io(raw, substitute, qkey: int, qno: str) -> dict:
    """样例输入/输出（逐字）；文本字段同样替换图占位符。"""
    out = {"input": None, "output": None}
    if isinstance(raw, dict):
        for k in ("input", "output"):
            v = _text_or_none(raw.get(k))
            if v:
                out[k] = substitute(v, qkey, qno) or None
    return out


def _metadata_of(raw) -> dict:
    meta = dict.fromkeys(_META_FIELDS)
    if isinstance(raw, dict):
        for k in _META_FIELDS:
            meta[k] = _text_or_none(raw.get(k))
    return meta
# 题号形态：子问整体形如 `(3)`／`（3）`；纯数字父题号
_SUB_NO_RE = re.compile(r"^[（(]\s*(\d+)\s*[)）]$")
_PLAIN_NO_RE = re.compile(r"^\d+$")
_CJK_ONLY_RE = re.compile(r"^[\u4e00-\u9fff]+$")
_FENCE_BLOCK_RE = re.compile(r"```[a-zA-Z]*\n.*?```", re.DOTALL)


def compute_blank_positions(stem: str) -> list[dict]:
    """确定性扫描 ____（≥4 连续下划线）生成 blank_positions（Python 下标）。"""
    return [{"start_pos": m.start(), "end_pos": m.end(), "pattern": None}
            for m in _BLANK_RE.finditer(stem or "")]


def apply_blank_patterns(positions: list[dict], blanks) -> None:
    """把模型给的 `blanks`（各空答案形态描述）按下标写入 blank_positions[].pattern。

    数量不匹配时按位截断（多出的描述丢弃、少出的空保持 None）；非字符串条目跳过。
    """
    if not isinstance(blanks, list):
        return
    # strict=False：模型给的描述条数与占位符数**本就允许不等**（按位截断是既定语义）
    for pos, b in zip(positions, blanks, strict=False):
        if isinstance(b, str) and b.strip():
            pos["pattern"] = b


def _material_only(q: dict) -> bool:
    """材料/题头行：没有任何可作答内容（无选项、无答案、无空）。"""
    return not (q.get("options") or []) and not q.get("answer") and not q.get("blanks")


def _merge_question(prev: dict, cur: dict) -> None:
    """把 cur 并入 prev（页边界截断的续写：按原顺序接在题干之后）。"""
    head = (prev.get("stem") or "").rstrip()
    tail = (cur.get("stem") or "").lstrip()
    prev["stem"] = f"{head}\n{tail}" if head and tail else (head or tail)
    if not prev.get("options") and cur.get("options"):
        prev["options"] = cur["options"]
    if prev.get("type") == "short_answer" and cur.get("type") == "fill_blank":
        prev["type"] = "fill_blank"  # 续写含空格：保留填空识别（blank_positions 依赖 type）
    for k in ("answer", "explanation", "blanks", "score", "difficulty"):
        if not prev.get(k) and cur.get(k):
            prev[k] = cur[k]
    if cur.get("figures"):
        prev["figures"] = (prev.get("figures") or []) + cur["figures"]


def _plain_int(no: str) -> int | None:
    """`no` 作为纯数字题号时的整数值（容忍尾点号变体 `1.`/`1、`/`1．`）；否则 None。

    只服务规则⑤的门控：判「本节是否从 1 起编」时，`1`、`1.`、`1、`、`1．` 是同一种
    意图的不同写法。父号沿用（规则①）仍严格要求 `^\\d+$`——若用它当父号，会拼出
    `1.(1)` 这种产物。
    """
    m = re.match(r"^(\d+)[.、．]?$", no)
    return int(m.group(1)) if m else None


def normalize_numbering(
        raw: list[tuple[int | None, dict]]) -> tuple[list[tuple[int | None, dict]], list[str]]:
    """题号保真后处理：按文档顺序规范化模型给出的题号。

    ① 子问补父号：`(3)` → `11(3)`（父号 = 同一大题内最近一次出现的纯数字题号）；
    ② 材料/题头行折入首个子问：`11`（无作答内容）后紧跟 `11(1)` 时并入后者；
    ③ 相邻同号合并：页边界截断的续写（同大题两条同号）合成一条；
    ④ 空题丢弃：无题干、无选项、无答案的行不留号；
    ⑤ 大题归属存疑只告警：页边界把上一大题的尾题挂到了下一大题时，仅提示疑似
       归属，**按原文保留不改写**（不确定即保留，忠实优先）。

    规则⑤以「新大题自证从 1 起编」为门控：某大题的题目里出现 `_plain_int(no) == 1`
    才认为它重新起编，此时该大题内序号 > 1 的题可能来自上一大题的续号（页边界带偏），
    但模型看到完整版面，其归属通常比启发式可靠，故只告警、不迁移。
    连续编号的卷子（各大题共用一个编号序列）新大题里没有 1 号，门控不成立，不告警。
    另要求该大题**首次露面**（`title not in seen`）且已有生效的上一大题（`category`
    非空）：页边界误挂只发生在大题第一次出现时；文档首题没有上一大题，同样不告警。

    只动 `no`/`stem`/`figures` 等字段，不产出 schema 结构，故可安全地跑在
    模型原始 dict 上；对已规范化的输入幂等。
    """
    notes: list[str] = []
    # 规则⑤门控预扫描：只有"本节含 1 号题"的大题才算重新起编（restart 卷）。
    restart_titles: set[str] = set()
    for _, rq in raw:
        rtitle = (rq.get("category_title") or "").strip()
        if rtitle and _plain_int(str(rq.get("no") or "").strip()) == 1:
            restart_titles.add(rtitle)

    staged: list[tuple[int | None, dict, str]] = []
    seen: set[str] = set()  # 已作为当前大题采纳过的标题（规则⑤门控：只对首次露面告警）
    parent = ""
    category = ""
    for page, q in raw:
        q = dict(q)
        no = str(q.get("no") or "").strip()
        title = (q.get("category_title") or "").strip()
        if title and title not in HEADERLESS_TITLES and title != category:
            n = _plain_int(no)
            if (category and title not in seen and title in restart_titles
                    and n is not None and n > 1):
                # 规则⑤：首次露面的大题从 1 起编，本题却带着续号 → 可能被页边界带偏。
                # 不确定即保留原文：只告警，不改写 category_title。
                notes.append(f"第 {page} 页题 {no} 疑似归属 {title}"
                             "（新大题从 1 起编，本题序号是续号），按原文保留")
            category, parent = title, ""  # 换大题：父号不跨大题沿用
            seen.add(title)
        sub = _SUB_NO_RE.match(no)
        if sub:
            if parent:
                q["no"] = f"{parent}({sub.group(1)})"
                notes.append(f"第 {page} 页子问 {no} 补父号 → {q['no']}")
            else:
                notes.append(f"第 {page} 页子问 {no} 在本大题内找不到父题号，保持原样")
        elif _PLAIN_NO_RE.match(no):
            parent = no
        staged.append((page, q, category))

    folded: list[tuple[int | None, dict, str]] = []
    for i, (page, q, cat) in enumerate(staged):
        no = str(q.get("no") or "")
        nxt = staged[i + 1] if i + 1 < len(staged) else None
        same_cat_next = nxt is not None and nxt[2] == cat
        # ① 编号材料行：`11`（无作答内容）后紧跟 `11(1)` 时并入后者
        numbered_material = (bool(_PLAIN_NO_RE.match(no)) and same_cat_next
                             and str(nxt[1].get("no") or "").startswith(f"{no}("))
        # ② CJK 纯文字题号（如 no=材料）不是编号：并入同大题紧随其后的题；
        #    罗马数字/(a)/1-2/空号等外部编号形态一律原样放过
        unnumbered_material = bool(_CJK_ONLY_RE.match(no)) and same_cat_next
        if _material_only(q) and (numbered_material or unnumbered_material):
            child = nxt[1]
            head = (q.get("stem") or "").strip()
            if head:
                child["stem"] = f"{head}\n{child.get('stem') or ''}"
            if q.get("figures"):
                child["figures"] = q["figures"] + (child.get("figures") or [])
            notes.append(f"第 {page} 页材料/题头行 {no or '无题号'} 无作答内容，"
                         f"已并入 {child.get('no')}")
            continue
        folded.append((page, q, cat))

    # 重复代码清理：同一大题内，后续子问若整段重复上一条的代码块，只保留第一条
    # （模型常把程序代码复制进每个子问；同一段代码不得重复出现在多题）。
    deduped: list[tuple[int | None, dict, str]] = []
    prev_block, prev_cat = "", None
    for page, q, cat in folded:
        m = _FENCE_BLOCK_RE.search(q.get("stem") or "")
        block = m.group(0).strip() if m else ""
        if block and cat == prev_cat and block == prev_block:
            q = dict(q)
            dup = prev_block

            def _strip_dup(m, dup=dup):
                return "" if m.group(0).strip() == dup else m.group(0)

            q["stem"] = _FENCE_BLOCK_RE.sub(_strip_dup, q["stem"]).strip()
            notes.append(f"第 {page} 页题 {q.get('no') or '无题号'} 与上一条重复的代码块"
                         "已移除（只保留第一条）")
        else:
            prev_block, prev_cat = block, cat
        deduped.append((page, q, cat))
    folded = deduped

    out: list[tuple[int | None, dict, str]] = []
    for page, q, cat in folded:
        no = str(q.get("no") or "")
        if not (q.get("stem") or "").strip() and not (q.get("options") or []) \
                and not q.get("answer"):
            notes.append(f"第 {page} 页空题（no={no or '无'}）已丢弃")
            continue
        if out and no and out[-1][2] == cat and str(out[-1][1].get("no") or "") == no:
            _merge_question(out[-1][1], q)
            notes.append(f"第 {out[-1][0]}、{page} 页题 {no} 相邻同号，已合并为一条")
            continue
        out.append((page, q, cat))
    return [(page, q) for page, q, _ in out], notes


_FENCE_SPLIT_RE = re.compile(r"(```.*?```)", re.DOTALL)
_DOLLAR_BLOCK_RE = re.compile(r"\$\$([^$]+)\$\$")
_DOLLAR_INLINE_RE = re.compile(r"\$([^$\n]+?)\$")


def _strip_math_delims(text: str) -> tuple[str, bool]:
    """成对 `$$...$$` / `$...$` 去定界（保留裸 LaTeX）；围栏代码块原样保留。

    返回 (新文本, 是否仍有孤立 $)。
    """
    parts = _FENCE_SPLIT_RE.split(text)
    stray = False
    for i, part in enumerate(parts):
        if i % 2 == 1:  # 奇数段 = 围栏代码块，不得改动
            continue
        part = _DOLLAR_BLOCK_RE.sub(r"\1", part)
        part = _DOLLAR_INLINE_RE.sub(r"\1", part)
        stray = stray or ("$" in part)
        parts[i] = part
    return "".join(parts), stray


def _strip_math_delims_in_place(obj) -> bool:
    """递归处理 dict/list 中的字符串；返回是否出现孤立 $（未成对）。"""
    stray = False
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str):
                nv, has = _strip_math_delims(v)
                if nv != v:
                    obj[k] = nv
                stray = stray or has
            else:
                stray = _strip_math_delims_in_place(v) or stray
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            if isinstance(v, str):
                nv, has = _strip_math_delims(v)
                if nv != v:
                    obj[i] = nv
                stray = stray or has
            else:
                stray = _strip_math_delims_in_place(v) or stray
    return stray


def assemble(page_results: list[dict], figs: list[dict], out_json: Path,
             *, source: dict | None = None) -> dict:
    """合并分类/题目 → 占位替换为图片链接 → schema JSON。

    source：`{file, pages, engine}`（可选）——给出时同时在 `_questions.json` 旁写出
    `_bank.json`（reader 契约 `uvreader.question-bank/v1`，见 `model/bank.py`）。
    """
    by_n = {f["n"]: f for f in figs}
    categories: list[dict] = []
    cat_index: dict[str, dict] = {}
    questions: list[dict] = []
    q_cats: list[str] = []  # 与 questions 对齐的大类名（供大类说明锚定）
    # 全局图号 -> (题号键, 该题 question_no)。题号键不参与去重比较（只用于标注
    # 挂载来源：<0 为兜底挂载），故重复题号不会影响"先归属者优先"。
    used: dict[int, tuple[int, str]] = {}
    last_category = ""  # 最近一次出现的大题标题，用于续页续题的继承

    # 大题说明文字：先到先得（同 exam_info 策略），后续页同 title 仅在前者为空时补齐
    note_by_title: dict[str, str] = {}
    for res in page_results:
        for c in res.get("categories") or []:
            t = (c.get("title") or "").strip()
            raw_note = c.get("score_note")
            note = raw_note.strip() if isinstance(raw_note, str) else ""
            if t and note and not note_by_title.get(t):
                note_by_title[t] = note

    def md_link(n: int) -> str:
        f = by_n.get(n)
        return f"![插图{n}]({f['rel']})" if f else f"[缺图{n}]"

    def substitute(text: str, qkey: int, qno: str) -> str:
        def repl(m):
            n = int(m.group(1))
            if n not in by_n:
                log.warning("[vision] 占位 [[box:%d]] 无对应裁剪资产", n)
                return ""
            if n in used:  # 同题内重复引用（题干+解析各引一次）与跨题重复都只留首次
                log.warning("[vision] 图 IMG_%d 已在 Q%s 引用，"
                            "Q%s 的重复引用已移除（先归属者优先）",
                            n, used[n][1], qno)
                return ""
            used[n] = (qkey, qno)
            return md_link(n)
        return BOX_RE.sub(repl, text or "")

    raw: list[tuple[int | None, dict]] = [(res.get("page"), q)
                                          for res in page_results
                                          for q in res.get("questions", [])]
    raw, num_notes = normalize_numbering(raw)
    for note in num_notes:
        if "补父号" in note:
            log.info("[vision] 题号规范化：%s", note)  # ① 例行补号，内容未变
        else:
            log.warning("[vision] 题号规范化：%s", note)  # ②③④ 改动了内容

    for qkey, (page, q) in enumerate(raw):
        qno = str(q.get("no") or "")  # qkey：同题内多处引用（题干+选项+解析）共用一个键
        # 大题标题跨页继承：页协议只送次页条带、不回溯上一页，故续页上的
        # 续题看不到本大题的头；按页序把最近一次出现的标题延续下去。
        raw_title = (q.get("category_title") or "").strip()
        if raw_title and raw_title not in HEADERLESS_TITLES:
            last_category = raw_title
        title = last_category or UNCATEGORIZED
        if title not in cat_index:
            cat = {"category_id": f"cat{len(categories) + 1}", "category_name": title,
                   "description": note_by_title.get(title),
                   "question_count": "0", "score_per_question": None}
            cat_index[title] = cat
            categories.append(cat)
        cat_index[title]["question_count"] = str(int(cat_index[title]["question_count"]) + 1)

        stem = substitute(q.get("stem") or "", qkey, qno)
        ans = q.get("answer")
        if isinstance(ans, str):  # answer 里的占位符与其它文本字段同样须替换
            ans = substitute(ans, qkey, qno) or None
        item = {
            "question_no": qno,
            "question_id": None,
            "question_type": q.get("type") or "short_answer",
            "question_text": stem,
            "blank_positions": [],  # 孤儿图可能前置到题干，挂载后统一重算
            "options": [{"option_id": o.get("option_id"),
                         "option_text": substitute(o.get("option_text") or "", qkey, qno)}
                        for o in q.get("options") or []],
            "answer": ans, "score": q.get("score"),
            "difficulty": q.get("difficulty"),
            "explanation": substitute(q.get("explanation") or "", qkey, qno) or None,
            "sample_input_output": _sample_io(q.get("sample_input_output"), substitute, qkey, qno),
            "metadata": _metadata_of(q.get("metadata")),
            "_page": page,  # 内部字段：兜底归属用，写出前删除
            "_blanks": q.get("blanks"),  # 模型给的各空答案形态，重算 blank_positions 后回填
        }
        for k, v in _Q_FIELDS_DEFAULT.items():
            item.setdefault(k, v)
        for k in _MODEL_TEXT_FIELDS:  # 模型给出的可选字段优先于默认 None
            if isinstance(q.get(k), str) and q[k].strip():
                item[k] = q[k]
        questions.append(item)
        q_cats.append(title)

    # 未归属框兜底：挂到同页第一题，其次全卷第一题
    unattributed = [n for res in page_results for n in res.get("unattributed", [])]
    for n in unattributed:
        f = by_n.get(n)
        if not f or n in used:
            log.warning("[vision] 未归属框 %s 兜底跳过（%s）", n,
                        "无对应裁剪资产" if not f else "图已挂载")
            continue
        target = next((q for q in questions if q["_page"] == f["page"]), None) \
            or (questions[0] if questions else None)
        if target is None:
            log.warning("[vision] 未归属图 IMG_%d 无题可挂（questions 为空），丢弃", n)
            continue
        target["question_text"] = md_link(n) + "\n" + target["question_text"]
        used[n] = (-1, target["question_no"])  # -1 = 兜底挂载来源标记
        log.warning("[vision] 未归属图 IMG_%d 兜底挂到 Q%s", n, target["question_no"])

    # 从未被提及的图（不在任何占位符、figures[]、unattributed_boxes 里）：
    # 不挂载就静默丢图，故兜底挂到同页第一题题干末尾，其次全卷第一题
    for f in figs:
        n = f["n"]
        if n in used:  # 已挂载：占位挂载是常规路径，仅兜底挂载的须留痕
            if used[n][0] < 0:
                log.warning("[vision] 图 IMG_%d 已由兜底挂载，未提及兜底跳过", n)
            continue
        target = next((q for q in questions if q["_page"] == f["page"]), None) \
            or (questions[0] if questions else None)
        if target is None:
            log.warning("[vision] 未提及图 IMG_%d 无题可挂（questions 为空），丢弃", n)
            continue
        target["question_text"] = (target["question_text"] or "") + md_link(n)
        used[n] = (-1, target["question_no"])  # -1 = 兜底挂载来源标记
        log.warning("[vision] 未提及图 IMG_%d 兜底挂到 Q%s 题干末尾",
                    n, target["question_no"])

    for i, item in enumerate(questions, 1):  # 唯一 ID（文档顺序）：document_notes 的锚点
        item["question_id"] = f"q{i}"

    # 非题目说明文字：after_no → after_question_id（null=文档开头）；
    # 找不到锚点时挂到已解析到的最后一道题，保证顺序不丢。
    # 大类说明（categories[].description）也作为锚定文字，位置=该大类首题之前。
    entries: list[tuple[int, str]] = []  # (其前已过的题数, 文本)
    cursor = 0
    cat_names = [c["category_name"] for c in categories]
    for n in [n for res in page_results for n in (res.get("notes") or [])]:
        head = n["text"].strip().splitlines()[0].strip() if n["text"].strip() else ""
        if any(head.startswith(name) for name in cat_names):
            # 大类标题/说明由 categories[] 统一派生并锚定；模型重复给出会双写
            log.warning("[vision] notes 条目与大类标题重复，已忽略: %s", head[:40])
            continue
        after_no = n.get("after_no")
        pos = 0
        if after_no is not None:
            for j in range(cursor, len(questions)):
                if str(questions[j]["question_no"]) == str(after_no):
                    pos = j + 1
                    cursor = j + 1
                    break
            else:
                pos = cursor  # 找不到：挂到已解析到的位置，顺序不丢
        entries.append((pos, n["text"]))
    first_idx: dict[str, int] = {}
    for i, cat_name in enumerate(q_cats):
        first_idx.setdefault(cat_name, i)
    for cat in categories:  # 大类标题必收录（无说明也要保留标题）；位置=该大类首题之前
        desc = (cat.get("description") or "").strip()
        name = cat["category_name"]
        entries.append((first_idx.get(name, 0), f"{name}\n{desc}" if desc else name))
    entries.sort(key=lambda t: t[0])
    document_notes = [
        {"after_question_id": (questions[p - 1]["question_id"] if p > 0 else None),
         "text": text}
        for p, text in entries
    ]

    data = {"exam_info": {"title": None, "total_score": None,
                          "question_count": None, "time_limit": None},
            "question_categories": categories, "questions": questions,
            "document_notes": document_notes}
    for res in page_results:  # exam_info 先到先得
        for k, v in (res.get("exam_info") or {}).items():
            if data["exam_info"].get(k) in (None, "") and v:
                data["exam_info"][k] = v
    if not data["exam_info"].get("question_count"):  # 模型常不给：以题目数兜底
        data["exam_info"]["question_count"] = str(len(questions))
    question_pages = [q.pop("_page", None) for q in data["questions"]]

    if _strip_math_delims_in_place(data):
        log.warning("[vision] 文本中存在孤立 $（未成对），已按原文保留")

    for item in data["questions"]:  # 唯一计算点：孤儿图前置会平移下标，须在挂载后重算
        item["blank_positions"] = (compute_blank_positions(item["question_text"])
                                   if item["question_type"] == "fill_blank" else [])
        apply_blank_patterns(item["blank_positions"], item.pop("_blanks", None))

    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    try:  # 题库导出（reader 契约 uvreader.question-bank/v1；失败不影响主产物）
        from pdf_tool.model.bank import bank_path, questions_to_bank

        bank = questions_to_bank(data, source=source, pages=question_pages)
        path = bank_path(out_json)
        path.write_text(json.dumps(bank, ensure_ascii=False, indent=2), encoding="utf-8")
        log.info("[vision] bank: %d 题 -> %s", len(bank["questions"]), path.name)
    except Exception as e:
        log.warning("[vision] bank 导出失败（忽略）：%s", e)
    log.info("[vision] assembled %d questions, %d categories -> %s",
             len(questions), len(categories), out_json)
    return data


def audit_boxes(pages: dict[int, Path], figs: list[dict]) -> tuple[int, int]:
    """整卷框审计：返回 (画出的框总数, 越界框数)。

    越界 = 框坐标超出该页渲染像素边界（坐标空间不一致的信号）。
    """
    drawn = outside = 0
    for pno, path in pages.items():
        with Image.open(path) as im:
            w, h = im.size
        boxes = boxes_for_page(figs, pno, h)
        drawn += len(boxes)
        outside += sum(1 for _, (x0, y0, x1, y1) in boxes
                       if x0 < 0 or y0 < 0 or x1 > w or y1 > h)
    return drawn, outside


def carry_forward(spill: str | None) -> str | None:
    """把页末遗留材料转交下一页前剥离占位符。

    占位符里的编号是**本页局部号**；原样带入下一页会被 `_convert` 按下一页的
    局部表重新解释，把材料里的图错挂到另一个全局图号上（实测：第 1 页的
    `[[box:4]]` 在第 2 页被解释成全局图 8）。图本身由本页的 figures /
    unattributed 记账，故这里只传文字。

    剥离已在 `parse_page_result` 完成（落盘的 page_NN.json 亦干净），此处
    保留为幂等兜底，供手工构造的 page_results 使用。
    """
    if not spill:
        return None
    text = BOX_RE.sub("", spill).strip()
    if text != spill.strip():
        log.warning("[vision] spill_material 含页内占位符，转交下一页前已剥离")
    return text or None


def run_extraction(pdf: Path, client, rules: str, figs: list[dict], work: Path,
                   strict: bool = False) -> list[dict]:
    """逐页调用（含次页 lookahead）；单页失败跳过（strict 时抛出）。"""
    from PIL import Image as _Image
    pages = render_pages(pdf, work / "pages", zoom=2.0)
    total = len(pages)
    drawn, outside = audit_boxes(pages, figs)
    if figs and not drawn:  # 陈旧 figs.json（无 rect2x）或页码越界：满费跑且图全错位
        log.warning("[vision] %d 张图无一画出红框（figs.json 缺 rect2x 或页码越界）："
                    "本次仍逐页调用，图的归属将系统性错位", len(figs))
    if outside:
        log.warning("[vision] %d 个框超出页渲染边界（坐标空间可能不一致），已按原样绘制",
                    outside)
    vdir = work / "vision"
    vdir.mkdir(parents=True, exist_ok=True)
    # 失败页不写文件，上一轮的同名 page_NN.json 会被误当成本轮产物（排查被误导）；
    # 开跑前清干净，usage.json 一并重置。
    for pattern in ("page_*.json", "boxes_page*.json"):
        for stale in vdir.glob(pattern):
            stale.unlink()
    (work / "usage.json").unlink(missing_ok=True)
    results: list[dict] = []
    attributed: set[int] = set()
    page_h = None
    carry: str | None = None  # 上一页页末遗留的共用材料，随页码顺延
    carry_src: int | None = None  # 该材料的来源页，仅用于日志
    for pno in sorted(pages):
        with _Image.open(pages[pno]) as im:
            page_h = im.size[1]
            img = im.convert("RGB").copy()
        next_img = None
        next_page_h = page_h
        if pno + 1 in pages:
            with _Image.open(pages[pno + 1]) as im2:
                next_page_h = im2.size[1]
                next_img = im2.convert("RGB").copy()
        page_boxes = boxes_for_page(figs, pno, page_h)
        next_boxes = (boxes_for_page(figs, pno + 1, next_page_h, top_ratio=TOP_RATIO)
                      if next_img else [])
        incoming = carry  # 本页本该承接的材料（失败时随页丢弃，见下）
        try:
            res, mapping = extract_page(client, rules, pno, total, img, next_img,
                                        page_boxes, next_boxes, skip_globals=attributed,
                                        spill_note=incoming)
        except Exception as e:  # 单页失败不拖垮整卷
            log.error("[vision] 页 %d 抽取失败: %s", pno, e)
            if strict:
                raise
            # 失败页没有产出，材料不能继续下传：再传下去只会注入并不拥有
            # 它的题目（正是本计划要消灭的错挂类）。随页丢失 = 与页丢失同语义。
            if incoming:
                log.warning("[vision] 页 %d 失败，第 %s 页遗留的材料随页丢失：%s",
                            pno, carry_src, _preview(incoming))
            carry, carry_src = None, None
            continue
        if incoming:
            log.debug("[vision] 第 %s 页遗留材料 %d 字已由第 %d 页承接",
                      carry_src, len(incoming), pno)
        carry = carry_forward(res.get("spill_material"))  # 本页页末材料 → 下一页提示词
        carry_src = pno if carry else None
        if carry:
            log.debug("[vision] 第 %d 页产出遗留材料 %d 字 -> 第 %d 页",
                      pno, len(carry), pno + 1)
        (vdir / f"page_{pno:02d}.json").write_text(
            json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
        (vdir / f"boxes_page{pno:02d}.json").write_text(
            json.dumps({str(k): v for k, v in mapping.items()}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        results.append({"page": pno, **res})
        attributed |= {f["box"] for q in res["questions"] for f in q.get("figures") or []}
    if carry:  # 末页之后无处承接：显式告警而不是静默丢弃
        log.warning("[vision] 末页之后仍有第 %s 页遗留的材料未承接，已丢弃：%s",
                    carry_src, _preview(carry))
    u = getattr(client, "usage", None)
    (work / "usage.json").write_text(
        json.dumps({"vision": u, "attributed": sorted(attributed)},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    log.info("[vision] pages done: %d/%d", len(results), total)
    return results


def extract_page(client, rules: str, page_no: int, total_pages: int, page_img, next_img,
                 page_boxes, next_boxes, skip_globals: set[int],
                 spill_note: str | None = None) -> tuple[dict, dict[int, int]]:
    """画框（本页图 + 次页顶部条带，连续编号）→ prompt → 调用 → 解析。

    次页只发顶部条带：整页次页图会让模型把次页题目也抽出来（重复题，
    且其框被记入 attributed 后倒逼次页"忽略"自己的图）。
    """
    labeled, mapping = draw_labeled(page_img, page_boxes, first_id=1)
    images = [labeled]
    band = lookahead_image(next_img, next_boxes) if next_img is not None else None
    if band is not None:  # 框坐标即页坐标，裁剪自 y=0 起，无需偏移换算
        labeled_next, mapping_next = draw_labeled(band, next_boxes,
                                                  first_id=len(page_boxes) + 1)
        images.append(labeled_next)
        mapping.update(mapping_next)
    prompt = build_page_prompt(rules, page_no, total_pages, band is not None,
                               mapping, skip_globals, spill_note=spill_note)
    raw, _usage = client.extract_json(prompt, images, tag=f"page_{page_no:02d}",
                                      required_keys=("questions",))
    return parse_page_result(raw, mapping), mapping

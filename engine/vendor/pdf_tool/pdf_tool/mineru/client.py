#!/usr/bin/env python3
"""MinerU API 客户端：PDF → content_list → 我们的 blocks schema。

- 标准 API（v4）：申请上传链接 → PUT 上传 → 轮询 → 下载 zip（full.md/images/content_list）
- content_list → blocks：text_level→heading、equation→equation（LaTeX + 裁剪图）、
  image→image（caption 进 alt）、table→table（HTML→行列）；页眉/页脚/页码等页面装饰跳过
- 公式裁剪：按 bbox（0-1000 归一化）从 origin.pdf 裁出公式图，供重排 PDF 使用
"""
from __future__ import annotations

import html
import io
import itertools
import json
import logging
import re
import time
import zipfile
from html.parser import HTMLParser
from pathlib import Path

import requests

from pdf_tool.core.mathfix import normalize_math_delims
from pdf_tool.mineru import MineruCancelled

log = logging.getLogger("qb.mineru")

API_BASE = "https://mineru.net/api/v4"
DEFAULT_MODEL = "vlm"


class MineruError(RuntimeError):
    pass


class MineruClient:
    """MinerU 标准 API（需 token：https://mineru.net/apiManage）。"""

    supports_page_range = False  # 云端 API 无页范围参数（本地后端支持）

    def __init__(self, token: str, *, model: str = DEFAULT_MODEL,
                 timeout: int = 3600, poll_interval: float = 5.0):
        if not token:
            raise MineruError("缺少 MinerU token（--mineru-token 或环境变量 "
                              "MINERU_TOKEN / MINERU_API_KEY）")
        self.token = token
        self.model = model
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._hdr = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # ---- API ----

    def submit(self, pdf: Path) -> str:
        r = requests.post(f"{API_BASE}/file-urls/batch", headers=self._hdr,
                          json={"files": [{"name": pdf.name}], "model_version": self.model},
                          timeout=60)
        data = (r.json() or {}).get("data") or {}
        batch_id, urls = data.get("batch_id"), data.get("file_urls") or []
        if not batch_id:
            raise MineruError(f"申请上传链接失败: {r.status_code} {r.text[:200]}")
        with pdf.open("rb") as f:
            up = requests.put(urls[0], data=f, timeout=600)
        if up.status_code not in (200, 201):
            raise MineruError(f"文件上传失败: HTTP {up.status_code}")
        log.info("[mineru] 已上传 %s (%.1fMB)，等待解析", pdf.name,
                 pdf.stat().st_size / 1024 / 1024)
        return batch_id

    def wait(self, batch_id: str) -> dict:
        t0 = time.time()
        last = ""
        while time.time() - t0 < self.timeout:
            r = requests.get(f"{API_BASE}/extract-results/batch/{batch_id}",
                             headers=self._hdr, timeout=30)
            res = ((r.json() or {}).get("data", {}).get("extract_result") or [{}])[0]
            state = res.get("state")
            if state != last:
                prog = res.get("extract_progress") or {}
                log.info("[mineru] %s %s/%s (%.0fs)", state,
                         prog.get("extracted_pages"), prog.get("total_pages"),
                         time.time() - t0)
                last = state
            if state == "done":
                return {"state": state, "zip_url": res.get("full_zip_url"),
                        "elapsed": time.time() - t0}
            if state == "failed":
                raise MineruError(f"解析失败: {res.get('err_msg')}")
            time.sleep(self.poll_interval)
        raise MineruError(f"解析超时（{self.timeout}s，batch={batch_id}）")

    def parse(self, pdf: Path, work_dir: Path) -> dict:
        """完整流程：提交 → 轮询 → 下载解压。返回产物路径。"""
        batch_id = self.submit(pdf)
        got = self.wait(batch_id)
        z = requests.get(got["zip_url"], timeout=600)
        z.raise_for_status()
        work_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(z.content)) as zf:
            zf.extractall(work_dir)
        md = next(work_dir.rglob("full.md"), None)
        cl = next(work_dir.rglob("*content_list.json"), None)
        origin = next(work_dir.rglob("*origin.pdf"), None)
        log.info("[mineru] 完成: %.0fs, md=%s, content_list=%s",
                 got["elapsed"], md is not None, cl is not None)
        return {"dir": work_dir, "md": md, "content_list": cl, "origin": origin,
                "elapsed": got["elapsed"]}


# ---------------- content_list → blocks ----------------

class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []

    def handle_endtag(self, tag):
        if tag == "tr" and self._row is not None:
            if any(c.strip() for c in self._row):
                self.rows.append(self._row)
            self._row = None
        elif tag in ("td", "th") and self._cell is not None:
            if self._row is not None:
                self._row.append("".join(self._cell).strip())
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def html_table_to_rows(html: str) -> tuple[list[str], list[list[str]]] | None:
    """MinerU 的 table_body（HTML）→ (headers, rows)；解析不出返回 None。"""
    if not html or "<tr" not in html.lower():
        return None
    p = _TableParser()
    try:
        p.feed(html)
    except Exception:
        return None
    if not p.rows:
        return None
    return p.rows[0], p.rows[1:]


def _rel(path: Path, base: Path) -> str:
    return path.relative_to(base).as_posix()


def crop_equations(origin_pdf: Path | None, items: list[dict], out_dir: Path,
                   base: Path) -> dict[int, str]:
    """按 bbox（0-1000 归一化）从 origin.pdf 裁出公式图；返回 {item_index: rel_path}。"""
    if origin_pdf is None or not origin_pdf.exists():
        return {}
    import fitz

    doc = fitz.open(origin_pdf)
    out_dir.mkdir(parents=True, exist_ok=True)
    mapping: dict[int, str] = {}
    for i, it in enumerate(items):
        if it.get("type") != "equation":
            continue
        bbox, page_idx = it.get("bbox"), it.get("page_idx")
        if not bbox or page_idx is None or not (0 <= page_idx < doc.page_count):
            continue
        page = doc[page_idx]
        w, h = page.rect.width, page.rect.height
        rect = fitz.Rect(bbox[0] / 1000 * w - 2, bbox[1] / 1000 * h - 2,
                         bbox[2] / 1000 * w + 2, bbox[3] / 1000 * h + 2)
        dest = out_dir / f"eq_{i:04d}.jpg"
        pix = page.get_pixmap(clip=rect, matrix=fitz.Matrix(3, 3))
        pix.save(dest)
        mapping[i] = _rel(dest, base)
    doc.close()
    return mapping


def write_figs_json(items: list[dict], origin_pdf: Path | None, out_path: Path,
                    *, image_prefix: str = "mineru") -> int:
    """把 MinerU 的图片/表格 bbox 导出成我们的 figs.json（供 blocks_to_pdf 按原行并排）。

    条目：{n, page, pos:[x0,y0,x1,y1]（点）, src}（bbox 由 0-1000 归一化换算为点）。
    """
    if origin_pdf is None or not origin_pdf.exists():
        return 0
    import fitz

    doc = fitz.open(origin_pdf)
    prefix = f"{image_prefix.strip('/')}/" if image_prefix else ""
    figs: list[dict] = []
    n = 0
    for it in items:
        if it.get("type") not in ("image", "table", "chart"):
            continue
        src = it.get("img_path")
        bbox, page_idx = it.get("bbox"), it.get("page_idx")
        if not src or not bbox or page_idx is None or not (0 <= page_idx < doc.page_count):
            continue
        w, h = doc[page_idx].rect.width, doc[page_idx].rect.height
        n += 1
        figs.append({"n": n, "page": int(page_idx) + 1,
                     "pos": [round(bbox[0] / 1000 * w), round(bbox[1] / 1000 * h),
                             round(bbox[2] / 1000 * w), round(bbox[3] / 1000 * h)],
                     "src": prefix + src})
    doc.close()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(figs, ensure_ascii=False, indent=1), encoding="utf-8")
    return len(figs)


CODE_HINT_RE = re.compile(
    r"#include|using\s+namespace|int\s+\w+\s*\(|void\s+\w+\s*\(|for\s*\(|while\s*\(|"
    r"cin\s*>>|cout\s*<<|return\s+\w|struct\s+\w+|const\s+int|char\s+\w+|"
    r"[A-Za-z_]\w*\s*\([^)]*\)|->|::|\+\+|--|[A-Za-z_]\w*\[\w+\]|"
    r"=\s*[A-Za-z_0-9\"\']+\s*[;)]|;\s*$")
PROSE_HINT_RE = re.compile(r"当输入为|输出为|下列|正确的是|判断|（\s*）|A\.\s|B\.\s|C\.\s|D\.\s")
_NUM_LINE_RE = re.compile(r"(?<!\d)(\d{2})(?!\d)\s+")
_LEADING_NO_RE = re.compile(r"^\s*\(?(\d{1,2})[).、]\s*\n")


def split_numbered_lines(text: str) -> list[tuple[str, str]] | None:
    """把「01 code 02 code …」拆成 [(行号, 内容)]；行号不足 2 个返回 None。"""
    marks = list(_NUM_LINE_RE.finditer(text))
    if len(marks) < 2:
        return None
    out: list[tuple[str, str]] = []
    for k, m in enumerate(marks):
        end = marks[k + 1].start() if k + 1 < len(marks) else len(text)
        out.append((m.group(1), text[m.end():end].strip()))
    return out


def looks_like_code_text(text: str) -> bool:
    """行号开头的文本块是否其实是代码（跨页代码的上半页）。"""
    lines = split_numbered_lines(text)
    if not lines:
        return False
    body = " ".join(b for _n, b in lines)
    if CODE_HINT_RE.search(body):
        return True
    return sum(1 for _n, b in lines if b) >= 3


def looks_like_prose(text: str) -> bool:
    """被误判成 code 的正文（题目文字等）。"""
    return len(PROSE_HINT_RE.findall(text)) >= 2 and not CODE_HINT_RE.search(text)


# ---------------- 代码块识别 / 行号剥离（reader 2026-10-20） ----------------

_OPTION_LINE_RE = re.compile(r"^\s*[A-H][.、)]\s")
_QNUM_LINE_RE = re.compile(r"^\s*\d{1,3}\s*[)）.、]\s")
_CODE_LINE_HINT_RE = re.compile(
    r"^\s*(?:#\s*include|#\s*define|using\s+namespace|typedef\b|struct\b|class\b|"
    r"for\s*\(|while\s*\(|if\s*\(|else\b|switch\s*\(|case\b|break\s*;|continue\s*;|"
    r"return\b|int\b|char\b|double\b|float\b|void\b|long\b|short\b|unsigned\b|"
    r"const\b|printf\s*\(|scanf\s*\(|memset\s*\(|puts\s*\(|cout\b|cin\b)")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_MD_ESCAPE_RE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!])")
_TRAIL_COMMENT_RE = re.compile(r"//.*$")
_LEADING_LINE_NO_RE = re.compile(r"^(\d{1,3})[ \t]+(?=\S)")


def _code_part(line: str) -> str:
    """去掉行尾注释后的代码部分（判断中文占比/结尾符号用）。"""
    return _TRAIL_COMMENT_RE.sub("", str(line))


def _is_single_code_line(text) -> bool:
    """单行块是否一行代码（扫描页 MinerU 常把代码按行拆成 text 项）。"""
    t = str(text or "").strip()
    if not t or "\n" in t:
        return False
    if _OPTION_LINE_RE.match(t) or _QNUM_LINE_RE.match(t):
        return False  # 选项行 / 题号行
    core = _code_part(t).strip()
    if not core:
        return False
    if len(_CJK_RE.findall(core)) / max(1, len(core)) > 0.2:
        return False  # 中文行（题面/正文）
    m = _LEADING_LINE_NO_RE.match(core)
    if m:  # 页边行号 + 代码
        core = core[m.end():].strip()
        if not core:
            return False
    return bool(_CODE_LINE_HINT_RE.match(core) or re.search(r"[;{}]\s*$", core)
                or core in ("}", "{"))


def looks_like_code_block(text) -> bool:
    """多行 text 是否「整段程序」（reader 2026-10-20：矩阵变幻被判成 text）。"""
    raw = str(text or "")
    lines = [ln for ln in raw.splitlines() if ln.strip()]
    if len(lines) < 3:
        return False
    if sum(1 for ln in lines if _OPTION_LINE_RE.match(ln)) >= 2:
        return False  # 选择题选项列表
    core_text = "\n".join(_code_part(ln) for ln in lines)
    cjk = len(_CJK_RE.findall(core_text))
    alnum = sum(1 for c in core_text if c.isascii() and c.isalnum())
    if cjk > alnum * 0.6:
        return False  # 中文正文
    hints = sum(1 for ln in lines if _CODE_LINE_HINT_RE.search(_code_part(ln)))
    struct = sum(1 for ln in lines if re.search(r"[;{}]\s*$", _code_part(ln).rstrip()))
    if "#include" in raw and struct >= 2:
        return True
    return struct >= 3 and hints >= max(3, int(len(lines) * 0.35))


def _unescape_code(text) -> str:
    """代码块反转义：HTML 实体（`&lt;` 等）+ Markdown 反斜杠转义（`\\_` 等）。"""
    s = str(text or "")
    if any(e in s for e in ("&lt;", "&gt;", "&amp;", "&quot;", "&#39;")):
        s = html.unescape(s)
    return _MD_ESCAPE_RE.sub(r"\1", s)


def _strip_code_line_numbers(blocks) -> int:
    """剥离代码块行首的页边行号（reader 2026-10-20 P3）。

    仅当「≥2 行带行号且递增（间隔 ≤10）」时剥；`line_start` 只在**首行**带号时记录
    （跨页合并块的起始行不一定有号）。返回剥掉的行数。
    """
    removed = 0
    for b in blocks:
        if b.get("type") != "code":
            continue
        lines = str(b.get("content") or "").splitlines()
        nums = [int(m.group(1)) for ln in lines
                for m in [_LEADING_LINE_NO_RE.match(ln)] if m]
        if len(nums) < 2 or not all(0 < y - x <= 10
                                    for x, y in itertools.pairwise(nums)):
            continue
        first_has_no = bool(lines and _LEADING_LINE_NO_RE.match(lines[0]))
        out_lines: list[str] = []
        for ln in lines:
            m = _LEADING_LINE_NO_RE.match(ln)
            if m:
                out_lines.append(ln[m.end():])
                removed += 1
            else:
                out_lines.append(ln)
        b["content"] = "\n".join(out_lines)
        if first_has_no:
            b.setdefault("line_start", nums[0])
    return removed


# ---------------- 代码缺口检测 / 定向补识别（reader 2026-10-20 续） ----------------

def _line_no_of(text) -> int | None:
    m = _LEADING_LINE_NO_RE.match(str(text or ""))
    return int(m.group(1)) if m else None


# 全角 ASCII 标点/字母/数字 → 半角（仅用于 OCR 补回的代码行；不动中文注释与 ①②③）
_FW_TO_ASCII = str.maketrans(
    "；（）［］｛｝，．：？！＋－＊／＝＜＞０１２３４５６７８９"
    "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ"
    "ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ　",
    ";()[]{},.:?!+-*/=<>0123456789"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz ",
)


def _normalize_code_punct(text: str) -> str:
    """OCR 补回行：仅把 `//` 之前的全角标点/字母/数字转半角（中文注释保持原样）。"""
    code, sep, comment = str(text).partition("//")
    return code.translate(_FW_TO_ASCII) + sep + comment


def _line_pitch(entries) -> float | None:
    ys = [float(e["y0"]) for e in entries
          if isinstance(e.get("y0"), (int, float))]
    diffs = sorted(b - a for a, b in itertools.pairwise(ys) if 0 < b - a <= 80)
    return diffs[len(diffs) // 2] if diffs else None


def _ocr_page_lines(pdf, page_no: int, *, dpi: int = 200) -> list[tuple[float, str]]:
    """整页 OCR（仅在有缺口时调用）：返回 [(页内归一化 y 中心, 文本)]，已去行号。

    缺口小条 OCR 对裁剪/缩放很敏感（实测同一行会读残），整页识别稳定得多
    （reader 2026-10-20 建议 2 的落地方式）。
    """
    if pdf is None:
        return []
    try:
        import io

        import fitz
        import numpy as np
        from PIL import Image

        from pdf_tool.ocr.backends import make_backend

        doc = fitz.open(str(pdf))
        try:
            if not (1 <= int(page_no) <= doc.page_count):
                return []
            page = doc[int(page_no) - 1]
            pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72))
        finally:
            doc.close()
        img = np.array(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
        ih = img.shape[0]
        out: list[tuple[float, str]] = []
        for ln in make_backend("rapid").ocr(img):
            t = str(getattr(ln, "text", "") or "").strip()
            m = _LEADING_LINE_NO_RE.match(t)
            if m:
                t = t[m.end():].strip()
            if not t or re.fullmatch(r"\d{1,3}", t):
                continue  # 纯行号框
            quad = getattr(ln, "quad", None) or []
            if not quad:
                continue
            ys = [float(p[1]) for p in quad]
            out.append(((min(ys) + max(ys)) / 2 / max(1, ih) * 1000, t))
        return out
    except Exception as e:
        log.warning("[mineru] 缺口整页 OCR 失败（Page %s）：%s", page_no, e)
        return []


def _fill_code_gaps(entries, *, pdf, page_no: int) -> tuple[list[dict], list[dict], int]:
    """按印刷行号做缺口检测，行距只用来**定位**缺口；有 PDF 时整页 OCR 补行。

    行号是主信号：两个相邻行号 n→m 之间有 k 条内容行时，缺行数 = (m-n-1)-k；
    行距把缺行落到具体 y 位置。这样空白行/加大行距不会被误判成缺行。
    返回 (行条目列表, 未补上的 gaps, 补回行数)；gaps: [{"expected": [...], "page": N}]。
    """
    anchors = [(i, _line_no_of(e.get("text"))) for i, e in enumerate(entries)
               if _line_no_of(e.get("text")) is not None]
    if len(anchors) < 2:
        return entries, [], 0
    first = anchors[0][0]
    pitch = _line_pitch(entries[first:])
    if not pitch:
        return entries, [], 0
    page_lines: dict[int, list[tuple[float, str]]] = {}
    out: list[dict] = list(entries[:first + 1])
    gaps: list[dict] = []
    filled = 0
    for (i, n), (j, m) in itertools.pairwise(anchors):
        segment = entries[i + 1:j]
        missing = max(0, (m - n - 1) - len(segment))
        # 行距缺口（仅同页相邻行；定位用）
        slots: dict[int, int] = {}
        if missing:
            for k in range(i + 1, j + 1):
                prev, cur = entries[k - 1], entries[k]
                if prev.get("page") != cur.get("page"):
                    continue
                if prev.get("y0") is None or cur.get("y0") is None:
                    continue
                slot_n = max(0, round(
                    (float(cur["y0"]) - float(prev["y0"])) / pitch) - 1)
                if slot_n:
                    slots[k] = slot_n
        next_num = n + 1
        for k in range(i + 1, j + 1):
            if k in slots and next_num < m:
                take = min(slots[k], m - next_num)
                pg = int(entries[k - 1].get("page") or page_no)
                lo = float(entries[k - 1].get("y1") or 0) - 2
                hi = float(entries[k]["y0"]) + 2
                if pg not in page_lines:
                    page_lines[pg] = _ocr_page_lines(pdf, pg)
                got = [t for y, t in page_lines[pg] if lo <= y <= hi][:take]
                got = [_normalize_code_punct(t) for t in got]
                nums = list(range(next_num, next_num + take))
                if len(got) >= take:
                    out.extend({"text": t, "_filled": True} for t in got)
                    filled += take
                else:  # 补不全：已识别的也保留，剩余如实记缺口
                    out.extend({"text": t, "_filled": True} for t in got)
                    filled += len(got)
                    gaps.append({"expected": nums, "page": pg})
                next_num += take
            out.append(entries[k])
            if k < j and _line_no_of(entries[k].get("text")) is None:
                next_num += 1  # 无号行也消耗一个行号
        if next_num < m:  # 行距没跳/OCR 缺行：无坐标，仅报告
            gaps.append({"expected": list(range(next_num, m)),
                         "page": entries[j].get("page") or page_no})
    return out, gaps, filled


def _attach_code_gaps(block: dict, gaps, page_no: int, filled: int, stats: dict) -> None:
    """把缺口/补回信息挂到最终代码块上（同页合并 expected）。"""
    if filled:
        stats["code_filled"] = stats.get("code_filled", 0) + filled
    by_page: dict[int, list[int]] = {}
    for g in gaps:
        pg = int(g.get("page") or page_no)
        by_page.setdefault(pg, []).extend(g.get("expected") or [])
    for pg, nums in sorted(by_page.items()):
        nums = sorted(set(nums))
        if not nums:
            continue
        entry = {"position": f"Page {pg}", "expected": nums}
        existing = next((g for g in block.setdefault("code_gaps", [])
                         if g.get("position") == entry["position"]), None)
        if existing is not None:
            existing["expected"] = sorted(set(existing["expected"]) | set(nums))
        else:
            block["code_gaps"].append(entry)
        block["incomplete"] = True
        stats["code_gap_lines"] = stats.get("code_gap_lines", 0) + len(nums)


def _single_numbered_line(text: str) -> bool:
    """单行「（可选题号）+ 行号 + 内容」（扫描页 MinerU 会把代码按行切成 text 项）。"""
    t = str(text).strip()
    return "\n" not in t and bool(
        re.match(r"^(?:\(?\d{1,3}\)?[.、]?\s*)?\d{2}\s+\S", t))


_FURNITURE_LINE_RE = re.compile(
    r"^\s*(?:第\s*\d+\s*页[,，、]?\s*共\s*\d+\s*页|CCF\s+CSP[^\n]*试题[^\n]*|"
    r"第\s*\d+\s*页\s*$)\s*$")


def build_merged_text(blocks: list[dict]) -> str:
    """把 text/heading/code 块按页码合并成连续文本（保留 `===== 第 N 页 =====` 标记）。

    供「合并文本 → LLM 重新切分」使用：跨页代码在连续文本里天然连续，
    模型可据此输出完整代码块（不依赖逐页 item 的启发式缝合）。
    """
    parts: list[str] = []
    cur_page = -1
    prev_codeish = False
    for b in blocks:
        if b.get("type") not in ("text", "heading", "code"):
            continue
        page = _page_num(b) or (cur_page if cur_page > 0 else 1)
        body = str(b.get("content") if b.get("type") == "code"
                   else b.get("text") or "").strip()
        codeish = b.get("type") == "code" or _single_numbered_line(body) \
            or looks_like_code_text(body)
        # 连续代码之间不插页码标记，避免 LLM 顺着标记把跨页代码切开
        if page != cur_page and not (prev_codeish and codeish):
            parts.append(f"===== 第 {page} 页 =====")
        cur_page = page
        if body:
            parts.append(body)
        prev_codeish = codeish
    return "\n\n".join(parts)


def reflow_text_blocks(blocks: list[dict], client, prompt: str, *,
                       max_chars: int = 30000) -> tuple[list[dict], dict]:
    """用 LLM 把 text/code 部分重新切分成 text/heading/code 块（修复跨页代码）。

    - 输入：MinerU 的 blocks（含 image/table/equation）；
    - 输出：(新 blocks, stats)。image/table/equation 原样保留，text/heading/code 换成
      LLM 输出，并按页码与保留块合并排序。
    """
    from pdf_tool.extract.doc_mode import split_doc_text

    keep_types = ("image", "table", "equation", "page_footnote")
    keep = [b for b in blocks if b.get("type") in keep_types]
    text = build_merged_text(blocks)
    if not text.strip():
        return blocks, {"reflow_chunks": 0, "reflow_blocks": 0}
    chunks = split_doc_text(text, max_chars=max_chars)
    out: list[dict] = []
    for i, chunk in enumerate(chunks, 1):
        tag = f"reflow_{i:03d}"
        data, _usage = client.extract_json(
            f"{prompt}\n\n# 文档文本（第 {i}/{len(chunks)} 段）\n\n{chunk}", [],
            tag=tag, max_tokens=32000, retries=2, required_keys=("blocks",))
        for b in data.get("blocks") or []:
            if b.get("type") in ("text", "heading", "code"):
                out.append(b)
    merged = sorted([*keep, *out], key=lambda b: _page_num(b) or 0)
    stats = {"reflow_chunks": len(chunks), "reflow_blocks": len(out),
             "kept_blocks": len(keep)}
    log.info("[reflow] %s", stats)
    return merged, stats


def _is_content_line(line: str) -> bool:
    """选项/题号/代码行是题目内容，不可能是页眉页脚（reader 2026-10-20）。"""
    s = str(line or "").strip()
    if _OPTION_LINE_RE.match(s) or _QNUM_LINE_RE.match(s):
        return True
    core = _code_part(s).strip()
    if not core:
        return False
    return bool(_CODE_LINE_HINT_RE.match(core) or re.search(r"[;{}]\s*$", core))


def strip_furniture_lines(blocks: list[dict], *, min_blocks: int = 3) -> int:
    """剔除混进代码/正文块的页面装饰行（页脚、页码、跨页重复行）。

    - 正则命中（`第 N 页，共 M 页` / `CCF CSP…试题`）直接删；
    - 其余「跨 ≥min_blocks 个**不同页**、**归一化前内容完全一致**且长度 ≥8」的行才剔除；
      选项行 / 题号行 / 代码行永不删除（reader 2026-10-20：数字归一 `\\d+ → #` 会把
      结构相同的选项行误判成页眉页脚）。
    """
    from collections import defaultdict

    pages: dict[str, set] = defaultdict(set)
    for bi, b in enumerate(blocks):
        if b.get("type") not in ("code", "text"):
            continue
        page = _page_num(b)
        loc = ("p", page) if page else ("b", bi)  # 无页码信息时按块计
        body = str(b.get("content") or b.get("text") or "")
        for ln in {x.strip() for x in body.splitlines() if x.strip()}:
            if len(ln) >= 8 and not _is_content_line(ln):
                pages[ln].add(loc)
    repeated = {ln for ln, locs in pages.items() if len(locs) >= min_blocks}

    removed = 0
    for b in blocks:
        t = b.get("type")
        if t not in ("code", "text"):
            continue
        key = "content" if t == "code" else "text"
        body = str(b.get(key) or "")
        if not body:
            continue
        keep: list[str] = []
        for ln in body.splitlines():
            s = ln.strip()
            if s and _FURNITURE_LINE_RE.match(s):
                removed += 1
                continue
            # 重复行启发式只用于 text（代码行如 #include 天然跨程序重复，不能删）
            if t == "text" and s and len(s) >= 8 and s in repeated:
                removed += 1
                continue
            keep.append(ln)
        new = "\n".join(keep).strip("\n")
        if new != body:
            b[key] = new
    return removed


def stitch_blocks(blocks: list[dict], *, pdf: Path | None = None) -> tuple[list[dict], dict]:
    """跨页缝合：代码上半页(text)+下半页(code) 合并、误判 code 降级、跨页表格续接。

    MinerU 在跨页处会把同一代码块拆成两个 item（上半页常被判成 text），
    这里按行号连续性合并；表格则按「表头相同且相邻页」续接去重。
    代码块若有印刷行号缺口：尝试用原始页图对缺口区域定向 OCR 补回（需传 pdf），
    补不上的记 `code_gaps` + `incomplete`（reader 2026-10-20）。
    """
    stats = {"code_merged": 0, "code_demoted": 0, "tables_merged": 0, "code_runs": 0,
             "furniture_lines": 0, "code_promoted": 0, "code_line_numbers": 0,
             "code_filled": 0, "code_gap_lines": 0}
    # ⑤a 先把「整段程序」的 text 提升为 code —— 必须先于家具行剔除：
    # 否则公共代码行（using namespace std; / int main() { / return 0;）会被
    # 重复行启发式当页眉页脚删掉（reader 2026-10-20 实测）。
    promoted = 0
    for b in blocks:
        if b.get("type") == "text" and looks_like_code_block(str(b.get("text") or "")):
            b["content"] = _unescape_code(str(b.get("text") or ""))
            b["type"] = "code"
            b.pop("text", None)
            promoted += 1
    stats["code_promoted"] = promoted
    # 再剔页面装饰（页脚里的页码会干扰行号判断）
    stats["furniture_lines"] = strip_furniture_lines(blocks)
    out: list[dict] = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        t = b.get("type")
        # ⓪ 扫描页的「逐行代码」：连续单行代码 text 块 → 合并成代码块（可跨页续接）
        if t in ("text", "code") and _is_single_code_line(
                b.get("text") if t == "text" else b.get("content")):
            entries: list[dict] = []
            j = i
            while j < len(blocks):
                cand = blocks[j]
                ct = cand.get("type")
                if ct not in ("text", "code"):
                    break
                line = cand.get("text") if ct == "text" else cand.get("content")
                if not _is_single_code_line(line):
                    break
                entries.append({"text": str(line), "page": _page_num(cand),
                                "y0": cand.get("_y0"), "y1": cand.get("_y1"),
                                "x0": cand.get("_x0"), "x1": cand.get("_x1")})
                j += 1
            page_no = _page_num(b)
            entries, gap_list, filled = _fill_code_gaps(entries, pdf=pdf,
                                                        page_no=page_no)
            body = _unescape_code("\n".join(e["text"] for e in entries))
            prev = out[-1] if out else None
            mergeable = (len(entries) >= 2 and prev is not None
                         and prev.get("type") == "code"
                         and not str(prev.get("content") or "").rstrip().endswith("}")
                         and (_page_num(prev) == _page_num(b)
                              or _adjacent_pages(prev, b)))
            if len(entries) >= 3 or mergeable:
                if mergeable:
                    prev["content"] = (str(prev.get("content") or "").rstrip()
                                       + "\n" + body)
                    stats["code_merged"] += 1
                    target = prev
                else:
                    target = {"type": "code", "position": b.get("position"),
                              "content": body}
                    out.append(target)
                _attach_code_gaps(target, gap_list, page_no, filled, stats)
                stats["code_runs"] += 1
                i = j
                continue
        # ① 误判为代码的正文 → 降级为 text
        if t == "code" and looks_like_prose(str(b.get("content") or "")):
            out.append({"type": "text", "position": b.get("position"),
                        "text": str(b.get("content") or "").strip()})
            stats["code_demoted"] += 1
            i += 1
            continue
        # ② 代码型 text（跨页上半页/尾部碎片）→ 并入相邻代码块
        if t == "text" and looks_like_code_text(str(b.get("text") or "")):
            lines = split_numbered_lines(str(b["text"])) or []
            body = "\n".join(f"{n} {c}".rstrip() for n, c in lines)
            prefix = str(b["text"])[:str(b["text"]).find(lines[0][0])].strip(" 　")
            caption = prefix or b.get("caption") or ""
            # ②a 优先并入前一个代码块（行号连续，常见于跨页尾部碎片）
            if (out and out[-1].get("type") == "code"
                    and _continuity_ok(out[-1], {"content": body})):
                out[-1]["content"] = (str(out[-1].get("content") or "").rstrip()
                                      + "\n" + body)
                stats["code_merged"] += 1
                i += 1
                continue
            nxt = blocks[i + 1] if i + 1 < len(blocks) else None
            if nxt and nxt.get("type") == "code":
                merged = {"type": "code", "position": b.get("position"),
                          "content": body + "\n" + str(nxt.get("content") or "").strip()}
                if nxt.get("lang"):
                    merged["lang"] = nxt["lang"]
                if caption or nxt.get("caption"):
                    merged["caption"] = caption or nxt.get("caption")
                out.append(merged)
                stats["code_merged"] += 1
                i += 2
                continue
            if CODE_HINT_RE.search(body):  # 后面不是代码块，但本身强代码特征
                blk = {"type": "code", "position": b.get("position"), "content": body}
                if caption:
                    blk["caption"] = caption
                out.append(blk)
                stats["code_merged"] += 1
                i += 1
                continue
        # ③ 同类型跨页合并（code/table：结构性合并；行号连续性作为软校验）
        if t in ("code", "table") and out and out[-1].get("type") == t:
            prev = out[-1]
            a = _last_line_no(str(prev.get("content") or ""))
            bnum = _first_line_no(str(b.get("content") or ""))
            same_type_merge = (
                (t == "code" and a is not None and bnum is not None and bnum == a + 1)
                or (t == "code" and a is None and bnum is None and _adjacent_pages(prev, b))
                or (t == "table" and b.get("headers") == prev.get("headers")
                    and _adjacent_pages(prev, b))
            )
            if same_type_merge:
                if t == "code":
                    prev["content"] = str(prev.get("content") or "").rstrip() + "\n" + \
                        str(b.get("content") or "").strip()
                    stats["code_merged"] += 1
                else:
                    prev["rows"] = list(prev.get("rows") or []) + list(b.get("rows") or [])
                    if not prev.get("caption") and b.get("caption"):
                        prev["caption"] = b["caption"]
                    stats["tables_merged"] += 1
                i += 1
                continue
        # ④ 跨页表格：表头相同且下一页 → 续接（兼容续页重复表头的排版）
        if (t == "table" and out and out[-1].get("type") == "table"
                and b.get("headers") == out[-1].get("headers")
                and _adjacent_pages(out[-1], b)):
            out[-1]["rows"] = list(out[-1].get("rows") or []) + list(b.get("rows") or [])
            stats["tables_merged"] += 1
            i += 1
            continue
        out.append(b)
        i += 1

    for b in out:  # 题号混进代码首行（如 "3)"）→ 移到 caption
        if b.get("type") == "code" and not b.get("caption"):
            m = _LEADING_NO_RE.match(str(b.get("content") or ""))
            if m:
                b["caption"] = f"({m.group(1)})"
                b["content"] = str(b["content"])[m.end():]
    stats["code_line_numbers"] = _strip_code_line_numbers(out)  # P3：页边行号不进 content
    for b in out:  # 清掉缺口检测用的私有坐标（不进 Doc JSON）
        for k in ("_y0", "_y1", "_x0", "_x1"):
            b.pop(k, None)
    return out, stats


def _page_num(block: dict) -> int:
    m = re.search(r"(\d+)", str(block.get("position") or ""))
    return int(m.group(1)) if m else 0


def _last_line_no(text: str) -> int | None:
    """文本里最后一个行号：优先取结尾裸行号（'…\\n26'），否则取最后出现的行号。"""
    m = re.search(r"(?<!\d)(\d{2})(?!\d)\s*$", str(text).strip())
    if m:
        return int(m.group(1))
    marks = list(_NUM_LINE_RE.finditer(text))
    return int(marks[-1].group(1)) if marks else None


def _first_line_no(text: str) -> int | None:
    """文本里第一个行号（支持只有一行的情况，如 '07 int c;' → 7）。"""
    m = re.match(r"\s*(?:\(?\d{1,3}\)?[.、]?\s*)?(\d{2})(?!\d)\s+\S", text)
    return int(m.group(1)) if m else None


def _adjacent_pages(prev: dict, nxt: dict) -> bool:
    """严格「下一页」：跨页续写才合并，同页的两个代码块/表格视为独立。"""
    a, b = _page_num(prev), _page_num(nxt)
    return a > 0 and b > 0 and b - a == 1


def _continuity_ok(prev: dict, nxt: dict) -> bool:
    """行号连续性作为「软校验」：都有行号时必须连续；只有一边有则保守不合并。"""
    a = _last_line_no(str(prev.get("content") or ""))
    b = _first_line_no(str(nxt.get("content") or ""))
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return b == a + 1


def content_list_to_blocks(items: list[dict], *, base: Path,
                           eq_images: dict[int, str] | None = None,
                           image_prefix: str = "",
                           footnotes: bool = True) -> tuple[list[dict], dict]:
    """MinerU content_list → blocks（含 position=Page N；跳过页眉页脚等）。

    image_prefix：图片路径前缀（如 `mineru`），使相对路径能对上解压目录。
    footnotes：是否保留 `page_footnote` 脚注块（默认 True；False 时与页眉/页脚/页码
    一起计入 skipped_furniture）——不需要脚注的消费方（旧行为）可关闭。
    """
    eq_images = eq_images or {}
    prefix = f"{image_prefix.strip('/')}/" if image_prefix else ""
    blocks: list[dict] = []
    stats = {"items": len(items), "skipped_furniture": 0, "footnotes": 0,
             "equations": 0, "tables": 0, "images": 0, "headings": 0, "codes": 0,
             "charts": 0}
    for i, it in enumerate(items):
        t = it.get("type")
        page = int(it.get("page_idx") or 0) + 1
        pos = f"Page {page}"
        if t == "text":
            raw = it.get("text") or ""
            text = raw.strip()
            if not text:
                continue
            extra: dict = {}
            # 单行代码（扫描页常见）：保留行首缩进 + 行框坐标（缺口检测/定向补识别用；
            # `stitch_blocks` 结束时清掉，不进入 Doc JSON）—— reader 2026-10-20
            if "\n" not in text and _is_single_code_line(text):
                text = raw.strip("\n").rstrip()
                bbox = it.get("bbox") or []
                if len(bbox) == 4:
                    extra = {"_y0": float(bbox[1]), "_y1": float(bbox[3]),
                             "_x0": float(bbox[0]), "_x1": float(bbox[2])}
            level = it.get("text_level")
            if level:
                stats["headings"] += 1
                blocks.append({"type": "heading", "position": pos,
                               "level": int(level), "text": text})
            else:
                blocks.append({"type": "text", "position": pos, "text": text, **extra})
        elif t == "equation":
            stats["equations"] += 1
            blk = {"type": "equation", "position": pos,
                   "text": (it.get("text") or "").strip()}
            if i in eq_images:
                blk["image"] = {"src": eq_images[i], "alt": "公式"}
            blocks.append(blk)
        elif t == "code":  # MinerU 的代码块：code_body 是带围栏的 markdown
            body = (it.get("code_body") or "").strip()
            if not body:
                continue
            stats["codes"] += 1
            lang = ""
            m = re.match(r"^```([A-Za-z0-9_+.-]*)\s*\n?(.*?)\n?```\s*$", body, re.DOTALL)
            if m:
                lang, body = m.group(1), m.group(2)
            blk = {"type": "code", "position": pos, "content": body}
            if lang and lang.lower() not in ("txt", "text", "plain"):
                blk["lang"] = lang
            caption = " ".join(it.get("code_caption") or [])
            if caption:
                blk["caption"] = caption
            blocks.append(blk)
        elif t == "chart":  # 图表按图片处理
            src = it.get("img_path") or ""
            if not src:
                continue
            stats["charts"] += 1
            caption = " ".join(it.get("chart_caption") or [])
            blocks.append({"type": "image", "position": pos,
                           "image": {"src": prefix + src, "alt": caption or "图表"}})
        elif t == "image":
            src = it.get("img_path") or ""
            if not src:
                continue
            stats["images"] += 1
            caption = " ".join(it.get("image_caption") or [])
            blocks.append({"type": "image", "position": pos,
                           "image": {"src": prefix + src, "alt": caption or "插图"}})
        elif t == "table":
            body = it.get("table_body") or ""
            parsed = html_table_to_rows(body)
            caption = " ".join(it.get("table_caption") or [])
            if parsed:
                headers, rows = parsed
                # P1-a：单元格里的半截公式分隔符归一成对（$…$）
                headers = [normalize_math_delims(c) for c in headers]
                rows = [[normalize_math_delims(c) for c in r] for r in rows]
                stats["tables"] += 1
                blk = {"type": "table", "position": pos, "headers": headers,
                       "rows": rows}
                if caption:
                    blk["caption"] = caption
                if it.get("img_path"):
                    blk["image"] = {"src": prefix + it["img_path"],
                                    "alt": caption or "表格"}
                blocks.append(blk)
            elif it.get("img_path"):  # HTML 解析失败 → 退化为表格图
                stats["images"] += 1
                blocks.append({"type": "image", "position": pos,
                               "image": {"src": prefix + it["img_path"],
                                         "alt": caption or "表格"}})
        elif t == "page_footnote":  # 脚注正文：默认保留（reader 需求；可 footnotes=False 关闭）
            text = (it.get("text") or "").strip()
            if text and footnotes:
                stats["footnotes"] += 1
                blocks.append({"type": "page_footnote", "position": pos, "text": text,
                               "page_idx": int(it.get("page_idx") or 0)})
            else:
                stats["skipped_furniture"] += 1
        elif t == "page_number":  # 家具跳过；但印刷页码要留下（reader R1：目录页码 ↔ 正文定位）
            stats["skipped_furniture"] += 1
            m = re.fullmatch(r"[^\d]{0,8}(\d{1,4})[^\d]{0,8}", (it.get("text") or "").strip())
            if m:
                stats.setdefault("page_numbers", {})[page] = int(m.group(1))
        elif t in ("header", "footer", "page_footnote", "aside_text"):
            stats["skipped_furniture"] += 1
        else:
            stats["skipped_furniture"] += 1
    return blocks, stats


# ---------------- 大文档分卷解析（超过 max_pages 自动分卷并合并） ----------------

def merge_chunk_layouts(chunk_layouts: list, total: int, out_path: Path) -> dict:
    """把各卷 layout.json 的 pdf_info 按页码偏移合并成整本（缺页补空页，保证页对齐）。

    chunk_layouts: [(start0, pdf_info, meta), ...]；返回合并后的 layout 数据。
    """
    by_page: dict[int, dict] = {}
    meta: dict = {}
    page_size = None
    for start0, pages, m in chunk_layouts:
        if not meta:
            meta = {k: v for k, v in (m or {}).items() if k.startswith("_")}
        for pg in pages:
            if not isinstance(pg, dict):
                continue
            local = int(pg.get("page_idx") or 0)
            g = start0 + local
            if not (0 <= g < total):
                log.warning("[mineru] layout 合并：忽略越界页 %s（start=%s）", local, start0)
                continue
            item = dict(pg)
            item["page_idx"] = g
            by_page[g] = item
            page_size = item.get("page_size") or page_size

    got = sum(len(pages) for _, pages, _ in chunk_layouts)
    if got != total:
        log.warning("[mineru] layout 合并：分卷页数合计 %d ≠ 文档总页数 %d", got, total)

    missing = [g for g in range(total) if g not in by_page]
    for g in missing:  # 补空页：页码不能因缺页而整体前移
        by_page[g] = {"page_idx": g, "page_size": page_size, "para_blocks": [],
                      "discarded_blocks": []}
    data = {**meta, "pdf_info": [by_page[g] for g in range(total)], "_chunked": True}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if missing:
        log.warning("[mineru] layout 合并缺页（已补空页保持页对齐）: %s", missing[:20])
    return data


def parse_pdf(client, pdf: Path, work_dir: Path, *, max_pages: int = 200,
              force: bool = False, on_chunk=None, pages=None, cancelled=None) -> dict:
    """解析整份 PDF：≤max_pages 单次；超过则按卷解析并合并 content_list。

    - 每卷缓存 `work_dir/chunks/{tag}/`（`_done.json` 存在即跳过，force 重跑）；
    - 合并时 `page_idx` 平移为全文档页码，图片路径重写为 `chunks/{tag}/{原路径}`；
    - pages（1-based 列表，可选）：只解析这些页——单卷时对支持页范围的客户端透传
      `--pages`（MinerU 保持原页码，`page_idx` 仍是全局值）；分卷时只取相交的卷，
      并让卷 PDF 只含这些页（两类客户端都省算力）；
    - cancelled（可调用，返回 True=取消）：支持取消的客户端（本地 CLI/常驻服务）在解析中
      响应取消（杀进程 / DELETE 任务），抛 `MineruCancelled`；分卷模式下在卷之间也会检查；
    - 返回 {"items", "chunks":[{tag,start,origin,items_local}], "md", "elapsed",
            "pages", "chunked", "content_list"}；chunks 供公式裁剪 / figs 使用。
    """
    import fitz

    from pdf_tool.core.pdfops import make_chunk_pdf, split_ranges

    want = {int(p) for p in pages or [] if int(p) > 0}
    can_range = bool(getattr(client, "supports_page_range", False))
    can_cancel = bool(getattr(client, "supports_cancel", False))
    extra: dict = {"cancelled": cancelled} if (cancelled is not None and can_cancel) else {}

    def _check_cancel() -> None:
        if cancelled is not None and cancelled():
            raise MineruCancelled("已取消（分卷解析开始前）")

    pdf = Path(pdf)
    doc = fitz.open(pdf)
    try:
        total = doc.page_count
        ranges = split_ranges(total, max_pages)
        merged_layout = None
        if len(ranges) <= 1:
            kwargs = {"pages": sorted(want)} if (want and can_range) else {}
            parsed = client.parse(pdf, work_dir, **{**kwargs, **extra})
            items = json.loads(Path(parsed["content_list"]).read_text(encoding="utf-8"))
            exact = work_dir / "layout.json"  # 阅读端契约：work/layout.json
            if exact.exists():
                merged_layout = exact
            else:
                lj = next(iter(sorted(work_dir.glob("*layout.json"))), None)
                if lj is not None:  # 带 uuid 前缀的产物统一命名为 layout.json
                    merged_layout = exact
                    merged_layout.write_bytes(lj.read_bytes())
            return {"items": items,
                    "chunks": [{"tag": None, "start": 0, "origin": parsed["origin"],
                                "items_local": items}],
                    "md": parsed["md"], "elapsed": parsed["elapsed"], "pages": total,
                    "chunked": False, "content_list": Path(parsed["content_list"]),
                    "layout": merged_layout}

        merged: list[dict] = []
        chunks: list[dict] = []
        chunk_layouts: list = []
        md_parts: list[str] = []
        elapsed = 0.0
        for start, end in ranges:
            _check_cancel()
            chunk_pages = list(range(start, end + 1))
            if want:
                chunk_pages = [p for p in chunk_pages if p in want]
                if not chunk_pages:  # 整卷不在请求范围内：跳过（合并时补空页）
                    continue
            offset0 = chunk_pages[0] - 1
            tag = f"{start:04d}-{end:04d}"
            cdir = work_dir / "chunks" / tag
            marker = cdir / "_done.json"
            meta = None
            if marker.exists() and not force:
                m = json.loads(marker.read_text(encoding="utf-8"))
                # 范围一致才复用缓存（旧 marker 无 page_list 时按整卷处理）
                if m.get("page_list") == chunk_pages or (
                        "page_list" not in m and not want):
                    meta = m
            if meta:
                cl = Path(meta["content_list"])
                origin = Path(meta["origin"]) if meta.get("origin") else None
            else:
                chunk_pdf = cdir / "chunk.pdf"
                make_chunk_pdf(doc, chunk_pages, chunk_pdf)
                parsed = client.parse(chunk_pdf, cdir, **extra)
                cl = Path(parsed["content_list"])
                origin = parsed["origin"]
                elapsed += float(parsed.get("elapsed") or 0.0)
                marker.write_text(json.dumps(
                    {"content_list": str(cl), "origin": str(origin) if origin else None,
                     "start": start, "end": end, "page_list": chunk_pages},
                    ensure_ascii=False, indent=1), encoding="utf-8")
                log.info("[mineru] 分卷 %s 完成（%d 页%s）", tag, len(chunk_pages),
                         "，按请求范围过滤" if want else "")

            items_local = json.loads(cl.read_text(encoding="utf-8"))
            for it in items_local:  # 合并副本：页号平移 + 图片路径重写（不改原卷数据）
                item = dict(it)
                item["page_idx"] = int(item.get("page_idx") or 0) + offset0
                src = item.get("img_path")
                if src:
                    item["img_path"] = f"chunks/{tag}/{src}"
                merged.append(item)
            chunks.append({"tag": tag, "start": offset0, "origin": origin,
                           "items_local": items_local})
            lj = next((p for p in (cdir / "layout.json",
                                   *sorted(cdir.glob("*layout.json"))) if p.exists()), None)
            if lj is not None:  # 各卷版式（合并后供阅读端 hybrid / layout 契约使用）
                ldata = json.loads(lj.read_text(encoding="utf-8"))
                chunk_layouts.append((start - 1, ldata.get("pdf_info") or [],
                                      {k: v for k, v in ldata.items()
                                       if k.startswith("_")}))
            md = next(cdir.rglob("full.md"), None)
            if md:
                md_parts.append(f"<!-- pages {start}-{end} -->\n"
                                + md.read_text(encoding="utf-8"))
            if on_chunk is not None:
                on_chunk(tag, len(chunks), len(ranges))

        if chunk_layouts:
            merged_layout = work_dir / "layout.json"
            merge_chunk_layouts(chunk_layouts, total, merged_layout)

        cl_path = work_dir / "content_list.json"
        cl_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2),
                           encoding="utf-8")
        md_path = None
        if md_parts:
            md_path = work_dir / "full.md"
            md_path.write_text("\n\n".join(md_parts), encoding="utf-8")
        return {"items": merged, "chunks": chunks, "md": md_path, "elapsed": elapsed,
                "pages": total, "chunked": True, "content_list": cl_path,
                "layout": merged_layout}
    finally:
        doc.close()


def crop_equations_chunked(chunks: list[dict], eq_dir: Path, base: Path) -> dict[int, str]:
    """按卷裁公式图（每卷一个子目录避免重名），返回 {全局 item 下标: rel}。"""
    mapping: dict[int, str] = {}
    offset = 0
    for ch in chunks:
        tag = ch.get("tag") or "all"
        m = crop_equations(ch["origin"], ch["items_local"], eq_dir / tag, base)
        for local_i, rel in m.items():
            mapping[offset + local_i] = rel
        offset += len(ch["items_local"])
    return mapping


def write_figs_json_chunked(chunks: list[dict], out_path: Path, *,
                            image_prefix: str = "mineru") -> int:
    """分卷版 figs.json：page 为全文档页码，src 与合并后的 img_path 一致。"""
    import fitz

    prefix = f"{image_prefix.strip('/')}/" if image_prefix else ""
    figs: list[dict] = []
    n = 0
    for ch in chunks:
        if not ch.get("origin"):
            continue
        doc = fitz.open(ch["origin"])
        try:
            for it in ch["items_local"]:
                if it.get("type") not in ("image", "table", "chart"):
                    continue
                src, bbox, pi = it.get("img_path"), it.get("bbox"), it.get("page_idx")
                if not src or not bbox or pi is None or not (0 <= pi < doc.page_count):
                    continue
                w, h = doc[pi].rect.width, doc[pi].rect.height
                tag_prefix = f"chunks/{ch['tag']}/" if ch.get("tag") else ""
                n += 1
                figs.append({"n": n, "page": ch["start"] + int(pi) + 1,
                             "pos": [round(bbox[0] / 1000 * w), round(bbox[1] / 1000 * h),
                                     round(bbox[2] / 1000 * w), round(bbox[3] / 1000 * h)],
                             "src": prefix + tag_prefix + src})
        finally:
            doc.close()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(figs, ensure_ascii=False, indent=1), encoding="utf-8")
    return len(figs)


def parse_to_blocks(client, pdf: Path, out_dir: Path, *, max_pages: int = 200,
                    force: bool = False, on_chunk=None, stitch: bool = True,
                    pages=None, cancelled=None, footnotes: bool = True) -> tuple[list[dict], dict]:
    """PDF → MinerU blocks 的统一入口（大文档自动分卷；产物落 out_dir/mineru/）。

    pages：1-based 页码列表（可选）——只解析这些页（详见 `parse_pdf`）。
    cancelled：可调用（返回 True=取消）——本地后端会中断解析并抛 `MineruCancelled`。
    footnotes：是否保留 `page_footnote` 脚注块（默认 True）。
    """
    out_dir = Path(out_dir)
    work = out_dir / "mineru"
    parsed = parse_pdf(client, pdf, work, max_pages=max_pages, force=force,
                       on_chunk=on_chunk, pages=pages, cancelled=cancelled)
    if parsed["chunked"]:
        eq_images = crop_equations_chunked(parsed["chunks"], work / "equations", out_dir)
    else:
        ch = parsed["chunks"][0]
        eq_images = crop_equations(ch["origin"], parsed["items"],
                                   work / "equations", out_dir)
    n_figs = write_figs_json_chunked(parsed["chunks"], work / "figs.json",
                                     image_prefix="mineru")
    blocks, stats = content_list_to_blocks(parsed["items"], base=out_dir,
                                           eq_images=eq_images, image_prefix="mineru",
                                           footnotes=footnotes)
    if stitch:
        blocks, sstats = stitch_blocks(blocks, pdf=pdf)
        stats = {**stats, **sstats}
    stats = {**stats, "figs": n_figs, "chunked": parsed["chunked"],
             "chunks": len(parsed["chunks"]),
             "elapsed_s": round(parsed["elapsed"], 1),
             "md": parsed["md"].relative_to(out_dir).as_posix() if parsed["md"] else None}
    return blocks, stats

#!/usr/bin/env python3
"""blocks JSON（box/doc 协议输出）→ Markdown / HTML 转换。

用法:
  python pdf_tool/blocks_to_md.py --json output/{stem}/{stem}_doc.json --out out.md
  python pdf_tool/blocks_to_md.py --json output/{stem}/{stem}_doc.json --out out.html

- 图片路径原样保留（适合把输出写到 JSON 同目录）；跨目录时用 --base 加前缀；
- 兼容考题（question）blocks：题号/题干/选项/表格/答案/解析；
- 离线、无第三方依赖。
"""
from __future__ import annotations

import argparse
import html as html_mod
import json
import os
import re
from pathlib import Path

from pdf_tool.model.document import page_of

REF_RE = re.compile(r"!\[插图(\d+)\]")
IMG_MD_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")


def as_text(v) -> str:
    """把 str / {text|content} / list 等字段统一成文本。"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float, bool)):
        return str(v)
    if isinstance(v, list):
        return "\n".join(x for x in (as_text(i) for i in v) if x)
    if isinstance(v, dict):
        for k in ("text", "content"):
            if isinstance(v.get(k), str):
                return v[k]
        if isinstance(v.get("steps"), list):
            return "\n".join(x for x in (as_text(i) for i in v["steps"]) if x)
    return str(v)


def src_url(s) -> str:
    """src 可能是 markdown 链接 `![alt](url)`，也可能是裸 url/[[box:n]]。"""
    m = IMG_MD_RE.match(str(s or ""))
    return m.group(1) if m else str(s or "")


def _refs(text) -> set[str]:
    return set(REF_RE.findall(str(text or "")))


def md_table(headers, rows) -> str:
    def cell(x) -> str:
        return as_text(x).replace("|", "\\|").replace("\n", "<br>")

    head = [cell(h) for h in headers or []]
    if not head:
        return ""
    lines = ["| " + " | ".join(head) + " |",
             "| " + " | ".join("---" for _ in head) + " |"]
    for r in rows or []:
        lines.append("| " + " | ".join(cell(c) for c in r) + " |")
    return "\n".join(lines)


def _img_md(im: dict) -> str:
    return f"![{as_text(im.get('alt'))}]({src_url(im.get('src'))})"


def _images_md(block: dict, in_text: set[str]) -> list[str]:
    out = []
    for im in block.get("images") or []:
        if not isinstance(im, dict):
            continue
        k = re.search(r"插图(\d+)", str(im.get("src") or ""))
        if k and k.group(1) in in_text:
            continue
        out.append(_img_md(im))
    return out


def render_md_blocks(blocks: list[dict], *, anchors: bool = True,
                     printed: dict | None = None) -> list[str]:
    """blocks → Markdown 行；`anchors=True` 时按页插入锚点注释（reader 用）。

    printed：可选 `{PDF 页号: 印刷页码}`——有值时锚点写成 `<!--page:16 printed:7-->`（R1）。
    R3：标题行**紧前**保证有一个锚点（页中标题也能直接命中，不必推断）。
    """
    printed = printed or {}
    out: list[str] = []
    cur_page = 0
    prev_anchor_page = 0  # 上一行若是锚点，这里是它的页号；否则 0
    for b in blocks:
        page = page_of(b.get("position")) if anchors else 0
        want_anchor = False
        if page:
            if page != cur_page:
                want_anchor = True
            elif b.get("type") == "heading" and prev_anchor_page != page:
                want_anchor = True  # 页中标题紧前补锚点（R3）
        if want_anchor:
            p = printed.get(page)
            out.append(f"<!--page:{page} printed:{p}-->" if p else f"<!--page:{page}-->")
            cur_page = prev_anchor_page = page
        n_before = len(out)
        t = b.get("type")
        if t == "heading":
            level = min(max(int(b.get("level") or 2), 1), 6)
            out.append("#" * level + " " + as_text(b.get("text")))
        elif t == "text":
            text = as_text(b.get("text") if b.get("text") is not None else b.get("content"))
            parts = [text, *_images_md(b, _refs(text))]
            out.append("\n".join(p for p in parts if p))
        elif t == "code":
            lang = str(b.get("lang") or "")
            out.append(f"```{lang}\n{as_text(b.get('content') or b.get('code'))}\n```")
        elif t == "table":
            tb = b.get("table") if isinstance(b.get("table"), dict) else b
            out.append(md_table(tb.get("headers"), tb.get("rows")))
        elif t == "image":
            im = b.get("image") if isinstance(b.get("image"), dict) else b
            out.append(_img_md(im))
        elif t == "equation":  # MinerU：LaTeX 原样保留
            out.append(as_text(b.get("text") or b.get("content")))
        elif t == "page_footnote":  # 脚注（MinerU page_footnote）：引用块 + 页码
            page = page_of(b.get("position"))
            lines = ["> " + ln for ln in as_text(b.get("text")).splitlines() if ln.strip()]
            if lines and page:
                lines[-1] += f"（第 {page} 页）"
            out.append("\n".join(lines))
        elif t == "question":  # 兼容考题输出
            parts = [f"**题 {as_text(b.get('number'))}**", as_text(b.get("stem"))]
            parts += _images_md(b, _refs(b.get("stem")))
            opts = b.get("options")
            items = list(opts.items()) if isinstance(opts, dict) else list(enumerate(opts or []))
            for k, v in items:
                key = k if isinstance(k, str) else chr(65 + int(k))
                parts.append(f"- {key}. {as_text(v.get('text') if isinstance(v, dict) else v)}")
                if isinstance(v, dict) and isinstance(v.get("image"), dict):
                    parts.append("  " + _img_md(v["image"]))
            if isinstance(b.get("table"), dict):
                parts.append(md_table(b["table"].get("headers"), b["table"].get("rows")))
            if b.get("answer"):
                parts.append("答案：" + as_text(b.get("answer")))
            if b.get("explanation"):
                parts.append("解析：" + as_text(b.get("explanation")))
            out.append("\n".join(p for p in parts if p))
        if len(out) > n_before:  # 本次写了内容行 → 锚点不再是「紧前」
            prev_anchor_page = 0
    return [x for x in out if x.strip()]


def _md_inline(text: str) -> str:
    s = html_mod.escape(str(text))
    s = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)", r'<img src="\2" alt="\1">', s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s.replace("\n", "<br>")


def _text_html(text: str) -> str:
    """text 里可能混有 ``` 围栏代码块，拆开渲染。"""
    parts = str(text).split("```")
    out = []
    for i, p in enumerate(parts):
        out.append(f"<pre>{html_mod.escape(p)}</pre>" if i % 2 else _md_inline(p))
    return "".join(out)


def _html_table(headers, rows) -> str:
    h = ["<table><thead><tr>"]
    h += [f"<th>{_md_inline(as_text(x))}</th>" for x in headers or []]
    h.append("</tr></thead><tbody>")
    for r in rows or []:
        h.append("<tr>" + "".join(f"<td>{_md_inline(as_text(c))}</td>" for c in r) + "</tr>")
    h.append("</tbody></table>")
    return "".join(h)


def _fig_html(im: dict) -> str:
    u = src_url(im.get("src"))
    if not u or u.startswith("[[box:"):  # 未解析的框引用不渲染
        return ""
    alt = html_mod.escape(as_text(im.get("alt")))
    return f'<img src="{html_mod.escape(u, quote=True)}" alt="{alt}">'


def _block_images_html(block: dict, in_text: set[str]) -> str:
    out = []
    for im in block.get("images") or []:
        if not isinstance(im, dict):
            continue
        k = re.search(r"插图(\d+)", str(im.get("src") or ""))
        if k and k.group(1) in in_text:
            continue
        out.append(_fig_html(im))
    return "".join(out)


def render_html_blocks(blocks: list[dict]) -> str:
    out: list[str] = []
    for b in blocks:
        t = b.get("type")
        if t == "heading":
            level = min(max(int(b.get("level") or 2), 1), 6)
            out.append(f"<h{level}>{_md_inline(as_text(b.get('text')))}</h{level}>")
        elif t == "text":
            text = as_text(b.get("text") if b.get("text") is not None else b.get("content"))
            out.append(f"<p>{_text_html(text)}{_block_images_html(b, _refs(text))}</p>")
        elif t == "code":
            code = html_mod.escape(as_text(b.get("content") or b.get("code")))
            out.append(f'<pre class="code">{code}</pre>')
        elif t == "table":
            tb = b.get("table") if isinstance(b.get("table"), dict) else b
            out.append(_html_table(tb.get("headers"), tb.get("rows")))
        elif t == "image":
            im = b.get("image") if isinstance(b.get("image"), dict) else b
            out.append(_fig_html(im))
        elif t == "page_footnote":  # 脚注：引用块 + 页码
            page = page_of(b.get("position"))
            suffix = f'<span class="fn-page">（第 {page} 页）</span>' if page else ""
            note = _md_inline(as_text(b.get("text")))
            out.append(f'<blockquote class="footnote">{note}{suffix}</blockquote>')
        elif t == "question":
            num = html_mod.escape(as_text(b.get("number")))
            stem = _text_html(as_text(b.get("stem")))
            stem += _block_images_html(b, _refs(b.get("stem")))
            parts = [f'<div class="q"><div class="qh">题 {num}</div>',
                     f'<div class="qtext">{stem}</div>']
            opts = b.get("options")
            items = list(opts.items()) if isinstance(opts, dict) else list(enumerate(opts or []))
            if items:
                parts.append('<div class="opts">')
                for k, v in items:
                    key = k if isinstance(k, str) else chr(65 + int(k))
                    txt = _text_html(as_text(v.get("text") if isinstance(v, dict) else v))
                    parts.append(f'<div class="opt"><b>{html_mod.escape(key)}.</b> {txt}</div>')
                    if isinstance(v, dict) and isinstance(v.get("image"), dict):
                        parts.append(_fig_html(v["image"]))
                parts.append("</div>")
            if isinstance(b.get("table"), dict):
                parts.append(_html_table(b["table"].get("headers"), b["table"].get("rows")))
            if b.get("answer"):
                ans = html_mod.escape(as_text(b.get("answer")))
                parts.append(f'<div class="ans"><b>答案：</b>{ans}</div>')
            if b.get("explanation"):
                exp = _md_inline(as_text(b.get("explanation")))
                parts.append(f'<div class="ans"><b>解析：</b>{exp}</div>')
            parts.append("</div>")
            out.append("".join(parts))
    return "\n".join(x for x in out if x.strip())


_HTML_CSS = """body{font:15px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;color:#222;
background:#f4f5f7;margin:0}
main{max-width:900px;margin:0 auto;padding:24px 16px 80px;background:#fff}
h1,h2,h3,h4{line-height:1.35}
img{max-width:100%;border:1px solid #e3e4e8;border-radius:8px;margin:6px 0}
table{border-collapse:collapse;margin:8px 0}
th,td{border:1px solid #e3e4e8;padding:4px 12px}th{background:#f0f3fa}
pre{background:#f6f7f9;border:1px solid #e3e4e8;border-radius:8px;padding:10px 14px;
overflow-x:auto}code{background:#f0f1f3;border-radius:4px;padding:0 5px}
.q{border:1px solid #e3e4e8;border-radius:10px;padding:12px 16px;margin:10px 0}
.qh{font-weight:700}.ans{margin-top:8px;padding:8px 12px;background:#f2fbf6;
border-left:4px solid #0d9b6e;font-size:13px}
blockquote.footnote{margin:6px 0;padding:6px 12px;border-left:3px solid #b9c2d0;
 background:#f7f8fa;color:#555;font-size:13px}
.fn-page{color:#999;margin-left:6px}"""


def render_html(blocks: list[dict], title: str = "") -> str:
    body = render_html_blocks(blocks)
    return (f'<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
            f"<title>{html_mod.escape(title)}</title>\n<style>{_HTML_CSS}</style>\n</head>\n"
            f"<body>\n<main>\n{body}\n</main>\n</body>\n</html>\n")


def _rewrite_images(text: str, fix) -> str:
    text = re.sub(r'(<img[^>]+src=")([^"]+)(")',
                  lambda m: m.group(1) + fix(m.group(2)) + m.group(3), text)
    return re.sub(r"(!\[[^\]]*\]\()([^)\s]+)(\))",
                  lambda m: m.group(1) + fix(m.group(2)) + m.group(3), text)


def _prefix_images(text: str, base: str) -> str:
    base = base.rstrip("/") + "/"

    def fix(u: str) -> str:
        if re.match(r"^(data:|https?:|/|[A-Za-z]:)", u):
            return u
        return base + u

    return _rewrite_images(text, fix)


def _relocate_images(text: str, src: Path, out: Path) -> str:
    """把 OUT_ROOT 相对的图片路径改写为相对输出文件的路径（存在性校验）。

    box/doc 输出的图片 rel 以 pdf_tool/output 为基准（含 {stem}/ 前缀）；
    导出到任意目录时按实际文件位置改写，避免断链。
    """
    json_dir = src.parent
    out_dir = out.parent

    def fix(u: str) -> str:
        if re.match(r"^(data:|https?:|/|[A-Za-z]:)", u):
            return u
        for base in (json_dir, json_dir.parent):
            p = base / u
            if p.exists():
                return os.path.relpath(p, out_dir).replace("\\", "/")
        prefix = json_dir.name + "/"  # 文件不存在时按约定去掉 {stem}/ 前缀
        return u.removeprefix(prefix)

    return _rewrite_images(text, fix)


def main() -> int:
    ap = argparse.ArgumentParser(description="blocks JSON → Markdown / HTML")
    ap.add_argument("--json", required=True, help="blocks 格式 JSON（box/doc 模式输出）")
    ap.add_argument("--out", required=True, help="输出 .md / .html")
    ap.add_argument("--format", default="auto", choices=["auto", "md", "html"])
    ap.add_argument("--base", default="",
                    help="相对图片路径前缀（默认原样，适合输出到 JSON 同目录）")
    ap.add_argument("--title", default="", help="HTML 标题（默认取 JSON 文件名）")
    args = ap.parse_args()

    src = Path(args.json).resolve()
    data = json.loads(src.read_text(encoding="utf-8"))
    blocks = data.get("blocks") or []

    fmt = args.format
    if fmt == "auto":
        fmt = "html" if Path(args.out).suffix.lower() in (".html", ".htm") else "md"
    if fmt == "md":
        text = "\n\n".join(render_md_blocks(blocks)) + "\n"
    else:
        text = render_html(blocks, title=args.title or src.stem)
    if args.base:
        text = _prefix_images(text, args.base)
    else:
        text = _relocate_images(text, src, Path(args.out).resolve())

    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"written {out} ({len(text)} chars, {fmt}, {len(blocks)} blocks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Generate a self-contained HTML viewer for a pdf_tool JSON output.

用法:
  python pdf_tool/make_viewer.py --json <path-to-questions.json> [--out <path-to.html>]

把题目 JSON 与图片资产(base64)内嵌进 pdf_tool/viewer.html，
浏览器双击即可打开预览。
"""
import argparse
import base64
import json
import mimetypes
from pathlib import Path

from pdf_tool.core.paths import PKG

ROOT = PKG

HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>题目预览 - pdf_tool</title>
<style>
  :root { --line:#e3e4e8; --muted:#8a8f98; --card:#fff; --bg:#f4f5f7; --accent:#2f6fed; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.7 "Segoe UI", "Microsoft YaHei", sans-serif;
         background:var(--bg); color:#222; }
  header { position:sticky; top:0; background:#fff; border-bottom:1px solid var(--line);
           padding:14px 24px; z-index:5; }
  h1 { margin:0 0 6px; font-size:20px; }
  .meta { color:var(--muted); font-size:13px; }
  main { max-width: 880px; margin: 0 auto; padding: 18px 16px 80px; }
  .stats { display:flex; gap:10px; flex-wrap:wrap; margin:10px 0 18px; }
  .stat { background:#fff; border:1px solid var(--line); border-radius:10px;
          padding:8px 16px; font-size:13px; }
  .stat b { font-size:18px; display:block; }
  .category { background:#eef2fb; border:1px solid #d4ddf3; border-radius:10px;
              padding:8px 14px; margin:14px 0 6px; font-weight:600; font-size:15px; }
  .category small { font-weight:400; color:var(--muted); margin-left:8px; }
  .qcard { background:var(--card); border:1px solid var(--line); border-radius:12px;
           padding:16px 18px; margin:10px 0; }
  .qhead { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .qno { font-weight:700; font-size:15px; }
  .badge { font-size:12px; padding:2px 10px; border-radius:99px; color:#fff; }
  .b-choice-single { background:#2f6fed; } .b-choice-multiple { background:#7c4dff; }
  .b-true-false { background:#0d9b6e; } .b-fill-blank { background:#e08600; }
  .b-short-answer { background:#d64545; } .b-programming { background:#4b5563; }
  .b-other { background:#8a8f98; }
  .qtext { white-space:pre-wrap; word-break:break-word; }
  .qtext code { background:#f0f1f3; border-radius:4px; padding:0 5px;
                font-family:Consolas,monospace; font-size:13px; }
  .qtext pre { background:#f6f7f9; border:1px solid var(--line); border-radius:8px;
               padding:10px 14px; overflow-x:auto; }
  .qtext img { max-width: 100%; border:1px solid var(--line); border-radius:8px;
               margin:6px 0; background:#fff; }
  .mdtable { border-collapse:collapse; margin:8px 0; width:auto; background:#fff; }
  .mdtable th, .mdtable td { border:1px solid var(--line); padding:4px 12px; text-align:center; }
  .mdtable th { background:#f0f3fa; font-weight:600; }
  .options { margin:8px 0 2px 4px; }
  .option { display:flex; gap:8px; padding:3px 0; align-items:flex-start; }
  .option .key { font-weight:700; min-width:26px; }
  .blank { display:inline-block; min-width:90px; border-bottom:2px solid var(--accent);
           background:#f3f7ff; border-radius:4px; text-align:center; color:#8ab; margin:0 2px; }
  .answerbox { margin-top:10px; padding:10px 14px; border-left:4px solid #0d9b6e;
               background:#f2fbf6; font-size:13px; }
  .answerbox b { color:#0d9b6e; }
  .answerbox pre { background:#f6f7f9; border:1px solid var(--line); border-radius:6px;
                   padding:8px 10px; overflow-x:auto; margin:4px 0; white-space:pre-wrap; }
  .hint { color:var(--muted); font-size:12px; margin-top:6px; }
  .examnotes { background:#fffdf3; border:1px solid #efe3b8; border-radius:10px;
               padding:12px 16px; margin:0 0 14px; white-space:pre-wrap; font-size:14px; }
  .examnotes b { display:block; margin-bottom:6px; color:#8a6d1a; }
  .posbadge { color:var(--muted); font-size:12px; font-weight:400; margin-left:8px; }
  .figimg { display:block; max-width:100%; border:1px solid var(--line); border-radius:8px;
            margin:6px 0; background:#fff; }
  .toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .toolbar input[type=file] { font-size:13px; }
</style>
</head>
<body>
<header>
  <h1 id="title">题目预览</h1>
  <div class="toolbar">
    <span class="meta" id="meta"></span>
    <input type="file" id="file" accept=".json" title="加载其它题目 JSON">
  </div>
</header>
<main id="main"></main>
<script>
const SAMPLE = __SAMPLE__;

const TYPE_LABEL = {
  multiple_choice_single: '单选题', multiple_choice_multiple: '多选题',
  true_false: '判断题', fill_blank: '填空题', short_answer: '简答题',
  programming: '编程题'
};

function esc(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* 把 markdown 表格段转为真实 <table>；其余行做行内渲染 */
function renderTables(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indexOf('|') === 0) {
      const rows = [];
      while (i < lines.length && lines[i].indexOf('|') === 0) {
        // 行首去掉首个 "|"，行尾**仅当以 "|" 结尾**时去掉（表格行尾可能是图片等非 "|" 内容）
        let row = lines[i];
        if (row.startsWith('|')) row = row.slice(1);
        if (row.endsWith('|')) row = row.slice(0, -1);
        const cells = row.split('|').map(c => c.trim());
        rows.push(cells);
        i++;
      }
      // 去掉可能的分隔行（|---|）
      const dataRows = rows.filter(r => !(r.length && /^:?-{2,}:?$/.test(r[0]) &&
        r.every(c => /^:?-{2,}:?$/.test(c))));
      if (dataRows.length) {
        const head = dataRows[0];
        let h = '<table class="mdtable"><thead><tr>' +
          head.map(c => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>';
        for (let r = 1; r < dataRows.length; r++) {
          h += '<tr>' + dataRows[r].map(c => '<td>' + inlineMd(c || '') + '</td>').join('') +
            '</tr>';
        }
        out.push(h + '</tbody></table>');
        continue;
      }
      out.push(esc(line));
      continue;
    }
    out.push(inlineMd(line));
    i++;
  }
  return out.join('\\n');
}

function inlineMd(s) {
  let h = esc(s);
  h = h.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)/g,
    (m, alt, src) => /^(data:|\\.\\.?\\/|[a-z]+:\\/\\/)/.test(src)
      ? '<img src="' + src + '" alt="' + alt + '" loading="lazy">' : m);
  h = h.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (m, label, href) =>
    /^(https?:|mailto:|#|\\/)/.test(href)
      ? '<a href="' + href + '" target="_blank">' + label + '</a>' : m);
  h = h.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 下标/上标：LaTeX 式 X_p / X_{测} / x^2 / x^{2} 渲染为 <sub>/<sup>
  // 前后都不邻接同类符号，避免吃掉填空题的连续下划线（____ 的最后一个 _）
  h = h.replace(/(?<!_)_\\{([^{}]+)\\}/g, '<sub>$1</sub>');
  h = h.replace(/(?<!_)_([A-Za-z0-9\\u4e00-\\u9fff])(?!_)/g, '<sub>$1</sub>');
  h = h.replace(/(?<!\\^)\\^\\{([^{}]+)\\}/g, '<sup>$1</sup>');
  h = h.replace(/(?<!\\^)\\^([A-Za-z0-9+-])(?!\\^)/g, '<sup>$1</sup>');
  return h;
}

function mdRender(text) {
  if (!text) return '';
  const blocks = [];
  const parts = String(text).split(/```/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { blocks.push('<pre>' + esc(parts[i]) + '</pre>'); continue; }
    blocks.push(renderTables(parts[i].split('\\n')).replace(/\\n/g, '\\n'));
  }
  return blocks.join('');
}

function renderBlank(text) {
  // 填空题：只把 **连续 ≥4 个下划线** 换成输入框占位（单个 _x 是下标，不能动）
  return mdRender(text).replace(/(_{4,})/g, '<span class="blank">&nbsp;</span>');
}

const SAFE_TYPES = { multiple_choice_single: 1, multiple_choice_multiple: 1, true_false: 1,
                     fill_blank: 1, short_answer: 1, programming: 1 };
function typeBadge(t) {
  const safe = SAFE_TYPES[t] ? t : 'other';
  return '<span class="badge b-' + safe + '">' + esc(TYPE_LABEL[t] || t || '未知') + '</span>';
}

/* ---------- blocks 格式（--mode box 输出）---------- */

function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('\\n');
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (typeof v.content === 'string') return v.content;
    if (Array.isArray(v.steps)) return v.steps.map(asText).filter(Boolean).join('\\n');
  }
  return String(v);
}

function srcUrl(s) {
  const m = /!\\[[^\\]]*\\]\\(([^)\\s]+)\\)/.exec(String(s || ''));
  return m ? m[1] : String(s || '');
}

function refKeys(text) {
  const out = new Set();
  const re = /!\\[插图(\\d+)\\]/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(m[1]);
  return out;
}

function figHtml(src, alt) {
  const u = srcUrl(src);
  if (!/^(data:|https?:|\\.{0,2}\\/)/.test(u)) return '';
  return '<img class="figimg" src="' + u + '" alt="' + esc(asText(alt)) + '" loading="lazy">';
}

function tableHtml(headers, rows) {
  let h = '<table class="mdtable"><thead><tr>' +
    (headers || []).map(x => '<th>' + inlineMd(asText(x)) + '</th>').join('') +
    '</tr></thead><tbody>';
  (rows || []).forEach(r => {
    h += '<tr>' + r.map(c => '<td>' + inlineMd(asText(c)) +
      '</td>').join('') + '</tr>';
  });
  return h + '</tbody></table>';
}

function renderBlock(b) {
  const pos = b.position ? '<span class="posbadge">' + esc(b.position) + '</span>' : '';
  if (b.type === 'question') {
    const h = ['<div class="qcard">'];
    h.push('<div class="qhead"><span class="qno">题 ' + esc(b.number) + '</span>' + pos +
      '</div>');
    const stem = asText(b.stem);
    h.push('<div class="qtext">' + mdRender(stem) + '</div>');
    const inText = refKeys(stem);
    (b.images || []).forEach(im => {
      const k = /插图(\\d+)/.exec(String(im.src || ''));
      if (k && inText.has(k[1])) return;  // 已在正文原位置渲染
      h.push(figHtml(im.src, im.alt));
    });
    const opts = b.options;
    let items = [];
    if (Array.isArray(opts)) items = opts.map((v, i) => [String.fromCharCode(65 + i), v]);
    else if (opts && typeof opts === 'object') items = Object.keys(opts).map(k => [k, opts[k]]);
    if (items.length) {
      h.push('<div class="options">');
      items.forEach(pair => {
        const k = pair[0], v = pair[1];
        const t = (v && typeof v === 'object') ? (v.text || '') : (v == null ? '' : v);
        let line = '<div class="option"><span class="key">' + esc(k) + '.</span>' +
          '<span class="qtext">' + mdRender(asText(t)) + '</span>';
        if (v && typeof v === 'object' && v.image && typeof v.image === 'object') {
          const kk = /插图(\\d+)/.exec(String(v.image.src || ''));
          if (!(kk && (inText.has(kk[1]) || refKeys(asText(t)).has(kk[1])))) {
            line += figHtml(v.image.src, v.image.alt);
          }
        }
        h.push(line + '</div>');
      });
      h.push('</div>');
    }
    if (b.table && (b.table.headers || b.table.rows)) {
      h.push(tableHtml(b.table.headers, b.table.rows));
    }
    if (b.answer) {
      h.push('<div class="answerbox"><b>答案：</b>' + esc(asText(b.answer)) +
        (b.explanation ? '<br><b>解析：</b>' + mdRender(asText(b.explanation)) : '') +
        '</div>');
    }
    h.push('</div>');
    return h.join('');
  }
  if (b.type === 'text') {
    return '<div class="examnotes">' + pos +
      mdRender(asText(b.content != null ? b.content : b.text)) + '</div>';
  }
  if (b.type === 'image') {
    return figHtml((b.image || {}).src || b.src, (b.image || {}).alt);
  }
  if (b.type === 'equation') {  // MinerU：优先公式裁剪图，缺失时显示 LaTeX 源
    const fig = (b.image && b.image.src) ? figHtml(b.image.src, '公式') : '';
    if (fig) return fig;
    return '<div class="examnotes">' + esc(asText(b.text)) + '</div>';
  }
  if (b.type === 'table') {
    const tb = b.table || b;
    return tableHtml(tb.headers, tb.rows);
  }
  if (b.type === 'code') {
    return '<pre>' + esc(b.content || b.code || '') + '</pre>';
  }
  return '';
}

function renderBlocks(data) {
  const blocks = data.blocks || [];
  const qs = blocks.filter(b => b.type === 'question');
  document.title = '题目预览';
  document.getElementById('title').textContent = '题目预览';
  document.getElementById('meta').textContent =
    '题目:' + qs.length + ' | 内容块:' + blocks.length;
  document.getElementById('main').innerHTML =
    '<div class="stats">' +
    '<div class="stat"><b>' + qs.length + '</b>题目</div>' +
    '<div class="stat"><b>' + blocks.length + '</b>内容块</div>' +
    '</div>' +
    blocks.map(renderBlock).join('');
}

function metaLine(q) {
  const m = q.metadata || {};
  const parts = [];
  if (m.source_id) parts.push('编号 ' + m.source_id);
  if (m.time_limit) parts.push('时间限制 ' + m.time_limit);
  if (m.memory_limit) parts.push('内存限制 ' + m.memory_limit);
  return parts.join(' · ');
}

/* 判题相关字段：样例IO / 输入输出说明 / 参考代码 / 评分标准 / 提示 / 填空形态 */
function extraFields(q) {
  const h = [];
  const sio = q.sample_input_output || {};
  if (sio.input || sio.output) {
    h.push('<div class="answerbox io"><b>样例输入：</b><pre>' + esc(sio.input || '') +
      '</pre><b>样例输出：</b><pre>' + esc(sio.output || '') + '</pre></div>');
  }
  [['输入说明', q.input_description], ['输出说明', q.output_description],
   ['参考代码', q.reference_code], ['评分标准', q.grading_criteria],
   ['提示', q.additional_tips]].forEach(function (pair) {
    if (!pair[1]) return;
    h.push('<div class="answerbox io"><b>' + pair[0] + '：</b>' +
      (pair[0] === '参考代码' ? '<pre>' + esc(String(pair[1])) + '</pre>'
                             : '<div class="qtext">' + mdRender(String(pair[1])) + '</div>') +
      '</div>');
  });
  const blanks = (q.blank_positions || []).filter(function (b) { return b && b.pattern; });
  if (blanks.length) {
    h.push('<div class="hint">填空答案形态：' +
      blanks.map(function (b) { return esc(b.pattern); }).join(' / ') + '</div>');
  }
  return h.join('');
}

function renderQuestion(q) {
  const h = [];
  h.push('<div class="qcard">');
  h.push('<div class="qhead"><span class="qno">' + esc(q.question_no) + '.</span>' +
    typeBadge(q.question_type) +
    (q.score ? '<span class="hint">' + esc(q.score) + ' 分</span>' : '') +
    (q.difficulty ? '<span class="hint">难度 ' + esc(q.difficulty) + '</span>' : '') +
    '</div>');
  const ml = metaLine(q);
  if (ml) h.push('<div class="hint">' + esc(ml) + '</div>');
  h.push('<div class="qtext">' + renderBlank(q.question_text || '') + '</div>');
  const opts = q.options || [];
  if (opts.length) {
    h.push('<div class="options">');
    opts.forEach(o => h.push('<div class="option"><span class="key">' +
      esc(o.option_id || o.key) + '.</span><span class="qtext">' +
      renderBlank(o.option_text || '') + '</span></div>'));
    h.push('</div>');
  }
  if ((q.answer || q.explanation) && String(q.answer) !== 'null') {
    h.push('<div class="answerbox"><b>答案：</b>' + mdRender(String(q.answer || '—')) +
      (q.explanation ? '<br><b>解析：</b>' + mdRender(String(q.explanation)) : '') + '</div>');
  }
  h.push(extraFields(q));
  h.push('</div>');
  return h.join('');
}

function render(data) {
  if (Array.isArray(data.blocks)) { renderBlocks(data); return; }
  document.title = data.exam_info && data.exam_info.title ? data.exam_info.title : '题目预览';
  document.getElementById('title').textContent =
    (data.exam_info && data.exam_info.title) || '题目预览';
  const ei = data.exam_info || {};
  document.getElementById('meta').textContent =
    ['总分:' + (ei.total_score || '?'), '题量:' + (ei.question_count || data.questions.length),
     '时限:' + (ei.time_limit || '?')].filter(Boolean).join(' | ');
  const main = document.getElementById('main');
  const qs = data.questions || [];
  const countBy = {};
  qs.forEach(q => { countBy[q.question_type] = (countBy[q.question_type] || 0) + 1; });
  const notesByAfter = {};
  (data.document_notes || []).forEach(n => {
    const key = n.after_question_id || '__start__';
    (notesByAfter[key] = notesByAfter[key] || []).push(String(n.text || ''));
  });
  const notesHtml = key => (notesByAfter[key] || []).map(t =>
    '<div class="examnotes">' + esc(t) + '</div>').join('');
  main.innerHTML =
    notesHtml('__start__') +
    '<div class="stats">' +
    '<div class="stat"><b>' + qs.length + '</b>总题数</div>' +
    Object.keys(countBy).map(k => '<div class="stat"><b>' + countBy[k] + '</b>' +
      esc(TYPE_LABEL[k] || k || '') + '</div>').join('') +
    '</div>' +
    qs.map(q => renderQuestion(q) + notesHtml(q.question_id)).join('');
}

/* 数据里图片已内嵌为 data: URI（make_viewer.py 注入），无需额外处理 */
function loadFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try { render(JSON.parse(reader.result)); } catch (e) { alert('JSON 解析失败: ' + e.message); }
  };
  reader.readAsText(file, 'utf-8');
}

document.getElementById('file').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (f) loadFromFile(f);
});

render(SAMPLE);
</script>
</body>
</html>
"""


def data_uri(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    b64 = base64.b64encode(path.read_bytes()).decode()
    return f"data:{mime};base64,{b64}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--json", required=True)
    parser.add_argument("--out", default=str(ROOT / "viewer.html"), help="输出 HTML 路径")
    args = parser.parse_args()
    src = Path(args.json).resolve()
    data = json.loads(src.read_text(encoding="utf-8"))

    # 图片资产路径 -> data URI。JSON 里的图片路径有两种基准，都必须匹配：
    #   stage2 写入的 rel   —— 相对 pdf_tool/output（`{stem}/assets/imgs/…`）
    #   mineru 的 image.src —— 相对本文档目录（`mineru/images/…`）
    # 只认前者会让 mineru 产物的图全部断链（实测 CSP2019_doc 丢 1 张且无任何提示）。
    root_dir = src.parent  # 例如 pdf_tool/output/{stem}
    out_root = ROOT / "output"
    text = json.dumps(data, ensure_ascii=False)  # 只序列化一次（原实现每图重解析整个 JSON）
    inlined = 0
    unmatched: list[str] = []
    exts = ("*.jpg", "*.jpeg", "*.png", "*.webp", "*.gif", "*.bmp")
    images = sorted({p for pat in exts for p in root_dir.rglob(pat)})
    for img in images:
        rel_doc = img.relative_to(root_dir).as_posix()
        try:
            rel_out = img.relative_to(out_root).as_posix()
        except ValueError:
            rel_out = ""
        # 长键优先：避免短键（纯文件名）抢先匹配到别处的同名资产
        keys = sorted({k for k in (rel_out, rel_doc, img.name) if k}, key=len, reverse=True)
        for key in keys:
            if key in text:
                text = text.replace(key, data_uri(img))
                inlined += 1
                break
        else:
            unmatched.append(rel_doc)
    if unmatched:
        # 不静默：磁盘上有资产但产物没引用 —— 可能丢图，也可能是别的模式的资产
        print(f"提示：{len(unmatched)} 个图片资产未被本产物引用：{unmatched[:6]}")

    sample = (text
              .replace("</", "<\\/")
              .replace("\u2028", "\\u2028")
              .replace("\u2029", "\\u2029"))
    html = HTML.replace("__SAMPLE__", sample)
    out = Path(args.out).resolve()
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html, encoding="utf-8")
    except OSError as e:
        print(f"viewer 生成失败：{e}")
        return 1
    size_kb = out.stat().st_size // 1024 if out.exists() else 0
    print(f"viewer generated -> {out} ({size_kb} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# reader 侧需求:Doc JSON 保留脚注(`page_footnote`)

日期:2026-10-14 · 来源:UV Reader 书坊 · 关联:MinerU 内容提取链路

## 状态(2026-10-14 晚):**pdf_tool 已实现,reader 侧已验证**

pdf_tool 工作区(未提交)的改动:

- `mineru/client.py`:`content_list_to_blocks()` 新增 `elif t == "page_footnote":` 分支,
  保留块(`{"type": "page_footnote", "position": "Page N", "text": …, "page_idx": N-1}`),
  `stats` 增加 `footnotes`;`reflow_text_blocks()` 的 `keep_types` 也带上它;
- `extract/furniture.py`:空文本丢弃规则覆盖 `page_footnote`(避免把空脚注留下);
- `render/md.py`:`render_md_blocks()` 把脚注写成引用块 + 页码
  (`> ① 原题: …（第 17 页）`)。

reader 侧验证(用该书的真实 `*_content_list.json` 调 `content_list_to_blocks`):

```
733 块 | stats.footnotes = 47 | page_footnote 块 47
示例: {"type":"page_footnote","position":"Page 17","page_idx":16} | ① 原题: An Axiomatization of Set Theory…
```

reader 侧已就绪:`formula-html` 把 `page_footnote`(及 `footnote`)渲染成引用块(HTML 与 md 两条路);
`extract-doc` 的脚注兜底(见下)加了「上游已写过就不重复补」的判断,两边同时生效不会出现双份。

> 待办(pdf_tool 侧):把上述改动提交,并补一条单测(`content_list_to_blocks` 里含
> `page_footnote` 的用例 → 期望保留块 + `stats.footnotes == 1`)。

## 原始现象(留档)

用户用书坊把一本扫描/OCR 的 PDF 做成 EPUB(《数学在科学和社会中的作用》,Von Neumann):

- 正文里有脚注标记(`①`,源自 `$^{①}$`),**但脚注正文全部丢失** —— "详细注解也丢了";
- 用户原本能在原书页脚看到这些注解(例如「① 原题: An Axiomatization of Set Theory。译者 J. van Heijnoort(ed.) From Frege to Gödel. Harvard University Press」)。

## 定位(MinerU 有,Doc JSON 没有)

- MinerU 的 `*_content_list.json` 里脚注是有的,类型是 **`page_footnote`**,例如:

  ```json
  {"type": "page_footnote", "text": "① 原题: An Axiomatization of Set Theory。译者 J. van Heijnoort(ed.) From Frege to Gödel. Harvard University Press, ...", "page_idx": 16}
  ```

- 但 pdf_tool 产出的 Doc JSON(`<stem>_doc.json`)里块类型只有
  `{"heading": 78, "text": 692, "image": 2, "equation": 11}` —— **`page_footnote` 被丢弃**,
  于是 MinerU 的 md 与我们的合并稿都没有脚注正文。

## 需求

请在 Doc JSON 里保留脚注(二选一即可):

1. **推荐**:保留块,`type: "page_footnote"`(与 MinerU 同名),`text` 原样、`page`/`page_idx` 保留;
2. 或者在 `.md` 产物里写成引用块 / Markdown 脚注,例如 `> ① 原题: …（第 17 页）`。

reader 侧已经做的兜底(不改上游也能用):我们从 `*_content_list.json` 里把 `page_footnote`
捞回来,按页码排序附在成品末尾的「注释」一段;所以这份需求不是阻塞项,只是希望上游
不要丢数据,位置信息也能更准(现在只能按页码对回原书)。

## 复现

- 源:`D:\Users\rayni\Downloads\数学在科学和社会中的作用 (冯·诺伊曼 …).pdf`
- 中间产物:`%APPDATA%\qiaomu-reader-desktop\book-cache\work\_Von_Neumann_John_z-library.sk_1lib.sk_z-9c1e91d4\extract\`
  - `mineru/chunks/*/<hash>_content_list.json` ← 脚注在这里(共 51 条)
  - `<书名>.json` ← Doc JSON,脚注已被丢掉

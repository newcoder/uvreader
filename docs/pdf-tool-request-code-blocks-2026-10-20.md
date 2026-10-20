# pdf_tool 需求:程序清单(代码块)的类型判定、跨页合并与页边行号

日期:2026-10-20 · 提出方:reader(UV Reader / 纽扣)

## 背景

书坊「格式转换」的**公式优先**链路(reader 生成桥接 HTML → DocVortex)和「内容提取」的 Markdown 都直接消费 pdf_tool 的 **Doc JSON**(`type: code | text | heading | …`)。这一份真题(CSP2019)的最后两段程序在产物里是坏的,html/docx/md 三个出口都能复现:

- HTML 里 5 段程序只有 3 个阅读程序是对的,**「矩阵变幻」和「计数排序」两段**是坏的;
- 用户原话:「最后两个代码段有问题,前三个是好的」。

## 现状(用 `CSP2019.pdf` 的 Doc JSON 核对,块 id 为 `p<页>-b<n>`)

### 1. 整段程序被判成 `text`

第 7 页「矩阵变幻」的完整程序(`#include <cstdio>` 到最后一个 `}`,**5 个空 ①–⑤**)是**一个 `type: "text"` 块**,不是 `code`:

```
p7 [text] #include <cstdio>\nint n;\nconst int max_size = 1 << 10;\nint res[max_size][max_size];\nvoid recursive(...) { … }\nscanf("%d", &n);\nrecursive(0, 0, ①);\nint size = ②;…
```

reader 的桥(`formula-html.js`)按块类型渲染:`code` → `<pre>`,其余 → `<p>`。这一段因此在 HTML 里成了**一整段正文**,换行被压成一行(reader 已在桥上保换行止血,但仍是普通段落、不是代码块)。

### 2. 跨页程序被拆成 6 个 `text` + 1 个 `code`

「计数排序」第 8 页是**正确的 `code` 块**(行 1–21),第 9 页的续行却拆成:

```
p9-b1 [text] 22 memset(cnt, 0, sizeof(cnt));
p9-b2 [text] 23 for (int i = 0; i < n; ++i)
p9-b3 [text] for (int i = 0; i < maxs; ++i)
p9-b4 [text] cnt[i + 1] += cnt[i];
p9-b5 [text] for (int i = n - 1; i >= 0; --i)
p9-b6 [text] 28 ④; // 记录最终排序结果
p9-b7 [code] 30 printf("%d %d\n", ⑤);\n31 return 0;\n32 }
```

结果:第 8 页代码 + 第 9 页的六行**正文段落** + 一个 3 行的 `<pre>`,同一段程序被撕成三块。

### 3. 页边行号进了正文

`22` / `23` / `28` 是 PDF 页边的行号,现在和代码粘在同一个字符串里(`"22 memset(…);"`),下游只能靠正则剥。

## 需求

1. **块类型**:连续的、带代码特征的行走廊(`#include`、以 `;` `{` `}` 结尾、缩进一致、成段出现)输出 `type: "code"`。「矩阵变幻」那一段必须是**一个** code 块。
2. **跨页合并**:同一段程序跨页(如 p8→p9)时输出**一个** code 块,或第二个块带 `continues_from: "<上一块的 id>"` 之类的标记;不要拆成多个互不相关的 `text` 块。
3. **页边行号**:不要拼进 `content`。建议给结构化字段(例如 `line_start` / `line_numbers`),或至少在 `content` 里与代码**分行**存放。
4. **验收**(用 `CSP2019.pdf`):
   - Doc JSON 里 5 段程序(3 个阅读程序 + 矩阵变幻 + 计数排序)都是 `code` 块;
   - 计数排序跨 p8/p9 是**一个** code 块,内容里没有 `22`/`23`/`28` 这类页边行号;
   - 经 reader 的桥 → DocVortex 转出的 HTML 里 5 个 `<pre>` 完整、缩进正确、可直接复制运行;Markdown 出口同理。
   - 建议把这一页加进现有回归样例。

## reader 侧现状(不阻塞,但只能止血)

- `formula-html.js`:text 块里的换行不再被 `<p>` 压成一行(改成 `<br>`),**但不会把 text 猜成 code**(那是上游的判定);
- `markdown-fix.js`:`joinSplitCodeFences`(两段围栏并回一段)与 `stripCodeLineNumbers`(剥页边行号,容忍 ≤3 的跳号)只对**已经成了围栏**的 md 生效;上文的 6 个 `text` 块在 md 里就是 6 个段落,后处理无从判断它们是代码。

所以这两段程序的根治在上游块类型判定,reader 不再加「猜代码」的启发式。

# pdf_tool 后续:代码块跨页合并已生效,但扫描页会漏行(可用页边行号发现)

日期:2026-10-20 · 提出方:reader(UV Reader / 纽扣) · 关联:`reader-request-code-blocks-2026-10-20.md`

## 先确认:上一轮的修复有效

用 `991b766`(vendored 快照)重跑 `CSP2019.pdf`(`--mode mineru --mineru-source local`):

- 5 段程序全部是 `code` 块(3 个阅读程序 + 矩阵变幻 + 计数排序);
- **矩阵变幻**从 `text` 提升为 `code`(`code_promoted: 1`);
- **计数排序**的第 8/9 页合成**一个** `code` 块(`code_merged: 1`),页边行号剥掉(`code_line_numbers: 6`);
- 产物:`by_type {code: 5, heading: 12, image: 1, text: 59}`,`audit_ok=True`。

reader 侧已把快照刷新到 `991b766`,引擎 pytest 23/23、e2e 35/35 通过。

## 还剩的问题:扫描页 OCR 漏行

CSP2019 第 9 页是**扫描图**(文字层里只有水印「山东」),MinerU 的 content_list 在 p9 只给出:

```
22 memset(cnt, 0, sizeof(cnt));
23 for (int i = 0; i < n; ++i)
   for (int i = 0; i < maxs; ++i)      ← 印刷行号 25,数字丢了
       cnt[i + 1] += cnt[i];           ← 26
   for (int i = n - 1; i >= 0; --i)    ← 27
28 ④; // 记录最终排序结果
30 printf("%d %d\n", ⑤);
31 return 0;
32 }
```

对照 PDF 第 9 页的图,**第 24 行和第 29 行是存在的**:

```
24  ③;    // 利用 cnt 数组统计数量
29  for (int i = 0; i < n; ++i)
```

现在合并后的 code 块是 28 行(应为 32 行),**③ 这道空直接不在代码里**,而题目选项里仍然有「3) ③处应填」——下游(题库/答题页)无法发现这种缺行。

## 建议

1. **按印刷行号做缺口检测**(确定性、便宜):代码区域里已经出现行号时,按 `n → n+1` 校验;缺号记进 audit,例如
   ```json
   "code_gaps": [{ "position": "Page 9", "expected": [24, 29] }]
   ```
   同时给块加 `incomplete: true`(或 `gaps: [24, 29]`),让下游能提示「代码可能缺行,请对照原文」。
2. **能补则补**:缺号对应的行在页面上有坐标,可用原始页图 + 现有 OCR(rapidocr 或 MinerU 的 layout 框)对**缺口区域**做一次定向识别,把 `③;` / `for (...)` 补回;补不了就保留第 1 条的警告,不要静默丢。
3. **验收**(用 `CSP2019.pdf`,第 9 页):
   - 计数排序的 code 块包含 22–32 全部行(`③; // 利用 cnt 数组统计数量` 与第 29 行 `for (int i = 0; i < n; ++i)` 都在);或
   - audit 里出现 `code_gaps: [24, 29]` 且该块标记为不完整;
   - 建议把这一页加进现有跨页代码回归。

## reader 侧会怎么用

- 题库提取读 Doc JSON 的 code 块:有 `incomplete` / `gaps` 就在 `_questions_audit.json` 里给 warning(并显示在数据提取页的结果里);
- 不猜内容:模型/规则都不补代码,缺行就如实标出来。

## 处理结果(2026-10-20,pdf_tool `d614fdf`)

- 已实现:按印刷行号 `n → m` 之间的内容行数算缺行数,行距只用来定位缺口 y 区间(空白行/行距变化不误报);有 PDF 时用原页**整页 OCR(RapidOCR,200 dpi)**补行(小条裁剪会读残,已弃用),`//` 之前做全角→半角;补足不写缺口,补不足保留 `code_gaps` + `incomplete` 并把已识别部分放回;新增 `code_filled` / `code_gap_lines`。
- CSP2019 复验(reader 侧,快照刷新后):计数排序 **30 个内容行**(22–32 全在,含 `③; // 利用 cnt 数组统计数量` 与第 29 行),`code_filled=2`、`code_gap_lines=0`、无 `code_gaps`;失败路径(不传 PDF)如实给 `incomplete` + `code_gaps: [{position: "Page 9", expected: [24, 29]}]`。
- 引擎已带该快照发 **0.1.8**(`engine-v0.1.8`)。


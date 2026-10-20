# pdf_tool:家具清理把「选项行」当重复行删掉了

日期:2026-10-20 · 提出方:reader(UV Reader / 纽扣) · 关联:`reader-request-code-blocks-2026-10-20.md`、`reader-request-code-line-gaps-2026-10-20.md`

## 现象

`CSP2019.pdf` 的题库提取有 **22 题「像选择题但只找到 0 个选项」**。核对后发现不是解析器的问题:

- MinerU 的 `content_list.json` 里选项是**完整**的,例如
  ```
  #9 p1 [text] '3. 一个 32 位整型变量占用（）个字节。\nA. 32 B. 128 C. 4 D. 8'
  #13 p1 [text] '7. 把 8 个同样的球放在 5 个同样的袋子里…\nA. 22 B. 24 C. 18 D. 20'
  ```
- 到了 Doc JSON(`p1-b10` / `p1-b14`)选项行**整行消失**;
- 直接调用 `pdf_tool.mineru.client.strip_furniture_lines(blocks)` 复现:这一份文档删掉 **15 行**,全部是选项行。

## 根因

`strip_furniture_lines` 的「跨块重复行」启发式:

```python
def norm(s): return re.sub(r"\d+", "#", s.strip())
counts[norm(ln)] += 1
repeated = {k for k, v in counts.items() if v >= min_blocks}  # min_blocks = 3
```

选项行里的数字被归一成 `#`,不同题目的选项因此**变成同一个字符串**:

```
A. ## B. ## C. ## D. ##   ← 12 道题的选项都归一成这个
A. ## B. ### C. # D. #    ← 另外 12 道
```

统计下来 `count=12`,远超 3,于是被当成页眉页脚整行删除。命中实例(`CSP2019`):

```
count=12  'A. 32 B. 128 C. 4 D. 8'
count=12  'A. 22 B. 24 C. 18 D. 20'
count=12  'A. 89 B. 97 C. 91 D. 93'
count=12  'A. 27 B. 33 C. 29 D. 31'
count=12  'A. 3000 B. 2500 C. 2400 D. 2520'
count=12  'A. 60 B. 125 C. 75 D. 100'
count=12  'A. 18 B. 6 C. 10 D. 1'
count=12  'A. 36 B. 100000 C. 1 D. 128'
...
```

顺带:代码行 `using namespace std;` / `int main() {` / `return 0;` 也会被计入重复统计。现在因为「代码块不参与重复行删除」而没有误删,但如果一段程序还是 `text`(尚未被提升为 code),这些行有被删的风险。

## 需求

1. **选项行不参与重复行删除**:行匹配 `^\s*[A-H][.、)]\s` 时直接保留(它们是题目内容,不可能是页眉页脚)。
2. 更一般地:**不要对「数字归一后相同」的短行做跨块删除**。页眉页脚是「同一行在每页重复」,而选项是「每道题各有一行、结构相似」。建议至少:
   - 选项行 / 题号行(`^\s*\d{1,3}[.、)]\s`)跳过;
   - 或者要求重复行同时满足「出现在 ≥3 个**不同页**」且「归一化前的内容完全一致」,不要用 `\d+ → #`;
   - 代码行(`#include` / `using namespace` / `int main()` / `return 0;`)同样跳过。
3. **保留原有家具清理能力**:页脚(`CCF CSP-J 2019 …`)、页码(`第 N 页,共 M 页`)仍然要删;现有家具测试保持通过。
4. **验收**(`CSP2019.pdf`):
   - Doc JSON 里 q3、q7 的选项行完整(`A. 32 B. 128 C. 4 D. 8`、`A. 22 B. 24 C. 18 D. 20`);
   - `strip_furniture_lines` 不再删除任何 `A.`/`B.`/… 开头的行;
   - 页脚/页码仍被删除;
   - 建议加一条回归:同一份卷子里 ≥3 道题的选项行结构相同(数字位数一致),不得被删。

## reader 侧会怎么用

- 选项恢复后,题库解析按行拆选项;同一行里的选项(`A. 6 B. 10 C. 15`,q8 那种)由 reader 自己的规则拆,不需要 pdf_tool 处理;
- reader 不做「从图片里补选项」的兜底——缺了就是缺了,会在 `_questions_audit.json` 里给 warning。

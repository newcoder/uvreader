# 2021 CCF 非专业级别软件能力认证第一轮 (CSP-J1)入门级C++语言试题

认证时间:2021 年9 月19 日14:30~16:30

## 考生注意事项:

试题纸共有12 页,答题纸共有1 页,满分100 分。请在答题纸上作答,写在试题纸上的 一律无效。

不得使用任何电子设备(如计算器、手机、电子词典等)或查阅任何书籍资料。

## 一、单项选择题(共15 题,每题2 分,共计30 分;每题有且仅有一个正确选项)

1. 以下不属于面向对象程序设计语言的是( )。 A. C++ B. Python C. Java D. C

2. 以下奖项与计算机领域最相关的是( )。 A. 奥斯卡奖 B. 图灵奖 C. 诺贝尔奖 D. 普利策奖

3. 目前主流的计算机储存数据最终都是转换成( )数据进行储存。 A. 二进制 B. 十进制 C. 八进制 D. 十六进制

4. 以比较作为基本运算,在N 个数中找出最大数,最坏情况下所需要的最少的比较次数为 ( )。 A. $N ^ { 2 }$

B. N C. N-1 D. N+1

5. 对于入栈顺序为a, b, c, d, e 的序列,下列( )不是合法的出栈序列。 A. a, b, c, d, e B. e, d, c, b, a C. b, a, c, d, D. c, d, a, e,

6. 对于有n 个顶点、m 条边的无向连通图 (m>n),需要删掉( )条边才能使其成为一棵 树。 A. n-1 B. m-n C. m-n-1 D. m-n+1

7. 二进制数101.11 对应的十进制数是( )。 A. 6.5 B. 5.5 C. 5.75 D. 5.25

8. 如果一棵二叉树只有根结点,那么这棵二叉树高度为1。请问高度为5 的完全二叉树有 ( )种不同的形态? A. 16 B. 15 C. 17 D. 32

9. 表达式 $a ^ { * } ( b + c ) ^ { * } d$ 的后缀表达式为( ),其中“*”和“+”是运算符。 A. $* * a + b c d$ B. $a b c + ^ { * } d ^ { * }$ C. $a b c + d ^ { * * }$ D. $^ { * } a ^ { * } + b c d$

10. 6 个人,两个人组一队,总共组成三队,不区分队伍的编号。不同的组队情况有( ) 种。 A. 10 B. 15 C. 30 D. 20

11. 在数据压缩编码中的哈夫曼编码方法,在本质上是一种( )的策略。 A. 枚举 B. 贪心 C. 递归 D. 动态规划

12. 由1,1,2,2,3 这五个数字组成不同的三位数有( )种。 A. 18 B. 15 C. 12 D. 24

13. 考虑如下递归算法 solve(n) if n<=1 return 1

else if n>=5 return n*solve(n-2) else return n*solve(n-1)

则调用solve(7)得到的返回结果为( )。 A. 105 B. 840 C. 210 D. 420

14. 以a 为起点,对右边的无向图进行深度优先遍历,则b、 c、 d、 e 四个点中有可能作 为最后一个遍历到的点的个数为 ）。 a A. 1 B. 2 b c C. 3 D. 4 d e

![插图](mineru/images/page_3_image_3.jpg)

15. 有四个人要从A 点坐一条船过河到B 点,船一开始在A 点。该船一次最多可坐两个人。 已知这四个人中每个人独自坐船的过河时间分别为1, 2, 4, 8, 且两个人坐船的过河时 间为两人独自过河时间的较大者。则最短( )时间可以让四个人都过河到B 点(包括从 B 点把船开回 A 点的时间)。 A. 14 B. 15 C. 16 D. 17

## 二、阅读程序(程序输入不超过数组或字符串定义的范围;判断题正确填√,错误填×;除特 殊说明外,判断题1.5 分,选择题3 分,共计40 分)

```
#include &lt;iostream&gt;
using namespace std;

int n;
int a[1000];
int f(int x)
{
    int ret = 0;
    for (; x; x &= x - 1) ret++;
    return ret;
}
int g(int x)
{
    return x & -x;
}
int main()
{
    cin >> n;
    for (int i = 0; i < n; i++) cin >> a[i];
    for (int i = 0; i < n; i++)
        cout << f(a[i]) + g(a[i]) << ' ';
    cout << endl;
    return 0;
}
```

## l 判断题

16. 输入的n 等于1001 时,程序不会发生下标越界。

17. 输入的a[i] 必须全为正整数,否则程序将陷入死循环。

18. 当输入为“5 2 11 9 16 10”时,输出为“3 4 3 17 5”。（ ）

19. 当输入为“1 511998”时,输出为“18

20. 将源代码中g 函数的定义(14-17 行)移到main 函数的后面,程序可以正常编译运 行。

## l 单选题

21. 当输入为“2 -65536 2147483647”时,输出为( )。 A. “65532 33” B. “65552 32” C. “65535 34” D. “65554 33”

```
#include &lt;iostream&gt;
#include &lt;string&gt;
using namespace std;
char base[64];
char table[256];
void init()
{
    for (int i = 0; i < 26; i++) base[i] = 'A' + i;
    for (int i = 0; i < 26; i++) base[26 + i] = 'a' + i;
    for (int i = 0; i < 10; i++) base[52 + i] = '0' + i;
    base[62] = '+', base[63] = '/';
    for (int i = 0; i < 256; i++) table[i] = 0xff;
    for (int i = 0; i < 64; i++) table[base[i]] = i;
    table['='] = 0;
}
string decode(string str)
{
    string ret;
    int i;
    for (i = 0; i < str.size(); i += 4) {
        ret += table[str[i]] << 2 | table[str[i + 1]] >> 4;
        if (str[i + 2] != '=')
            ret += (table[str[i + 1]] & 0x0f) << 4 | table[str[i + 2]] >> 2;
        if (str[i + 3] != '=')
            ret += table[str[i + 2]] << 6 | table[str[i + 3]];
    }
    return ret;
}
int main()
{
    init();
    cout << int(table[0]) << endl;
    string str;
    cin >> str;
    cout << decode(str) << endl;
    return 0;
}
```

l 判断题

22. 输出的第二行一定是由小写字母、大写字母、数字和“+”、“/”、“=”构成的 字符串。

23. 可能存在输入不同,但输出的第二行相同的情形。

24.输出的第一行为“-1”。（ ）

## l 单选题

25. 设输入字符串长度为n,decode 函数的时间复杂度为( )。 A. Θ(√n) B. Θ(n) C. Θ(𝑛 log 𝑛) D. Θ(𝑛!)

26. 当输入为“Y3Nx”时,输出的第二行为( )。 A. “csp” B. “csq” C. “CSP D. “Csp ”

27. (3.5 分)当输入为“Y2NmIDIwMjE=”时,输出的第二行为( )。 A. “ccf2021” B. “ccf2022” C. “ccf 2021” D. “ccf 2022

```
#include <iostream>
using namespace std;
const int n = 100000;
const int N = n + 1;
int m;
int a[N], b[N], c[N], d[N];
int f[N], g[N];
void init()
{
    f[1] = g[1] = 1;
    for (int i = 2; i <= n; i++) {
        if (!a[i]) {
            b[m++] = i;
            c[i] = 1, f[i] = 2;
            d[i] = 1, g[i] = i + 1;
        }
        for (int j = 0; j < m && b[j] * i <= n; j++) {
            int k = b[j];
            a[i * k] = 1;
            if (i % k == 0) {
                c[i * k] = c[i] + 1;
                f[i * k] = f[i] / c[i * k] * (c[i * k] + 1);
                d[i * k] = d[i];
g[i * k] = g[i] * k + d[i];
break;
}
else {
c[i * k] = 1;
f[i * k] = 2 * f[i];
d[i * k] = g[i];
g[i * k] = g[i] * (k + 1);
}
}
}
}

int main()
{
init();

int x;
cin >> x;
cout << f[x] << ' ' << g[x] << endl;
return 0;
}
```

假设输入的x 是不超过1000 的自然数,完成下面的判断题和单选题:

## l 判断题

28. 若输入不为“1”,把第13 行删去不会影响输出的结果。

29. (2 分)第25 行的“f[i] / c[i * k]”可能存在无法整除而向下取整的情况。 ）

30. (2 分)在执行完init()后,f 数组不是单调递增的,但g 数组是单调递增的。

## l 单选题

31. init 函数的时间复杂度为( )。 A. Θ(n) B. Θ(nlog n) C. Θ)𝑛√𝑛\* D. Θ(𝑛!)

32. 在执行完init()后,f[1], f[2], f[3]...... f[100]中有( )个等于2。 A. 23 B. 24 C. 25 D. 26

33. (4 分)当输入为“1000”时,输出为( )。 A. “15 1340” B. “15 2340 C. “16 2340” D. $\text{" }16\_1349 \text{" }$

## 三、完善程序(单选题,每小题3 分,共计30 分)

1)(Josephus 问题)有 n 个人围成一个圈,依次标号 0 至 n− 1。从 0 号开 始,依次 0, 1, 0, 1,... 交替报数,报到 1 的人会离开,直至圈中只剩下一个人。求最后 剩下人的编号。

试补全模拟程序。

```
#include <iostream>
using namespace std;
const int MAXN = 1000000;
int F[MAXN];
int main() {
    int n;
    cin >> n;
    int i = 0, p = 0, c = 0;
    while (①) {
        if (F[i] == 0) {
            if (②) {
                F[i] = 1;
                ③;
            }
            ④;
        }
        ⑤;
    }
    int ans = -1;
    for (i = 0; i < n; i++)
        if (F[i] == 0)
            ans = i;
    cout << ans << endl;
    return 0;
}
```

34.①处应填（ ）A. i < n B. c < n C. i < n - 1 D. c < n - 1

35.②处应填（ ）A. i % 2 == 0 B. i % 2 == 1 C. p D. !p

36.③处应填（ ）A. i++ B. i = (i + 1) % n C. c++ D. p ^= 1

37.④处应填（ ）A. i++ B. i = (i + 1) % n C. c++ D. p ^= 1

38.⑤处应填（ ）A. i++ B. i = (i + 1) % n C. c++ D. p ^= 1

2) (矩形计数)平面上有 n 个关键点,求有多少个四条边都和x 轴或者y 轴平行的矩 形,满足四个顶点都是关键点。给出的关键点可能有重复,但完全重合的矩形只计一 次。

试补全枚举算法。

```
#include <iostream>
using namespace std;
struct point {
    int x, y, id;
};
bool equals(point a, point b) {
    return a.x == b.x && a.y == b.y;
}
bool cmp(point a, point b) {
    return ①;
}
void sort(point A[], int n) {
    for (int i = 0; i < n; i++)
        for (int j = 1; j < n; j++)
            if (cmp(A[j], A[j - 1])) {
                point t = A[j];
                A[j] = A[j - 1];
                A[j - 1] = t;
            }
}
int unique(point A[], int n) {
    int t = 0;
    for (int i = 0; i < n; i++)
        if (②)
            A[t++] = A[i];
    return t;
}
bool binary_search(point A[], int n, int x, int y) {
    point p;
    p.x = x;
    p.y = y;
    p.id = n;
    int a = 0, b = n - 1;
    while (a < b) {
        int mid = ③;
        if (④)
            a = mid + 1;
        else
            b = mid;
    }
    return equals(A[a], p);
}
const int MAXN = 1000;
point A[MAXN];
int main() {
    int n;
    cin >> n;
    for (int i = 0; i < n; i++) {
        cin >> A[i].x >> A[i].y;
        A[i].id = i;
    }
    sort(A, n);
    n = unique(A, n);
    int ans = 0;
    for (int i = 0; i < n; i++)
        for (int j = 0; j < n; j++)
            if (⑤ && binary_search(A, n, A[i].x, A[j].y) &&
                binary_search(A, n, A[j].x, A[i].y)) {
                ans++;
            }
    cout << ans << endl;
return 0;
}
```

39.①处应填（ ）A. $a . x \downarrow = b . x \downarrow \; a . x < b . x \; : \; a . \downarrow d < b . \downarrow d$ B. $a.x \mid = b.x \mid a.x < b.x \mid a.y < b.y$ C. $\mathsf { e q u a l s ( a , b ) : a . i d < b . i d : a . x < b . x }$ D. $\mathtt { e q u a l s ( a , b ) : a . i d < b . i d . : ( a . x : = b . x : : a . x < b . x : a . y < b . y ) }$

40.②处应填（ ）A. $\mathrm{i} \equiv \mathrm{o} \quad \mathrm{|} \quad \mathrm{comp}(\mathrm{A[i]}, \mathrm{A[i-1]})$ B. $\mathbf{t} = \mathbf{\theta} \mid \mid \mathsf{equal} \bar{\mathsf{s}}(\bar{\mathsf{A}}[\bar{\mathsf{i}}], \bar{\mathsf{A}}[\bar{\mathsf{t}} - \bar{\mathsf{1}}])$ C. $\mathbf{i} == \mathbf{\beta} \quad | \quad \mathsf{l} \mathsf{comp}(\mathsf{A}[\mathbf{\bar{1}}], \mathsf{A}[\mathbf{\bar{1}} - \mathbf{1}])$ D. $\mathbf { t } = = \mathbf { \Theta } \coprod \mathtt { \_ l e q u a l s ( \bar { A } [ i ] , \; A [ t \_ - \; 1 ] ) }$

41.③处应填（ ）A. $b - ( b - a ) / 2 + 1$ B. $( a + b + 1 ) > 1$ C. $( a + b ) > 1$ D. $a + ( b - a + 1 ) / 2$

42.④处应填（ ）A. $\mathsf { I }   \mathsf { c m p } ( \mathsf { A } [ \mathsf { m i d } ]   \mathsf { , } \mathsf { p } )$ B. $\mathsf { c m p } \left( \mathsf { A } [ \mathsf { m i d } ]   , \mathsf { p } \right)$ C. $\mathsf { c m p } ( \mathsf { p } , \mathsf { A } [ \mathsf { m i d } ] )$ D. $\mathsf { I c m p } ( \mathsf { p } , \mathsf { A } [ \mathsf { m i d } ] )$

43.⑤处应填（ ）A. $A[1].x \; = \; A[j].x$ B. $\tt A [ i ] . i d \: < \: A [ j ] . i d$ C. $\mathtt { A [ i ] . x } \; = \; \mathtt { A [ j ] . x } \; \mathtt { 8 8 } \; \mathtt { A [ i ] . i d } \; \mathtt { < } \; \mathtt { A [ j ] . i d }$ D. $\mathtt { A [ i ] . x \: < \: A [ j ] . x \: 8 8 \: A [ i ] . y \: < \: A [ j ] . y }$
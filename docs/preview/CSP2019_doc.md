<!--page:1-->

# 2019CCF 非专业级别软件能力认证第一轮

<!--page:1-->

# (CSP-J) 入门级 C++语言试题 A 卷

认证时间:2019 年 10 月 19 日 14:30\~16:30

<!--page:1-->

## 考生注意事项:

- 试题纸共有9页，答题纸共有1页，满分100分。请在答题纸上作答，写在试题纸上的一律无效。

- 不得使用任何电子设备（如计算器、手机、电子词典等）或查阅任何书籍资料。

<!--page:1-->

## 一、单项选择题（共 15 题，每题 2 分，共计 30 分；每题有且仅有一个正确选项）

1. 中国的国家顶级域名是（）
A. .cn B. .ch C. .chn D. .china

2. 二进制数 11 1011 1001 0111 和 01 0110 1110 1011 进行逻辑与运算的结果是（）。A. 01 0010 1000 1011 B. 01 0010 1001 0011 C. 01 0010 1000 0001 D. 01 0010 1000 0011

3. 一个 32 位整型变量占用（）个字节。
A. 32 B. 128 C. 4 D. 8

4. 若有如下程序段，其中 s、a、b、c 均已定义为整型变量，且 a、c 均已赋值（c 大于 0）
s = a;
for (b = 1; b <= c; b++) s = s - 1;
则与上述程序段功能等价的赋值语句是（）
A. s = a - c; 
B. s = a - b; 
C. s = s - c; 
D. s = b - c;

5. 设有 100 个已排好序的数据元素，采用折半查找时，最大比较次数为（）
A. 7
B. 10
C. 6
D. 8

6. 链表不具有的特点是（）
A. 插入删除不需要移动元素
B. 不必事先估计存储空间
C. 所需空间与线性表长度成正比
D. 可随机访问任一元素

7. 把 8 个同样的球放在 5 个同样的袋子里，允许有的袋子空着不放，问共有多少种不同的分法？（）提示:如果 8 个球都放在一个袋子里，无论是哪个袋子，都只算同一种分法
A. 22 B. 24 C. 18 D. 20

<!--page:2-->

8. 一棵二叉树如右图所示, 若采用顺序存储结构, 即用一维数组元素存储该二叉树中的结点 (根结点的下标为 1 , 若某结点的下标为 i , 则其左孩子位于下标 2i 处、右孩子位于下标 2i+1 处), 则该数组的最大下标至少为 ( )。 A. 6 B. 10 C. 15 D. 12

![插图](mineru/images/page_1_image_1.jpg)

9. 100 以内最大的素数是（）。
A. 89 B. 97 C. 91 D. 93

10.319 和 377 的最大公约数是（）。A. 27 B. 33 C. 29 D. 31

11. 新学期开学了，小胖想减肥，健身教练给小胖制定了两个训练方案。方案一:每次连续跑3公里可以消耗300千卡（耗时半小时）；方案二:每次连续跑5公里可以消耗600千卡（耗时1小时）。小胖每周周一到周四能抽出半小时跑步，周五到周日能抽出一小时跑步。另外，教练建议小胖每周最多跑21公里，否则会损伤膝盖。请问如果小胖想严格执行教练的训练方案，并且不想损伤膝盖，每周最多通过跑步消耗多少千卡？（）
A. 3000 B. 2500 C. 2400 D. 2520

12. 一副纸牌除掉大小王有 52 张牌，四种花色，每种花色 13 张。假设从这 52 张牌中随机抽取 13 张纸牌，则至少（）张牌的花色一致。
A. 4
B. 2
C. 3
D. 5

13. 一些数字可以颠倒过来看，例如 0、1、8 颠倒过来还是本身，6 颠倒过来是 9，9 颠倒过来看还是 6，其他数字颠倒过来都不构成数字。类似的，一些多位数也可以颠倒过来看，比如 106 颠倒过来是 901。假设某个城市的车牌只由 5 位数字组成，每一位都可以取 0 到 9。请问这个城市最多有多少个车牌倒过来恰好还是原来的车牌？（）
A. 60 B. 125 C. 75 D. 100

14. 假设一棵二叉树的后序遍历序列为 DGJHEBIFCA, 中序遍历序列为 DBGEHJACIF, 则其前序遍历序列为（）。 A. ABCDEFGHIJ B. ABDEGHJCFI C. ABDEGJHCFI D. ABDEGHJFIC

15. 以下哪个奖项是计算机科学领域的最高奖？（）
A. 图灵奖 B. 鲁班奖 C. 诺贝尔奖 D. 普利策奖

<!--page:3-->

## 二、阅读程序（程序输入不超过数组或字符串定义的范围；判断题正确填√，错误填×；除特殊说明外，判断题1.5分，选择题3分，共计40分）

```
#include <cstdio>
#include <cstring>
using namespace std;
char st[100];
int main() {
    scanf("%s", st);
    int n = strlen(st);
    for (int i = 1; i <= n; ++i) {
        if (n % i == 0) {
            char c = st[i - 1];
            if (c >= 'a')
                st[i - 1] = c - 'a' + 'A';
        }
    }
    printf("%s", st);
    return 0;
}
```

- 判断题

1）输入的字符串只能由小写字母或大写字母组成。（）

2）若将第8行的“i = 1”改为“i = 0”，程序运行时会发生错误。（）

3）若将第8行的“i <= n”改为“i \* i <= n”，程序运行结果不会改变。（）

4）若输入的字符串全部由大写字母组成，那么输出的字符串就跟输入的字符串一样。（）

<!--page:3-->

## - 选择题

5）若输入的字符串长度为18，那么输入的字符串跟输出的字符串相比，至多有（）个字符不同。
A. 18 B. 6 C. 10 D. 1

6）若输入的字符串长度为（），那么输入的字符串跟输出的字符串相比，至多有36个字符不同。
A. 36 B. 100000 C. 1 D. 128

<!--page:4-->

```
#include <cstdio>
using namespace std;
int n, m;
int a[100], b[100];
int main() {
    scanf("%d%d", &n, &m);
    for (int i = 1; i <= n; ++i)
        a[i] = b[i] = 0;
    for (int i = 1; i <= m; ++i) {
        int x, y;
        scanf("%d%d", &x, &y);
        if (a[x] < y && b[y] < x) {
            if (a[x] > 0)
                b[a[x]] = 0;
            if (b[y] > 0)
                a[b[y]] = 0;
            a[x] = y;
            b[y] = x;
        }
    }
    int ans = 0;
    for (int i = 1; i <= n; ++i) {
        if (a[i] == 0)
            ++ans;
        if (b[i] == 0)
            ++ans;
    }
    printf("%d\n", ans);
    return 0;
}
```

假设输入的 n 和 m 都是正整数，x 和 y 都是在  $[1, n]$  的范围内的整数，完成下面的判断题和单选题:

<!--page:4-->

## - 判断题

1) 当 m>0 时，输出的值一定小于 2n。（）

2）执行完第 27 行的 “++ans” 时，ans 一定是偶数。（）

3) a[i]和 b[i]不可能同时大于  $\theta$ 。（）

<!--page:5-->

4）若程序执行到第 13 行时，x 总是小于 y，那么第 15 行不会被执行。（）

<!--page:5-->

## - 选择题

5）若 m 个 x 两两不同，且 m 个 y 两两不同，则输出的值为（）
A. 2n-2m B. 2n+2 C. 2n-2 D. 2n

6) 若 m 个 x 两两不同，且 m 个 y 都相等，则输出的值为（）
A. 2n-2 B. 2n C. 2m D. 2n-2m

<!--page:5-->

## 3.

```
#include <iostream>
using namespace std;
const int maxn = 10000;
int n;
int a[maxn];
int b[maxn];
int f(int l, int r, int depth) {
    if (l > r)
        return 0;
    int min = maxn, mink;
    for (int i = l; i <= r; ++i) {
        if (min > a[i]) {
            min = a[i];
            mink = i;
        }
    }
    int lres = f(l, mink - 1, depth + 1);
    int rres = f(mink + 1, r, depth + 1);
    return lres + rres + depth * b[mink];
}
int main() {
    cin >> n;
    for (int i = 0; i < n; ++i)
        cin >> a[i];
    for (int i = 0; i < n; ++i)
        cin >> b[i];
    cout << f(0, n - 1, 1) << endl;
    return 0;
}
```

<!--page:5-->

## - 判断题

1）如果 a 数组有重复的数字，则程序运行时会发生错误。（）

<!--page:6-->

2）如果 b 数组全为 0，则输出为 0。（）

<!--page:6-->

## - 选择题

3）当 n=100 时，最坏情况下，与第 12 行的比较运算执行的次数最接近的是:（）。
A. 5000 B. 600 C. 6 D. 100

4）当 n=100 时，最好情况下，与第 12 行的比较运算执行的次数最接近的是:（）。
A. 100 B. 6 C. 5000 D. 600

5）当 n=10 时，若 b 数组满足，对任意  $0 \leq i < n$ ，都有  $b[i] = i + 1$ ，那么输出最大为（）。
A. 386 B. 383 C. 384 D. 385

6）（4分）当n=100时，若b数组满足，对任意 $0\leq i<n$ ，都有 $b[i]=1$ ，那么输出最小为（）。
A. 582 B. 580 C. 579 D. 581

<!--page:6-->

## 三、完善程序（单选题，每小题3分，共计30分）

1. （矩阵变幻）有一个奇幻的矩阵，在不停的变幻，其变幻方式为:数字0变成矩阵 $\begin{bmatrix}0&0\\ 0&1\end{bmatrix}$ ，数字1变成矩阵 $\begin{bmatrix}1&1\\ 1&0\end{bmatrix}$ 。最初该矩阵只有一个元素0，变幻n次后，矩阵会变成什么样？
例如，矩阵最初为:[0]；矩阵变幻1次后: $\begin{bmatrix}0&0\\ 0&1\end{bmatrix}$ ；矩阵变幻2次后:
 $\begin{bmatrix}0&0&0&0\\ 0&1&0&1\\ 0&0&1&1\\ 0&1&1&0\end{bmatrix}$ 。

输入一行一个不超过 10 的正整数 n。输出变幻 n 次后的矩阵。

试补全程序。

提示:

“<<”表示二进制左移运算符，例如 $(11)_{2}<<2=(1100)_{2}$ ;

而 “^” 表示二进制异或运算符，它将两个参与运算的数中的每个对应的二进制位一一进行比较，若两个二进制位相同，则运算结果的对应二进制位为 0，反之为 1。

<!--page:7-->

```
#include <cstdio>
using namespace std;
int n;
const int max_size = 1 << 10;
int res[max_size][max_size];
void recursive(int x, int y, int n, int t) {
    if (n == 0) {
        res[x][y] = ①;
        return;
    }
    int step = 1 << (n - 1);
    recursive(②, n - 1, t);
    recursive(x, y + step, n - 1, t);
    recursive(x + step, y, n - 1, t);
    recursive(③, n - 1, !t);
}
int main() {
    scanf("%d", &n);
    recursive(0, 0, ④);
    int size = ⑤;
    for (int i = 0; i < size; ++i) {
        for (int j = 0; j < size; ++j)
            printf("%d", res[i][j]);
        puts("");
    }
    return 0;
}
```

1）①处应填（）
A. n % 2 B. 0 C. t D. 1

2）②处应填（）
A. x - step, y - step
B. x, y - step
C. x - step, y
D. x, y

3）③处应填（）
A. x - step, y - step
B. x + step, y + step
C. x - step, y
D. x, y - step

4) ④处应填（）

<!--page:8-->

A. n - 1, n % 2
B. n, 0
C. n, n % 2
D. n - 1, 0

5) ⑤处应填（）
A. 1 << (n + 1)
B. 1 << n
C. n + 1
D. 1 << (n - 1)

2. （计数排序）计数排序是一个广泛使用的排序方法。下面的程序使用双关键字计数排序，将 n 对 10000 以内的整数，从小到大排序。

例如有三对整数（3,4）、（2,4）、（3,3），那么排序之后应该是（2,4）、（3,3）、（3,4）。
输入第一行为 n，接下来 n 行，第 i 行有两个数 a[i] 和 b[i]，分别表示第 i 对整数的第一关键字和第二关键字。
从小到大排序后输出。

数据范围  $1 \leq n \leq 10^{7}, 1 \leq a[i], b[i] \leq 10^{4}$ 。

提示:应先对第二关键字排序，再对第一关键字排序。数组 ord[] 存储第二关键字排序的结果，数组 res[] 存储双关键字排序的结果。
试补全程序。

```
#include <cstdio>
#include <cstring>
using namespace std;
const int maxn = 10000000;
const int maxs = 10000;
int n;
unsigned a[maxn], b[maxn], res[maxn], ord[maxn];
unsigned cnt[maxs + 1];
int main() {
    scanf("%d", &n);
    for (int i = 0; i < n; ++i)
        scanf("%d%d", &a[i], &b[i]);
    memset(cnt, 0, sizeof(cnt));
    for (int i = 0; i < n; ++i)
        ①;    // 利用 cnt 数组统计数量
    for (int i = 0; i < maxs; ++i)
        cnt[i + 1] += cnt[i];
    for (int i = 0; i < n; ++i)
        ②;    // 记录初步排序结果
memset(cnt, 0, sizeof(cnt));
for (int i = 0; i < n; ++i)
③; // 利用 cnt 数组统计数量
for (int i = 0; i < maxs; ++i)
    cnt[i + 1] += cnt[i];
for (int i = n - 1; i >= 0; --i)
④; // 记录最终排序结果
for (int i = 0; i < n; ++i)
printf("%d %d\n", ⑤);
return 0;
}
```

<!--page:9-->

1) ①处应填（）
A. ++cnt[i]
B. ++cnt[b[i]]
C. ++cnt[a[i] \* maxs + b[i]]
D. ++cnt[a[i]]

2) ②处应填（）
A. ord[--cnt[a[i]]] = i
B. ord[--cnt[b[i]]] = a[i]
C. ord[--cnt[a[i]]] = b[i]
D. ord[--cnt[b[i]]] = i

3) ③处应填（）
A. ++cnt[b[i]]
B. ++cnt[a[i] \* maxs + b[i]]
C. ++cnt[a[i]]
D. ++cnt[i]

4) ④处应填（）
A. res[--cnt[a[ord[i]]]] = ord[i]
B. res[--cnt[b[ord[i]]]] = ord[i]
C. res[--cnt[b[i]]] = ord[i]
D. res[--cnt[a[i]]] = ord[i]

5) ⑤处应填（）
A. a[i], b[i]
B. a[res[i]], b[res[i]]
C. a[ord[res[i]]], b[ord[res[i]]]
D. a[res[ord[i]]], b[res[ord[i]]]

# pdf_tool reader sidecar 功能验证报告（含问题清单）

- 日期：2026-09-26
- 对象：`pdf_tool/reader`（行 JSON-RPC sidecar，README 见 `reader/README.md`）
- 环境：Windows / Python 3.13.7 / PyMuPDF 1.26.7 / rapidocr 3.x（PP-OCRv6，onnxruntime 1.30.0）/
  Intel i5-12400F（6 核 12 线程）
- 方式：真实入口 `python -m pdf_tool.reader`（stdin/stdout 管道，模拟 Electron spawn）+ 真实
  RapidOCR 后端 + 真实样例件（`pdfs/small_ocr.pdf`、`ctest.pdf`、`CSP2019.pdf`、`testpdf2.pdf`、`aitest.pdf`）；
  另外先跑通单测基线：`tests/test_pdf_tool_*.py` **138 项全绿**。
- 结论速览：**核心几何/缓存/会话管理正确；`convert.start mode=export` 在真实 sidecar 中会永久挂起（P0），
  文本型 PDF 导出会叠加重复文字层（P1），README §8 的逐页容错未实现（P1）。**

---

## 1. 正确性验证（通过项）

| 功能 | 验证内容 | 结果 |
|---|---|---|
| 协议 | `ping`；坏 JSON→`-32700`；未知方法→`-32601`；缺文件/缺参→`-32602` | 通过 |
| 并发模型 | 请求串行（任务/预热在后台线程），与 README §1 一致 | 通过 |
| `doc.open` | 页数、`has_text_pages`/`scanned_pages`；内容指纹（复制改名后同一 `doc`，缓存共用） | 通过 |
| `ocr.page` 几何 | 30/30 行 `transform` 反算回 OCR 框，误差 <2.5px | 通过 |
| `/Rotate` | 真页旋转 90° 后 OCR：31/31 行，误差 <3px | 通过 |
| `ocr.page` 结构 | `items`（str/dir/width/height/transform/fontName/hasEOL）、`styles.ocr`、`lang=null` | 通过 |
| 页级缓存 | 键含 `ocr_dpi_s{min_score}_v3`（dpi 隔离、`force` 重跑、命中内容一致） | 通过 |
| `ocr.prefetch` | 入队返回 `queued`，逐页 `ocr.prefetched` 通知；预热页随后为缓存命中 | 通过 |
| `search.query` | 命中/未命中/`cached_pages`/`truncated`/缺 `q` 报错 | 通过 |
| `convert.cancel` | 页边界生效（`cancelled=true`），不产半成品 | 通过 |
| `convert.start mode=cache` | `convert.progress` 1..N、`convert.status` 终态、页缓存落盘 | 通过 |
| `convert.start mode=export`（扫描件，单页且缓存已热） | 1.1s 完成，产物存在、页数保留 | 通过（其余形态见 P0） |
| 导出正确性（扫描件 2 页，单进程直调 `build()`） | 58 行插入、8/8 抽样前缀可 `search_for` 命中、**6/6 检索短语落在对应 OCR 行框内（containment>0.9）** | 通过 |
| `text_source`（hybrid，MinerU `layout.json`） | `source=hybrid`、51 行中 21 行被文本源替换；缓存热时仅 +38ms | 通过 |
| `doc.convert mode=blocks`（离线） | `_doc.json/_doc.md/_doc.html/_audit.json`、`audit_ok=true` | 通过 |
| `convert.page`（blocks） | `doc`+`markdown`，14ms | 通过 |
| `cache.stats` / `cache.clear` | 计数、清理、清后归零 | 通过 |

---

## 2. 问题清单

### P0-1 `convert.start mode=export` 在真实 sidecar 中永久挂起（不报错、不可取消）

**现象**

| 形态 | 结果 |
|---|---|
| `pages="1-2"`（创建 `mp.Pool(6)`），页缓存已热 | **挂起**：6 个子进程已启动、子进程 stderr 出现 RapidOCR 模型加载日志，但父进程**永不产生 `convert.progress`/`convert.done`**；`convert.cancel` 无效果；>240s 无任何输出 |
| `pages="1"` 单页，但该页此前未在**本进程** OCR 过 | **挂起**：任务线程卡在 `rapidocr → cv2 → numpy` 的 import 链中（见下方栈） |
| `pages="1"` 单页，且该页缓存已热（`ocr.page` 先行过） | 正常，1.1s 完成 |
| `mode=cache`（任意页数） | 正常 |
| 同参数 `build()` 在**纯脚本**里多进程（workers=2/6，主线程或子线程） | 正常，8.1–8.6s |

**证据：单页挂起时的任务线程栈（faulthandler）**

```
backends.py:122 _worker_init -> backends.py:111 make_backend -> backends.py:32 RapidBackend.__init__
  -> rapidocr/__init__.py:25 __getattr__ -> import_module('rapidocr.main')
  -> rapidocr/main.py:9  import cv2
  -> cv2/__init__.py:11  import numpy
  -> numpy/__init__.py ... numpy/_core/multiarray.py:11
  -> <frozen importlib._bootstrap> create_module   ← 卡死在这里
```

**影响**

- 阅读器「导出可搜索 PDF」入口会假死：无进度、无错误、取消无效，客户端会无限等待。
- 首次 OCR 落在后台任务线程时，进程可能被 import 锁毒化（后续 OCR 请求也可能卡在同名导入上）。
- 现有测试覆盖不到：`tests/test_pdf_tool_reader_server.py` 的导出用例注入 `backend=`，走的是单进程分支且不触发真实导入。

**最小复现（放到仓库根目录执行）**

```python
# repro_export_hang.py
import json, subprocess, sys, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PDF = ROOT / "pdf_tool/pdfs/small_ocr.pdf"
proc = subprocess.Popen([sys.executable, "-m", "pdf_tool.reader"], cwd=ROOT,
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
out = []
threading.Thread(target=lambda: [out.append(l.rstrip()) for l in proc.stdout], daemon=True).start()

rid = 0
def call(method, params=None, timeout=120):
    global rid
    rid += 1
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method,
                                 "params": params or {}}, ensure_ascii=False) + "\n")
    proc.stdin.flush()
    t0 = time.time()
    while time.time() - t0 < timeout:
        for line in list(out):
            msg = json.loads(line)
            if msg.get("id") == rid:
                return msg
        time.sleep(0.01)
    raise TimeoutError(method)

call("ping")
call("doc.open", {"path": str(PDF)})
# 形态 A：不预热直接导出 1 页（触发 import 死锁）；改成 pages="1-2" 则触发多进程挂起
job = call("convert.start", {"path": str(PDF), "mode": "export", "pages": "1",
                             "out": str(ROOT / "temp_output" / "repro_out.pdf")})["result"]["job"]
print("job", job, "submitted; waiting 120s...")
t0 = time.time()
while time.time() - t0 < 120:
    if any("convert.done" in l for l in out):
        print("finished in", round(time.time() - t0), "s")
        break
    time.sleep(1)
else:
    print("HANGS: no convert.done in 120s")
proc.kill()
```

**修复建议（任选其一，建议 1+2+3 一起）**

1. **启动时在主线程预热后端**（消除「首次 import 落在任务线程」这一类死锁）：
   ```python
   # pdf_tool/reader/server.py
   def main() -> int:
       ...
       from pdf_tool.ocr import backends
       backends.make_backend("rapid")     # 主线程先导入 cv2/numpy/onnxruntime
       ReaderServer().serve()
   ```
2. **sidecar 的 export 默认单进程**：`rpc_convert_start` 的 export 分支显式传 `workers=1`
   （把 `workers` 暴露成参数，仅 CLI/批量场景用多进程），或先探测 `mp.Pool` 可用性、失败回退单进程。
3. **任务看门狗**：`_run_job` 里对「N 秒无 `convert.progress`」做超时；超时把 `rec["error"]="timeout after Xs"`
   并照常发 `convert.done`（至少让客户端能报错、能重试）。
4. **补集成测试**：不注入 backend，真跑 `convert.start mode=export pages=1-2`（标记 slow），
   断言 `convert.done` 在限定时间内到达。

---

### P1-1 文本型 PDF 导出会叠加重复文字层

**现象**：`mode=export` 对已有文字层的页也会 OCR 并插入不可见层（server 传 `skip_text_chars=0`）。
实测 `aitest.pdf` 第 1 页：

| 短语 | 原始命中 | 导出后命中 |
|---|---|---|
| 智能算法挑战复赛初中组 | 1 | **2** |
| 【题目描述】 | 2 | **4** |
| 修复机器人的对话词库错误 | 1 | **2** |

**影响**：搜索命中翻倍、选区/高亮重叠、白跑一遍 OCR（每页 +4s）。README 的 export 场景面向扫描件，
但服务端没有任何保护。

**建议**：export 分支传 `skip_text_chars=200`（`build()` 的默认值），或按页判定 `has_text` 后跳过并写入
`stats.skipped_text_pages`（`build()` 已有该字段）。

---

### P1-2 README §8「单页失败不影响其它页 / `stats.failed_*`」未实现

**现象**：用注入后端让第 2 页 OCR 抛错，`convert.start mode=cache` 的整个任务以
`convert.done.error="RuntimeError: boom on page 2"` 结束，`stats` 只有 `{"error": ...}`，**没有 `failed_*` 统计**，
也未继续处理其余页。

**建议**：`warm_pages()` / `build()` 的单页 OCR 加 try/except，累计 `stats.failed_pages` / `stats.failed_list`
并继续；全部失败再置 `error`。同时更新 README（或按建议修实现，二选一）。

---

### P2-1 `reader_main.py` 不存在

README §7 的打包入口脚本 `reader_main.py` 在仓库中不存在（`pdf_tool/reader/` 只有 `__main__.py`）。
开发入口 `python -m pdf_tool.reader` 正常。建议补文件或修正 §7。

### P2-2 性能声明偏差（本机实测）

| 项目 | 实测 | README |
|---|---|---|
| `ocr.page` 首跑 200dpi 单页 | **3.8–4.3s/页** | 1–2s/页 |
| 缓存命中 | 均值 **3.4ms**（20 次；最大 8.8ms；prefetch 后单次 10.3ms） | <5ms |
| `search.query` | 2.7ms / 1 缓存页；25ms / 6 缓存页 | 毫秒级 |
| `ocr.prefetch` | 2 页 8.0s（≈4s/页，单线程串行，符合设计） | — |
| `convert.start mode=cache` | 2 页 7.9s | — |
| 导出（单进程） | 11.9s / 2 页（≈6s/页，含 OCR+插层+保存，496KB） | — |
| `doc.open` | 扫描件 3–5ms（≤14 页）；文本 76ms（22 页） | — |

建议：README 的「1–2s/页」注明机器/尺寸前提，或按实测改为「2–4s/页（6 核 CPU，200dpi）」；
「缓存命中 <5ms」改为「≈3–10ms（含 IPC/JSON 反序列化）」。

### P3 小项

- `convert.status` 对 cache/export 任务返回的 `kind` 恒为 `None`（doc 任务才有值）；`files`/`audit_ok` 也为 `None`。
  不影响使用，README §3.4 的示例里没有 `kind`，可忽略或补上。
- 串行模型意味着 4s 的 `ocr.page` 会阻塞其后的所有请求（含 `ping`、`search.query`）。阅读器接入时
  应「先出页面图像、异步补文字层」，避免把健康检查排在 OCR 后面。
- 多进程路径在一次 wrapper 运行中还观察到子进程 `spawn_main` 报
  `OSError: [WinError 87] OpenProcess(parent_pid=...)` 并被 `Pool` 无限重拉（stderr 无 Traceback 的形态
  表现为静默挂起）。与 P0 同属「多进程在 sidecar 上下文不可靠」，一并按 P0 处理即可。

---

## 3. 阅读器接入注意（验证通过部分）

- `ocr.page` 返回的 `content` 可直接喂 pdf.js（`transform` 已是 PDF 用户空间，含 cropbox/`/Rotate` 处理），
  行框位置经验证与检索命中一致（containment>0.9），「选中/高亮偏位」风险已排除。
- 搜索请按 README §4.3 走「只搜已缓存页 + `convert.start mode=cache` 预热」，不要直接触发 pdf.js 全书遍历。
- 缓存根用 `PDF_TOOL_OCR_CACHE` 指到 `%APPDATA%/<App>/ocr_cache`，键与内容指纹绑定（改名/移动不失效）。
- **导出功能在 P0 修复前不要暴露给用户**。

## 4. 复现脚本

本报告的最小复现已内联（见 P0-1）。完整验证脚本（含几何回环、缓存隔离、prefetch、取消、hybrid、
blocks 转换、性能计时）为一次性 harness，未入库；如需固化为回归测试，建议把
「几何反算（0/90/180/270）+ 真入口导出 1–2 页 + 缓存键隔离」三条并入 `tests/test_pdf_tool_*.py`。

---

## 5. 修复记录（对应本报告，2026-09-26）

| 问题 | 处理 | 验证 |
|---|---|---|
| P0-1 导出永久挂起 | ① `reader` 首个 OCR 请求在**请求线程**预载后端（`_ensure_ocr_ready`，消除任务线程首次 import 死锁）；② `convert.start mode=export` **默认 `workers=1`**（sidecar 内不用 mp.Pool），`workers` 可显式覆盖；③ 新增任务看门狗：无进度超过 `timeout`（默认 600s）发 `convert.done.error="timeout: ..."`，任务可通过 `_finish_job` 幂等收尾 | 报告最小复现脚本：冷缓存单页 **6.0s 完成**、两页 **0.5s 完成**（修复前两形态均 >75s 挂起）；构造 3s 卡死任务的单测命中看门狗 |
| P1-1 文本型 PDF 叠加重复层 | export 分支传 `skip_text_chars=200`（`build()` 默认值）：已有文字层的页跳过并计入 `stats.skipped_text_pages`；可用 `skip_text_chars` 参数覆盖 | `aitest.pdf` 第 1 页导出：`skipped_text_pages=1`、`lines_inserted=0`、0.4s；命中数不变（1/2/1 → 1/2/1） |
| P1-2 单页失败不隔离 | `backends.process_page_safe`（build 三分支统一走它）+ `warm_pages` 单页 try/except；失败进 `stats.failed_pages=[{page,error}]`（`ok=false`），其余页继续 | 新增单测 `test_build_isolates_page_failure`、`test_warm_pages_isolates_page_failure` |
| P2-1 `reader_main.py` 缺失 | 新增 `pdf_tool/reader_main.py`（PyInstaller 入口，含 sys.path 引导）；README §7 命令同步 | 文件入库，入口与 `python -m pdf_tool.reader` 等价 |
| P2-2 性能声明偏差 | README 改为「首跑 2–4s/页（6 核 CPU，200dpi）」「缓存命中 ≈3–10ms（含 IPC/JSON）」，并注明实测机型；prefetch/convert 实测值保留在报告 | 文档 |
| P3 `convert.status.kind` 恒 None | OCR 任务记录补 `kind="ocr"`（doc 任务为 `"doc"`） | 单测断言 `rec["kind"] == "ocr"` |
| P3 串行阻塞健康检查 | README §1 增补：首请求预载约 1–2s、先出页面图再异步补文字层、健康检查不要排在 OCR 之后 | 文档 |

新增/修改的测试：`test_pdf_tool_reader_server.py`（导出默认值、workers 覆盖、看门狗、预载一次）、
`test_pdf_tool_ocr_page.py`（warm_pages 失败隔离）、`test_pdf_tool_ocr_layer.py`（build 失败隔离）。
全量 `pytest tests/` 通过、`ruff check pdf_tool tests` 全绿。

---

## 6. 复验结果（2026-09-26，第三方独立复验）

复验方式与原报告一致：真入口 `python -m pdf_tool.reader`（stdin/stdout 管道）+ 真 RapidOCR +
全新缓存目录；另用注入失败后端做 in-process 断言。

| 修复项 | 复验步骤 | 结果 |
|---|---|---|
| P0-1 导出挂起 | ① 全新缓存、`pages="1-2"` 两页冷导出；② **全新进程首个请求**即单页冷导出；③ `timeout=0.001` 看门狗 | ✅ ①10.9s 完成（58 行、导出页 798 字符可搜索文字层，`workers=1` 出现在 stats 中）②6.2s 完成 ③1.0s 收到 `convert.done.error="timeout: …"`（修复前两形态均 >75s 挂起、不可取消） |
| P1-1 重复文字层 | `aitest.pdf` 第 1 页（文本页）导出 | ✅ `skipped_text_pages=1`、`lines_inserted=0`、330ms；5 个短语命中数导出前后完全一致（1/2/1/2/1） |
| P1-2 逐页容错（export） | 注入失败后端、单页导出 | ✅ `failed_pages=[{"page":1,"error":"RuntimeError: …"}]`、`ok=false`，其余流程照常完成 |
| P1-2 逐页容错（cache） | 注入失败后端、`convert.start mode=cache pages=1-2` | ❌ **未透出**：`warm_pages` 已收集 `failed`，但 `server._run_job` 的 cache 分支只上报 `{"pages":2,"done":2}`，`convert.done.stats` 里没有 `failed_pages`/`ok` —— 客户端无法得知第 2 页失败（README §8 对 cache 模式仍不成立） |
| P2-1 `reader_main.py` | `python pdf_tool/reader_main.py` + `ping` | ✅ 68ms 正常应答 |
| P2-2 性能/串行声明 | 检查 `reader/README.md` | ✅ §1 增加预载说明；§3.2/§9 改为「首跑 2–4s/页（6 核 CPU，200dpi）」「缓存命中 ≈3–10ms」；§4.1 保留“先出图、异步补文字层” |
| P3 `convert.status.kind` | 导出任务 status | ✅ `kind="ocr"`（doc 任务为 `"doc"`） |
| 回归 | 全量 `pytest tests/`（≈370 项，含本表新增 6 例）+ `ruff check pdf_tool tests` | ✅ 全通过 / All checks passed |

**结论**：P0-1、P1-1、P2-1、P2-2、P3 已修复并复验通过；P1-2 仅剩一处 2 行的服务端缺口 ——
在 `server.py` 的 cache 分支把 `warm_pages` 返回的 `failed` 合入 stats，例如：

```python
stats = {"pages": result.get("pages"), "done": result.get("done"),
         "failed_pages": result.get("failed") or []}
if stats["failed_pages"]:
    stats["ok"] = False
```

并补一条「cache 模式失败透出」的单测即可完全闭环。

---

## 7. 补验：P1-2 cache 模式失败透出（2026-09-26，第三轮）

修复内容（`server.py` `_run_job` 的 cache 分支）：

```python
failed = result.get("failed") or []
stats = {"pages": result.get("pages"), "done": result.get("done"),
         "failed_pages": failed}          # 恒存在，空列表表示无失败
if failed:
    stats["ok"] = False                   # export 分支同样 setdefault("failed_pages", [])
```

| 复验步骤 | 结果 |
|---|---|
| 注入失败后端（第 2 页抛错）、`convert.start mode=cache pages=1-2` | ✅ `{"pages":2,"done":2,"failed_pages":[{"page":2,"error":"RuntimeError: boom on page 2"}],"ok":false}`，`error=None`（其余页继续、任务正常收尾） |
| 健康后端同样路径（形状与误报检查） | ✅ `{"pages":2,"done":2,"failed_pages":[],"ok":null}` |
| 真入口 sidecar、真实 OCR、`mode=cache pages=1`（字段形状） | ✅ `{"pages":1,"done":1,"failed_pages":[],"ok":null}`，`error=None` |
| 新增单测 `test_convert_cache_mode_reports_failed_pages` + 既有测试的 `failed_pages == []` 断言 | ✅ 通过（三个相关测试文件 22 例全绿） |
| 回归 | ✅ 全量 `pytest tests/` 通过；`ruff check pdf_tool tests` All checks passed |

**至此 P0-1 / P1-1 / P1-2 / P2-1 / P2-2 / P3 全部修复并复验通过，无遗留项。**
`convert.done.stats` 现在对 cache 与 export 两种模式都带 `failed_pages`（无失败为空列表），
有失败时附 `ok=false`；客户端可据此提示「部分页未成功」而不再静默。

- 闭环补充（P1-2 cache 模式）：`server._run_job` 的 cache 分支已把 `warm_pages` 的失败页并入
  `convert.done.stats.failed_pages`（**恒存在，无失败为空列表**）并在非空时置 `stats.ok=false`；
  export 分支同样 `setdefault("failed_pages", [])`，两模式字段形状一致；
  单测：`test_convert_cache_mode_reports_failed_pages`（失败透出）、`test_convert_cache_mode_progress`（无失败时 `failed_pages == []`）。

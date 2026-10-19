# 阅读器 sidecar 接入说明（给 Electron / pdf.js 开发者）

pdf_tool 以**本地子进程（sidecar）**形式为阅读器提供 PDF 结构处理能力：
扫描页文字层（逐页懒加载 / 整本批量）、PDF → Doc 转换、已缓存页检索。
传输协议是**行分隔 JSON-RPC over stdio**（stdin 一行一个请求，stdout 一行一个响应或通知，
日志走 stderr），与 `deepseek_tool/server.py` 同一约定。

协议版本：`schema_version = 1`（Doc/content/audit 结构随版本变更；新增字段向后兼容）。

---

## 1. 启动与协议

开发期（仓库根目录）：

```bash
python -m pdf_tool.reader
```

生产（PyInstaller 打包后的 exe，见 §8）由 Electron main 进程 spawn：

```js
const { spawn } = require('child_process');
const proc = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
// 逐行读写：
proc.stdout.setEncoding('utf8');
let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));   // 响应 or 通知
    buf = buf.slice(i + 1);
    handleMessage(msg);
  }
});
proc.stderr.on('data', (d) => log.info('[sidecar] ' + d));  // 日志，勿当协议数据
```

请求 / 响应帧：

```jsonc
// 请求（id 由客户端自增）
{"jsonrpc": "2.0", "id": 1, "method": "doc.open", "params": {"path": "C:/x/scan.pdf"}}
// 响应
{"jsonrpc": "2.0", "id": 1, "result": { ... }}
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "..."}}
// 通知（无 id，服务端 → 客户端）
{"jsonrpc": "2.0", "method": "convert.progress", "params": {"job": "ab12", "done": 3, "total": 220, "page": 3}}
```

错误码：`-32700` 解析失败 / `-32601` 未知方法 / `-32602` 参数错误 / `-32000` 服务端异常。
**长任务的业务失败在 `convert.done.error` 里**（不是 JSON-RPC error）。

请求处理是**串行**的（除任务/预热在后台线程）；一次只发一个同步请求（如 `ocr.page`），
翻页预取请用 `ocr.prefetch` 队列。

首个触发 OCR 的请求会在**请求线程**先预载 OCR 后端（约 1–2s，之后常驻），避免重型 import 落在任务线程；
建议文档打开后先请求第 1 页，后续页面走缓存/预取。

---

## 2. 方法总览

| 方法 | 说明 | 同步/任务 |
|---|---|---|
| `ping` | 存活探测 | 同步 |
| `doc.open` | 打开文档：指纹/页数/哪些页已有文字层 | 同步 |
| `ocr.page` | **单页文字层**（缓存优先）：pdf.js TextContent items | 同步（首跑 2–4s/页） |
| `ocr.prefetch` | 预热页级缓存（后台队列） | 通知 `ocr.prefetched` |
| `convert.start` | 文字层批量：`mode=cache` 填缓存 / `mode=export` 另存可搜索 PDF | 任务 |
| `convert.status` / `convert.cancel` | 任务状态 / 取消 | 同步 |
| `doc.convert` | **PDF → Doc**（规范模型 v1，json/md/html + 审计） | 任务 |
| `convert.page` | 单页转换预览（blocks/mineru/text/vision） | 同步 |
| `search.query` | 在**已缓存**页的行文本上检索 | 同步 |
| `cache.stats` / `cache.clear` | 缓存用量 / 清理 | 同步 |

---

## 3. 方法参考

### 3.1 `doc.open`

```jsonc
→ {"path": "C:/x/scan.pdf"}
← {"doc": "sha1-b0d2e91ba597131054f7",   // 内容指纹（缓存键，改名不失效）
   "path": "C:/x/scan.pdf", "pages": 14, "size": 4087782,
   "has_text_pages": [],                  // 已有文字层的页（1-based）
   "scanned_pages": 14}
```

### 3.2 `ocr.page`（核心）

```jsonc
→ {"path": "C:/x/scan.pdf", "page": 3,
   "ocr": "rapid",          // rapid(默认,质量) | windows(极速)
   "dpi": 200, "min_score": 0.5,
   "text_source": null,     // 可选：MinerU layout.json / vision_results.json / blocks JSON 路径
   "force": false}          // 忽略缓存重跑
← {"page": 3, "dpi": 200, "source": "ocr",   // ocr | hybrid（带 text_source 时）
   "has_text": true,
   "lines": [["行文本", [[x0,y0],[x1,y0],[x1,y1],[x0,y1]], 0.99], ...],  // 200dpi 像素框
   "content": {              // ★ 直接作为 pdf.js 的 TextContent 使用
     "items": [{"str": "...", "dir": "ltr", "width": 123.4, "height": 8.2,
                "transform": [a,b,c,d,e,f],   // PDF 用户空间文本矩阵
                "fontName": "ocr", "hasEOL": true}, ...],
     "styles": {"ocr": {"fontFamily": "sans-serif", "ascent": 0.8,
                        "descent": -0.2, "vertical": false}},
     "lang": null}}
```

- `content.items[].transform` 已处理 **cropbox / y 翻转 / 页 `/Rotate`**，渲染端不需要任何换算；
- `lines` 保留原始几何（画框调试、自定义高亮、批注锚点可用）；
- 页级缓存命中时毫秒返回（`source` 相同，无额外字段区分；需要区分可看耗时）。

### 3.3 `ocr.prefetch`

```jsonc
→ {"path": "...", "pages": [4, 2]}
← {"queued": 2}
// 完成后通知：
{"jsonrpc":"2.0","method":"ocr.prefetched","params":{"page":4,"doc":"sha1-..."}}
```

建议：当前页返回后预取 `n+1, n-1`；不要一次入队几百页（队列单线程串行）。
实测（i5-12400F，200dpi）：首跑 3.8–4.3s/页；缓存命中 ≈3–10ms（含 IPC/JSON）。

### 3.4 文字层批量 `convert.start`

```jsonc
// 只填缓存（阅读器内立刻生效，与懒加载共用同一页级缓存）
→ {"path": "...", "mode": "cache", "pages": "1-220"}     // pages 支持 "1-10,20" 或 [1,2,3]
← {"job": "64917531"}

// 导出可搜索 PDF
→ {"path": "...", "mode": "export", "pages": "1-220", "out": "C:/out/searchable.pdf"}
← {"job": "1b25b2e0"}
// 可选：workers（sidecar 默认 1）、skip_text_chars（默认 200：已有文字层的页跳过）、timeout（看门狗秒数）

// 任务生命周期通知
{"method":"convert.progress","params":{"job":"...","done":37,"total":220,"page":37}}
{"method":"convert.done","params":{"job":"...","cancelled":false,"error":null,
   "stats":{"pages":220,"lines_inserted":8123,"size_kb":4100,"out":"..."},
   "files":null,"audit_ok":null}}

→ convert.status {"job":"..."} ← {"running":false,"done":220,"total":220,"error":null,...}
→ convert.cancel {"job":"..."} ← {"cancelled":true}   // 在页边界生效，不产生半成品文件
```

### 3.5 PDF → Doc

```jsonc
→ {"path": "C:/x/book.pdf",
   "mode": "auto",          // auto | blocks | mineru | text | vision
   "pages": "1-50",         // 可选
   "blocks": "output/{stem}/{stem}_doc.json",  // mode=blocks 的输入
   "mineru_token": "...", "mineru_model": "vlm",
   "mineru_max_pages": 200,   // MinerU 单文件页数上限；超过自动分卷合并（默认 200）
   "via": "api",            // text/vision 通道：api(DeepSeek API) | browser(网页会话)
   "model": "deepseek-flash",
   "formats": ["json","md","html"],
   "out_dir": "C:/out/convert"}
← {"job": "620e528c"}
// done 通知带产物：
{"method":"convert.done","params":{"job":"620e528c","error":null,"audit_ok":true,
   "stats":{"mode":"blocks","pages":8,"blocks":40,
            "by_type":{"code":5,"heading":5,"image":1,"text":29}},
   "files":{"json":"...CSP2019_doc.json","md":"...CSP2019_doc.md",
            "html":"...CSP2019_doc.html","audit":"...CSP2019_audit.json"}}}
```

- `mode=auto`：有 MinerU token 走 `mineru`；文本型 PDF 走 `text`；扫描件走 `vision`；
- `mode=blocks` **离线**：只做模型化 + 导出 + 审计（可用于“把已有抽取产物转成 Doc/预览”）；
- 产物命名：`{stem}_doc.json`（Doc v1）/ `_doc.md` / `_doc.html` / `_audit.json`；
  `doc.source.pages` 为源 PDF 页数，缺块页保留为空页；
- 分卷 MinerU：`out/mineru/layout.json` 为整本合并版式（页号已平移、缺页补空页），
  可直接作为文字层 hybrid 的文本源；`load_text_blocks` 同时接受 Doc JSON（兜底）。

### 3.6 `convert.page`（单页预览）

```jsonc
→ {"path": "...", "page": 12, "mode": "blocks", "blocks": "..."}   // 也支持 mineru/text/vision
← {"page": 12, "mode": "blocks",
   "doc": {"schema_version":1, "source":{...}, "pages":[{"page":12,"blocks":[...]}]},
   "markdown": "# 标题\n\n正文..."}
```

### 3.7 `search.query`

```jsonc
→ {"path": "...", "q": "新能源汽车", "limit": 200}
← {"hits": [{"page": 1, "line": 4, "text": "1. 新能源汽车……", "quad": [[..]], "score": 0.99}],
   "cached_pages": 3, "truncated": false}
```

只覆盖**已缓存**页；未 OCR 的页不参与。全书检索策略见 §4.3。

### 3.8 缓存

```jsonc
→ cache.stats {"path": "..."} ← {"dir":"...","pages":4,"bytes":24661}
→ cache.clear {"path": "..."} ← {"cleared":4,"dir":"..."}
```

缓存根：环境变量 `PDF_TOOL_OCR_CACHE`（默认仓库 `temp_output/ocr_layer`；
桌面端建议指到 `%APPDATA%/<App>/ocr_cache`）。
键：`{内容指纹}/{ocr}_{dpi}_s{min_score}_v3/` —— 参数变化自动换目录，指纹保证改名/移动不失效。

---

## 4. pdf.js 集成

### 4.1 扫描页文字层（保持既有搜索/划词/批注可用）

原理：扫描页 `getTextContent()` 返回 0 个 item，调用 sidecar 拿到 `content` 后**替换返回值**，
pdf.js 的 textLayer / findController / 选区高亮全部照常工作（无需另画一层）。

```js
// renderer：包装 PDFPageProxy.getTextContent
const original = pdfPage.getTextContent.bind(pdfPage);
pdfPage.getTextContent = async (params) => {
  const tc = await original(params);
  if (tc.items.length > 0) return tc;                 // 原生文本页不处理
  const res = await bridge.call('ocr.page', { path: pdfPath, page: pdfPage.pageNumber });
  return res.has_text ? res.content : tc;
};
```

- **pdf.js v4**：文本层走 `streamTextContent` / `new TextContent(...)`，包装对应方法即可
  （`content` 的 items/styles/lang 与 v3 兼容）；
- 注入时机：页面渲染后若当前 textLayer 为空，重新渲染文本层（v4 用 `textLayer.update()`）；
- 懒加载交互建议：先显示页面图像，文字层就绪后再挂（或异步替换），并提示「本页文字层生成中」；
- 批量预热：后台 `convert.start mode=cache`（进度条走 `convert.progress`），之后翻页即秒开；
- 划词/批注：items 按**行**生成（CJK 更稳），`hasEOL=true`；高亮/笔记基于行选区即可。

### 4.2 目录（先用 Doc 的 heading 块）

当前协议没有独立 toc 方法（规划中，见 §10）。可用 `doc.convert(mode=blocks|mineru)` 产出的
heading 块在前端组装 outline：

```js
const outline = [];
for (const pg of doc.pages) for (const b of pg.blocks) {
  if (b.type === 'heading') outline.push({
    title: b.text, level: b.level,
    dest: [pg.page - 1, { name: 'XYZ' }, null, null, null],   // 跳到该页
  });
}
const originalGetOutline = docProxy.getOutline.bind(docProxy);
docProxy.getOutline = async () => (await originalGetOutline()) || outline;
```

### 4.3 搜索策略（避免“搜索触发全书 OCR”）

findController 会遍历所有页取 TextContent → 懒加载下等于全书 OCR。三选一：

1. **只搜已缓存页**：接管 Ctrl+F，走 `search.query`（毫秒级），命中后跳页 + 自绘高亮；
2. **全书搜索（先转换）**：弹确认 → `convert.start mode=cache`（进度）→ 完成后恢复 pdf.js 原生搜索；
3. 预转换过（`doc.convert` 或 export）的文档，直接用 pdf.js 原生搜索。

### 4.4 PDF → Doc 的 UI 流程

- 入口按钮按 `mode` 给三档：快速预览（`convert.page` 当前页）、整本转换（`doc.convert` 任务）、
  导出可搜索 PDF（`convert.start mode=export`）；
- 长任务用 `convert.progress` 显示进度，`audit_ok=false` 时提示查看 `_audit.json`；
- 缺凭据的报错文案：text/vision 模式需 `DEEPSEEK_API_KEY`（或 `via=browser` 已登录网页会话）；
  mineru 模式需 `mineru_token`。

---

## 5. 几何与坐标系

| 数据 | 坐标系 | 用途 |
|---|---|---|
| `lines[].quad` | 200dpi 渲染图（页面显示方向、左上原点） | 调试画框、自定义高亮 |
| `content.items[].transform` | **PDF 用户空间**（左下原点，`[a,b,c,d,e,f]`） | 直接给 pdf.js，无需换算 |
| `doc.pages[].blocks[].rect`（如有） | 同上（PDF 用户空间） | 转换结果定位 |

页 `/Rotate` 已在服务端处理（0/90/180/270 有单测覆盖，回环误差 <0.02px）。

---

## 6. 并发与性能

- `ocr.page` 首跑 rapid ≈ 2–4s/页（6 核 CPU，200dpi）；缓存命中 ≈3–10ms；建议**同一时刻只发 1 个**；
- `ocr.prefetch` 单线程队列，可安全连发多个页号；
- `convert`/`doc.convert`：CLI 默认多进程（6 workers × 2 线程）；**sidecar 导出默认 `workers=1`**（多进程在 sidecar 上下文曾有挂起问题），需要加速可显式传 `workers`；同时只跑一个整本任务；
- 看门狗：任务超过 `timeout`（默认 600s）无进度会收到 `convert.done.error="timeout: ..."`，客户端应报错并重启 sidecar（卡死的线程无法安全取消）；
- 大文档分段：`pages` 传 `"1-50"`，完成后追加下一段（缓存累计，不会重复识别）。

---

## 7. 打包与部署（PyInstaller）

入口脚本 `pdf_tool/reader_main.py`（仓库内已提供）：

```python
from pdf_tool.reader.server import main
raise SystemExit(main())
```

```bash
pyinstaller --onefile --name pdf_tool_reader \
  --collect-all rapidocr --collect-all onnxruntime \
  --collect-data pdf_tool \
  --paths . pdf_tool/reader_main.py
```

- `--collect-data pdf_tool`：带上 `prompts/`（doc.convert vision 模式需要）；
- 体积参考：onnxruntime + PP-OCR 模型 ≈ 50MB，PyMuPDF ≈ 20MB；
- Electron 放 `extraResources`，用绝对路径 spawn；崩溃重启 + 退出时关闭 stdin；
- 离线部署时把 OCR 模型随包分发（rapidocr 模型缓存目录打进包）。

---

## 8. 错误处理

- 参数/文件错误：JSON-RPC `error`（`-32602` 缺文件、`-32601` 未知方法）；
- 任务错误：`convert.done.error`（如缺 API key、MinerU 超时），任务本身不崩溃；
- **单页失败不影响其它页**：`convert.done.stats.failed_pages=[{page,error}]`（cache/export 均上报，非空时 `stats.ok=false`），`convert.progress` 照常推进，重跑该页即可；
- **任务卡死**（极端情况）：看门狗发 `convert.done.error="timeout: ..."`，重启 sidecar 后重试；
- sidecar 退出：stdout EOF，客户端应视为致命并重启进程。

---

## 9. 路线图（未实现，勿依赖）

- `doc.segments` / `layer.apply`：把 OCR/翻译等统一成“层”，支持英汉对照等**上层语义功能**
  （翻译在阅读器/上层实现，pdf_tool 只做承载与排版）；
- `feature.list` + 统一 `task.*`：目录/封面等结构能力的注册表与动态入口；
- 表格合并单元格、样式字段、DOCX/EPUB 导出。

---

## 10. FAQ

**Q：换 OCR 后端/DPI/min_score 后缓存会串吗？**
不会。缓存键含三者；改动即换目录、重新识别。

**Q：文字层生成了但选中/高亮偏位？**
先看该页是否旋转页（`page.rotate`），本协议已处理；若仍偏差，检查渲染端是否在 viewport
之外又叠加了缩放（transform 只需乘 viewport，不要再手动缩放）。

**Q：导出 PDF 与阅读器里看到的文字层不一致？**
导出是服务端把文字**写进 PDF**（字体子集化，像素零差异）；阅读器注入的是 DOM 层。
两者同源（同一份 OCR/缓存），但导出可被任何阅读器搜索。

**Q：MinerU 与 hybrid 什么时候用？**
页面公式/表格密集且允许上传第三方时用 `text_source`（hybrid）或 `mode=mineru`；
否则 rapid 足够。hybrid 只提升文本质量，位置仍来自 rapid 行框。

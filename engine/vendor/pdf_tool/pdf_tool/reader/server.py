"""阅读器 sidecar 服务：文档结构处理（文字层 + PDF → Doc + 结构操作）。

- ocr.page / ocr.prefetch：扫描页文字层（页级缓存，逐页懒加载）；
- convert.start：文字层批量（mode=cache 预热 / mode=export 另存可搜索 PDF）；
- doc.convert / convert.page：PDF → Doc（规范模型 v1，json/md/html + 分元素审计）；
- search.query / cache.*：已缓存页检索与缓存管理。
"""
from __future__ import annotations

import json
import logging
import sys
import threading
import time
import uuid
from pathlib import Path

from pdf_tool.core.io import fingerprint
from pdf_tool.core.paths import OUT_ROOT
from pdf_tool.ocr import page as ocr_page
from pdf_tool.ocr.build import ConversionCancelled, build
from pdf_tool.ocr.cache import cache_dir

log = logging.getLogger("pdf_tool.reader")

PARSE_ERROR = -32700
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
SERVER_ERROR = -32000

DEFAULT_OCR = "rapid"
DEFAULT_DPI = 200.0
DEFAULT_MIN_SCORE = 0.5


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


class ReaderServer:
    """行 JSON-RPC 服务。backend/cache_root/notify/out 仅测试注入。"""

    def __init__(self, *, backend=None, cache_root=None, notify=None, out=None,
                 progress_timeout: float = 600.0):
        self.backend = backend
        self._progress_timeout = float(progress_timeout)
        self._ocr_ready = False
        self.cache_root = Path(cache_root) if cache_root else None
        self._notify_cb = notify
        self._out = out
        self._write_lock = threading.Lock()
        self._jobs: dict[str, dict] = {}
        self._prefetch: list[tuple[str, int, str, float, float, str | None]] = []
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: threading.Thread | None = None
        self._fp_cache: dict[tuple[str, int, int], str] = {}

    # ---------- 基础 ----------

    def _doc_key(self, path: Path) -> str:
        st = path.stat()
        ck = (str(path), st.st_size, st.st_mtime_ns)
        key = self._fp_cache.get(ck)
        if key is None:
            key = fingerprint(path)
            self._fp_cache[ck] = key
        return key

    def _write(self, obj: dict) -> None:
        line = json.dumps(obj, ensure_ascii=False)
        with self._write_lock:
            if self._out is None:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            else:
                self._out.write(line + "\n")
                self._out.flush()

    def _notify(self, method: str, params: dict) -> None:
        if self._notify_cb is not None:
            self._notify_cb(method, params)
            return
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    @staticmethod
    def _require_path(params: dict) -> Path:
        raw = str(params.get("path") or "")
        path = Path(raw)
        if not raw or not path.exists():
            raise RpcError(INVALID_PARAMS, f"文件不存在: {raw or '(空)'}")
        return path

    def _opts(self, params: dict) -> dict:
        return {"ocr": str(params.get("ocr") or DEFAULT_OCR),
                "dpi": float(params.get("dpi") or DEFAULT_DPI),
                "min_score": float(params.get("min_score", DEFAULT_MIN_SCORE))}

    def _ensure_ocr_ready(self) -> None:
        """在请求线程完成 OCR 后端导入：避免首次 import 落在任务线程里死锁。"""
        if self._ocr_ready:
            return
        try:
            from pdf_tool.ocr import backends

            backends.make_backend(DEFAULT_OCR)
        except Exception as e:
            log.warning("OCR 后端预载失败: %s", e)
        self._ocr_ready = True

    def _finish_job(self, rec: dict, *, stats=None, files=None, audit_ok=None,
                    error=None, cancelled=None) -> None:
        """任务结束（幂等）：只发一次 convert.done；任务线程与看门狗都可调用。"""
        if rec.get("done_sent"):
            return
        rec["done_sent"] = True
        rec["running"] = False
        rec.update({k: v for k, v in (
            ("stats", stats), ("files", files), ("audit_ok", audit_ok),
            ("error", error), ("cancelled", cancelled)) if v is not None})
        self._notify("convert.done", {"job": rec["id"], "cancelled": rec.get("cancelled"),
                                      "error": rec.get("error"), "stats": rec.get("stats"),
                                      "files": rec.get("files"),
                                      "audit_ok": rec.get("audit_ok")})

    def _watch_job(self, rec: dict) -> None:
        """看门狗：无进度超时则报错结束（卡死的线程无法取消，客户端可据此重启）。"""
        limit = float(rec.get("progress_timeout") or self._progress_timeout)
        while rec["running"] and not rec.get("done_sent"):
            if time.time() - rec.get("last_progress", 0.0) > limit:
                rec["stop"] = True
                log.error("任务 %s 超过 %.0fs 无进度，标记超时", rec["id"], limit)
                self._finish_job(rec, error=f"timeout: {limit:.0f}s 无进度"
                                            "（任务可能卡死，建议重启 sidecar）")
                return
            time.sleep(1.0)

    # ---------- 方法 ----------

    def rpc_ping(self, params: dict) -> dict:
        return {"ok": True, "name": "pdf_tool.reader"}

    def rpc_doc_open(self, params: dict) -> dict:
        import fitz

        path = self._require_path(params)
        doc = fitz.open(path)
        try:
            pages = doc.page_count
            has_text = [i + 1 for i in range(pages)
                        if len(doc[i].get_text().strip()) > 20]
        finally:
            doc.close()
        return {"doc": self._doc_key(path), "path": str(path), "pages": pages,
                "size": path.stat().st_size, "has_text_pages": has_text,
                "scanned_pages": pages - len(has_text)}

    def rpc_ocr_page(self, params: dict) -> dict:
        path = self._require_path(params)
        self._ensure_ocr_ready()
        page_no = int(params.get("page") or 0)
        opts = self._opts(params)
        text_source = params.get("text_source")
        return ocr_page.ocr_page_items(
            path, page_no, name=self._doc_key(path), backend=self.backend,
            cache_root=self.cache_root, force=bool(params.get("force")),
            text_source=Path(text_source) if text_source else None, **opts)

    def rpc_ocr_prefetch(self, params: dict) -> dict:
        path = self._require_path(params)
        self._ensure_ocr_ready()
        pages = params.get("pages") or []
        if not isinstance(pages, (list, tuple)):
            raise RpcError(INVALID_PARAMS, "pages 需为数组")
        opts = self._opts(params)
        key = self._doc_key(path)
        with self._prefetch_lock:
            for p in pages:
                self._prefetch.append((str(path), int(p), key, opts["ocr"],
                                       opts["dpi"], opts["min_score"]))
            queued = len(self._prefetch)
            if self._prefetch_thread is None or not self._prefetch_thread.is_alive():
                self._prefetch_thread = threading.Thread(
                    target=self._prefetch_worker, daemon=True)
                self._prefetch_thread.start()
        return {"queued": queued}

    def _prefetch_worker(self) -> None:
        while True:
            with self._prefetch_lock:
                if not self._prefetch:
                    return
                path, page_no, key, ocr, dpi, min_score = self._prefetch.pop(0)
            try:
                ocr_page.ocr_page_lines(path, page_no, ocr=ocr, dpi=dpi,
                                        min_score=min_score, cache_root=self.cache_root,
                                        backend=self.backend, name=key)
                self._notify("ocr.prefetched", {"page": page_no, "doc": key})
            except Exception as e:  # 单页失败不拖垮队列
                log.warning("prefetch 第 %d 页失败: %s", page_no, e)

    def rpc_search_query(self, params: dict) -> dict:
        path = self._require_path(params)
        query = str(params.get("q") or "")
        if not query:
            raise RpcError(INVALID_PARAMS, "缺少 q")
        limit = int(params.get("limit") or 200)
        opts = self._opts(params)
        cdir = cache_dir(self._doc_key(path), opts["ocr"], opts["dpi"],
                         opts["min_score"], self.cache_root)
        hits: list[dict] = []
        cached_pages = 0
        for f in sorted(cdir.glob("page_*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            cached_pages += 1
            page_no = int(data.get("page") or 0)
            for i, item in enumerate(data.get("lines") or []):
                text = str(item[0])
                if query.lower() in text.lower():
                    hits.append({"page": page_no, "line": i, "text": text,
                                 "quad": item[1], "score": item[2] if len(item) > 2 else 1.0})
                    if len(hits) >= limit:
                        return {"hits": hits, "cached_pages": cached_pages,
                                "truncated": True}
        return {"hits": hits, "cached_pages": cached_pages, "truncated": False}

    def rpc_convert_start(self, params: dict) -> dict:
        path = self._require_path(params)
        self._ensure_ocr_ready()
        mode = str(params.get("mode") or "cache")
        if mode not in ("cache", "export"):
            raise RpcError(INVALID_PARAMS, "mode 需为 cache 或 export")
        if mode == "export" and not params.get("out"):
            raise RpcError(INVALID_PARAMS, "mode=export 需要 out")
        job = uuid.uuid4().hex[:8]
        rec = {"id": job, "kind": "ocr", "mode": mode, "running": True, "done": 0,
               "total": 0, "out": params.get("out"), "cancelled": False,
               "error": None, "stop": False, "last_progress": time.time(),
               "done_sent": False, "progress_timeout": float(params.get("timeout") or 0)}
        self._jobs[job] = rec
        threading.Thread(target=self._run_job, args=(rec, path, params),
                         daemon=True).start()
        threading.Thread(target=self._watch_job, args=(rec,), daemon=True).start()
        return {"job": job}

    def _run_job(self, rec: dict, path: Path, params: dict) -> None:
        opts = self._opts(params)

        def on_page(page_no: int, done: int, total: int):
            rec["done"], rec["total"] = done, total
            rec["last_progress"] = time.time()
            self._notify("convert.progress", {"job": rec["id"], "done": done,
                                              "total": total, "page": page_no})
            return not rec["stop"]

        try:
            if rec["mode"] == "cache":
                result = ocr_page.warm_pages(
                    path, params.get("pages") or "", name=self._doc_key(path),
                    backend=self.backend, cache_root=self.cache_root,
                    force=bool(params.get("force")), on_page=on_page, **opts)
                rec["cancelled"] = bool(result.get("cancelled"))
                rec["done"] = rec["total"] = result.get("pages", rec["total"])
                failed = result.get("failed") or []
                # failed_pages 恒存在（无失败为空列表），cache/export 口径一致
                stats = {"pages": result.get("pages"), "done": result.get("done"),
                         "failed_pages": failed}
                if failed:
                    stats["ok"] = False
            else:
                pages = self._norm_pages(path, params.get("pages"))
                stats = build(path, Path(rec["out"]), ocr=opts["ocr"], dpi=opts["dpi"],
                              pages_spec=",".join(str(p) for p in pages) if pages else "",
                              min_score=opts["min_score"], force=bool(params.get("force")),
                              skip_text_chars=int(params.get("skip_text_chars", 200)),
                              workers=int(params.get("workers") or 1),
                              on_page=on_page, backend=self.backend,
                              cache_root=self.cache_root, cache_name=self._doc_key(path))
                stats["out"] = rec["out"]
                stats.setdefault("failed_pages", [])  # 与 cache 模式统一字段形状
        except ConversionCancelled:
            rec["cancelled"] = True
            stats = {"cancelled": True}
        except Exception as e:
            log.exception("convert %s 失败", rec["id"])
            rec["error"] = f"{type(e).__name__}: {e}"
            stats = {"error": rec["error"]}
        finally:
            self._finish_job(rec, stats=stats)

    def rpc_convert_status(self, params: dict) -> dict:
        job = str(params.get("job") or "")
        rec = self._jobs.get(job)
        if rec is None:
            raise RpcError(INVALID_PARAMS, f"未知任务: {job}")
        return {k: rec.get(k) for k in ("id", "kind", "mode", "running", "done", "total",
                                        "out", "cancelled", "error", "files", "audit_ok")}

    def rpc_convert_cancel(self, params: dict) -> dict:
        rec = self._jobs.get(str(params.get("job") or ""))
        if rec is None:
            raise RpcError(INVALID_PARAMS, "未知任务")
        rec["stop"] = True
        return {"cancelled": True}

    def rpc_cache_stats(self, params: dict) -> dict:
        path = self._require_path(params)
        opts = self._opts(params)
        cdir = cache_dir(self._doc_key(path), opts["ocr"], opts["dpi"],
                         opts["min_score"], self.cache_root)
        files = list(cdir.glob("page_*.json")) if cdir.exists() else []
        return {"dir": str(cdir), "pages": len(files),
                "bytes": sum(f.stat().st_size for f in files)}

    def rpc_cache_clear(self, params: dict) -> dict:
        import shutil

        stats = self.rpc_cache_stats(params)
        cdir = Path(stats["dir"])
        if cdir.exists():
            shutil.rmtree(cdir)
        return {"cleared": stats["pages"], "dir": stats["dir"]}

    # ---------- PDF → Doc ----------

    def _norm_pages(self, path: Path, pages):
        if pages is None or pages == "":
            return None
        if isinstance(pages, (list, tuple)):
            return [int(p) for p in pages]
        import fitz

        from pdf_tool.core.pages import parse_pages

        doc = fitz.open(path)
        try:
            return parse_pages(str(pages), doc.page_count)
        finally:
            doc.close()

    def rpc_doc_convert(self, params: dict) -> dict:
        path = self._require_path(params)
        job = uuid.uuid4().hex[:8]
        rec = {"id": job, "kind": "doc", "mode": str(params.get("mode") or "auto"),
               "running": True, "done": 0, "total": 0, "out": None, "cancelled": False,
               "error": None, "stop": False, "last_progress": time.time(),
               "done_sent": False, "progress_timeout": float(params.get("timeout") or 0)}
        self._jobs[job] = rec
        threading.Thread(target=self._run_doc_job, args=(rec, path, params),
                         daemon=True).start()
        threading.Thread(target=self._watch_job, args=(rec,), daemon=True).start()
        return {"job": job}

    def _run_doc_job(self, rec: dict, path: Path, params: dict) -> None:
        from pdf_tool.convert.pipeline import (
            DEFAULT_FORMATS,
            make_llm_client,
        )
        from pdf_tool.convert.pipeline import (
            convert as convert_doc,
        )
        from pdf_tool.mineru import MineruCancelled

        def on_page(page_no: int, done: int, total: int):
            rec["done"], rec["total"] = done, total
            rec["last_progress"] = time.time()
            self._notify("convert.progress", {"job": rec["id"], "done": done,
                                              "total": total, "page": page_no})
            return not rec["stop"]

        try:
            mode = str(params.get("mode") or "auto")
            token = str(params.get("mineru_token") or "")
            client = None
            if mode in ("text", "vision") or (mode == "auto" and not token):
                client = make_llm_client(via=str(params.get("via") or "api"),
                                         model=str(params.get("model") or "deepseek-flash"))
            out_dir = params.get("out_dir") or str(OUT_ROOT / path.stem / "convert")
            formats = tuple(params.get("formats") or DEFAULT_FORMATS)
            _fn = params.get("footnotes")
            _st = params.get("structure")
            result = convert_doc(
                path, mode=mode, pages=self._norm_pages(path, params.get("pages")),
                blocks_path=params.get("blocks"), client=client, mineru_token=token,
                mineru_model=str(params.get("mineru_model") or "vlm"),
                mineru_source=str(params.get("mineru_source") or "auto"),
                mineru_tier=str(params.get("mineru_tier") or ""),
                mineru_url=str(params.get("mineru_url") or ""),
                mineru_max_pages=int(params.get("mineru_max_pages") or 200),
                out_dir=out_dir,
                formats=formats, max_chars=int(params.get("doc_chars") or 16000),
                force=bool(params.get("force")), on_page=on_page,
                cancelled=lambda: bool(rec.get("stop")),
                footnotes=True if _fn is None else bool(_fn),
                structure=True if _st is None else bool(_st))
            rec["mode"] = result["mode"]
            rec["stats"] = result["stats"]
            rec["files"] = result["files"]
            rec["audit_ok"] = result["audit"]["ok"]
        except MineruCancelled as e:
            log.info("doc.convert %s 已取消：%s", rec["id"], e)
            rec["cancelled"] = True
            rec["stats"] = {"cancelled": True}
        except Exception as e:
            log.exception("doc.convert %s 失败", rec["id"])
            rec["error"] = f"{type(e).__name__}: {e}"
        finally:
            self._finish_job(rec, stats=rec.get("stats"), files=rec.get("files"),
                             audit_ok=rec.get("audit_ok"))

    def rpc_convert_page(self, params: dict) -> dict:
        from pdf_tool.convert.pipeline import convert_page as convert_doc_page
        from pdf_tool.convert.pipeline import make_llm_client

        path = self._require_path(params)
        page = int(params.get("page") or 0)
        if page <= 0:
            raise RpcError(INVALID_PARAMS, "page 需为正整数")
        mode = str(params.get("mode") or "blocks")
        client = None
        if mode in ("text", "vision"):
            client = make_llm_client(via=str(params.get("via") or "api"),
                                     model=str(params.get("model") or "deepseek-flash"))
        _fn = params.get("footnotes")
        return convert_doc_page(path, page, mode=mode, blocks_path=params.get("blocks"),
                                client=client,
                                mineru_token=str(params.get("mineru_token") or ""),
                                mineru_model=str(params.get("mineru_model") or "vlm"),
                                mineru_source=str(params.get("mineru_source") or "auto"),
                                mineru_tier=str(params.get("mineru_tier") or ""),
                                mineru_url=str(params.get("mineru_url") or ""),
                                mineru_max_pages=int(params.get("mineru_max_pages") or 200),
                                footnotes=True if _fn is None else bool(_fn))

    # ---------- 分发/主循环 ----------

    def dispatch(self, method: str, params: dict) -> dict:
        handler = getattr(self, f"rpc_{str(method).replace('.', '_')}", None)
        if handler is None:
            raise RpcError(METHOD_NOT_FOUND, f"未知方法: {method}")
        return handler(params or {})

    def handle_line(self, line: str) -> dict | None:
        line = line.strip()
        if not line:
            return None
        try:
            req = json.loads(line)
        except Exception:
            return {"jsonrpc": "2.0", "id": None,
                    "error": {"code": PARSE_ERROR, "message": "JSON 解析失败"}}
        rid = req.get("id")
        if rid is None:  # 客户端 notification：忽略
            return None
        try:
            return {"jsonrpc": "2.0", "id": rid,
                    "result": self.dispatch(req.get("method"), req.get("params"))}
        except RpcError as e:
            return {"jsonrpc": "2.0", "id": rid,
                    "error": {"code": e.code, "message": str(e)}}
        except Exception as e:
            log.exception("rpc %s 失败", req.get("method"))
            return {"jsonrpc": "2.0", "id": rid,
                    "error": {"code": SERVER_ERROR,
                              "message": f"{type(e).__name__}: {e}"}}

    def serve(self, stream_in=None) -> None:
        stream_in = stream_in if stream_in is not None else sys.stdin
        for line in stream_in:
            resp = self.handle_line(line)
            if resp is not None:
                self._write(resp)


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s",
                        stream=sys.stderr)
    # 行 JSON-RPC 走 stdio，固定 UTF-8：Windows 中文控制台默认 GBK，OCR 文本里的
    # 非 GBK 字符（如 ²）会在写响应时 UnicodeEncodeError 崩溃。
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:  # 流不可重配（测试替身/已重定向）时保持原样
            log.warning("stdio 流无法重配为 UTF-8，沿用默认编码: %r", stream)
    ReaderServer().serve()
    return 0

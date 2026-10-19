"""本地 MinerU 后端（4.x）：CLI 形态 + 常驻服务（HTTP）形态，同一产物适配。

两种形态共享 `_assemble()`：zip → middle_json → `local_helper.py` 渲染 content_list V1，
因此 `parse_pdf` / `content_list_to_blocks` 完全复用（分卷 / 合并 / 公式裁剪 / stitching）。

- `MineruLocalClient`（CLI）：`<cmd> parse <pdf> --tier T --format zip -o <out>`；
  **每次调用都要重新加载模型（固定 ~10–15s 启动，首跑更久）**。
- `MineruLocalHttpClient`（常驻服务）：`mineru-kit api-server` 的 V1 任务接口
  （`POST /v1/tasks` 原始字节上传 → 轮询 `/v1/tasks/{id}/result` 取 zip；取消走
  `DELETE /v1/tasks/{id}`）；模型常驻，单次调用只付推理时间（~1–2s/页）。地址：
  `MINERU_LOCAL_URL`（如 `http://127.0.0.1:8000`），可配 `MINERU_LOCAL_API_KEY`
  （服务端 `--api-key` 时）。取消语义见 `MineruCancelled`（pdf_tool/mineru/__init__.py）。
- 进度输出走 logging（stderr）——阅读器 stdout 是 JSON-RPC 协议，不能污染；
- `make_mineru_client()` 实现 `--mineru-source auto|cloud|local` 路由：
  显式 `local` 走 `MINERU_LOCAL_URL`（若配置）否则 CLI，不静默回退；
  `auto` 顺序 = LOCAL_URL > token（云端）> CLI。
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from pdf_tool.mineru import MineruCancelled, page_spec

log = logging.getLogger("qb.mineru.local")

DEFAULT_CMD = "mineru-kit"
DEFAULT_TIER = "standard"
TIERS = ("basic", "standard", "advanced", "flash")
HELPER = Path(__file__).with_name("local_helper.py")


class MineruLocalError(RuntimeError):
    pass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def local_available(cmd: str | None = None) -> str:
    """本地 MinerU 命令是否可用：返回可执行路径（空串 = 不可用）。"""
    name = cmd or _env("MINERU_LOCAL_CMD", DEFAULT_CMD)
    p = Path(name)
    if p.is_file():
        return str(p)
    return shutil.which(name) or ""


def local_url() -> str:
    """常驻服务地址（env `MINERU_LOCAL_URL`）；空串 = 未配置。"""
    return _env("MINERU_LOCAL_URL")


def _resolve_python(cmd: str = "") -> str:
    """helper 解释器：`MINERU_LOCAL_PYTHON` > cmd 同目录 python（venv）> 当前解释器。"""
    env = _env("MINERU_LOCAL_PYTHON")
    if env:
        return env
    if cmd:
        p = Path(cmd)
        for name in ("python.exe", "python"):
            cand = p.with_name(name)
            if cand.exists():
                return str(cand)
    return sys.executable


def _is_loopback(url: str) -> bool:
    """本地回环地址：绕过系统代理（代理环境变量不应拦 127.0.0.1）。"""
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host in ("localhost", "::1") or host.startswith("127.")


# 取消看门狗（独立进程）：父进程退出后 DELETE 服务端任务，防止 sidecar 被强杀后 GPU 空占。
# 仅在常驻服务模式下每个任务临时拉起、正常结束即回收；轮询父进程存活（~2s）。
_WATCHDOG_SCRIPT = (
    "import ctypes, os, sys, time, urllib.request\n"
    "base, task, parent = sys.argv[1], sys.argv[2], int(sys.argv[3])\n"
    "def alive(pid):\n"
    "    if os.name != 'nt':\n"
    "        try:\n"
    "            os.kill(pid, 0); return True\n"
    "        except OSError:\n"
    "            return False\n"
    "    k32 = ctypes.windll.kernel32\n"
    "    h = k32.OpenProcess(0x1000, 0, pid)\n"
    "    if not h:\n"
    "        return False\n"
    "    try:\n"
    "        code = ctypes.c_ulong()\n"
    "        if not k32.GetExitCodeProcess(h, ctypes.byref(code)):\n"
    "            return False\n"
    "        return code.value == 259\n"
    "    finally:\n"
    "        k32.CloseHandle(h)\n"
    "while alive(parent):\n"
    "    time.sleep(2)\n"
    "req = urllib.request.Request(base + '/v1/tasks/' + task, method='DELETE')\n"
    "key = os.environ.get('MINERU_LOCAL_API_KEY', '')\n"
    "if key:\n"
    "    req.add_header('Authorization', 'Bearer ' + key)\n"
    "try:\n"
    "    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))\n"
    "    opener.open(req, timeout=15).read(1)\n"
    "except Exception:\n"
    "    pass\n"
)


class _LocalArtifacts:
    """CLI / HTTP 两种本地形态共享的产物整理与契约。"""

    supports_page_range = True  # `parse(..., pages=[1,2,3])` → 只解析这些页
    supports_cancel = True      # `parse(..., cancelled=fn)` → 取消（杀进程 / DELETE 任务）

    def __init__(self, *, tier: str | None = None, timeout: int = 7200,
                 helper: Path | None = None, python: str = ""):
        self.tier = (tier or _env("MINERU_TIER", DEFAULT_TIER)).lower()
        if self.tier not in TIERS:
            raise MineruLocalError(f"未知档位 {self.tier}（可选 {TIERS}；env MINERU_TIER）")
        self.timeout = timeout
        self.helper = Path(helper or _env("MINERU_LOCAL_HELPER", str(HELPER)))
        self.python = python or _resolve_python()

    # ---- 产物整理（zip → middle_json → content_list V1） ----

    def _extract(self, work_dir: Path) -> None:
        zips = sorted((work_dir / "out").rglob("*.zip")) or sorted(work_dir.rglob("*.zip"))
        if not zips:
            raise MineruLocalError(f"未找到 zip 产物（现有：{self._listing(work_dir)}）")
        with zipfile.ZipFile(zips[0]) as zf:
            zf.extractall(work_dir)
        mids = sorted(work_dir.rglob("*middle_json*.json"))  # 4.x zip 可能带顶层目录
        if mids and mids[0].parent != work_dir:
            root = mids[0].parent
            for p in list(root.iterdir()):
                dest = work_dir / p.name
                if not dest.exists():
                    shutil.move(str(p), str(dest))

    def _render_content_list(self, middle: Path, out_dir: Path, *, need_md: bool) -> None:
        cmd = [self.python, str(self.helper), "--middle", str(middle), "--out", str(out_dir)]
        if need_md:
            cmd.append("--markdown")
        log.info("[mineru-local] helper: %s", " ".join(cmd))
        h = subprocess.run(cmd, check=False, capture_output=True, text=True,  # noqa: S603
                           encoding="utf-8", errors="replace", timeout=1800)
        last = (h.stdout or "").strip().splitlines()
        status = last[-1] if last else ""
        try:
            ok = bool(json.loads(status).get("ok"))
        except Exception:
            ok = False
        if h.returncode != 0 or not ok:
            detail = status or (h.stderr or "").strip()[-300:]
            if "No module named" in detail:
                detail += ("。请在本地 MinerU 环境运行 helper：设置 MINERU_LOCAL_PYTHON 指向该"
                           " venv 的 python（或设置 MINERU_LOCAL_CMD 指向 venv 内的 "
                           "mineru-kit，会自动取同目录 python）")
            raise MineruLocalError(f"content_list 渲染失败：{detail}")

    @staticmethod
    def _first(base: Path, pattern: str) -> Path | None:
        return next(iter(sorted(base.rglob(pattern))), None)

    @staticmethod
    def _listing(base: Path) -> str:
        files = [str(p.relative_to(base)) for p in sorted(base.rglob("*")) if p.is_file()]
        return ", ".join(files[:10]) + ("…" if len(files) > 10 else "")

    def _assemble(self, work_dir: Path, pdf: Path, t0: float) -> dict:
        """统一收尾：解压 → middle_json → content_list V1（helper）→ 契约字典。"""
        self._extract(work_dir)
        middle = self._first(work_dir, "*middle_json*.json")
        if middle is None:
            raise MineruLocalError(f"未找到 middle_json（现有：{self._listing(work_dir)}）")
        md = self._first(work_dir, "*.md")
        cl = self._first(work_dir, "*content_list*.json")
        if cl is None:  # 4.x zip 默认不含 content_list：用 helper 渲染 V1
            cl = work_dir / "content_list.json"
            self._render_content_list(middle, work_dir, need_md=md is None)
            if md is None:
                md = work_dir / "full.md"
        origin = work_dir / f"{pdf.stem}_origin.pdf"
        if not origin.exists():
            shutil.copy2(pdf, origin)
        return {"dir": work_dir, "md": md, "content_list": cl, "origin": origin,
                "elapsed": time.time() - t0}


class MineruLocalClient(_LocalArtifacts):
    """本地 MinerU（4.x）CLI：`<cmd> parse <pdf> --tier T --format zip -o <out>`。

    每次调用都是新进程（模型冷加载 ~10–15s）；常驻服务模式见 `MineruLocalHttpClient`。
    """

    def __init__(self, *, tier: str | None = None, cmd: str | None = None,
                 timeout: int = 7200, helper: Path | None = None):
        self.cmd = local_available(cmd)
        if not self.cmd:
            name = cmd or _env("MINERU_LOCAL_CMD", DEFAULT_CMD)
            raise MineruLocalError(
                f"未找到本地 MinerU 命令（MINERU_LOCAL_CMD={name}）：请安装 mineru"
                "（建议隔离 venv，见 docs/plan-mineru-local-2026-10-12.md）"
                "或把该变量指向 venv 内的 mineru-kit")
        super().__init__(tier=tier, timeout=timeout, helper=helper,
                         python=_resolve_python(self.cmd))

    def parse(self, pdf: Path, work_dir: Path, pages=None, cancelled=None) -> dict:
        """运行本地 MinerU 并适配产物；返回与云端 `MineruClient.parse` 相同的形状。

        pages：页码列表（1-based）；给出时透传 `--pages`，只解析这些页（省 GPU 时间）。
        cancelled：可调用（返回 True=取消）——取消时杀掉解析进程并抛 `MineruCancelled`。
        """
        pdf, work_dir = Path(pdf), Path(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        out = work_dir / "out"
        cmd = [self.cmd, "parse", str(pdf), "--tier", self.tier,
               "--format", "zip", "-o", str(out)]
        spec = page_spec(pages)
        if spec:
            cmd += ["--pages", spec]
        log.info("[mineru-local] %s", " ".join(cmd))
        t0 = time.time()
        tail: list[str] = []
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,  # noqa: S603 - 本机工具
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace")
        except OSError as e:
            raise MineruLocalError(f"无法启动 {self.cmd}：{e}") from e

        def _drain() -> None:
            """独立线程持续排空输出：tqdm 用回车刷新（无换行），按行阻塞读会写满
            管道造成死锁；stdin 置空避免子进程继承 JSON-RPC 协议流。
            """
            buf = ""
            stream = proc.stdout
            while True:
                chunk = stream.read(4096) if stream is not None else ""
                if not chunk:
                    break
                buf = (buf + chunk).replace("\r\n", "\n").replace("\r", "\n")
                *lines, buf = buf.split("\n")
                for ln in lines:
                    if ln.strip():
                        tail.append(ln.strip())
                        del tail[:-8]
                        log.info("[mineru-local] %s", ln.strip())
            if buf.strip():
                tail.append(buf.strip())

        drain = threading.Thread(target=_drain, daemon=True)
        drain.start()
        deadline = t0 + self.timeout
        rc: int | None = None
        while rc is None:
            try:
                rc = proc.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                if cancelled is not None and cancelled():
                    proc.kill()
                    proc.wait(timeout=10)
                    drain.join(timeout=5)
                    log.info("[mineru-local] 已取消（杀进程 pid=%s）", proc.pid)
                    raise MineruCancelled(f"已取消（本地解析 pid={proc.pid}）") from None
                if time.time() > deadline:
                    proc.kill()
                    drain.join(timeout=5)
                    raise MineruLocalError(f"本地解析超时（{self.timeout}s）") from None
        drain.join(timeout=5)
        if rc != 0:
            raise MineruLocalError(f"mineru 退出码 {rc}：{' | '.join(tail[-3:])}")

        return self._assemble(work_dir, pdf, t0)


class MineruLocalHttpClient(_LocalArtifacts):
    """本地 MinerU 常驻服务（`mineru-kit api-server`，V1 API）——免每次启动模型。

    流程：`GET /v1/health` 探活 → `POST /v1/tasks`（application/octet-stream 上传 +
    `output_formats=zip`）→ 立即拿 `task_id` → 轮询结果
    `GET /v1/tasks/{task_id}/result?response_format=zip`（202=进行中）。
    取消：`DELETE /v1/tasks/{task_id}`（见 `cancel_task`）。
    """

    def __init__(self, *, base_url: str | None = None, tier: str | None = None,
                 timeout: int = 7200, helper: Path | None = None,
                 poll_interval: float = 2.0):
        url = (base_url if base_url is not None else local_url()).strip().rstrip("/")
        if not url:
            raise MineruLocalError(
                "未配置本地 MinerU 服务地址：设置 MINERU_LOCAL_URL"
                "（如 http://127.0.0.1:8000，服务端 `mineru-kit api-server`）"
                "或改用 CLI 形态（MINERU_LOCAL_CMD）")
        if not url.lower().startswith(("http://", "https://")):
            raise MineruLocalError(f"MINERU_LOCAL_URL 需为 http(s) 地址：{url!r}")
        self.base_url = url
        self.poll_interval = max(0.5, float(poll_interval))
        self.api_key = _env("MINERU_LOCAL_API_KEY")
        self._bypass_proxy = _is_loopback(url)
        self._healthy = False
        self._task_id: str | None = None
        self._task_lock = threading.Lock()
        self._watchdog: subprocess.Popen | None = None
        super().__init__(tier=tier, timeout=timeout, helper=helper,
                         python=_resolve_python(local_available()))

    # ---- HTTP 底层 ----

    def _request(self, method: str, path: str, *, data: bytes | None = None,
                 headers: dict[str, str] | None = None,
                 timeout: float | None = None):
        req = urllib.request.Request(self.base_url + path,  # noqa: S310 - 已在构造时校验 http(s)
                                     data=data, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        opener = (urllib.request.build_opener(urllib.request.ProxyHandler({})).open
                  if self._bypass_proxy else urllib.request.urlopen)
        try:
            return opener(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as e:
            raise self._http_error(e) from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise MineruLocalError(self._unreachable(e)) from e

    @staticmethod
    def _error_detail(e: urllib.error.HTTPError) -> str:
        """从错误响应里提取可读信息：`{"error": {"message"}}` / files[].error / 原文。"""
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:
            return ""
        try:
            data = json.loads(raw)
        except ValueError:
            return raw.strip()[:300]
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict) and (err.get("message") or err.get("code")):
                return str(err.get("message") or err.get("code"))
            for f in data.get("files") or []:
                fe = (f or {}).get("error") if isinstance(f, dict) else None
                if isinstance(fe, dict) and (fe.get("message") or fe.get("code")):
                    return str(fe.get("message") or fe.get("code"))
        return raw.strip()[:300]

    def _http_error(self, e: urllib.error.HTTPError) -> MineruLocalError:
        detail = self._error_detail(e) or "（无错误详情）"
        if e.code == 503:
            return MineruLocalError(
                f"本地 MinerU 服务尚未就绪（HTTP 503）：{detail}。"
                "若服务以 --preload-models 启动，等预加载完成后重试")
        if e.code == 401:
            return MineruLocalError(
                f"本地 MinerU 服务要求 API key（HTTP 401）：{detail}。"
                "设置 MINERU_LOCAL_API_KEY 与服务的 --api-key 一致")
        return MineruLocalError(
            f"本地 MinerU 服务错误（HTTP {e.code}）：{detail}（MINERU_LOCAL_URL={self.base_url}）")

    def _unreachable(self, e: Exception) -> str:
        parts = urllib.parse.urlsplit(self.base_url)
        example = (f"mineru-kit api-server --host {parts.hostname or '127.0.0.1'} "
                   f"--port {parts.port or 8000} --tier {self.tier}")
        return (f"未能连接本地 MinerU 服务（{self.base_url}）：{e}。"
                f"请先启动常驻服务，例如：{example}；"
                "或取消 MINERU_LOCAL_URL 改用 CLI 形态（MINERU_LOCAL_CMD，每次多 ~10-15s 启动）")

    def _health(self) -> None:
        if self._healthy:
            return
        with contextlib.closing(self._request("GET", "/v1/health", timeout=15)) as resp:
            resp.read(1)
        self._healthy = True

    def _poll(self, task_id: str, *, deadline: float, cancelled=None) -> bytes:
        """轮询任务结果（202=进行中）；返回 zip 字节。取消时 DELETE 任务后抛异常。"""
        if not task_id:
            raise MineruLocalError("本地 MinerU 服务未返回 task_id")
        path = f"/v1/tasks/{task_id}/result?response_format=zip"
        log.info("[mineru-local] 任务 %s：轮询结果（间隔 %.1fs）", task_id, self.poll_interval)
        while True:
            if cancelled is not None and cancelled():
                self.cancel_task(task_id)
                raise MineruCancelled(f"已取消（服务端任务 {task_id}）") from None
            if time.time() >= deadline:
                raise MineruLocalError(f"本地解析超时（{self.timeout}s，task={task_id}）")
            with contextlib.closing(self._request("GET", path, timeout=180)) as resp:
                blob = resp.read()
                if int(getattr(resp, "status", 200) or 200) == 202:
                    time.sleep(self.poll_interval)
                    continue
            if blob[:2] == b"PK":
                return blob
            raise MineruLocalError(f"任务 {task_id} 的结果不是 zip：{blob[:200]!r}")

    def cancel_task(self, task_id: str | None = None) -> bool:
        """尽力取消服务端任务（`DELETE /v1/tasks/{id}`）；失败只告警不抛异常。

        注意：MinerU 4.0.12 的本地推理线程不可中断——任务会被标记 canceled、本客户端
        立即停止等待，但 GPU 要等这次解析跑完才释放。
        """
        tid = task_id or self._task_id
        if not tid:
            return False
        try:
            with contextlib.closing(
                    self._request("DELETE", f"/v1/tasks/{tid}", timeout=30)) as resp:
                resp.read(1)
            log.info("[mineru-local] 已请求取消服务端任务 %s", tid)
            return True
        except MineruLocalError as e:
            log.warning("[mineru-local] 取消任务 %s 失败（忽略）：%s", tid, e)
            return False

    def _start_watchdog(self, task_id: str) -> None:
        """父进程退出（sidecar 被强杀）后由看门狗 DELETE 任务，避免 GPU 空占。"""
        if self._watchdog is not None and self._watchdog.poll() is None:
            return
        try:
            self._watchdog = subprocess.Popen(  # noqa: S603 - 固定本机脚本
                [sys.executable, "-c", _WATCHDOG_SCRIPT, self.base_url, task_id,
                 str(os.getpid())],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as e:
            log.warning("[mineru-local] 取消看门狗启动失败（忽略）：%s", e)
            self._watchdog = None

    def _stop_watchdog(self) -> None:
        p, self._watchdog = self._watchdog, None
        if p is not None and p.poll() is None:
            p.kill()

    # ---- 对 parse_pdf 暴露的接口 ----

    def parse(self, pdf: Path, work_dir: Path, pages=None, cancelled=None) -> dict:
        """上传 → 解析（服务端常驻模型）→ 轮询 zip 产物；形状与 CLI/云端一致。

        cancelled：可调用（返回 True=取消）——取消时 `DELETE /v1/tasks/{id}` 并抛
        `MineruCancelled`（服务端因推理线程不可中断，GPU 在本次解析结束后释放）。
        """
        pdf, work_dir = Path(pdf), Path(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        self._health()
        query: dict[str, str] = {
            "filename": pdf.name,
            "tier": self.tier,
            "output_formats": "zip",
        }
        # 刻意不带 sha256sum：服务端的上传去重命中时不读请求体就关闭连接，
        # Windows 下会因接收缓冲仍有未读数据而发 RST，客户端读响应可能被重置。
        # 去掉后服务端必然读完请求体（回环上传开销可忽略）。
        spec = page_spec(pages)
        if spec:
            query["page_range"] = spec
        data = pdf.read_bytes()
        path = "/v1/tasks?" + urllib.parse.urlencode(query)
        log.info("[mineru-local] HTTP %s（%s，%.1fMB，pages=%s）",
                 self.base_url + path.split("?", 1)[0], pdf.name, len(data) / 1e6,
                 spec or "all")
        with contextlib.closing(self._request(
                "POST", path, data=data,
                headers={"Content-Type": "application/octet-stream"},
                timeout=600)) as resp:
            status = int(getattr(resp, "status", 202) or 202)
            blob = resp.read()
        try:
            payload = json.loads(blob.decode("utf-8"))
        except ValueError as e:
            raise MineruLocalError(
                f"本地 MinerU 服务响应无法解析（HTTP {status}）：{blob[:200]!r}") from e
        task_id = str((payload or {}).get("task_id") or "")
        if not task_id:
            raise MineruLocalError(f"本地 MinerU 服务未返回 task_id：{str(payload)[:200]}")
        with self._task_lock:
            self._task_id = task_id
        self._start_watchdog(task_id)  # 客户端进程若被强杀，由看门狗取消任务
        try:
            blob = self._poll(task_id, deadline=t0 + self.timeout, cancelled=cancelled)
        finally:
            self._stop_watchdog()
            with self._task_lock:
                self._task_id = None
        if blob[:2] != b"PK":
            raise MineruLocalError(
                f"本地 MinerU 服务返回的非 zip 内容（HTTP {status}）：{blob[:200]!r}")
        out = work_dir / "out"
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{pdf.stem}.zip").write_bytes(blob)
        return self._assemble(work_dir, pdf, t0)


def make_mineru_client(source: str = "auto", *, token: str = "", model: str = "vlm",
                       tier: str | None = None, cmd: str | None = None,
                       url: str | None = None):
    """`--mineru-source auto|cloud|local` 路由。

    - `local`：配置了 `MINERU_LOCAL_URL`（或显式 url）走常驻服务，否则 CLI；
    - `auto`：LOCAL_URL > token（云端）> CLI；
    - 显式 `local` 不静默回退（不可用时由客户端给可操作报错）。
    """
    from pdf_tool.mineru.client import MineruClient, MineruError

    src = (source or _env("MINERU_SOURCE", "auto")).lower()
    if src not in ("auto", "cloud", "local"):
        raise MineruError(f"未知 --mineru-source {src}（可选 auto|cloud|local）")
    local = (url if url is not None else local_url()).strip()
    if src == "cloud":
        if not token:
            raise MineruError("--mineru-source cloud 需要 mineru token"
                              "（--mineru-token 或 MINERU_TOKEN / MINERU_API_KEY）")
        return MineruClient(token, model=model)
    if src == "local":
        if local:
            return MineruLocalHttpClient(base_url=local, tier=tier)
        return MineruLocalClient(tier=tier, cmd=cmd)
    if local:  # auto：显式配置了常驻服务地址 → 本地优先
        return MineruLocalHttpClient(base_url=local, tier=tier)
    if token:  # auto：云端优先
        return MineruClient(token, model=model)
    try:
        return MineruLocalClient(tier=tier, cmd=cmd)
    except MineruLocalError as e:
        raise MineruError(
            f"auto：无 token 且本地 MinerU 不可用（{e}）。"
            "请设置 MINERU_API_KEY 走云端，或安装本地 mineru 并设置 MINERU_LOCAL_CMD，"
            "或启动常驻服务并设置 MINERU_LOCAL_URL") from e

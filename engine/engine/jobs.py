"""作业模型:提交 → 排队 → 运行(带进度)→ 结果 / 失败 / 取消。

与应用的「任务队列」语义对齐(status / progress / label / cancel),应用侧只做轮询。
长任务(提取、转换、文字层)一律走作业;轻量同步接口(如 /v1/math)不进作业。
"""
from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

TERMINAL = {"done", "failed", "cancelled"}


@dataclass
class Job:
    id: str
    kind: str
    args: dict
    status: str = "queued"
    label: str = ""
    done: int = 0
    total: int = 0
    error: str = ""
    result: Any = None
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    finished_at: float = 0.0
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def public(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "label": self.label,
            "done": self.done,
            "total": self.total,
            "error": self.error,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
        }

    def cancelled(self) -> bool:
        return self.cancel_event.is_set()


class JobRegistry:
    """进程内作业表 + 小线程池。提取/转换类任务天然串行更好,默认 2 个工人。"""

    def __init__(self, workers: int = 2, history: int = 50) -> None:
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._history = max(1, int(history))
        self._pool = ThreadPoolExecutor(max_workers=max(1, int(workers)), thread_name_prefix="engine-job")
        self._lock = threading.Lock()

    def submit(self, kind: str, args: dict, runner: Callable[[Job], Any]) -> Job:
        job = Job(id=uuid.uuid4().hex[:16], kind=str(kind), args=dict(args or {}))
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._trim()
        self._pool.submit(self._run, job, runner)
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(str(job_id or ""))

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.status in TERMINAL:
            return False
        job.cancel_event.set()
        if job.status == "queued":
            # 还没开始跑:直接落终态(工人起来后会跳过)。
            job.status = "cancelled"
            job.finished_at = time.time()
        return True

    def _trim(self) -> None:
        while len(self._order) > self._history:
            oldest = self._order[0]
            job = self._jobs.get(oldest)
            if job is not None and job.status not in TERMINAL:
                break  # 还在跑,别丢
            self._order.pop(0)
            self._jobs.pop(oldest, None)

    def _run(self, job: Job, runner: Callable[[Job], Any]) -> None:
        if job.status == "cancelled":
            return
        job.status = "running"
        job.started_at = time.time()
        try:
            result = runner(job)
            if job.cancelled():
                job.status = "cancelled"
            else:
                job.status = "done"
                job.result = result
        except Exception as exc:  # noqa: BLE001 —— 作业失败就是失败,回给应用看
            job.status = "cancelled" if job.cancelled() else "failed"
            job.error = "" if job.cancelled() else str(exc)[:300]
        finally:
            job.finished_at = time.time()


def report_progress(job: Job, *, done: int | None = None, total: int | None = None, label: str = "") -> None:
    if done is not None:
        job.done = int(done)
    if total is not None:
        job.total = int(total)
    if label:
        job.label = str(label)

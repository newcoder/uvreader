"""HTTP 服务:能力清单 / 作业 / 轻量同步接口。

- 默认只绑 127.0.0.1;设了令牌就必须带 `Authorization: Bearer <token>`;
- `/v1/health` 上报 engine.json(版本 + 能力),应用据此判断「装了什么 / 要不要更新」;
- 长任务走 `/v1/jobs`(提交 → 轮询 → 取结果 / 取消),与应用的任务队列语义对齐。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import __version__
from .jobs import TERMINAL, JobRegistry
from .kinds import JOB_KINDS, render_math

STARTED_AT = time.time()


class JobRequest(BaseModel):
    kind: str
    args: dict = Field(default_factory=dict)


class MathRequest(BaseModel):
    latex: list[str] = Field(default_factory=list)


def load_manifest(path: str | os.PathLike[str] | None = None) -> dict:
    """engine.json(随包清单);读不到就给一份最小清单。"""
    candidates = [Path(path)] if path else []
    candidates.append(Path(__file__).with_name("engine.json"))
    for candidate in candidates:
        try:
            if candidate and candidate.exists():
                data = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
        except Exception:  # noqa: BLE001 —— 清单坏了不该拦住服务
            continue
    return {
        "schemaVersion": 1,
        "engineVersion": __version__,
        "platform": f"{os.sys.platform}-{os.uname().machine if hasattr(os, 'uname') else 'unknown'}",
        "capabilities": {},
    }


def create_app(*, token: str = "", manifest_path: str | None = None, workers: int = 2) -> FastAPI:
    app = FastAPI(title="UV Reader workshop engine", version=__version__)
    registry = JobRegistry(workers=workers)
    manifest = load_manifest(manifest_path)

    def require_token(authorization: str = Header(default="")) -> None:
        if not token:
            return  # 没设令牌(开发模式):放行
        expected = f"Bearer {token}"
        if authorization.strip() != expected:
            raise HTTPException(status_code=401, detail="令牌不对")

    @app.get("/v1/health", dependencies=[Depends(require_token)])
    def health() -> dict:
        capabilities = dict(manifest.get("capabilities") or {})
        capabilities["jobKinds"] = sorted(JOB_KINDS)
        return {
            "ok": True,
            "engineVersion": str(manifest.get("engineVersion") or __version__),
            "schemaVersion": int(manifest.get("schemaVersion") or 1),
            "platform": str(manifest.get("platform") or ""),
            "python": str(manifest.get("python", {}).get("version") if isinstance(manifest.get("python"), dict) else manifest.get("python") or ""),
            "packages": manifest.get("packages") or {},
            "capabilities": capabilities,
            "uptimeSeconds": round(time.time() - STARTED_AT, 1),
            "pid": os.getpid(),
        }

    @app.post("/v1/math", dependencies=[Depends(require_token)])
    def math(request: MathRequest) -> dict:
        return {"mathml": render_math(list(request.latex or []))}

    @app.post("/v1/jobs", dependencies=[Depends(require_token)])
    def submit(request: JobRequest) -> dict:
        runner = JOB_KINDS.get(str(request.kind or ""))
        if runner is None:
            raise HTTPException(status_code=400, detail=f"未知的作业类型:{request.kind or '(空)'}")
        job = registry.submit(request.kind, request.args, runner)
        return {"jobId": job.id}

    @app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_token)])
    def status(job_id: str) -> dict:
        job = registry.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="没有这个作业")
        return job.public()

    @app.get("/v1/jobs/{job_id}/result", dependencies=[Depends(require_token)])
    def result(job_id: str) -> dict:
        job = registry.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="没有这个作业")
        if job.status not in TERMINAL:
            raise HTTPException(status_code=409, detail="作业还没结束")
        return {"ok": job.status == "done", "status": job.status, "error": job.error, "result": job.result}

    @app.delete("/v1/jobs/{job_id}", dependencies=[Depends(require_token)])
    def cancel(job_id: str) -> dict:
        return {"cancelled": registry.cancel(job_id)}

    return app

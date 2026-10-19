"""HTTP 服务:能力清单 / 配置 / 作业 / 轻量同步接口。

- 默认只绑 127.0.0.1;设了令牌就必须带 `Authorization: Bearer <token>`;
- `/v1/health` 上报**活的能力检测**(引擎自己探环境,应用不再逐个探测;`?refresh=1` 强制重探);
- `/v1/config` 读写引擎自己的配置(路径 / 凭据 / 并发)—— 配置的单一来源在引擎;
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
from .capabilities import detected_config, probe_all, reset_cache, summarize
from .config import DEFAULTS, SECRET_KEYS, load_config, public_config, save_config
from .jobs import TERMINAL, JobRegistry
from .kinds import JOB_KINDS, render_math

STARTED_AT = time.time()


class JobRequest(BaseModel):
    kind: str
    args: dict = Field(default_factory=dict)


class MathRequest(BaseModel):
    latex: list[str] = Field(default_factory=list)


class ConfigPatch(BaseModel):
    patch: dict = Field(default_factory=dict)


def load_manifest(path: str | os.PathLike[str] | None = None) -> dict:
    """engine.json(随包清单:构建时写死版本与打包内容)。

    打包版在**包根**(`<bundle>/engine.json`,由 scripts/build-engine.mjs 写;engine 包在 `<bundle>/engine/`),
    开发态在 `engine/engine.json`(dev 清单,版本停在开发号)。
    **包根优先** —— 否则打包版会读到包内那份 dev 清单,`/v1/health` 就会报出过期的版本与 "dev" 平台。
    读不到就给一份最小清单。
    """
    candidates = [Path(path)] if path else []
    candidates.append(Path(__file__).resolve().parents[1] / "engine.json")  # 包根(打包版)
    candidates.append(Path(__file__).with_name("engine.json"))  # engine/engine.json(开发态)
    for candidate in candidates:
        try:
            if candidate and candidate.exists():
                data = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(data, dict) and str(data.get("platform") or "") != "dev":
                    return data
        except Exception:  # noqa: BLE001 —— 清单坏了不该拦住服务
            continue
    return {"schemaVersion": 1, "engineVersion": __version__, "platform": "", "packages": {}, "pdfTool": {"commit": ""}}


def create_app(*, token: str = "", manifest_path: str | None = None, workers: int | None = None) -> FastAPI:
    app = FastAPI(title="UV Reader workshop engine", version=__version__)
    manifest = load_manifest(manifest_path)
    config = load_config()
    registry = JobRegistry(workers=int(workers or config.get("workers") or 2))

    def require_token(authorization: str = Header(default="")) -> None:
        if not token:
            return  # 没设令牌(开发模式):放行
        if authorization.strip() != f"Bearer {token}":
            raise HTTPException(status_code=401, detail="令牌不对")

    @app.get("/v1/health", dependencies=[Depends(require_token)])
    def health(refresh: int = 0) -> dict:
        capabilities = probe_all(config, force=bool(refresh))
        return {
            "ok": True,
            "engineVersion": str(manifest.get("engineVersion") or __version__),
            "schemaVersion": int(manifest.get("schemaVersion") or 1),
            "platform": str(manifest.get("platform") or ""),
            "packages": manifest.get("packages") or {},
            "pdfTool": manifest.get("pdfTool") or {},
            "capabilities": {**capabilities, "jobKinds": sorted(JOB_KINDS)},
            "uptimeSeconds": round(time.time() - STARTED_AT, 1),
            "pid": os.getpid(),
        }

    @app.get("/v1/config", dependencies=[Depends(require_token)])
    def read_config() -> dict:
        # defaults + detected:界面拿它们当「缺省/占位」—— 填了用填的,没填就用探测到的,
        # 探测不到的留空(别把一张猜出来的路径写回配置)。
        return {
            "config": public_config(config),
            "defaults": {key: value for key, value in DEFAULTS.items() if key not in SECRET_KEYS},
            "detected": detected_config(config),
            "path": str(Path(config_path_for_display())),
        }

    @app.patch("/v1/config", dependencies=[Depends(require_token)])
    def patch_config(request: ConfigPatch) -> dict:
        nonlocal config
        patch = dict(request.patch or {})
        # 令牌留空 = 不改(面板里「已保存;留空不修改」的语义)。
        if not str(patch.get("mineruToken") or "").strip():
            patch.pop("mineruToken", None)
        config = save_config(patch)
        reset_cache()
        return {"config": public_config(config), "capabilities": probe_all(config, force=True)}

    @app.post("/v1/math", dependencies=[Depends(require_token)])
    def math(request: MathRequest) -> dict:
        return {"mathml": render_math(list(request.latex or []))}

    @app.get("/v1/jobs", dependencies=[Depends(require_token)])
    def list_jobs(limit: int = 20) -> dict:
        """最近的作业(新的在前):手工验证「这次是引擎干的」就看这里。"""
        return {"jobs": registry.recent(limit)}

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

    @app.get("/v1/log", dependencies=[Depends(require_token)])
    def log_summary() -> dict:
        return {"capabilities": summarize(probe_all(config)), "configPath": str(Path(config_path_for_display()))}

    return app


def config_path_for_display() -> str:
    from .config import config_path

    return str(config_path())

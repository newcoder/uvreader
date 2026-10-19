"""CLI:`python -m engine serve --port 8760 [--token …] [--host 127.0.0.1]`

单独部署时(服务器 / NAS / 带 GPU 的机器)也一样:起服务、给应用 URL 与令牌即可。
"""
from __future__ import annotations

import argparse

from . import __version__


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="engine", description="UV Reader 书坊引擎(本地 HTTP 服务)")
    parser.add_argument("--version", action="version", version=f"workshop engine {__version__}")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="启动服务")
    serve.add_argument("--host", default="127.0.0.1", help="监听地址(默认只本机)")
    serve.add_argument("--port", type=int, default=8760)
    serve.add_argument("--token", default="", help="Bearer 令牌;留空=不鉴权(仅开发)")
    serve.add_argument("--manifest", default="", help="engine.json 路径(默认随包)")
    serve.add_argument("--workers", type=int, default=2, help="同时运行的作业数")

    args = parser.parse_args(argv)
    if args.command != "serve":
        parser.print_help()
        return 0

    import logging

    import uvicorn

    from .server import create_app

    # 作业日志(engine.jobs)要能看见:root 先配好;uvicorn 的 dictConfig 不会把它拆掉。
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    app = create_app(token=args.token, manifest_path=args.manifest or None, workers=args.workers)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

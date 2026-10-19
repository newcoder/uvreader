"""python -m pdf_tool.reader：启动阅读器 sidecar（行 JSON-RPC over stdio）。"""
from pdf_tool.reader.server import main

if __name__ == "__main__":
    raise SystemExit(main())

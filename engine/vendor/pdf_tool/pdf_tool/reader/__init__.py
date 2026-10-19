"""阅读器 sidecar：行分隔 JSON-RPC over stdio（Electron/桌面端集成入口）。

约定与 `deepseek_tool/server.py` 一致：stdin 一行一个请求，stdout 一行一个响应
（或服务端 notification）；日志走 stderr，保 stdout 纯 JSON。
"""

"""书坊引擎:把书坊的后台能力做成可独立部署的本地 HTTP 服务。

设计要点(见 docs/workshop-engine-plan.md):
- 独立进程 / 独立部署:应用只通过 HTTP 调用,界面与功能解耦;
- 默认只绑 127.0.0.1,带 Bearer 令牌(安装时生成);
- 长任务一律走「作业」(提交 → 轮询进度 → 取结果 / 取消);
- 能力清单从 engine.json 读出来经 /v1/health 上报(应用据此判断装了什么)。
"""

__version__ = "0.1.5"

# 可选组件(components/)装在自己的目录里,这里挂到 sys.path 上:
# 引擎自己的代码与子进程(python -c …)都能 import 到它。
from .components import ensure_components_on_path  # noqa: E402

ensure_components_on_path()

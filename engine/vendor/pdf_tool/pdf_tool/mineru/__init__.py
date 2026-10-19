"""MinerU 集成：云端 API 客户端（client）/ 本地后端（local）/ 产物解析。"""

from __future__ import annotations


class MineruCancelled(RuntimeError):
    """解析被调用方取消（用户/宿主进程发起）。

    与「失败」区分：本地 CLI 会杀掉子进程，常驻服务会请求 `DELETE /v1/tasks/{id}`
    （服务端标记 canceled；注意 MinerU 4.0.12 的本地推理线程不可中断，GPU 会在
    本次解析跑完后释放）。reader sidecar 据此把任务标记为 `cancelled` 而非 `error`。
    """


def page_spec(pages) -> str:
    """页码列表 → MinerU `--pages` 语法：`[1,2,3,8]` → `'1-3,8'`；空输入返回 `''`。"""
    nums = sorted({int(p) for p in pages or [] if int(p) > 0})
    parts: list[str] = []
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        parts.append(str(nums[i]) if i == j else f"{nums[i]}-{nums[j]}")
        i = j + 1
    return ",".join(parts)

#!/usr/bin/env python3
"""本地 Ollama 文本客户端：与 VisionClient 同 extract_json 接口（走 OpenAI 兼容端点）。

用于「合并文本 → LLM 重新切分」等纯文本任务（如 glm-4.7-flash），不消耗云端 API 费用。
"""
from __future__ import annotations

import logging
import time

from pdf_tool.llm.json_repair import robust_parse

log = logging.getLogger("qb.ollama")

DEFAULT_BASE_URL = "http://localhost:11434/v1"
DEFAULT_MODEL = "glm-4.7-flash"


class OllamaTextClient:
    """Ollama（OpenAI 兼容）文本客户端；`images` 必须为空（纯文本模型）。"""

    def __init__(self, model: str = DEFAULT_MODEL, base_url: str = DEFAULT_BASE_URL,
                 timeout: float = 900.0):
        from openai import OpenAI

        self.model = model
        self.usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}
        self._client = OpenAI(base_url=base_url, api_key="ollama", timeout=timeout)

    def extract_json(self, prompt: str, images: list, *, tag: str,
                     max_tokens: int = 8000, retries: int = 2,
                     required_keys: tuple[str, ...] = ()) -> tuple[dict, dict]:
        if images:
            raise ValueError("OllamaTextClient 只支持纯文本（images 必须为空）")
        last_err: Exception | None = None
        for attempt in range(retries + 1):
            try:
                resp = self._client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=max_tokens, temperature=0,
                )
                body = (resp.choices[0].message.content or "").strip()
                usage = resp.usage.model_dump() if resp.usage else {}
                self.usage["calls"] += 1
                self.usage["prompt_tokens"] += usage.get("prompt_tokens", 0)
                self.usage["completion_tokens"] += usage.get("completion_tokens", 0)
                if not body:
                    raise ValueError("空响应")  # noqa: TRY301
                data = robust_parse(body)
                missing = [k for k in required_keys
                           if not isinstance(data, dict) or k not in data]
                if missing:
                    raise ValueError(f"响应缺少必需键 {missing}")  # noqa: TRY301
                log.info("[ollama] %s ok: chars=%d", tag, len(body))
                return data, usage
            except Exception as e:
                last_err = e
                log.warning("[ollama] %s attempt %d/%d failed: %s", tag, attempt + 1,
                            retries + 1, e)
                if attempt < retries:
                    time.sleep(2.0 * (attempt + 1))
        raise RuntimeError(f"Ollama 调用失败（{tag}）: {last_err}")

    def usage_report(self) -> str:
        u = self.usage
        return (f"ollama 用量: {u['calls']} 次调用, {u['prompt_tokens']} in / "
                f"{u['completion_tokens']} out tokens（本地推理，无费用）")

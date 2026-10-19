#!/usr/bin/env python3
"""DeepSeek 视觉模型 API 封装（pdf_tool vision 抽取路径）。

- OpenAI 兼容端点，关闭思考模式（视觉任务下 thinking 会吞输出预算）
- 空内容 / 坏 JSON / 超时自动重试（指数退避）
- JSON 解析复用 pdf_to_questions.robust_parse（截断/转义/引号修复）
- tokens 与费用估算记账
"""
from __future__ import annotations

import base64
import io
import logging
import os
import time

from PIL import Image

from pdf_tool.llm.json_repair import robust_parse

log = logging.getLogger("qb.vision")

# 官方价（元/百万 tokens，高峰档）：缓存未命中输入 / 输出
_PRICE_IN = 3.0
_PRICE_OUT = 9.0


class VisionClient:
    def __init__(self, model: str = "deepseek-flash",
                 api_key: str | None = None, timeout: float = 120.0, client=None):
        self.model = model
        self.usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}
        if client is not None:
            self._client = client
            return
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "")
        if not self.api_key:
            raise RuntimeError("DEEPSEEK_API_KEY 未设置：请导出环境变量后重试")
        from openai import OpenAI
        self._client = OpenAI(api_key=self.api_key,
                              base_url="https://api.deepseek.com", timeout=timeout)

    @staticmethod
    def _data_uri(image: Image.Image) -> str:
        buf = io.BytesIO()
        image.save(buf, "PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    def _call_once(self, prompt: str, images: list[Image.Image],
                   max_tokens: int) -> tuple[str, dict]:
        content: list[dict] = [{"type": "text", "text": prompt}]
        for im in images:
            content.append({"type": "image_url",
                            "image_url": {"url": self._data_uri(im), "detail": "original"}})
        resp = self._client.chat.completions.create(
            model=self.model, messages=[{"role": "user", "content": content}],
            response_format={"type": "json_object"}, max_tokens=max_tokens,
            temperature=0,  # 确定性：同一输入尽量给同一结果
            extra_body={"thinking": {"type": "disabled"}},
        )
        usage = resp.usage.model_dump() if resp.usage else {}
        return (resp.choices[0].message.content or ""), usage

    def extract_json(self, prompt: str, images: list[Image.Image], *, tag: str,
                     max_tokens: int = 8000, retries: int = 2,
                     required_keys: tuple[str, ...] = ()) -> tuple[dict, dict]:
        """调用并解析；空内容/坏 JSON/缺必需键自动重试。返回 (JSON, 本次 usage)。"""
        last_err: Exception | None = None
        for attempt in range(retries + 1):
            try:
                body, usage = self._call_once(prompt, images, max_tokens)
                self.usage["calls"] += 1
                self.usage["prompt_tokens"] += usage.get("prompt_tokens", 0)
                self.usage["completion_tokens"] += usage.get("completion_tokens", 0)
                if not body.strip():
                    # 空内容需走统一重试路径，故刻意在 try 内抛出
                    raise ValueError("empty content（json_object 模式已知问题）")  # noqa: TRY301
                data = robust_parse(body)
                # 契约不符同样重试：json_object 模式偶发只回 {} 或只回别的键，
                # 解析成功但缺 questions，早退会让整页静默丢失（页丢失主因）
                missing = [k for k in required_keys
                           if not isinstance(data, dict) or k not in data]
                if missing:
                    raise ValueError(  # noqa: TRY301
                        f"响应缺少必需键 {missing}（json_object 模式退化输出）")
                log.info("[vision] %s ok: in=%s out=%s", tag,
                         usage.get("prompt_tokens"), usage.get("completion_tokens"))
                return data, usage
            except Exception as e:  # 统一重试语义
                last_err = e
                log.warning("[vision] %s attempt %d/%d failed: %s",
                            tag, attempt + 1, retries + 1, e)
                if attempt < retries:
                    time.sleep(1.0 * (2 ** attempt))
        raise RuntimeError(f"vision 调用失败（{tag}，重试 {retries} 次后）: {last_err}")

    def usage_report(self) -> str:
        cost = (self.usage["prompt_tokens"] / 1e6 * _PRICE_IN
                + self.usage["completion_tokens"] / 1e6 * _PRICE_OUT)
        return (f"vision 用量: {self.usage['calls']} 次调用, "
                f"{self.usage['prompt_tokens']} in / {self.usage['completion_tokens']} out tokens, "
                f"约 ¥{cost:.2f}（高峰价估算）")

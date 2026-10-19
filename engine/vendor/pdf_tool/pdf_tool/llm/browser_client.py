#!/usr/bin/env python3
"""浏览器版视觉客户端：与 VisionClient 同接口，用 deepseek_tool 驱动真实浏览器替代 API。

- `extract_json(prompt, images, ...)` 与 `VisionClient` 完全一致，可直接替换进 box/doc 管线；
- 页面图写临时 JPEG（超预算自动降质/缩放）→ 一次上传全部 → `submit(structured=True)`
  （自动续写 + 标记提取）→ `robust_parse`；
- 大文件友好：超时按页数自动放大（`timeout_per_page`），可用 `timeout` 覆盖；
- 容错：失败自动重试，会话异常/连续失败时重建浏览器会话；
- 走网页会话，无 API token 计费；`usage_report()` 报告调用次数与上传量。
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from PIL import Image

from pdf_tool.core.paths import BROWSER_UPLOAD_DIR
from pdf_tool.llm.json_repair import robust_parse

log = logging.getLogger("qb.browser")

UPLOAD_DIR = BROWSER_UPLOAD_DIR

# 网页返回的典型故障文案（解析失败时用于判定「浏览器/站点故障」而非模型输出问题）
BROWSER_ERROR_MARKERS = (
    "服务器繁忙", "服务繁忙", "服务异常", "网络异常", "请求失败", "生成失败",
    "上传失败", "文件过大", "不支持的文件", "请稍后重试", "系统繁忙",
)


def compute_timeout(pages: int, timeout: int | None = None, *,
                    per_page: int = 90, min_timeout: int = 600,
                    max_timeout: int = 3600) -> int:
    """单次等待上限：显式 timeout 优先；否则按页数放大（90s/页，600~3600s）。"""
    if timeout:
        return max(60, min(int(timeout), max_timeout))
    return max(min_timeout, min(per_page * max(int(pages), 1), max_timeout))


def looks_like_browser_error(text: str) -> bool:
    """页面/响应文本是否包含站点故障文案。"""
    return any(k in str(text or "") for k in BROWSER_ERROR_MARKERS)


def next_compression(total_bytes: float, max_mb: float,
                     quality: int, scale: float) -> tuple[int, float]:
    """超预算时给出下一档 (quality, scale)；已达标则原样返回。"""
    if total_bytes <= max_mb * 1024 * 1024:
        return quality, scale
    quality -= 15
    if quality < 60:
        quality = 75
        scale = max(0.5, round(scale * 0.8, 2))
    return quality, scale


class BrowserVisionClient:
    """deepseek_tool 浏览器客户端（VisionClient 同接口）。"""

    def __init__(self, timeout: int | None = None, *, timeout_per_page: int = 90,
                 min_timeout: int = 600, max_timeout: int = 3600,
                 retries: int = 2, max_upload_mb: float = 45.0):
        self.timeout = timeout
        self.timeout_per_page = timeout_per_page
        self.min_timeout = min_timeout
        self.max_timeout = max_timeout
        self.retries = retries
        self.max_upload_mb = max_upload_mb
        self.usage = {"calls": 0, "attempts": 0, "upload_mb": 0.0, "seconds": 0.0}
        self._session = None

    # ---- VisionClient 兼容接口 ----

    def extract_json(self, prompt: str, images: list[Image.Image], *, tag: str,
                     max_tokens: int = 8000, retries: int | None = None,
                     required_keys: tuple[str, ...] = ("blocks",)) -> tuple[dict, dict]:
        """上传页面图并提交 prompt；返回 (JSON, usage)。"""
        n_retries = self.retries if retries is None else retries
        wait = compute_timeout(len(images), self.timeout,
                               per_page=self.timeout_per_page,
                               min_timeout=self.min_timeout, max_timeout=self.max_timeout)
        last_err: Exception | None = None
        t0 = time.time()
        for attempt in range(n_retries + 1):
            self.usage["attempts"] += 1
            try:
                session = self._ensure_session()
                paths, total_mb, quality, scale = self._dump_images(images, tag)
                log.info("[browser] %s 上传 %d 张页面图 (%.1fMB, q%d, scale=%.2f)，"
                         "等待上限 %ds", tag, len(paths), total_mb, quality, scale, wait)
                session.dispatch("upload_file", {"file_paths": paths})
                r = session.dispatch("submit", {
                    "prompt": prompt, "timeout": wait, "structured": True,
                })
                self.usage["calls"] += 1
                self.usage["upload_mb"] += total_mb
                data = self._handle_response(r, required_keys, tag)
                self.usage["seconds"] += time.time() - t0
                return data, {"prompt_tokens": 0, "completion_tokens": 0}
            except Exception as e:  # 统一重试语义
                last_err = e
                log.warning("[browser] %s attempt %d/%d failed: %s",
                            tag, attempt + 1, n_retries + 1, e)
                if attempt < n_retries:
                    self._recover(force=attempt >= 1)
                    time.sleep(3.0 * (attempt + 1))
        self.usage["seconds"] += time.time() - t0
        raise RuntimeError(f"browser 调用失败（{tag}，重试 {n_retries} 次后）: {last_err}")

    def extract_json_pdf(self, prompt: str, pdf_path: Path, *, tag: str,
                         timeout: int | None = None, retries: int | None = None,
                         required_keys: tuple[str, ...] = ("blocks",),
                         fresh_session: bool = True) -> tuple[dict, dict]:
        """整份 PDF 直传抽取（不逐页转图）；默认每卷开新会话，避免长会话退化。"""
        n_retries = self.retries if retries is None else retries
        wait = compute_timeout(0, timeout, min_timeout=self.min_timeout,
                               max_timeout=self.max_timeout)
        last_err: Exception | None = None
        t0 = time.time()
        for attempt in range(n_retries + 1):
            self.usage["attempts"] += 1
            try:
                if fresh_session:
                    session = self.new_session()
                    session.dispatch("new_chat", {})
                else:
                    session = self._ensure_session()
                    session.dispatch("new_chat", {})
                mb = pdf_path.stat().st_size / 1024 / 1024
                log.info("[browser] %s 上传 PDF %s (%.2fMB)，等待上限 %ds",
                         tag, pdf_path.name, mb, wait)
                session.dispatch("upload_file", {"file_path": str(pdf_path)})
                r = session.dispatch("submit", {
                    "prompt": prompt, "timeout": wait, "structured": True,
                })
                self.usage["calls"] += 1
                self.usage["upload_mb"] += mb
                data = self._handle_response(r, required_keys, tag)
                self.usage["seconds"] += time.time() - t0
                return data, {"prompt_tokens": 0, "completion_tokens": 0}
            except Exception as e:  # 统一重试语义
                last_err = e
                log.warning("[browser] %s attempt %d/%d failed: %s",
                            tag, attempt + 1, n_retries + 1, e)
                if attempt < n_retries:
                    self.close()  # PDF 路径失败一律重建会话
                    time.sleep(3.0 * (attempt + 1))
        self.usage["seconds"] += time.time() - t0
        raise RuntimeError(f"browser 调用失败（{tag}，重试 {n_retries} 次后）: {last_err}")

    def _handle_response(self, r: dict, required_keys: tuple[str, ...], tag: str) -> dict:
        """校验并解析 submit 响应；失败抛异常走统一重试。"""
        body = (r.get("response") or "").strip()
        if not body:
            # 空内容需走统一重试路径，故刻意在 try 内抛出
            raise ValueError("空响应（浏览器返回空内容）")
        if not r.get("completed") and len(body) < 500 and looks_like_browser_error(body):
            raise ValueError(f"站点故障文案: {body[:120]}")
        data = robust_parse(body)
        missing = [k for k in required_keys if not isinstance(data, dict) or k not in data]
        if missing:
            hint = "（疑似站点故障）" if looks_like_browser_error(body) else ""
            raise ValueError(f"响应缺少必需键 {missing}{hint}")
        log.info("[browser] %s ok: chars=%s complete=%s", tag, len(body), r.get("completed"))
        return data

    def new_session(self):
        """关闭当前会话并新建（分卷处理时避免长会话拖慢/阻塞）。"""
        self.close()
        return self._ensure_session()

    def usage_report(self) -> str:
        u = self.usage
        return (f"browser 用量: {u['calls']} 次调用 / {u['attempts']} 次尝试, "
                f"上传 {u['upload_mb']:.1f}MB, 耗时 {u['seconds']:.0f}s"
                f"（网页会话，无 API 费用）")

    # ---- 内部 ----

    def _ensure_session(self):
        if self._session is not None:
            return self._session
        from deepseek_tool.browser import BrowserSession
        from deepseek_tool.config import get_config

        session = BrowserSession(get_config())
        session.dispatch("init", {})
        session.dispatch("login", {})
        self._session = session
        return session

    def _recover(self, *, force: bool = False) -> None:
        """失败后恢复：健康检查通过且非强制时保留会话，否则重建。"""
        if self._session is None:
            return
        if not force:
            try:
                if self._session.dispatch("health_check", {}).get("healthy"):
                    return
            except Exception:
                pass
        log.warning("[browser] 重建浏览器会话（force=%s）", force)
        self.close()

    def _dump_images(self, images: list[Image.Image], tag: str,
                     ) -> tuple[list[str], float, int, float]:
        """写临时 JPEG；超出上传预算时迭代降质/缩放。返回 (paths, MB, quality, scale)。"""
        d = UPLOAD_DIR / tag
        d.mkdir(parents=True, exist_ok=True)
        quality, scale = 90, 1.0
        paths: list[str] = []
        total_mb = 0.0
        for _ in range(4):
            paths, total = [], 0
            for i, im in enumerate(images):
                p = d / f"page_{i + 1:02d}.jpg"
                img = im.convert("RGB")
                if scale < 1.0:
                    img = img.resize(
                        (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                        Image.LANCZOS)
                img.save(p, "JPEG", quality=quality)
                total += p.stat().st_size
                paths.append(str(p))
            total_mb = total / 1024 / 1024
            nq, ns = next_compression(total, self.max_upload_mb, quality, scale)
            if (nq, ns) == (quality, scale):
                break
            log.info("[browser] 上传体积 %.1fMB 超预算 %.0fMB，降档 q%d→q%d scale %.2f→%.2f",
                     total_mb, self.max_upload_mb, quality, nq, scale, ns)
            quality, scale = nq, ns
        return paths, total_mb, quality, scale

    def close(self) -> None:
        if self._session is not None:
            try:
                self._session.dispatch("close", {})
            except Exception as e:
                log.warning("browser close: %s", e)
            self._session = None

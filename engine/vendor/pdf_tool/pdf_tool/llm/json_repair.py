#!/usr/bin/env python3
"""JSON 容错解析：围栏剥离 / 截断检测 / 非法转义修复 / ASCII 引号修复。

从 `pdf_to_questions.py` 抽出，作为 vision 路径唯一的响应解析入口
（`vision_client.py` 复用）。行为与原实现逐字一致。
"""
from __future__ import annotations

import json
import logging
import re

log = logging.getLogger("qb")


def robust_parse(content: str) -> dict:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
    end = content.rfind("}")
    start = content.find("{")
    if start < 0 or end < start:
        raise ValueError("no JSON object found in response")
    body = content[start:end + 1]

    def _truncated() -> bool:
        return "继续生成" in content[-150:] or content.count("{") != content.count("}")

    try:
        return json.loads(body, strict=False)
    except json.JSONDecodeError as e:
        if _truncated():
            raise RuntimeError("response truncated (DeepSeek 输出被截断), retrying") from e
        if "escape" in e.msg:
            log.warning("fixing invalid backslash escapes (%s)", e.msg)

            def _fix_illegal(s: str) -> str:
                # 只双写“非法转义”（如 \m \D 的 LaTeX 命令反斜杠），
                # 保留合法转义（\n \u \" 等）交给 json 正常解析
                out: list[str] = []
                i = 0
                while i < len(s):
                    ch = s[i]
                    if ch == "\\" and i + 1 < len(s) and s[i + 1] not in 'nrtbf"\\/u01234567':
                        out.append("\\\\")
                        i += 1
                        continue
                    out.append(ch)
                    i += 1
                return "".join(out)

            fixed = _fix_illegal(body)
            try:
                return json.loads(fixed, strict=False)
            except json.JSONDecodeError:
                pass
        else:
            fixed = body
        # 模型把文本里的中文引号写成了 ASCII 引号（如 二、"重石头"元素），
        # 状态机修复：字符串内部遇到 " 且其后紧跟中文时视为文本引号
        log.warning("fixing ASCII quotes inside Chinese text (%s)", e.msg)

        def _is_cjk(ch: str) -> bool:
            cp = ord(ch)
            return 0x4E00 <= cp <= 0x9FFF or 0x3000 <= cp <= 0x303F or cp in (0x2014, 0x2026)

        def _fix_quotes(s: str) -> str:
            out: list[str] = []
            in_str = False
            esc = False
            quote_no = 0
            i = 0
            n = len(s)
            while i < n:
                ch = s[i]
                if esc:
                    out.append(ch)
                    esc = False
                    i += 1
                    continue
                if ch == "\\":
                    out.append(ch)
                    esc = True
                    i += 1
                    continue
                if ch != '"':
                    out.append(ch)
                    i += 1
                    continue
                if not in_str:
                    in_str = True
                    out.append(ch)
                    i += 1
                    continue
                j = i + 1
                while j < n and s[j].isspace():
                    j += 1
                if j < n and _is_cjk(s[j]):
                    quote_no += 1
                    out.append("“" if quote_no % 2 == 1 else "”")
                    i += 1
                    continue
                in_str = False
                out.append(ch)
                i += 1
            return "".join(out)

        return json.loads(_fix_quotes(fixed), strict=False)

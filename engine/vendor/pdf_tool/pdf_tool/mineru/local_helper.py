#!/usr/bin/env python3
"""本地 MinerU 适配 helper：把 4.x `middle_json` 渲染成现有解析器消费的 content_list V1。

**在本地 MinerU 环境（venv）里执行**，由 `MineruLocalClient` 调用：

    python local_helper.py --middle <middle_json.json> --out <dir> [--markdown]

产出：
    <dir>/content_list.json   ← `RenderFormat.CONTENT_LIST`（与云端 content_list 同 schema，
                                现有 `content_list_to_blocks` 零改动）
    <dir>/full.md             ← `--markdown` 时渲染（zip 缺 md 的兜底）

stdout 打一行 JSON 状态（`{"ok": true, "items": N}` / `{"ok": false, "error": ...}`）；
失败非零退出。该脚本是唯一依赖 MinerU Python API 的地方，API 漂移时只改这里。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="MinerU middle_json → content_list V1")
    ap.add_argument("--middle", required=True, help="middle_json.json 路径")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--markdown", action="store_true", help="同时渲染 full.md")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    try:
        from docvortex.schema import MiddleJson
        from mineru.render import RenderFormat, render
    except Exception as e:  # 明确区分「环境不对」与「渲染失败」
        print(json.dumps({"ok": False, "error":
                          f"import mineru.render/docvortex 失败（需在本地 MinerU 环境运行）: {e}"},
                         ensure_ascii=False))
        return 2
    try:
        middle = json.loads(Path(args.middle).read_text(encoding="utf-8"))
        # 4.x 的 middle_json 是 docvortex.middle v2：先载入为 MiddleJson 对象再渲染
        obj = (MiddleJson.model_validate(middle)
               if hasattr(MiddleJson, "model_validate") else MiddleJson(**middle))
        cl = render(obj, RenderFormat.CONTENT_LIST)
        (out / "content_list.json").write_text(
            json.dumps(cl, ensure_ascii=False, indent=2), encoding="utf-8")
        n = len(cl) if isinstance(cl, list) else 0
        if args.markdown:
            md = render(obj, RenderFormat.MARKDOWN)
            (out / "full.md").write_text(
                md if isinstance(md, str) else json.dumps(md, ensure_ascii=False),
                encoding="utf-8")
        print(json.dumps({"ok": True, "items": n}, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"},
                         ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

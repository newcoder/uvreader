"""pdf_tool 公用 JSON IO。"""
from __future__ import annotations

import json
from pathlib import Path


def load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path: Path, obj) -> None:
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def fingerprint(path: Path, chunk: int = 1 << 20) -> str:
    """???????size + ?/?? 1MB ? sha1????????????"""
    import hashlib

    src = Path(path)
    size = src.stat().st_size
    h = hashlib.sha1(str(size).encode(), usedforsecurity=False)
    with src.open("rb") as f:
        h.update(f.read(chunk))
        if size > chunk:
            f.seek(-min(chunk, size), 2)
            h.update(f.read())
    return f"sha1-{h.hexdigest()[:20]}"  # Windows ?????? ":"

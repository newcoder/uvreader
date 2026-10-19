"""引擎自己的测试:契约、鉴权、配置、能力、作业。

从仓库根跑:`python -m pytest engine/tests -q`(需要 engine/requirements-dev.txt 里的 pytest + httpx)。
这些测试进 CI 的 engine 作业;应用侧的单测只覆盖客户端。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from engine.server import create_app  # noqa: E402

AUTH = {"Authorization": "Bearer t0ken"}
FORMULA = "\\mathbb { } _ {j} \\lesssim \\varepsilon ^ { - (d - 1)}"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ENGINE_CONFIG", str(tmp_path / "config.json"))
    app = create_app(token="t0ken")
    return TestClient(app)


def make_pdf(path: Path, *, toc=None, pages: int = 2) -> Path:
    import fitz

    doc = fitz.open()
    for index in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"page {index + 1} text")
    if toc:
        doc.set_toc(toc)
    doc.save(str(path))
    doc.close()
    return path


def submit(client: TestClient, kind: str, args: dict) -> str:
    response = client.post("/v1/jobs", headers=AUTH, json={"kind": kind, "args": args})
    assert response.status_code == 200, response.text
    return response.json()["jobId"]


def wait_for(client: TestClient, job_id: str, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(f"/v1/jobs/{job_id}", headers=AUTH)
        assert response.status_code == 200
        job = response.json()
        if job["status"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError(f"作业没结束:{job_id}")


def test_health_requires_the_token(client):
    assert client.get("/v1/health").status_code == 401
    body = client.get("/v1/health", headers=AUTH).json()
    assert body["ok"] is True
    assert body["engineVersion"]
    capabilities = body["capabilities"]
    assert capabilities["python"]["ok"] is True
    assert "text-layer" in capabilities["jobKinds"]
    assert "outline" in capabilities["jobKinds"]
    assert "images-to-pdf" in capabilities["jobKinds"]
    assert "detail" in capabilities["pdfTool"], "能力项给 {ok, detail}"


def test_math_renders_and_repairs_empty_shells(client):
    response = client.post("/v1/math", headers=AUTH, json={"latex": ["x^2 + y^2 = z^2", FORMULA, "\\begin{array}{c} a \\\\ b \\end{array}\\tag{1.1}"]})
    assert response.status_code == 200
    mathml = response.json()["mathml"]
    assert "<math" in mathml["x^2 + y^2 = z^2"]
    assert "<math" in mathml[FORMULA], "空壳 \\mathbb { } 走修复路径也要出 MathML"
    assert "<math" in mathml["\\begin{array}{c} a \\\\ b \\end{array}\\tag{1.1}"]


def test_config_round_trip_masks_the_token(client, tmp_path):
    read = client.get("/v1/config", headers=AUTH).json()
    assert read["config"]["hasMineruToken"] is False
    assert read["path"].endswith("config.json")

    saved = client.patch("/v1/config", headers=AUTH, json={
        "patch": {"calibrePath": "C:/nope/ebook-convert.exe", "mineruToken": "secret-token", "unknown": "ignored"},
    }).json()
    assert saved["config"]["mineruToken"] == "", "不回显原值"
    assert saved["config"]["hasMineruToken"] is True
    assert saved["config"]["calibrePath"] == "C:/nope/ebook-convert.exe"
    assert "unknown" not in saved["config"], "未知字段忽略"
    assert saved["capabilities"]["calibre"]["ok"] is False, "路径不存在就是不可用"

    # 令牌留空 = 不改(面板「已保存;留空不修改」的语义)
    client.patch("/v1/config", headers=AUTH, json={"patch": {"mineruToken": ""}})
    disk = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert disk["mineruToken"] == "secret-token"


def test_text_layer_job_reports_progress(client, tmp_path):
    pdf = make_pdf(tmp_path / "tiny.pdf")
    job_id = submit(client, "text-layer", {"source": str(pdf), "out": str(tmp_path / "layer.json")})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    assert job["total"] == 2
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()
    assert result["ok"] is True
    assert result["result"]["pages"] == 2
    pages = json.loads((tmp_path / "layer.json").read_text(encoding="utf-8"))
    assert "page 1 text" in pages[0]


def test_outline_job_reads_bookmarks(client, tmp_path):
    pdf = make_pdf(tmp_path / "toc.pdf", toc=[[1, "第一章 起风了", 1], [2, "第一节", 1], [1, "第二章 雨", 2]])
    job_id = submit(client, "outline", {"source": str(pdf)})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["count"] == 3
    assert result["entries"][0]["title"] == "第一章 起风了"
    assert result["entries"][1]["level"] == 2


def test_images_to_pdf_packs_one_page_per_image(client, tmp_path):
    from PIL import Image

    images = []
    for index, color in enumerate([(255, 0, 0), (0, 0, 255)]):
        path = tmp_path / f"page-{index}.png"
        Image.new("RGB", (40, 60), color).save(path)
        images.append(str(path))
    out = tmp_path / "packed.pdf"
    job_id = submit(client, "images-to-pdf", {"images": images, "out": str(out)})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    import fitz

    doc = fitz.open(str(out))
    try:
        assert doc.page_count == 2
    finally:
        doc.close()
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["pages"] == 2


def test_bad_requests_are_rejected(client):
    assert client.post("/v1/jobs", headers=AUTH, json={"kind": "nope", "args": {}}).status_code == 400
    assert client.get("/v1/jobs/none", headers=AUTH).status_code == 404
    assert client.post("/v1/jobs", headers=AUTH, json={"kind": "images-to-pdf", "args": {"images": [], "out": "x.pdf"}}).status_code == 200
    job = wait_for(client, client.post("/v1/jobs", headers=AUTH, json={"kind": "images-to-pdf", "args": {"images": [], "out": "x.pdf"}}).json()["jobId"])
    assert job["status"] == "failed"
    assert "没有图片" in job["error"]


def test_redact_job_removes_the_marked_text(client, tmp_path):
    import fitz

    pdf = tmp_path / "dirty.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 40), "HEADER NOISE")
    page.insert_text((72, 200), "BODY KEEP")
    doc.save(str(pdf))
    doc.close()

    out = tmp_path / "clean.pdf"
    rects = [{"page": 1, "rect": [60, 30, 260, 55]}]
    job_id = submit(client, "redact", {"source": str(pdf), "out": str(out), "rects": rects})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["removed"] == 1
    doc = fitz.open(str(out))
    try:
        text = doc[0].get_text()
    finally:
        doc.close()
    assert "HEADER" not in text, "红标区域被擦掉"
    assert "BODY KEEP" in text, "区域外的正文保留"


def test_extract_job_runs_pdf_tool_from_the_config(client, tmp_path, monkeypatch):
    # 假的 pdf_tool:一个把产物写出来的 stub(真机由引擎按配置调用真的 pdf_tool)。
    pdf_tool_dir = tmp_path / "auto_chat"
    script_dir = pdf_tool_dir / "pdf_tool"
    script_dir.mkdir(parents=True)
    (script_dir / "pdf_to_doc.py").write_text(
        "import json, sys\n"
        "out = sys.argv[sys.argv.index('--out-dir') + 1]\n"
        "open(out + '/book_doc.json', 'w', encoding='utf-8').write(json.dumps({'mode': 'stub'}))\n"
        "print('stub pdf_tool ok')\n",
        encoding="utf-8",
    )
    pdf = make_pdf(tmp_path / "book.pdf")
    client.patch("/v1/config", headers=AUTH, json={"patch": {"pdfToolDir": str(pdf_tool_dir)}})
    out_dir = tmp_path / "extract"
    job_id = submit(client, "extract", {"source": str(pdf), "outDir": str(out_dir), "model": "vlm"})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["produced"] == ["book_doc.json"]
    assert (out_dir / "book_doc.json").exists()
    assert "stub pdf_tool ok" in result["log"]

    # 没配置 pdf_tool 目录时给可操作的错误
    client.patch("/v1/config", headers=AUTH, json={"patch": {"pdfToolDir": ""}})
    failed = wait_for(client, submit(client, "extract", {"source": str(pdf), "outDir": str(out_dir)}))
    assert failed["status"] == "failed"
    assert "pdf_tool" in failed["error"]


def test_convert_job_runs_docvortex(client, tmp_path, monkeypatch):
    # 假的 docvortex 模块:引擎用 `python -m docvortex` 调它(PYTHONPATH 指到 stub 目录)。
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    (stub_dir / "docvortex.py").write_text(
        "import pathlib, sys\n"
        "out = sys.argv[sys.argv.index('--output') + 1]\n"
        "pathlib.Path(out).write_text('# converted', encoding='utf-8')\n"
        "print('stub docvortex ok')\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHONPATH", str(stub_dir))
    source = tmp_path / "in.docx"
    source.write_text("x", encoding="utf-8")
    out = tmp_path / "out.md"
    job_id = submit(client, "convert", {"source": str(source), "format": "markdown", "out": str(out), "parseMode": "ocr"})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["out"] == str(out)
    assert out.read_text(encoding="utf-8") == "# converted"
    assert "stub docvortex ok" in result["log"]

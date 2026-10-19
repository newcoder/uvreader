"""引擎自己的测试:契约、鉴权、配置、能力、作业。

从仓库根跑:`python -m pytest engine/tests -q`(需要 engine/requirements-dev.txt 里的 pytest + httpx)。
这些测试进 CI 的 engine 作业;应用侧的单测只覆盖客户端。
"""
from __future__ import annotations

import json
import os
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
    # 「路径不存在」不等于不可用:还会看常见安装位置与 PATH(与应用侧 calibreCandidates 一致)。
    assert saved["capabilities"]["calibre"]["kind"] == "external"
    assert saved["capabilities"]["calibre"]["optional"] is True

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


def test_jobs_are_listed_for_manual_checks(client, tmp_path):
    pdf = make_pdf(tmp_path / "listed.pdf")
    first = submit(client, "outline", {"source": str(pdf)})
    wait_for(client, first)
    second = submit(client, "text-layer", {"source": str(pdf), "out": str(tmp_path / "listed.json")})
    wait_for(client, second)
    listed = client.get("/v1/jobs?limit=10", headers=AUTH).json()["jobs"]
    kinds = [job["kind"] for job in listed]
    assert kinds[0] == "text-layer", "新的在前"
    assert "outline" in kinds
    assert all("summary" in job and "status" in job for job in listed), "带参数摘要与状态"


def test_pdf_text_job_reads_the_structure(client, tmp_path):
    pdf = make_pdf(tmp_path / "text.pdf")
    work = tmp_path / "work"
    job_id = submit(client, "pdf-text", {"source": str(pdf), "workDir": str(work)})
    job = wait_for(client, job_id, timeout=60)
    assert job["status"] == "done", job.get("error")
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["pages"] == 2
    pages = json.loads((work / "pdf-text.json").read_text(encoding="utf-8"))
    assert isinstance(pages, list) and pages
    assert "lines" in pages[0], "结构化行在 pages[].lines 里"


def test_convert_job_runs_docvortex(client, tmp_path, monkeypatch):    # 假的 docvortex CLI:放在 PATH 最前面(引擎按 配置路径 → PATH → python -m 的顺序找)。
    stub_dir = tmp_path / "stubs"
    stub_dir.mkdir()
    (stub_dir / "docvortex.py").write_text(
        "import pathlib, sys\n"
        "out = sys.argv[sys.argv.index('--output') + 1]\n"
        "pathlib.Path(out).write_text('# converted', encoding='utf-8')\n"
        "print('stub docvortex ok')\n",
        encoding="utf-8",
    )
    sh_stub = stub_dir / "docvortex"
    sh_stub.write_text(f"#!/bin/sh\nexec \"{sys.executable}\" \"{stub_dir / 'docvortex.py'}\" \"$@\"\n", encoding="utf-8")
    sh_stub.chmod(0o755)
    cmd_stub = stub_dir / "docvortex.cmd"
    cmd_stub.write_text(f"@\"{sys.executable}\" \"{stub_dir / 'docvortex.py'}\" %*\r\n", encoding="utf-8")
    monkeypatch.setenv("PATH", str(stub_dir) + os.pathsep + os.environ.get("PATH", ""))
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


def test_config_with_a_bom_is_still_read(tmp_path, monkeypatch):
    """记事本(Windows)会在 UTF-8 前面写 BOM:那份配置必须照样读得出来,不能被静默忽略。"""
    from engine.config import load_config

    config_file = tmp_path / "config.json"
    config_file.write_bytes(b"\xef\xbb\xbf" + json.dumps({"bokoPath": "C:/boko/boko.exe", "workers": 3}).encode("utf-8"))
    monkeypatch.setenv("ENGINE_CONFIG", str(config_file))
    config = load_config()
    assert config["bokoPath"] == "C:/boko/boko.exe", "带 BOM 的配置不能被忽略"
    assert config["workers"] == 3
    # 顺带:配置是**启动时读一次**(之后靠 /v1/config 改),手工改文件要重启引擎才生效。
    assert config["calibrePath"] == ""


# ── 可选组件(install-component)─────────────────────────────────────

def test_capabilities_say_what_is_bundled_and_what_is_not(client):
    capabilities = client.get("/v1/health", headers=AUTH).json()["capabilities"]
    # 自带的:kind=bundled;另外装的:kind=external(DocVortex 还标了 installable)。
    assert capabilities["python"]["kind"] == "bundled"
    assert capabilities["pdfTool"]["kind"] == "bundled"
    assert capabilities["docvortex"]["kind"] == "external"
    assert capabilities["docvortex"]["installable"] is True, "DocVortex 可以一键装进引擎的 Python"
    assert capabilities["docvortex"]["component"] == "docvortex"
    assert capabilities["calibre"]["optional"] is True, "Calibre / boko 是可选组件"
    assert capabilities["boko"]["optional"] is True
    # 不可用时给「具体怎么补」,而不只是报错。
    for key in ("docvortex", "mineru", "calibre", "boko"):
        info = capabilities[key]
        if info["ok"] is False:
            assert info.get("fix"), f"{key} 不可用时要给 fix"


def test_component_install_job_runs_pip_into_the_engine_python(client, monkeypatch):
    from engine import components

    calls = []

    def fake_run_pip(packages, target, on_line, should_cancel=None):
        calls.append({"packages": list(packages), "target": str(target)})
        on_line("Collecting docvortex")
        on_line("Successfully installed docvortex")
        return 0

    monkeypatch.setattr(components, "_run_pip", fake_run_pip)
    job_id = submit(client, "install-component", {"name": "docvortex"})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["installed"] == ["docvortex"]
    assert calls and calls[0]["packages"] == ["docvortex"]
    assert calls[0]["target"].replace("\\", "/").endswith("components"), "装进独立的 components/(不碰解释器自己的 site-packages)"
    assert any("docvortex" in line for line in result["tail"])


def test_component_install_rejects_anything_outside_the_whitelist(client):
    job_id = submit(client, "install-component", {"name": "requests"})
    job = wait_for(client, job_id)
    assert job["status"] == "failed"
    assert "未知组件" in (job.get("error") or "")


def test_component_install_failure_surfaces_pip_output(client, monkeypatch):
    from engine import components

    def failing_run_pip(packages, target, on_line, should_cancel=None):
        on_line("ERROR: Could not find a version that satisfies the requirement docvortex")
        return 1

    monkeypatch.setattr(components, "_run_pip", failing_run_pip)
    job_id = submit(client, "install-component", {"name": "docvortex"})
    job = wait_for(client, job_id)
    assert job["status"] == "failed"
    assert "安装失败" in (job.get("error") or "")
    assert "Could not find a version" in (job.get("error") or ""), "失败要把 pip 的关键输出带出来"


# ── Calibre(ebook-convert)───────────────────────────────────────────

def _calibre_stub(tmp_path: Path) -> Path:
    """假的 ebook-convert:把源文件内容抄到输出(证明参数传对了)。"""
    script = tmp_path / "stub-calibre.py"
    script.write_text(
        "import pathlib, sys\n"
        "source, out = sys.argv[1], sys.argv[2]\n"
        "pathlib.Path(out).write_text(pathlib.Path(source).read_text(encoding='utf-8') + '|converted', encoding='utf-8')\n"
        "print('stub calibre ok')\n",
        encoding="utf-8",
    )
    if os.name == "nt":
        stub = tmp_path / "ebook-convert.cmd"
        stub.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        stub = tmp_path / "ebook-convert"
        stub.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
        stub.chmod(0o755)
    return stub


def test_ebook_convert_job_runs_calibre(client, tmp_path):
    stub = _calibre_stub(tmp_path)
    patched = client.patch("/v1/config", headers=AUTH, json={"patch": {"calibrePath": str(stub)}})
    assert patched.status_code == 200
    assert patched.json()["capabilities"]["calibre"]["ok"] is True, "配置了路径就该报可用"
    source = tmp_path / "book.epub"
    source.write_text("epub-bytes", encoding="utf-8")
    out = tmp_path / "book.azw3"
    job_id = submit(client, "ebook-convert", {"source": str(source), "out": str(out)})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["out"] == str(out)
    assert out.read_text(encoding="utf-8") == "epub-bytes|converted"
    assert result["bytes"] > 0


def test_ebook_convert_reports_missing_calibre_and_missing_source(client, tmp_path, monkeypatch):
    from engine import capabilities

    # 把常见安装位置与 PATH 都摘掉,确保「找不到 Calibre」这条分支真的被测到。
    monkeypatch.setenv("PATH", "")
    monkeypatch.delenv("ProgramFiles", raising=False)
    monkeypatch.delenv("ProgramFiles(x86)", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    capabilities.reset_cache()
    patched = client.patch("/v1/config", headers=AUTH, json={"patch": {"calibrePath": str(tmp_path / "nope")}})
    assert patched.json()["capabilities"]["calibre"]["ok"] is False
    source = tmp_path / "book.epub"
    source.write_text("x", encoding="utf-8")
    job_id = submit(client, "ebook-convert", {"source": str(source), "out": str(tmp_path / "o.azw3")})
    job = wait_for(client, job_id)
    assert job["status"] == "failed"
    assert "找不到 Calibre" in (job.get("error") or "")

    missing = submit(client, "ebook-convert", {"source": str(tmp_path / "nope.epub"), "out": str(tmp_path / "o.azw3")})
    job = wait_for(client, missing)
    assert job["status"] == "failed"
    assert "找不到源文件" in (job.get("error") or "")


# ── boko(EPUB / KFX / AZW3 互转)──────────────────────────────────────

def _boko_stub(tmp_path: Path) -> Path:
    """假的 boko:按 `convert <输入> <输出>` 写产物(证明参数传对了)。"""
    script = tmp_path / "stub-boko.py"
    script.write_text(
        "import pathlib, sys\n"
        "args = sys.argv[1:]\n"
        "if not args or args[0] != 'convert':\n"
        "    print('unexpected args:', args)\n"
        "    sys.exit(2)\n"
        "source, out = args[1], args[2]\n"
        "pathlib.Path(out).write_text(pathlib.Path(source).read_text(encoding='utf-8') + '|boko', encoding='utf-8')\n"
        "print('stub boko ok')\n",
        encoding="utf-8",
    )
    if os.name == "nt":
        stub = tmp_path / "boko.cmd"
        stub.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        stub = tmp_path / "boko"
        stub.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
        stub.chmod(0o755)
    return stub


def test_boko_convert_job_runs_boko_and_passes_the_paths(client, tmp_path):
    stub = _boko_stub(tmp_path)
    patched = client.patch("/v1/config", headers=AUTH, json={"patch": {"bokoPath": str(stub)}})
    assert patched.json()["capabilities"]["boko"]["ok"] is True, "配置了路径就该报可用"
    assert "KFX" in patched.json()["capabilities"]["boko"]["detail"], "能力说明要如实:EPUB / KFX / AZW3"
    source = tmp_path / "book.epub"
    source.write_text("epub-bytes", encoding="utf-8")
    out = tmp_path / "book.kfx"
    job_id = submit(client, "boko-convert", {"source": str(source), "out": str(out)})
    job = wait_for(client, job_id)
    assert job["status"] == "done", job.get("error")
    result = client.get(f"/v1/jobs/{job_id}/result", headers=AUTH).json()["result"]
    assert result["out"] == str(out)
    assert out.read_text(encoding="utf-8") == "epub-bytes|boko"
    assert result["bytes"] > 0


def test_boko_convert_refuses_mobi_output_and_reports_missing_boko(client, tmp_path, monkeypatch):
    stub = _boko_stub(tmp_path)
    client.patch("/v1/config", headers=AUTH, json={"patch": {"bokoPath": str(stub)}})
    source = tmp_path / "book.epub"
    source.write_text("x", encoding="utf-8")
    # MOBI:引擎自己就拒(实测 boko 也拒:"MOBI output is not supported; use .azw3 instead")
    job_id = submit(client, "boko-convert", {"source": str(source), "out": str(tmp_path / "book.mobi")})
    job = wait_for(client, job_id)
    assert job["status"] == "failed"
    assert "不能写 MOBI" in (job.get("error") or "")

    # 没配 + PATH 里也没有:要报「怎么补」,不是一句「失败」
    monkeypatch.setenv("PATH", "")
    client.patch("/v1/config", headers=AUTH, json={"patch": {"bokoPath": ""}})
    missing = submit(client, "boko-convert", {"source": str(source), "out": str(tmp_path / "book.azw3")})
    job = wait_for(client, missing)
    assert job["status"] == "failed"
    assert "找不到 boko" in (job.get("error") or "")
    assert "bokoPath" in (job.get("error") or "")

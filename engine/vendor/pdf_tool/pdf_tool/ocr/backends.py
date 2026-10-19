"""OCR 后端（rapid / windows）与子进程页级处理。"""
from __future__ import annotations

import io
import json
import logging
from pathlib import Path

from pdf_tool.core import watermark
from pdf_tool.ocr.lines import Line, order_lines

log = logging.getLogger("qb.ocrlayer")


# ---------------- OCR 后端 ----------------

class RapidBackend:
    """RapidOCR（onnxruntime）：优先新版 `rapidocr`（PP-OCRv6），回退 v1（PP-OCRv3）。

    intra_op：每进程 ONNX 线程数；多进程并行时按「核数 ÷ 进程数」设置可避免抢核
    （实测 12 核：2 线程 × 6 进程比默认全核 × 4 进程快 ~1.8x）。
    """

    name = "rapid"

    def __init__(self, intra_op: int | None = None) -> None:
        logging.getLogger("RapidOCR").setLevel(logging.WARNING)
        self._v3 = None
        self._v1 = None
        params = ({"EngineConfig.onnxruntime.intra_op_num_threads": int(intra_op)}
                  if intra_op else None)
        try:
            from rapidocr import RapidOCR as RapidOCRv3

            self._v3 = RapidOCRv3(params=params)
        except Exception as e:  # 新版不可用时回退
            log.warning("rapidocr 3.x 不可用（%s），回退 rapidocr_onnxruntime", e)
            from rapidocr_onnxruntime import RapidOCR as RapidOCRv1

            self._v1 = RapidOCRv1()

    def ocr(self, img) -> list[Line]:
        if self._v3 is not None:
            return self._ocr_v3(img)
        return self._ocr_v1(img)

    def _ocr_v3(self, img) -> list[Line]:
        res = self._v3(img)
        texts = list(getattr(res, "txts", None) or [])
        boxes = getattr(res, "boxes", None)
        scores = list(getattr(res, "scores", None) or [])
        out: list[Line] = []
        for i, text in enumerate(texts):
            if not str(text).strip() or boxes is None or i >= len(boxes):
                continue
            quad = [[float(p[0]), float(p[1])] for p in boxes[i]]
            out.append(Line(str(text), quad,
                            float(scores[i]) if i < len(scores) else 1.0))
        return out

    def _ocr_v1(self, img) -> list[Line]:
        result, _elapse = self._v1(img)
        out: list[Line] = []
        for item in result or []:
            box, rest = item[0], item[1:]
            if isinstance(rest[0], (list, tuple)):
                text, score = rest[0][0], rest[0][1]
            else:
                text = rest[0]
                score = rest[1] if len(rest) > 1 else 1.0
            if str(text).strip():
                out.append(Line(str(text), [[float(p[0]), float(p[1])] for p in box],
                                float(score)))
        return out


class WindowsBackend:
    """Windows OCR（Windows.Media.Ocr）：词级矩形，无置信度（按 1.0）。"""

    name = "windows"

    def ocr(self, img) -> list[Line]:
        import winocr
        from PIL import Image

        pil = img if isinstance(img, Image.Image) else Image.fromarray(img)
        res = winocr.recognize_pil_sync(pil, "zh-Hans-CN")
        out: list[Line] = []
        for ln in res.get("lines") or []:
            words = [w for w in (ln.get("words") or []) if (w.get("text") or "").strip()]
            if not words:
                continue
            xs0 = [w["bounding_rect"]["x"] for w in words]
            ys0 = [w["bounding_rect"]["y"] for w in words]
            xs1 = [w["bounding_rect"]["x"] + w["bounding_rect"]["width"] for w in words]
            ys1 = [w["bounding_rect"]["y"] + w["bounding_rect"]["height"] for w in words]
            quad = [[min(xs0), min(ys0)], [max(xs1), min(ys0)],
                    [max(xs1), max(ys1)], [min(xs0), max(ys1)]]
            out.append(Line("".join(w["text"] for w in words), quad, 1.0))
        return out


_BACKENDS = {"rapid": RapidBackend, "windows": WindowsBackend}
_WORKER = None
_INTRA_OP: int | None = None




def make_backend(name: str, intra_op: int | None = None):
    if name == "rapid":
        return RapidBackend(intra_op)
    return _BACKENDS[name]()


BACKEND_NAMES = tuple(_BACKENDS)

# ---------------- 单页处理（可在子进程运行） ----------------

def _worker_init(backend_name: str, intra_op: int | None = None) -> None:
    global _WORKER, _INTRA_OP
    _INTRA_OP = intra_op
    _WORKER = make_backend(backend_name, intra_op)


def process_page(args: tuple) -> tuple[int, list[list], float, bool]:
    """渲染 + OCR 一页，写页级缓存；返回 (page_no, lines_json, seconds, skipped)。

    已有文字层的页（原生文本 PDF）默认跳过，避免叠加重复文字。
    """
    import time

    import fitz
    import numpy as np
    from PIL import Image

    (pdf_path, page_no, dpi, backend_name, min_score, cache_file, force,
     skip_text_chars) = args
    cache_path = Path(cache_file)
    if cache_path.exists() and not force:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        return page_no, data["lines"], 0.0, bool(data.get("skipped"))

    t0 = time.time()
    doc = fitz.open(pdf_path)
    page = doc[page_no - 1]
    if skip_text_chars and len(page.get_text().strip()) >= skip_text_chars:
        doc.close()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(
            {"page": page_no, "dpi": dpi, "backend": backend_name, "skipped": True,
             "lines": []}, ensure_ascii=False), encoding="utf-8")
        log.info("[ocr-layer] 第 %d 页已有文字层，跳过", page_no)
        return page_no, [], time.time() - t0, True
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72))
    img = np.array(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
    faint = watermark.faint_traces(page)  # 出生 PDF 的浅色水印（扫描件为空）
    derotation = page.derotation_matrix   # OCR 框（渲染空间）→ 未旋转页面坐标
    doc.close()

    backend = _WORKER or make_backend(backend_name, _INTRA_OP)
    lines = backend.ocr(img)
    lines = [ln for ln in lines if ln.score >= min_score and ln.text.strip()]
    lines = watermark.filter_ocr_lines(lines, faint, dpi, derotation=derotation)
    lines = order_lines(lines, img.shape[1])

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(
        {"page": page_no, "dpi": dpi, "backend": backend_name,
         "lines": [ln.to_json() for ln in lines]}, ensure_ascii=False), encoding="utf-8")
    return page_no, [ln.to_json() for ln in lines], time.time() - t0, False


def process_page_safe(args: tuple) -> tuple[int, list[list], float, bool, str | None]:
    """process_page 的容错包装：单页失败返回错误文本而非抛出（多进程安全）。

    供 build()/批量路径使用：单页失败不影响其它页，错误进 stats.failed_pages。
    """
    try:
        page_no, lines, seconds, skipped = process_page(args)
        return page_no, lines, seconds, skipped, None
    except Exception as e:
        log.warning("[ocr-layer] 第 %s 页处理失败: %s", args[1], e)
        return int(args[1]), [], 0.0, False, f"{type(e).__name__}: {e}"

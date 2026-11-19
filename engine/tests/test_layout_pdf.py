"""Unit tests for the layout-preserving scanned-PDF job.

Run from the repository root:
    python -m pytest engine/tests -q
or with plain unittest:
    python -m unittest engine.tests.test_layout_pdf
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from engine import layout_pdf
from engine.jobs import Job


class FakeOcr:
    def __init__(self, lines):
        self.lines = lines

    def __call__(self, image):  # noqa: ARG002 - contract only
        return list(self.lines)


class LayoutHelpersTest(unittest.TestCase):
    def test_parse_pages(self):
        self.assertEqual(layout_pdf.parse_pages("", 5), [1, 2, 3, 4, 5])
        self.assertEqual(layout_pdf.parse_pages("2-4,8", 8), [2, 3, 4, 8])
        self.assertEqual(layout_pdf.parse_pages("9-2,0", 8), [2, 3, 4, 5, 6, 7, 8])
        self.assertEqual(layout_pdf.parse_pages("1-3", 2), [1, 2])

    def test_clean_text_removes_superscript_spacing(self):
        self.assertEqual(layout_pdf.clean_text("消息^{①} ？"), "消息①？")
        self.assertEqual(layout_pdf.clean_text("银蒜^{②} 押帘"), "银蒜②押帘")
        self.assertEqual(layout_pdf.clean_text("图解 纳兰词"), "图解 纳兰词")

    def test_align_lines_takes_characters_from_mineru(self):
        lines = [
            {"text": "消息谁传到拒霜①？两行斜雁碧"},
            {"text": "长。晚秋风景倍凄凉。"},
        ]
        texts, ratio = layout_pdf.align_lines("消息谁传到拒霜^{①}？两行斜雁碧天长。晚秋风景倍凄凉。", lines)
        self.assertGreater(ratio, 0.8)
        self.assertTrue(texts[0].endswith("天"))
        self.assertTrue(texts[1].startswith("长"))

    def test_choose_lines_assigns_each_line_once_and_skips_images(self):
        blocks = [
            {"type": "text", "bbox": [0.1, 0.1, 0.9, 0.3], "text": "第一行文字"},
            {"type": "text", "bbox": [0.1, 0.3, 0.9, 0.5], "text": "第二行文字"},
            {"type": "image", "bbox": [0.0, 0.5, 1.0, 1.0], "text": ""},
        ]
        lines = [
            {"text": "第一行文字", "score": 1.0, "rect": [100, 100, 700, 200], "angle": 0},
            {"text": "第二行文字", "score": 1.0, "rect": [100, 300, 700, 400], "angle": 0},
            {"text": "图解", "score": 1.0, "rect": [100, 600, 300, 700], "angle": 0},
            {"text": "旋转", "score": 1.0, "rect": [800, 100, 900, 300], "angle": 90},
            {"text": "竖排", "score": 1.0, "rect": [950, 100, 990, 400], "angle": 0},
        ]
        items = layout_pdf.choose_lines(blocks, lines, 1000, 1000)
        self.assertEqual([item["text"] for item in items], ["第一行文字", "第二行文字"])

    def test_choose_lines_preserves_explicit_index_lines(self):
        blocks = [{
            "type": "index",
            "bbox": [0.05, 0.1, 0.45, 0.7],
            "text": "浣溪沙（泪浥红笺第几行）/66\n浣溪沙（谁念西风独自凉）/68",
        }]
        lines = [
            {"text": "浣溪沙（泪浥红笺第几行）/66", "score": 1.0, "rect": [60, 100, 500, 140], "angle": 0},
            {"text": "浣溪沙（谁念西风独自凉）/68", "score": 1.0, "rect": [60, 160, 500, 200], "angle": 0},
        ]
        items = layout_pdf.choose_lines(blocks, lines, 1000, 1000)
        self.assertEqual([item["text"] for item in items], [
            "浣溪沙（泪浥红笺第几行）/66",
            "浣溪沙（谁念西风独自凉）/68",
        ])

    def test_text_mask_selects_glyphs_not_background(self):
        import numpy as np

        image = np.full((100, 200, 3), (240, 230, 220), dtype=np.uint8)
        image[30:60, 40:120] = (20, 20, 20)
        mask, _distance = layout_pdf.text_mask(image, np.array([240, 230, 220]))
        self.assertIsNotNone(mask)
        self.assertGreater(float(mask[30:60, 40:120].mean()), 0.9)
        background = mask.copy()
        background[30:60, 40:120] = 0
        self.assertLess(float(background.mean()), 0.05)

    def test_ring_background_uses_the_panel_colour(self):
        import numpy as np

        image = np.full((100, 200, 3), (210, 150, 110), dtype=np.uint8)
        background, spread = layout_pdf.ring_background(image, [40, 40, 160, 60])
        self.assertLess(spread, 1.0)
        self.assertTrue((background > 200).all() or (background < 220).all())

    def test_pick_font_returns_an_existing_path_or_builtin(self):
        path, name = layout_pdf.pick_font("")
        if path:
            self.assertTrue(Path(path).is_file())
        else:
            self.assertEqual(name, "china-s")


class LayoutJobTest(unittest.TestCase):
    def test_run_layout_pdf_rejects_partial_layout_for_full_run(self):
        import pymupdf

        work = tempfile.mkdtemp(prefix="qbr-layout-partial-")
        source = os.path.join(work, "scan.pdf")
        document = pymupdf.open()
        document.new_page(width=400, height=600)
        document.new_page(width=400, height=600)
        document.save(source)
        document.close()
        layout_path = os.path.join(work, "layout.json")
        with open(layout_path, "w", encoding="utf-8") as handle:
            json.dump({"pages": [{"page": 1, "blocks": []}]}, handle)
        job = Job(id="test", kind="layout-pdf", args={
            "source": source,
            "out": os.path.join(work, "out.pdf"),
            "layout": layout_path,
            "pages": "",
        })
        with self.assertRaisesRegex(ValueError, "不一致"):
            layout_pdf.run_layout_pdf(job)

    def test_run_layout_pdf_rebuilds_a_synthetic_scan(self):
        import pymupdf
        from PIL import Image, ImageDraw, ImageFont

        work = tempfile.mkdtemp(prefix="qbr-layout-job-")
        image = Image.new("RGB", (1200, 1600), "white")
        draw = ImageDraw.Draw(image)
        font_path = layout_pdf.pick_font("")[0]
        if not font_path:
            self.skipTest("no CJK font available")
        font = ImageFont.truetype(font_path, 144)
        draw.text((240, 360), "测试文字", font=font, fill=(20, 20, 20))
        png = io.BytesIO()
        image.save(png, format="PNG")
        source = os.path.join(work, "scan.pdf")
        document = pymupdf.open()
        page = document.new_page(width=400, height=533.333)
        page.insert_image(page.rect, stream=png.getvalue())
        document.save(source)
        document.close()

        layout_path = os.path.join(work, "layout.json")
        with open(layout_path, "w", encoding="utf-8") as handle:
            json.dump({"pages": [{
                "page": 1,
                "blocks": [{
                    "type": "text",
                    "bbox": [240 / 1200, 360 / 1600, 816 / 1200, 504 / 1600],
                    "text": "测试文字",
                }],
            }]}, handle, ensure_ascii=False)

        lines = [{"text": "测试文字", "score": 0.99, "rect": [240, 360, 816, 504], "angle": 0}]
        output = os.path.join(work, "out.pdf")
        job = Job(id="test", kind="layout-pdf", args={
            "source": source,
            "out": output,
            "layout": layout_path,
            "cacheDir": os.path.join(work, "cache"),
            "dpi": 216,
            "toc": [{"level": 1, "title": "测试文字", "page": 1}],
        })
        with mock.patch.object(layout_pdf, "RapidOcr", lambda: FakeOcr(lines)):
            result = layout_pdf.run_layout_pdf(job)
        self.assertEqual(result["pages"], 1)
        self.assertEqual(result["replaced"], 1)
        self.assertEqual(result["toc"], 1)
        self.assertTrue(Path(output).is_file())
        check = pymupdf.open(output)
        try:
            self.assertEqual(check.page_count, 1)
            self.assertIn("测试文字", check[0].get_text())
            self.assertEqual(check.get_toc(simple=True), [[1, "测试文字", 1]])
        finally:
            check.close()


if __name__ == "__main__":
    unittest.main()

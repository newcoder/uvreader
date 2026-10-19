"""pdf_tool：PDF 工具箱 —— 试卷/文档抽取、MinerU 集成、扫描件可搜索文字层、产物渲染。

模块按功能分层：
- core/     公用路径与 JSON IO
- llm/      模型通道（DeepSeek API / DeepSeek 网页 / Ollama）
- assets/   版面解析与图片资产（PP-DocLayoutV2 / PaddleOCR / fitz）
- extract/  题目/文档抽取流水线（vision / box / doc / pdf-chunks）+ 审计
- mineru/   MinerU 云端解析
- ocr/      扫描件可搜索文字层
- render/   blocks → Markdown / HTML / PDF / viewer

CLI 入口在包根：pdf_to_questions.py / ocr_layer_pdf.py / blocks_to_md.py /
blocks_to_pdf.py / make_viewer.py
"""

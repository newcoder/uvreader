// PDF form filling and image signatures for the desktop shell. PyMuPDF is
// used because the form may be encrypted and pdf-lib cannot write those back.
// Rendering stays in pdf.js; this service only reads field metadata and writes
// a flattened copy.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PDF_FORM_SCRIPT = String.raw`
import base64
import json
import os
import secrets
import sys
import traceback

try:
    import pymupdf
except Exception as exc:
    print(json.dumps({"ok": False, "error": "PyMuPDF is unavailable: " + str(exc)}, ensure_ascii=False))
    sys.exit(0)


def normalized(value):
    return round(float(value), 6)


def inspect_document(doc):
    fields = []
    pages = []
    for page_index, page in enumerate(doc):
        width = max(1.0, float(page.rect.width))
        height = max(1.0, float(page.rect.height))
        pages.append({"page": page_index + 1, "width": width, "height": height})
        for widget in page.widgets() or []:
            field_type = int(getattr(widget, "field_type", -1))
            kind = "checkbox" if field_type == 2 else "text" if field_type == 7 else "other"
            if kind == "other":
                continue
            value = getattr(widget, "field_value", "")
            if kind == "checkbox":
                # PyMuPDF returns the on-state name (often "On"/"Yes") or "Off".
                checked = bool(value) and str(value).strip().lower() not in ("", "off", "0", "false")
                value = checked
            else:
                value = "" if value is None else str(value)
            rect = widget.rect
            flags = int(getattr(widget, "field_flags", 0) or 0)
            max_length = int(getattr(widget, "text_maxlen", 0) or 0)
            # Acrobat comb fields in this InDesign form use the high field-flag
            # bits together with /MaxLen. Unknown flags without MaxLen are not
            # rendered as a grid.
            comb = bool(flags & 0x01800000) and max_length > 0
            fields.append({
                "id": "p%d:%d" % (page_index + 1, int(widget.xref)),
                "xref": int(widget.xref),
                "page": page_index + 1,
                "name": str(getattr(widget, "field_name", "") or ""),
                "kind": kind,
                "value": value,
                "readOnly": bool(flags & 1),
                "required": bool(flags & 2),
                "maxLength": max_length or None,
                "comb": comb,
                "left": normalized((rect.x0 - page.rect.x0) / width),
                "top": normalized((rect.y0 - page.rect.y0) / height),
                "width": normalized((rect.x1 - rect.x0) / width),
                "height": normalized((rect.y1 - rect.y0) / height),
            })
    return fields, pages


def fill_document(doc, request):
    # Keep the page alongside each widget: PyMuPDF widgets are page-bound and
    # can fail with "Annot is not bound to a page" if only the widget survives
    # the page iteration.
    by_xref = {}
    for page in doc:
        for widget in page.widgets() or []:
            by_xref[int(widget.xref)] = (page, widget)

    for update in request.get("values", []):
        try:
            xref = int(update.get("xref"))
        except Exception:
            continue
        entry = by_xref.get(xref)
        if entry is None:
            continue
        page, widget = entry
        field_type = int(getattr(widget, "field_type", -1))
        value = update.get("value")
        if field_type == 2:
            on_state = "Yes"
            getter = getattr(widget, "on_state", None)
            if callable(getter):
                try:
                    on_state = str(getter() or on_state)
                except Exception:
                    pass
            widget.field_value = on_state if bool(value) else "Off"
        elif field_type == 7:
            widget.field_value = "" if value is None else str(value)
        else:
            continue
        widget.update()

    for signature in request.get("signatures", []):
        try:
            page = doc[int(signature.get("page")) - 1]
            data = str(signature.get("data") or "")
            if "," in data:
                data = data.split(",", 1)[1]
            raw = base64.b64decode(data)
            if not raw:
                continue
            width = max(1.0, float(page.rect.width))
            height = max(1.0, float(page.rect.height))
            left = float(signature.get("left") or 0)
            top = float(signature.get("top") or 0)
            w = max(0.001, float(signature.get("width") or 0))
            h = max(0.001, float(signature.get("height") or 0))
            rect = pymupdf.Rect(
                page.rect.x0 + left * width,
                page.rect.y0 + top * height,
                page.rect.x0 + (left + w) * width,
                page.rect.y0 + (top + h) * height,
            )
            page.insert_image(rect, stream=raw, overlay=True)
        except Exception:
            continue

    # Acrobat Fill & Sign keeps the form editable when the user only fills
    # fields. Once a signature is placed, saving flattens the widgets so the
    # signed copy cannot be edited. Signature images are already page content;
    # flatten widgets explicitly and leave unrelated annotations alone.
    locked = bool(request.get("signatures"))
    if locked:
        doc.bake(annots=False, widgets=True)
    return locked


def save_document(doc, request, source, locked):
    output = str(request.get("out") or "")
    if not output:
        raise ValueError("missing output path")
    os.makedirs(os.path.dirname(output), exist_ok=True)
    same_source = os.path.normcase(os.path.abspath(output)) == os.path.normcase(os.path.abspath(source))
    if same_source and locked:
        raise RuntimeError("签名后不能覆盖原 PDF，请另存为副本")
    # An unsigned save may overwrite the source. Use an incremental save so
    # object numbers (the form field xrefs held by the open reader) survive and
    # subsequent fills in the same session keep updating the right widgets.
    if same_source:
        doc.save(source, incremental=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
        return source
    permissions = int(doc.permissions)
    encryption = str((doc.metadata or {}).get("encryption") or "")
    kwargs = {}
    if encryption or permissions not in (-1, -4):
        kwargs = {
            "encryption": pymupdf.PDF_ENCRYPT_AES_256,
            "owner_pw": secrets.token_hex(16),
            "user_pw": "",
            "permissions": permissions,
        }
    doc.save(output, garbage=4, deflate=True, **kwargs)
    return output


def main():
    try:
        request = json.load(sys.stdin)
        source = str(request.get("path") or "")
        if not source or not os.path.isfile(source):
            raise FileNotFoundError(source or "source")
        mode = str(request.get("mode") or "")
        doc = pymupdf.open(source)
        if doc.needs_pass:
            raise RuntimeError("PDF 需要打开密码，当前版本暂不支持加密打开")
        if mode == "inspect":
            fields, pages = inspect_document(doc)
            print(json.dumps({"ok": True, "fields": fields, "pages": pages}, ensure_ascii=False))
        elif mode == "save":
            locked = fill_document(doc, request)
            output = save_document(doc, request, source, locked)
            print(json.dumps({"ok": True, "output": output, "locked": bool(locked)}, ensure_ascii=False))
        else:
            raise ValueError("unknown mode")
        doc.close()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
    finally:
        try:
            doc.close()
        except Exception:
            pass


main()
`;

function hasSignatures(payload = {}) {
  return Array.isArray(payload.signatures) && payload.signatures.length > 0;
}

function uniqueOutput(source, signed = false) {
  const dir = path.dirname(source);
  const stem = path.basename(source).replace(/\.[^.]+$/, "") || "document";
  const suffixName = signed ? "filled_signed" : "filled";
  let candidate = path.join(dir, `${stem}_${suffixName}.pdf`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${suffixName}-${suffix}.pdf`);
    suffix += 1;
  }
  return candidate;
}

function isSamePath(left, right) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveSource(value, root = "") {
  const input = String(value || "").trim();
  if (!input) throw new Error("请选择当前 PDF 文件");
  const source = path.isAbsolute(input) ? input : path.resolve(String(root || ""), input);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`找不到 PDF:${source}`);
  return source;
}

function parseResult(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* ignore non-JSON output */ }
  }
  throw new Error("PDF 表单服务没有返回有效结果");
}

export function createPdfFormService({ engineService = null, log = () => {}, spawnImpl = spawn, timeoutMs = 120_000 } = {}) {
  async function resolvePython(settings = {}) {
    let status = null;
    try { status = await engineService?.status?.(); } catch { /* engine is optional */ }
    const enginePython = status?.dir
      ? path.join(status.dir, process.platform === "win32" ? "python/python.exe" : "python/bin/python3")
      : "";
    const candidates = [
      enginePython,
      String(settings.pdfFormPython || "").trim(),
      String(settings.ocrPython || "").trim(),
      String(settings.docvortexPython || "").trim(),
      String(process.env.QBR_PYTHON || "").trim(),
      "python",
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate === "python" || fs.existsSync(candidate)) return candidate;
    }
    return "python";
  }

  function runPython(python, payload) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child?.kill(); } catch { /* already stopped */ }
        finish({ ok: false, error: "PDF 表单处理超时" });
      }, Math.max(10_000, Number(timeoutMs) || 120_000));
      try {
        child = spawnImpl(python, ["-c", PDF_FORM_SCRIPT], {
          windowsHide: true,
          env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        finish({ ok: false, error: String(error?.message || error) });
        return;
      }
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      child.stdout?.on?.("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on?.("data", (chunk) => { stderr += String(chunk); });
      child.on?.("error", (error) => finish({ ok: false, error: String(error?.message || error) }));
      child.on?.("close", (_code) => {
        if (settled) return;
        try {
          const result = parseResult(stdout);
          if (result.ok === false) log(`[pdf-form] ${result.error || "failed"}`);
          finish(result);
        } catch (error) {
          const detail = String(stderr || error?.message || "PDF 表单服务失败").slice(-1200);
          finish({ ok: false, error: detail });
        }
      });
      try {
        child.stdin?.end?.(JSON.stringify(payload));
      } catch (error) {
        finish({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  async function inspect(payload = {}) {
    const source = resolveSource(payload.path, payload.root);
    const python = await resolvePython(payload.settings || {});
    return runPython(python, { mode: "inspect", path: source });
  }

  function defaultOutput(payload = {}) {
    return uniqueOutput(resolveSource(payload.path, payload.root), hasSignatures(payload));
  }

  async function save(payload = {}) {
    const source = resolveSource(payload.path, payload.root);
    const python = await resolvePython(payload.settings || {});
    const signed = hasSignatures(payload);
    const output = payload.out
      ? path.resolve(String(payload.out))
      : uniqueOutput(source, signed);
    // An unsigned fill can overwrite the source; a signed copy is flattened
    // and must stay a separate file.
    if (signed && isSamePath(output, source)) {
      return { ok: false, error: "签名后不能覆盖原 PDF，请另存为副本" };
    }
    const result = await runPython(python, {
      mode: "save",
      path: source,
      out: output,
      values: Array.isArray(payload.values) ? payload.values : [],
      signatures: Array.isArray(payload.signatures) ? payload.signatures : [],
    });
    if (!result?.ok) return result;
    return { ...result, output: result.output || output };
  }

  return { inspect, save, defaultOutput, resolvePython, uniqueOutput, hasSignatures };
}

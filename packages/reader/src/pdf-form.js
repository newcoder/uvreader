// In-reader AcroForm filling and image signatures. The PDF itself is still
// rendered by pdf.js; this module only overlays native controls and remembers
// values until the desktop shell writes a copy. Copies stay editable unless a
// signature was placed, in which case the shell flattens and locks them.
//
// Kept host-agnostic: the controller receives the small `pdfForm` bridge and
// translates/notifies through callbacks. No Node or Electron imports here.

function element(doc, tag, className, attrs = {}) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pageNumberForSurface(surface) {
  const holder = surface?.closest?.("[data-pdf-page-no]");
  const value = holder ? Number(holder.getAttribute("data-pdf-page-no")) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function setPercentBox(node, item) {
  node.style.left = `${item.left * 100}%`;
  node.style.top = `${item.top * 100}%`;
  node.style.width = `${item.width * 100}%`;
  node.style.height = `${item.height * 100}%`;
}

export function createPdfFormController({ view, bridge = null, translate = (key) => key, notify = () => {}, onChange = () => {}, openSignaturePicker = null }) {
  return new PdfFormController({ view, bridge, translate, notify, onChange, openSignaturePicker });
}

const MAX_SAVED_SIGNATURES = 8;

class PdfFormController {
  constructor({ view, bridge, translate, notify, onChange, openSignaturePicker }) {
    this.view = view;
    this.bridge = bridge;
    this.translate = translate;
    this.notify = notify;
    this.onChange = onChange;
    this.openSignaturePicker = openSignaturePicker;
    this.file = null;
    this.active = false;
    this.locked = false;
    this.loading = false;
    this.fields = [];
    this.values = new Map();
    this.pages = new Map();
    this.signatures = [];
    this.pendingSignature = null;
    this._signatureSeq = 0;
    this._doc = null;
    this._drag = null;
    this._acting = false;
    this._onSurfaceClick = this._onSurfaceClick.bind(this);
    this._onDocumentPointerMove = this._onDocumentPointerMove.bind(this);
    this._onDocumentPointerUp = this._onDocumentPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  get available() {
    return Boolean(this.bridge && this.file?.extension === "pdf" && !this.locked);
  }

  get isActive() {
    return this.active;
  }

  get isLocked() {
    return this.locked;
  }

  _vaultRoot() {
    const adapter = this.view?.app?.vault?.adapter;
    return String(adapter?.root || adapter?.basePath || globalThis.qbrDesktop?.paths?.vaultRoot || "");
  }

  setFile(file) {
    if (this.active) this.deactivate();
    this.file = file || null;
    this.locked = false;
    this.fields = [];
    this.values = new Map();
    this.pages = new Map();
    this.signatures = [];
    this.pendingSignature = null;
    this._signatureSeq = 0;
    this.onChange();
  }

  async open() {
    if (!this.available || this.loading) {
      if (!this.available) this.notify(this.translate("pdf-form-unavailable"));
      return;
    }
    this.loading = true;
    this.signatures = [];
    this.pendingSignature = null;
    this._signatureSeq = 0;
    this.view?.areaEl?.removeClass?.("qiaomu-reader-pdf-form-signing");
    this.onChange();
    try {
      const result = await this.bridge.inspect({
        path: this.file.path,
        root: this._vaultRoot(),
        settings: this.view?.plugin?.settings || {},
      });
      if (!result?.ok) throw new Error(String(result?.error || "inspect failed"));
      this.fields = Array.isArray(result.fields) ? result.fields : [];
      this.values = new Map(this.fields.map((field) => [
        field.id,
        field.kind === "checkbox" ? field.value === true : String(field.value ?? ""),
      ]));
      this.pages = new Map((result.pages || []).map((page) => [Number(page.page), page]));
      this.active = true;
      this._doc = this.view?.areaEl?.ownerDocument || globalThis.document;
      this._doc?.addEventListener?.("keydown", this._onKeyDown, true);
      this.view?.areaEl?.addEventListener?.("click", this._onSurfaceClick, true);
      this.view?.areaEl?.addClass?.("qiaomu-reader-pdf-form-mode");
      this.mountAll();
      this.notify(this.translate("pdf-form-fill-mode-on"));
    } catch (error) {
      this.notify(`${this.translate("pdf-form-inspect-failed")}: ${String(error?.message || error)}`);
    } finally {
      this.loading = false;
      this.onChange();
    }
  }

  close() {
    this.deactivate();
  }

  destroy() {
    this.deactivate();
    this.file = null;
    this.bridge = null;
  }

  deactivate() {
    if (!this.active && !this.pendingSignature) return;
    this.active = false;
    this.pendingSignature = null;
    this._drag = null;
    this._doc?.removeEventListener?.("keydown", this._onKeyDown, true);
    this.view?.areaEl?.removeEventListener?.("click", this._onSurfaceClick, true);
    this.view?.areaEl?.removeClass?.("qiaomu-reader-pdf-form-mode", "qiaomu-reader-pdf-form-signing");
    for (const surface of this._surfaces()) {
      surface.querySelector?.(".qiaomu-reader-pdf-form-layer")?.remove();
      surface.querySelector?.(".qiaomu-reader-pdf-signature-layer")?.remove();
      surface.classList?.remove("qiaomu-reader-pdf-form-page");
    }
    this.onChange();
  }

  async toggle() {
    if (this.active) this.deactivate();
    else await this.open();
  }

  mountAll() {
    if (!this.active) return;
    for (const surface of this._surfaces()) this.mountPage(surface, pageNumberForSurface(surface));
  }

  mountPage(surface, pageNumber) {
    if (!this.active || !surface || !pageNumber) return;
    const doc = surface.ownerDocument || this._doc;
    if (!doc) return;
    surface.querySelector?.(".qiaomu-reader-pdf-form-layer")?.remove();
    surface.querySelector?.(".qiaomu-reader-pdf-signature-layer")?.remove();
    surface.classList?.add("qiaomu-reader-pdf-form-page");

    const formLayer = element(doc, "div", "qiaomu-reader-pdf-form-layer");
    formLayer.setAttribute("data-pdf-form-layer", "");
    for (const field of this.fields) {
      if (Number(field.page) !== pageNumber) continue;
      if (field.kind !== "text" && field.kind !== "checkbox") continue;
      formLayer.appendChild(this._fieldControl(doc, field, surface));
    }
    surface.appendChild(formLayer);

    const signatureLayer = element(doc, "div", "qiaomu-reader-pdf-signature-layer");
    signatureLayer.setAttribute("data-pdf-signature-layer", "");
    for (const signature of this.signatures) {
      if (Number(signature.page) === pageNumber) signatureLayer.appendChild(this._signatureControl(doc, signature, surface));
    }
    surface.appendChild(signatureLayer);
  }

  _surfaces() {
    return [...(this.view?.pager?.flow?.querySelectorAll?.(".qiaomu-reader-pdf-page-surface") || [])];
  }

  _fieldControl(doc, field, surface) {
    if (field.kind === "text" && field.comb && Number(field.maxLength) > 0) {
      return this._combControl(doc, field, surface);
    }
    const input = element(doc, "input", "qiaomu-reader-pdf-form-input", {
      type: field.kind === "checkbox" ? "checkbox" : "text",
      "data-pdf-field-id": field.id,
      "aria-label": field.name || field.label || this.translate("pdf-field"),
      autocomplete: "off",
      spellcheck: "false",
    });
    setPercentBox(input, field);
    if (field.readOnly) {
      input.disabled = true;
      input.classList?.add("qiaomu-reader-pdf-form-readonly");
    }
    if (field.kind === "checkbox") {
      input.classList?.add("qiaomu-reader-pdf-form-checkbox");
      input.checked = this.values.get(field.id) === true;
      input.addEventListener("change", () => {
        this.values.set(field.id, Boolean(input.checked));
        this._changed();
      });
    } else {
      const heightPx = Math.max(6, (surface?.clientHeight || 800) * Number(field.height || 0));
      input.style.fontSize = `${clamp(heightPx * 0.68, 7, 13)}px`;
      input.style.lineHeight = `${Math.max(7, heightPx)}px`;
      input.value = String(this.values.get(field.id) ?? "");
      if (field.maxLength) input.maxLength = Number(field.maxLength);
      input.addEventListener("input", () => {
        this.values.set(field.id, input.value);
        this._changed();
      });
    }
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => event.stopPropagation());
    return input;
  }

  _combControl(doc, field, surface) {
    const count = clamp(Math.round(Number(field.maxLength) || 1), 1, 60);
    const wrapper = element(doc, "div", "qiaomu-reader-pdf-comb-field", {
      "data-pdf-field-id": field.id,
      "aria-label": field.name || field.label || this.translate("pdf-field"),
    });
    setPercentBox(wrapper, field);
    const heightPx = Math.max(6, (surface?.clientHeight || 800) * Number(field.height || 0));
    const fontSize = clamp(heightPx * 0.68, 7, 13);
    const cells = [];
    const current = String(this.values.get(field.id) ?? "").slice(0, count);
    for (let index = 0; index < count; index += 1) {
      const cell = element(doc, "input", "qiaomu-reader-pdf-comb-cell", {
        type: "text",
        maxlength: "1",
        autocomplete: "off",
        spellcheck: "false",
        "aria-label": `${field.name || this.translate("pdf-field")} ${index + 1}`,
      });
      cell.value = current[index] || "";
      cell.style.fontSize = `${fontSize}px`;
      cell.disabled = Boolean(field.readOnly);
      cell.addEventListener("input", () => {
        if (cell.value.length > 1) {
          const chars = [...cell.value];
          cell.value = chars[0] || "";
          for (let at = 1; at < chars.length && index + at < count; at += 1) {
            cells[index + at].value = chars[at];
          }
        }
        this._syncComb(field, cells);
        if (cell.value && index + 1 < count) cells[index + 1].focus();
      });
      cell.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && !cell.value && index > 0) {
          event.preventDefault();
          cells[index - 1].value = "";
          cells[index - 1].focus();
          this._syncComb(field, cells);
        } else if (event.key === "ArrowLeft" && index > 0) {
          event.preventDefault();
          cells[index - 1].focus();
        } else if (event.key === "ArrowRight" && index + 1 < count) {
          event.preventDefault();
          cells[index + 1].focus();
        }
        event.stopPropagation();
      });
      cell.addEventListener("paste", (event) => {
        event.preventDefault();
        const text = String(event.clipboardData?.getData("text") || "");
        const chars = [...text];
        for (let at = 0; at < chars.length && index + at < count; at += 1) {
          cells[index + at].value = chars[at];
        }
        this._syncComb(field, cells);
      });
      cell.addEventListener("pointerdown", (event) => event.stopPropagation());
      cell.addEventListener("click", (event) => event.stopPropagation());
      cells.push(cell);
      wrapper.appendChild(cell);
    }
    return wrapper;
  }

  _syncComb(field, cells) {
    this.values.set(field.id, cells.map((cell) => cell.value).join("").slice(0, cells.length));
    this._changed();
  }

  _signatureControl(doc, signature, surface) {
    const box = element(doc, "div", "qiaomu-reader-pdf-signature", {
      title: this.translate("pdf-signature"),
      "data-pdf-signature-id": signature.id,
    });
    setPercentBox(box, signature);
    const image = element(doc, "img", "qiaomu-reader-pdf-signature-img", { alt: this.translate("pdf-signature") });
    image.src = signature.dataUrl;
    image.draggable = false;
    box.appendChild(image);
    const remove = element(doc, "button", "qiaomu-reader-pdf-signature-remove", {
      type: "button",
      "aria-label": this.translate("delete"),
    });
    remove.textContent = "×";
    remove.addEventListener("pointerdown", (event) => event.stopPropagation());
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.signatures = this.signatures.filter((item) => item.id !== signature.id);
      box.remove();
      this._changed();
    });
    box.appendChild(remove);
    const resize = element(doc, "span", "qiaomu-reader-pdf-signature-resize", { "aria-hidden": "true" });
    box.appendChild(resize);

    image.addEventListener("pointerdown", (event) => this._startSignatureDrag(event, signature, surface, false));
    resize.addEventListener("pointerdown", (event) => this._startSignatureDrag(event, signature, surface, true));
    return box;
  }

  _startSignatureDrag(event, signature, surface, resize) {
    if (!this.active) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = surface.getBoundingClientRect();
    this._drag = {
      signature,
      surface,
      resize,
      rect,
      startX: event.clientX,
      startY: event.clientY,
      left: signature.left,
      top: signature.top,
      width: signature.width,
      height: signature.height,
      aspect: this._signatureAspect(signature),
    };
    this._doc?.addEventListener?.("pointermove", this._onDocumentPointerMove, true);
    this._doc?.addEventListener?.("pointerup", this._onDocumentPointerUp, true);
  }

  _onDocumentPointerMove(event) {
    const drag = this._drag;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / Math.max(1, drag.rect.width);
    const dy = (event.clientY - drag.startY) / Math.max(1, drag.rect.height);
    const signature = drag.signature;
    if (drag.resize) {
      const width = clamp(drag.width + dx, 0.05, 0.95);
      const height = clamp(width * drag.aspect, 0.02, 0.95);
      signature.width = Math.min(width, 0.95 - signature.left);
      signature.height = Math.min(height, 0.95 - signature.top);
    } else {
      signature.left = clamp(drag.left + dx, 0, 0.98 - signature.width);
      signature.top = clamp(drag.top + dy, 0, 0.98 - signature.height);
    }
    const box = drag.surface.querySelector?.(`[data-pdf-signature-id="${signature.id}"]`);
    if (box) setPercentBox(box, signature);
    this._changed();
  }

  _onDocumentPointerUp() {
    this._drag = null;
    this._doc?.removeEventListener?.("pointermove", this._onDocumentPointerMove, true);
    this._doc?.removeEventListener?.("pointerup", this._onDocumentPointerUp, true);
  }

  _signatureAspect(signature) {
    const page = this.pages.get(Number(signature.page));
    const pageWidth = Number(page?.width) || Number(signature.pageWidth) || 612;
    const pageHeight = Number(page?.height) || Number(signature.pageHeight) || 792;
    return (Number(signature.naturalHeight) || 1) / (Number(signature.naturalWidth) || 1)
      * (pageWidth / pageHeight);
  }

  async pickSignature() {
    if (!this.active) {
      await this.open();
      if (!this.active) return;
    }
    const opened = this.openSignaturePicker?.({
      signatures: this._savedSignatures(),
      onPick: (signature) => this._useSignature(signature),
      onImport: () => this._importSignature(),
      onDelete: (signature) => this._forgetSignature(signature),
    });
    if (!opened) this._importSignature();
  }

  _savedSignatures() {
    const list = this.view?.plugin?.settings?.pdfSignatures;
    if (!Array.isArray(list)) return [];
    return list
      .filter((entry) => entry && typeof entry.dataUrl === "string" && entry.dataUrl.startsWith("data:image/"))
      .slice(-MAX_SAVED_SIGNATURES);
  }

  _persistSignatures(signatures) {
    const settings = this.view?.plugin?.settings;
    if (!settings) return;
    settings.pdfSignatures = signatures.slice(-MAX_SAVED_SIGNATURES);
    try {
      const saving = this.view.plugin.saveAll?.();
      if (saving?.catch) saving.catch(() => {});
    } catch { /* keep the in-memory library for this session */ }
  }

  _rememberSignature(signature) {
    const list = this._savedSignatures();
    if (list.some((entry) => entry.dataUrl === signature.dataUrl)) return;
    list.push(signature);
    this._persistSignatures(list);
  }

  _forgetSignature(signature) {
    const list = this._savedSignatures().filter((entry) => entry.id !== signature.id);
    this._persistSignatures(list);
  }

  _useSignature(signature) {
    this.pendingSignature = {
      dataUrl: signature.dataUrl,
      naturalWidth: Number(signature.naturalWidth) || 1,
      naturalHeight: Number(signature.naturalHeight) || 1,
    };
    this.view?.areaEl?.addClass?.("qiaomu-reader-pdf-form-signing");
    this.notify(this.translate("click-to-place-signature"));
    this.onChange();
  }

  _importSignature() {
    const doc = this._doc || this.view?.areaEl?.ownerDocument || globalThis.document;
    const input = element(doc, "input", "qiaomu-reader-pdf-signature-picker", {
      type: "file",
      accept: "image/png,image/jpeg,image/webp",
    });
    input.style.display = "none";
    doc.body?.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const dataUrl = String(reader.result || "");
        if (!dataUrl) return;
        const image = doc.createElement("img");
        image.addEventListener("load", () => {
          const signature = {
            id: `saved-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            dataUrl,
            naturalWidth: image.naturalWidth || 1,
            naturalHeight: image.naturalHeight || 1,
            createdAt: Date.now(),
          };
          this._rememberSignature(signature);
          this._useSignature(signature);
        });
        image.addEventListener("error", () => this.notify(this.translate("signature-image-invalid")));
        image.src = dataUrl;
      });
      reader.readAsDataURL(file);
    }, { once: true });
    input.click();
  }

  _onSurfaceClick(event) {
    if (!this.active || !this.pendingSignature) return;
    const surface = event.target?.closest?.(".qiaomu-reader-pdf-page-surface");
    if (!surface) return;
    if (event.target?.closest?.(".qiaomu-reader-pdf-form-input, .qiaomu-reader-pdf-comb-field, .qiaomu-reader-pdf-signature")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = surface.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    const page = pageNumberForSurface(surface);
    if (!page) return;
    const pending = this.pendingSignature;
    let width = 0.24;
    let height = width * (pending.naturalHeight / pending.naturalWidth) * ((this.pages.get(page)?.width || 612) / (this.pages.get(page)?.height || 792));
    if (height > 0.2) {
      height = 0.2;
      width = height * (pending.naturalWidth / pending.naturalHeight) * ((this.pages.get(page)?.height || 792) / (this.pages.get(page)?.width || 612));
    }
    const signature = {
      id: `sig${++this._signatureSeq}`,
      page,
      left: clamp(x - width / 2, 0, 1 - width),
      top: clamp(y - height / 2, 0, 1 - height),
      width,
      height,
      dataUrl: pending.dataUrl,
      naturalWidth: pending.naturalWidth,
      naturalHeight: pending.naturalHeight,
    };
    this.signatures.push(signature);
    this.pendingSignature = null;
    this.view?.areaEl?.removeClass?.("qiaomu-reader-pdf-form-signing");
    this.mountPage(surface, page);
    this._changed();
  }

  _onKeyDown(event) {
    if (event.key !== "Escape") return;
    if (this.pendingSignature) {
      this.pendingSignature = null;
      this.view?.areaEl?.removeClass?.("qiaomu-reader-pdf-form-signing");
      this.onChange();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  _changed() {
    this.onChange();
  }

  async save() {
    if (!this.active || !this.available || this._acting) return;
    this._acting = true;
    this.onChange();
    try {
      const values = this.fields.map((field) => ({
        xref: field.xref,
        value: field.kind === "checkbox" ? Boolean(this.values.get(field.id)) : String(this.values.get(field.id) ?? ""),
      }));
      const signatures = this.signatures.map((signature) => ({
        page: signature.page,
        left: signature.left,
        top: signature.top,
        width: signature.width,
        height: signature.height,
        data: signature.dataUrl,
      }));
      const result = await this.bridge.save({
        path: this.file.path,
        root: this._vaultRoot(),
        settings: this.view?.plugin?.settings || {},
        values,
        signatures,
      });
      if (result?.cancelled) return;
      if (!result?.ok) throw new Error(String(result?.error || "save failed"));
      const locked = result.locked != null ? Boolean(result.locked) : signatures.length > 0;
      this.notify(this.translate(locked ? "signed-copy-saved-0" : "saved-0-2", result.output || ""));
      // Acrobat keeps an unsigned form editable after Save; a signed copy is
      // flattened and locks immediately.
      if (locked) {
        this.locked = true;
        this.deactivate();
      }
    } catch (error) {
      this.notify(`${this.translate("signed-copy-save-failed")}: ${String(error?.message || error)}`);
    } finally {
      this._acting = false;
      this.onChange();
    }
  }
}

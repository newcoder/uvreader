// buildCustomFontInput lives here so the reader logic stays host-agnostic.
import { FONT_FILE_ACCEPT, importedReaderFonts, listSystemFonts, readerFontStore } from "./reader-fonts.js";
import { docOf, winOf } from "./reader-dom.js";
import { normalizeCustomFontFamily, resolveReaderFont } from "./reader-appearance.js";

export function createBuildCustomFontInput({
  FONTS, ReaderFontPicker, qiaomuReaderTranslate,
}) {
  function buildCustomFontInput(host, plugin, apply) {
  const settings = plugin.settings;
  const wrap = host.createDiv("qiaomu-reader-custom-font");
  const actions = wrap.createDiv("qiaomu-reader-font-actions");
  const system = actions.createEl("button", { text: qiaomuReaderTranslate("choose-installed-font"), attr: { type: "button" } });
  const upload = actions.createEl("button", { text: qiaomuReaderTranslate("import-font-file"), attr: { type: "button" } });
  actions.createEl("a", { text: qiaomuReaderTranslate("download-more-fonts"), href: "https://github.com/newcoder/uvreader/blob/main/fonts/README.md", attr: { target: "_blank", rel: "noopener noreferrer" } });
  const files = wrap.createEl("input", { type: "file", attr: { accept: FONT_FILE_ACCEPT, "aria-label": qiaomuReaderTranslate("import-font-file") } });
  files.hidden = true;
  const saved = wrap.createDiv("qiaomu-reader-imported-fonts");
  const selected = wrap.createDiv("qiaomu-reader-font-selected");
  const status = wrap.createDiv({ cls: "qiaomu-reader-font-status", attr: { role: "status" } });
  const advanced = wrap.createEl("details");
  advanced.createEl("summary", { text: qiaomuReaderTranslate("enter-font-name-manually") });
  const label = advanced.createEl("label", { text: qiaomuReaderTranslate("font-name-font-family") });
  const input = label.createEl("input", { type: "text", cls: "qiaomu-reader-panel-input" });
  input.value = settings.customFontFamily || "";
  input.placeholder = '"georgia", serif';
  advanced.createDiv({ cls: "qiaomu-reader-pan-hint", text: qiaomuReaderTranslate("enter-an-installed-font-name-or-a-comma-separated-fallback-list") });
  const error = advanced.createDiv({ cls: "qiaomu-reader-custom-font-error", attr: { role: "status" } });
  let busy = false;
  const setBusy = (value) => {
    busy = value;
    system.disabled = upload.disabled = input.disabled = value;
    saved.querySelectorAll("button").forEach((button) => { button.disabled = value; });
  };
  const commit = async (family, imported = null) => {
    const previous = { customFontFamily: settings.customFontFamily, customFontId: settings.customFontId, importedFonts: settings.importedFonts };
    if (imported) {
      await readerFontStore(plugin).load(docOf(wrap), imported);
      settings.importedFonts = [...importedReaderFonts(settings).filter((font) => font.id !== imported.id), imported];
    }
    settings.customFontId = imported?.id || "";
    settings.customFontFamily = family;
    if (await plugin._saveLocalData() === false) {
      Object.assign(settings, previous);
      throw new Error("save");
    }
    refresh();
    await apply();
  };
  const choose = async (font) => {
    if (busy) return;
    setBusy(true);
    try {
      await commit(font.family || "", font.id ? font : null);
      status.setText(font.id ? qiaomuReaderTranslate("the-font-is-saved-in-the-vault-and-syncs-with-vault-files") : qiaomuReaderTranslate("installed-fonts-are-available-only-on-devices-where-they-are-ins"));
    } catch { status.setText(qiaomuReaderTranslate("could-not-apply-the-font-check-the-font-file-and-vault-write-acc")); }
    finally { setBusy(false); }
  };
  const refresh = () => {
    wrap.hidden = settings.fontFamily !== "custom";
    const font = importedReaderFonts(settings).find((item) => item.id === settings.customFontId);
    selected.setText(font?.name || settings.customFontFamily || qiaomuReaderTranslate("no-custom-font-selected"));
    selected.style.fontFamily = resolveReaderFont(settings, FONTS);
    input.value = settings.customFontFamily || "";
    saved.empty();
    for (const item of importedReaderFonts(settings)) {
      const button = saved.createEl("button", { text: item.name, attr: { type: "button", "aria-pressed": String(item.id === settings.customFontId) } });
      button.disabled = busy;
      button.addEventListener("click", () => { void choose(item); });
    }
  };
  system.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    status.setText(qiaomuReaderTranslate("reading-installed-fonts"));
    try {
      const fonts = await listSystemFonts(winOf(wrap));
      if (!wrap.isConnected) return;
      status.setText(fonts.length ? qiaomuReaderTranslate("found-0-installed-font-families", fonts.length) : qiaomuReaderTranslate("no-installed-fonts-were-returned-import-a-font-file-instead"));
      if (fonts.length) new ReaderFontPicker(plugin.app, fonts, choose).open();
    } catch {
      status.setText(qiaomuReaderTranslate("this-device-cannot-list-installed-fonts-or-access-was-denied-use"));
    } finally { setBusy(false); }
  });
  upload.addEventListener("click", () => { if (!busy) files.click(); });
  files.addEventListener("change", async () => {
    const file = files.files?.[0];
    files.value = "";
    if (!file || busy) return;
    setBusy(true);
    status.setText(qiaomuReaderTranslate("importing-font"));
    try {
      const font = await readerFontStore(plugin).importFile(docOf(wrap), file);
      await commit("", font);
      status.setText(qiaomuReaderTranslate("the-font-is-saved-in-the-vault-and-syncs-with-vault-files"));
    } catch (cause) {
      status.setText(cause?.message === "format" ? qiaomuReaderTranslate("choose-a-valid-ttf-otf-woff-or-woff2-font-file")
        : cause?.message === "size" ? qiaomuReaderTranslate("font-files-must-not-be-empty-or-larger-than-64-mb")
          : qiaomuReaderTranslate("font-import-failed-check-that-the-font-is-valid-and-the-vault-is"));
    } finally { setBusy(false); }
  });
  input.addEventListener("change", async () => {
    const value = normalizeCustomFontFamily(input.value);
    input.setAttribute("aria-invalid", String(value === null));
    error.setText(value === null ? qiaomuReaderTranslate("enter-font-names-separated-by-commas-not-css-rules") : "");
    if (value === null || busy) return;
    await choose({ family: value });
  });
  refresh();
  return refresh;
}
  return buildCustomFontInput;
}

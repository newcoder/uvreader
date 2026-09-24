import { selectionActionPreferences } from "./selection-preferences.js";
import { watchQuietUi } from "./quiet-ui.js";
import { STARTER_BOOKS } from "./starter-book-data.js";
import { createStarterLibraryInstaller, findStarterBook } from "./starter-library.js";
import { isNonChineseSource } from "./ai-source-language.js";
import { HL_COLOR_SWATCHES } from "./highlight-colors.js";
/*
 * UV Reader — source.
 *
 * Reads EPUB and PDF inside Obsidian and turns highlights into notes. Third
 * party libraries (pdf.js, epub.js, JSZip) come from npm and are bundled by
 * esbuild at build time — see esbuild.config.mjs for what gets stubbed out.
 */
import { AbstractInputSuggest, Component, FuzzySuggestModal, ItemView, MarkdownView, MarkdownRenderer, Menu, Modal, Notice, Platform, Plugin, PluginSettingTab, Scope, SecretComponent, Setting, TFile, TFolder, normalizePath, requestUrl, setIcon } from "obsidian";
import { EpubEngine, ENGINE_EXTENSIONS, coverFromBytes } from "./reader-engine.js";
import { coverPalette, migrateCoverCache } from "./book-cover.js";
// One place decides which extensions the reader opens: the rendering engine
// handles everything here except PDF, which keeps its dedicated pdf.js path.
const BOOK_EXTENSIONS = new Set([...ENGINE_EXTENSIONS, "pdf"]);
// Obsidian's Electron can lag the latest Chromium proposal set. The regular
// pdf.js 6 build calls Map#getOrInsertComputed, which is not available there and
// makes every page render fail. The supported legacy browser build includes the
// required compatibility layer while exposing the same API.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { classifyAiHttpStatus } from "./ai-providers.js";
import {
  effectiveCapability,
  interpretImageProbe,
  interpretToolsProbe,
  makeProbeImage,
  rememberCapability,
} from "./ai-capability.js";
import {
  MAX_AI_ATTACHMENTS,
  aiAttachmentPath,
  aiAttachmentsHaveImages,
  base64FromBytes,
  blobFromBase64,
  bytesFromBase64,
  hydrateAiAttachments,
  intakeAiFiles,
  normalizeAiAttachments,
  stripAttachmentData,
} from "./ai-attachments.js";
import { composeAiAnswerNote } from "./ai-note.js";
import { suggestAiNoteTitle } from "./ai-note-title.js";
import { addMissingQuoteLinks, highlightBacklink, jumpToEngineHighlight } from "./highlight-navigation.js";
import { bindAiComposer } from "./ai-composer.js";
import { DRAFT_LIMIT, loadAiDrafts } from "./ai-drafts.js";
import { aiAnswerMarker, appendAiAnswer, verifiedQuotes, normalizeLocationMarks } from "./reading-workflow.js";
import { searchableQuery, searchBookBlocks, nextSearchIndex } from "./reader-search.js";
import { captureReadingAnchor, restoreReadingAnchor, queueReadingLayout, shouldFollowContext, comfortableLineWidth, zoomAnchorOffset, textPoint } from "./reader-experience.js";
import { PDF_AI_CONTEXT_MAX_CHARS, READER_BLOCK_SELECTOR } from "./pdf-page-mode.js";
import { PDF_ZOOM_DEFAULT, PDF_ZOOM_MAX, PDF_ZOOM_MIN, clampPdfZoom, pdfZoomFromWheel, pdfZoomPercent, pdfZoomShortcut, stepPdfZoom } from "./pdf-zoom.js";
import { appendReadingNoteExcerpts, isReadingHighlightsHeading, migrateAndReplaceReadingHighlights, replaceManagedReadingHighlights } from "./reading-note.js";
import { QIAOMU_READER_EN } from "./i18n-en.js";
import { QIAOMU_READER_ZH_CN } from "./i18n-zh.js";
import { translateUiText } from "./i18n-runtime.js";
import { UI_LANGUAGES, normalizeUiLanguage, uiLanguageMetadata } from "./i18n-languages.js";
import { READER_THEMES, READER_THEME_CHOICES, migrateReaderTheme } from "./reader-themes.js";
import { FONT_FILE_ACCEPT, disposeReaderFonts, importedReaderFonts, listSystemFonts, readerFontStore } from "./reader-fonts.js";
import { normalizeCustomFontFamily, resolveReaderFont, readerTextCss, syncPageButtons } from "./reader-appearance.js";
import { BUNDLED_FONT_FAMILIES, ensureBundledReaderFont } from "./bundled-fonts.js";
import { cloneJson, createSerialTaskQueue, isPlainRecord, mergeReadingProgress, readJsonRecordStore, writeVerifiedJsonRecord } from "./storage.js";
import { createReaderLoadCoordinator, isReaderLoadAbort, throwIfReaderLoadAborted, waitForReaderFrame } from "./reader-load.js";
import { docOf, selOf, winOf } from "./reader-dom.js";
import { iconLabel, svgIcon } from "./reader-icons.js";
import { createPageJump } from "./page-jump.js";
import { createPdfZoomUi } from "./pdf-zoom-ui.js";
import { createSelectionActions } from "./selection-actions.js";
import { lookupSelection, lookupWordGloss } from "./pinyin-annotate.js";
import { createPinPopup } from "./pin-popup.js";
import { openShotOverlay, planRegionStitch } from "./reader-shot.js";
import { createReaderTimer } from "./reader-timer.js";
import { createReaderHud } from "./reader-hud.js";
import { createReaderView } from "./reader-view.js";
import { createPlugin } from "./plugin.js";
import { createSettingsTab } from "./settings-tab.js";
import { createBuildBookSettings } from "./book-settings.js";
import { createBuildFindPanelFor } from "./find-panel.js";
import { createAiStreamingMarkdownRendererFactory } from "./ai-streaming-markdown.js";
import { createBuildCustomFontInput } from "./custom-font-input.js";
import { createWhatsNew } from "./whats-new.js";
import { createTranslateModal } from "./translate-modal.js";
import { createAiChatHistoryModal } from "./ai-chat-history-modal.js";
import { createSettingsGroupModal } from "./settings-group-modal.js";
import { createHighlightExportModal } from "./highlight-export-modal.js";
import { createBookSetupModal } from "./book-setup-modal.js";
import { createCreateFolderModal } from "./create-folder-modal.js";
import { createNoteTitleModal } from "./note-title-modal.js";
import { createWhatsNewModal } from "./whats-new-modal.js";
import { createOnboardingModal } from "./onboarding-modal.js";
import { createGoToPageModal } from "./goto-page-modal.js";
import { createInfoModal } from "./info-modal.js";
import { createConfirmModal } from "./confirm-modal.js";
import { createPdfPaginatorClass } from "./pdf-paginator.js";
import { createAiChatView } from "./ai-chat-view.js";
import { createReadSettingsModal } from "./read-settings-modal.js";
import { createAiExplainModal } from "./ai-explain-modal.js";
import { createLibraryModal } from "./library-modal.js";
import { createReaderModal } from "./reader-modal.js";
import { buildTocItems, chapterForBlock, pageForBlock, readerSearchTexts } from "./toc-build.js";
import { createLibraryData, IMPORT_MIME_EXT } from "./library-data.js";
import { createPdfDocument } from "./pdf-document.js";
import { createAiContext } from "./ai-context.js";
import { createReaderChrome } from "./reader-chrome.js";
import { createAiRender } from "./ai-render.js";
import { createPiTransport } from "./ai-pi.js";
import { createNotePaths } from "./note-paths.js";
import { createBookNotes } from "./book-notes.js";


// Interface language is local to this plugin; dictionaries are bundled offline.
let qiaomuReaderLanguage = "zh";
function qiaomuReaderSetLanguage(v) { qiaomuReaderLanguage = normalizeUiLanguage(v); }
const {
  _readerSettings,
  noteTemplatePath,
  bookNoteTemplatePath,
  notesFolderPath,
  bookNotesFolderPath,
  inboxNotePath,
  resolveNotesFolder,
  bookNoteFiles,
  resolveBookNote,
  BookNotePicker,
  BookQuickOpen,
  TemplatePicker,
  vaultFolders,
  FolderPicker,
  FolderSuggest,
  attachFolderSuggest,
  attachPathInput,
  addFolderPathControl,
  addMarkdownFilePathControl,
  sanitizeNoteTitle,
  suggestNoteTitle,
  bindSettingsTabKeys,
  parseNoteTags,
  allVaultTags,
  processTemplateManually,
  bookNoteLinkFor,
  isUnsafeReadingNote,
  isMarkedReadingNote,
  stripGeneratedReadingNoteTitle,
  bookNoteFromFrontmatter,
  writeBookProperty,
  flattenSelectionText,
} = createNotePaths({
  translate: qiaomuReaderTranslate,
  path: qiaomuReaderPath,
  TFile,
  TFolder,
  AbstractInputSuggest,
  FuzzySuggestModal,
  Setting,
  window,
  getCreateFolderModal: () => CreateFolderModal,
});
const {
  aiSecretValue,
  aiConfig,
  aiSetupState,
  aiSetupMessage,
  aiSystemChat,
  defaultAiQuickPrompts,
  aiQuickPrompts,
  normalizeAiChatHistory,
  normalizeAiTurnContext,
  aiChatTitle,
  newAiSessionKey,
  aiContextMessage,
  aiMessages,
  aiTurnsHaveDocumentContext,
  clearAiSource,
  paintAiSource,
  restoreAiSource,
} = createAiContext({ translate: qiaomuReaderTranslate, platform: Platform, win: window, locateHl });
const {
  QUOTE_TEMPLATE_DEFAULT,
  appendLinkToBookNote,
  writeNoteText,
  promptForNoteTitle,
  firstFreeNoteName,
  tagPrefix,
  composeExcerptQuote,
  renderNoteTemplate,
  createTemplatedNote,
  createNoteFromSelection,
  createNoteFromAiAnswer,
  appendAnswerToBookNote,
  _escHtml,
  hlMark,
  normalizeHlText,
  splitExportedHighlights,
  openNoteBesideBook,
  openOrCreateBookNoteBeside,
  addBookFileMenu,
  dropBookState,
  deleteBookFromVault,
  backlinkLabel,
  quoteMarkdown,
  hlCommentMd,
  renderManagedReadingHighlights,
  syncHighlightsToReadingNote,
  exportHighlightsSeparate,
  openNoteInTab,
  collectHighlightGroups,
  exportHighlightsToBookNote,
  exportHighlightsMenu,
  bookNoteAction,
  cmpVer,
  whatsNewSince,
  writeWhatsNewNote,
} = createBookNotes({
  translate: qiaomuReaderTranslate,
  path: qiaomuReaderPath,
  Notice,
  TFile,
  getHlColors: () => HL_COLORS,
  normalizeAiTurnContext,
  readerSettings: _readerSettings,
  getWhatsNew: () => WHATS_NEW,
  noteTemplatePath,
  bookNotesFolderPath,
  notesFolderPath,
  inboxNotePath,
  resolveNotesFolder,
  resolveBookNote,
  bookNoteLinkFor,
  sanitizeNoteTitle,
  suggestNoteTitle,
  isUnsafeReadingNote,
  flattenSelectionText,
  processTemplateManually,
  getNoteTitleModal: () => NoteTitleModal,
  getConfirmModal: () => ConfirmModal,
  getHighlightExportModal: () => HighlightExportModal,
});
const pageJump = createPageJump({
  translate: qiaomuReaderTranslate,
  svgIcon,
  docOf,
  isPdf: readerIsPdf,
  pdfPages: readerPdfPages,
  rememberJump: rememberReaderJump,
});

const pdfZoom = createPdfZoomUi({ translate: qiaomuReaderTranslate, isPdf: readerIsPdf });

const readerHud = createReaderHud({
  translate: qiaomuReaderTranslate,
  notice: (message) => new Notice(message),
  window,
  platform: Platform,
  isPdf: readerIsPdf,
  jumpToHighlight: jumpToEngineHighlight,
  escapeSelector: (value) => CSS.escape(value),
});

// Highlight palette. Labels are lazy thunks: the plugin language is loaded
// after module evaluation, and eager translation here would freeze these four
// names in Russian even when the rest of the interface later switches to
// Chinese or English. Defined before the selection factory below so the bundle
// never captures the hoisted `undefined` placeholder.
const HL_COLORS = HL_COLOR_SWATCHES.map(([id, name, css]) => ({ id, label: () => qiaomuReaderTranslate(name), css }));
const TranslateModal = createTranslateModal({
  Menu,
  Modal,
  Notice,
  setIcon,
  copyToClipboard,
  currentTranslationNote,
  dailyNoteProvider,
  openNoteBesideBook,
  qiaomuReaderTranslate,
  saveTranslationNote,
  translateText,
});
const selectionHud = createSelectionActions({
  translate: qiaomuReaderTranslate,
  Notice, Scope, TranslateModal, setIcon, window,
  isPdf: readerIsPdf,
  hlColorCss,
  hlColors: HL_COLORS,
  positionPopup: readerHud.positionPopup,
  refreshHlPanel: qiaomuReaderRefreshHlPanel,
  autoFocus: readerHud.autoFocus,
  paintAiSource,
  copyToClipboard,
  flowSelectionParts,
  raiseSelectionPopup,
  lookupPinyin: lookupSelection,
  lookupWord: lookupWordGloss,
  translateSelection,
  translationTarget: (view) => translateSelectionTarget(view.plugin.settings),
});

const pinPopup = createPinPopup({
  translate: qiaomuReaderTranslate,
  positionPopup: readerHud.positionPopup,
});

const readerTimer = createReaderTimer({
  translate: qiaomuReaderTranslate,
  notice: (message) => new Notice(message),
  window,
});

const {
  attachEngineChrome,
  handleReaderWheel,
  wireReaderChrome,
  setReaderTitle,
  panelSection,
  buildReaderExtraSettings,
  buildReaderSettPanelBody,
  buildReaderTopBar,
  buildReaderMoreButton,
  buildReaderPageArea,
  buildReaderBotNav,
  buildReaderPanels,
  attachReaderContentClick,
  attachReaderSwipeNav,
} = createReaderChrome({
  translate: qiaomuReaderTranslate,
  Menu,
  Scope,
  svgIcon,
  iconLabel,
  docOf,
  selOf,
  window,
  readerIsPdf,
  clampPdfZoom,
  PDF_ZOOM_DEFAULT,
  readerHud,
  selectionHud,
  addReadingMenuActions,
  openReaderPagePicker,
  openFlowPin: openFlowPinPopup,
  syncPageButtons,
  addReaderNavigation,
  setupReaderSelection,
  setupPdfZoomInteractions,
  buildPageButtonsSetting,
  buildBookSettings: (...args) => buildBookSettings(...args),
  buildCustomFontInput: (...args) => buildCustomFontInput(...args),
  createPdfZoomSettings,
  READER_THEME_CHOICES,
  readerThemeLabel,
  selectedReaderTheme,
  setReaderTheme,
  qiaomuReaderReaderFonts,
  qiaomuReaderFontLabel,
  ensureBundledReaderFont,
});



function qiaomuReaderTranslate(s){
  const lang = qiaomuReaderLanguage || 'zh';
  let out = translateUiText(lang, s, QIAOMU_READER_EN, QIAOMU_READER_ZH_CN);
  if (arguments.length>1){ var a=arguments; out = String(out).replace(/\{(\d+)\}/g, function(m,d){ var v=a[(+d)+1]; return v==null?m:v; }); }
  return out;
}
function qiaomuReaderLocale() {
  return uiLanguageMetadata(qiaomuReaderLanguage).locale;
}

const VIEW_TYPE = "qiaomu-reader";
const AI_CHAT_VIEW_TYPE = "qiaomu-book-reader-ai-chat";
const {
  readerPageContext,
  readerDefaultAiContext,
  readerAiPanelContext,
  readerSupportsAiContext,
  syncReaderAiCapability,
  renderAiHeadMeta,
  enhanceAiMarkdown,
  renderAiMarkdown,
  aiLogFollowsTail,
  createAiChatLog,
  createAiStreamingMarkdownRenderer,
  renderAiContextQuote,
  renderAiAttachmentList,
  openAiAttachMenu,
  closeAiAttachMenu,
  bindReaderAiComposer,
  ReaderNameModal,
  contextualAiQuickPrompts,
  renderAiComposerPrompts,
  bindAiSlashPrompts,
  renderMobileAiHeader,
  renderAiUserTurn,
  syncOpenAiSelectionContext,
  syncOpenAiReaderContext,
} = createAiRender({
  translate: qiaomuReaderTranslate,
  Modal,
  Menu,
  MarkdownRenderer,
  Component,
  normalizeAiTurnContext,
  aiQuickPrompts,
  paintAiSource,
  readerHud,
  readerIsPdf,
  AI_CHAT_VIEW_TYPE,
  getAiChatView: () => AiChatView,
  getConfirmModal: () => ConfirmModal,
  openReadSettings: (app, readerView) => new ReadSettingsModal(app, readerView, "ai").open(),
  openPluginAiSettings,
});
// Settings defaults are assembled from concern-grouped fragments below. The
// fragments are spread in the original key order, so the resulting object keeps
// the exact persisted key layout: same keys, same values, same ordering.
const DEFAULT_SHELF = {
  // Interface language IDs are defined in UI_LANGUAGES.
  language: "zh", booksFolder: "", noteTemplate: "", notesFolder: "", bookNotesFolder: "",
  // Optional template used only for the one reading note created for each book.
  // It is deliberately separate from noteTemplate, which belongs to standalone
  // excerpt notes. Reusing that template could turn a reading note into a person,
  // meeting or project note just because the reader used that template elsewhere.
  bookNoteTemplate: "", autoBookNote: true, quotesToBookNote: true,
  dataFolder: "", bookTemplates: {}, exportColors: true,
};
const DEFAULT_APPEARANCE = {
  theme: "auto", libTheme: "auto", fontSize: 18, fontFamily: "zhuque",
  customFontFamily: "", customFontId: "", importedFonts: [],
  pageButtonsVisibility: "hover", lineHeight: 1.8, columns: "2",
  textAlign: "left", vAlign: "top",
};
const DEFAULT_TRANSLATION = {
  translateEnabled: false, translateTo: "zh-CN",
};
const DEFAULT_LIBRARY_UI = {
  bookNoteLinks: {}, locationMarks: [], bookNotePrompted: {}, coverFits: {},
  syncMode: "auto", libCategory: "all",
};
const DEFAULT_READER_SESSION = {
  readerAdvOpen: false, readerHistOpen: false,
  askNoteTitle: true, shortNoteTitles: true, defaultHlColor: "yellow",
  selectionShowLabels: false, selectionActions: null,
  // The reading chip: pinyin and gloss for Han selections, an AI translation
  // for other scripts.
  autoPinyinInfo: true, autoTranslateEnglish: true,
  // Docked highlights list width, dragged in the reader.
  hlDockWidth: 300,
  bookTags: {}, navMode: "buttons",
  timerEnabled: true, dailyGoalMin: 15, readingLog: {}, lifetimeSeconds: 0,
  // Content-first "immersive" chrome: controls overlay the page and fully
  // retract after a short idle period. The page itself never changes size.
  immersive: true, mobileTopInset: 0,
  onboarded: false, promptedRepaired: false,
  // One-time repair for older builds that inferred a reading note from any
  // Markdown file carrying a `book` property, including templates/person notes.
  readingNoteLinksRepaired: false,
  // One-time data-safe migration: excerpts manually appended by older versions
  // shared the generated highlights section and could be erased by the next sync.
  manualExcerptSectionsMigrated: false,
  figuresShownByDefault: false, einkMode: false,
};
const DEFAULT_AI = {
  aiCompanionVisible: null,
  aiEnabled: false, aiNeedsVerification: false, aiProvider: "",
  // The API key itself lives in Obsidian SecretStorage. data.json keeps only
  // the selected secret ID so vault syncing never copies the key.
  // aiSecret and aiBase remain only as migration bridges for versions before
  // 4.2.13. Active credentials and endpoint overrides are provider-scoped so
  // switching services cannot reuse or erase another service's configuration.
  aiSecret: "", aiKey: "", aiModel: "", aiBase: "",
  aiSecrets: {}, aiBases: {},
  // Model and reasoning choices belong to the provider, not to the global AI
  // switch. A reader can move between Codex and Claude without losing either
  // selection. aiModel remains as a migration bridge for pre-3.7 installs.
  aiModels: {},
  // Provider-specific reasoning switches. An absent DeepSeek entry keeps the
  // service default (thinking enabled), while an explicit false survives
  // switching to another provider and back.
  aiThinking: {},
  // What the configured endpoint proved it can do (probe results per
  // provider/base/model) plus the manual override for a wrong probe.
  aiCapabilities: {},
  aiVisionMode: "auto", aiToolsMode: "auto",
  aiInto: "中文", aiSystem: "",
  // null = use the six built-in reading prompts in the current UI language.
  // Once edited this becomes an array of { id, name, prompt } objects. Keeping
  // the built-ins implicit means switching interface language still translates
  // them until the reader actually customises the library.
  aiQuickPrompts: null,
  // Local, bounded chat snapshots for the right sidebar. They never leave the
  // vault except when the reader explicitly sends a turn to the chosen model.
  aiChatHistory: [],
};
const DEFAULT_READING_FLOW = {
  // The first manual append explains where the excerpt went and offers to open
  // the reading note. Later appends use a quiet toast; the reading-note button is
  // always available when the reader does want to open it.
  bookNoteAppendPromptSeen: false,
  languagePicked: false, readMode: "pages", pageTurnAnimation: true,
  progressToFrontmatter: false, quoteTemplate: "", quoteBacklinks: true,
  quoteBacklinkLabel: "", noteOpenMode: "split", maxLineCh: 0, fitPage: false,
  notesNextToBook: false, perDevice: false, deviceProfiles: {},
  lastSeenVersion: "", whatsNewNote: true,
};
const DEFAULT = Object.assign(
  {},
  DEFAULT_SHELF, DEFAULT_APPEARANCE, DEFAULT_TRANSLATION, DEFAULT_LIBRARY_UI,
  DEFAULT_READER_SESSION, DEFAULT_AI, DEFAULT_READING_FLOW
);

const TRANSLATION_LANGUAGE_CHOICES = Object.freeze([
  ["zh-CN", "simplified-chinese"],
  ["ru", "russian"],
  ["en", "english"],
  ["de", "german"],
  ["fr", "french"],
  ["es", "spanish"],
]);
const THEMES = READER_THEMES;
function readerThemeLabel(id) {
  return qiaomuReaderTranslate((THEMES[id] && THEMES[id].label) || id);
}
function selectedReaderTheme(settings) {
  return migrateReaderTheme(settings.theme);
}
function setReaderTheme(settings, id) {
  settings.einkMode = false;
  settings.theme = migrateReaderTheme(id);
}
function qiaomuReaderLibTheme(settings) {
  const s = settings || {};
  const mode = s.libTheme || "auto";
  if (mode === "reader") return qiaomuReaderTheme(s);
  if (s.einkMode === true) return THEMES.eink;
  return THEMES[mode] || THEMES.auto;
}
function qiaomuReaderTheme(settings) {
  const s = settings || {};
  if (s.einkMode === true) return THEMES.eink;
  return THEMES[s.theme] || THEMES.auto;
}
const READER_FONTS = Object.freeze({
  custom: {
    id: "custom",
    stack: "Georgia,serif",
    labels: { ru: "custom-font", en: "Custom font", zh: "自定义字体" },
  },
  georgia: {
    id: "georgia",
    stack: "Georgia,'Times New Roman',serif",
    labels: { ru: "Georgia", en: "Georgia", zh: "Georgia" },
  },
  lora: {
    id: "lora",
    stack: "'Lora',Georgia,serif",
    labels: { ru: "Lora", en: "Lora", zh: "Lora" },
  },
  inter: {
    id: "inter",
    stack: "'Inter',system-ui,sans-serif",
    labels: { ru: "Inter", en: "Inter", zh: "Inter" },
  },
  systemSans: {
    id: "systemSans",
    stack: "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC','Noto Sans SC',sans-serif",
    labels: { ru: "system-sans-serif", en: "System sans", zh: "系统黑体" },
    cjk: true,
  },
  sourceHanSerif: {
    id: "sourceHanSerif",
    stack: `'Source Han Serif CN','Source Han Serif SC','思源宋体 CN','Noto Serif CJK SC','Noto Serif SC','Songti SC','STSong','SimSun',serif`,
    labels: { ru: "Source Han Serif", en: "Source Han Serif", zh: "思源宋体" },
    cjk: true,
  },
  sourceHanSans: {
    id: "sourceHanSans",
    stack: `'Source Han Sans CN','Source Han Sans SC','思源黑体 CN','Noto Sans CJK SC','Noto Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif`,
    labels: { ru: "Source Han Sans", en: "Source Han Sans", zh: "思源黑体" },
    cjk: true,
  },
  songti: {
    id: "songti",
    stack: "'Songti SC','STSong','SimSun','Noto Serif CJK SC','Noto Serif SC',serif",
    labels: { ru: "cjk-serif", en: "CJK serif", zh: "宋体" },
    cjk: true,
  },
  kaiti: {
    id: "kaiti",
    stack: "'Kaiti SC','STKaiti','KaiTi','Noto Serif CJK SC','Songti SC',serif",
    labels: { ru: "kaiti", en: "Kaiti", zh: "楷体" },
    cjk: true,
  },
  lxgw: {
    id: "lxgw",
    stack: `'LXGW WenKai GB Screen','LXGW WenKai Screen','LXGW WenKai','霞鹜文楷','Songti SC','STSong','Noto Serif CJK SC',serif`,
    labels: { ru: "LXGW WenKai", en: "LXGW WenKai", zh: "霞鹜文楷" },
    cjk: true,
  },
  zhenkai: {
    id: "zhenkai",
    stack: `'LXGW ZhenKai GB','霞鹜臻楷 GB','Kaiti SC','STKaiti','KaiTi','Noto Serif CJK SC',serif`,
    labels: { ru: "LXGW ZhenKai GB", en: "LXGW ZhenKai GB", zh: "霞鹜臻楷 GB" },
    cjk: true,
  },
  zhuque: {
    id: "zhuque",
    stack: `'${BUNDLED_FONT_FAMILIES.zhuque}','Zhuque Fangsong (technical preview)','朱雀仿宋（预览测试版）','FangSong','STFangsong','Noto Serif CJK SC','Songti SC',serif`,
    labels: { ru: "Zhuque Fangsong", en: "Zhuque Fangsong", zh: "朱雀仿宋" },
    cjk: true,
  },
});
const FONTS = Object.fromEntries(Object.values(READER_FONTS).map((font) => [font.id, font.stack]));
function qiaomuReaderReaderFonts() { return Object.values(READER_FONTS); }
function qiaomuReaderFontLabel(font) { return font.labels[qiaomuReaderLanguage] || qiaomuReaderTranslate(font.labels.ru); }
async function ensureSelectedReaderFont(doc, plugin, settings = plugin.settings) {
  if (settings.fontFamily !== "custom" || !settings.customFontId) {
    return ensureBundledReaderFont(doc, settings.fontFamily);
  }
  try {
    const font = importedReaderFonts(settings).find((item) => item.id === settings.customFontId);
    if (!font) throw new Error("missing");
    await readerFontStore(plugin).load(doc, font);
    plugin._fontLoadErrors?.delete(font.id);
    return true;
  } catch {
    if (!plugin._fontLoadErrors) plugin._fontLoadErrors = new Set();
    if (!plugin._fontLoadErrors.has(settings.customFontId)) {
      plugin._fontLoadErrors.add(settings.customFontId);
      new Notice(qiaomuReaderTranslate("the-imported-font-is-unavailable-using-a-fallback-check-file-syn"));
    }
    return false;
  }
}
const ReaderFontPicker = class extends FuzzySuggestModal {
  constructor(app, fonts, choose) {
    super(app);
    this.fonts = fonts;
    this.choose = choose;
    this.setPlaceholder(qiaomuReaderTranslate("search-fonts"));
  }
  getItems() { return this.fonts; }
  getItemText(font) { return font.name; }
  renderSuggestion(match, el) {
    const font = match.item;
    el.createDiv({ text: font.name });
    const preview = el.createDiv({ cls: "qiaomu-reader-font-choice-preview", text: qiaomuReaderTranslate("mountains-and-pages-reading-123") });
    preview.style.fontFamily = font.family;
  }
  onChooseItem(font) { void this.choose(font); }
};
const buildCustomFontInput = createBuildCustomFontInput({
  FONTS,
  ReaderFontPicker,
  qiaomuReaderTranslate,
});
function buildPageButtonsSetting(host, plugin) {
  new Setting(host)
    .setName(qiaomuReaderTranslate("page-turn-buttons"))
    .addDropdown((d) => d
      .addOption("hover", qiaomuReaderTranslate("show-when-pointer-approaches"))
      .addOption("always", qiaomuReaderTranslate("always-show"))
      .setValue(plugin.settings.pageButtonsVisibility || "hover")
      .onChange(async (value) => {
        plugin.settings.pageButtonsVisibility = value;
        const readers = plugin.app.workspace.getLeavesOfType(VIEW_TYPE).map((leaf) => leaf.view);
        if (plugin._openReaderModal) readers.push(plugin._openReaderModal);
        for (const reader of readers) {
          syncPageButtons(reader);
          if (reader.bookHtml && typeof reader.repaginate === "function") await reader.repaginate();
          else if (reader.bookHtml && typeof reader._repaginate === "function") await reader._repaginate();
        }
        await plugin.saveAll();
      }));
}
function hlColorCss(colorId) {
  const swatch = HL_COLORS.find((entry) => entry.id === colorId) || HL_COLORS[0];
  return swatch.css;
}
function qiaomuReaderPath(p) {
  const trimmed = String(p == null ? "" : p).trim();
  if (!trimmed) return "";
  try {
    const normalized = normalizePath(trimmed);
    return normalized === "/" ? "" : normalized;
  } catch {
    return trimmed.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  }
}
const libraryData = createLibraryData({ translate: qiaomuReaderTranslate, path: qiaomuReaderPath });
const DEVICE_KEYS = ["theme", "fontSize", "fontFamily", "customFontFamily", "customFontId", "pageButtonsVisibility", "lineHeight", "columns", "textAlign", "vAlign", "einkMode"];
function qiaomuReaderDeviceKey() {
  let key = "desktop";
  try {
    if (Platform?.isPhone) key = "phone";
    else if (Platform?.isTablet) key = "tablet";
  } catch {
    // Optional step; a failure here must not interrupt reading.
  }
  return key;
}
function applyDeviceProfile(target) {
  if (!target?.perDevice) return;
  const profile = (target.deviceProfiles || {})[qiaomuReaderDeviceKey()];
  if (!profile) { return; }
  for (const field of DEVICE_KEYS) {
    if (profile[field] === undefined) continue;
    target[field] = profile[field];
  }
}
function captureDeviceProfile(target) {
  if (!target?.perDevice) return;
  target.deviceProfiles = target.deviceProfiles || {};
  const key = qiaomuReaderDeviceKey();
  const profiles = target.deviceProfiles;
  const profile = profiles[key] || (profiles[key] = {});
  for (const field of DEVICE_KEYS) profile[field] = target[field];
}
// hunting and makes the symptom impossible instead: the curtain (qiaomu-reader-booting)
const QIAOMU_READER_SETTLE_MS = 200;
function qiaomuReaderRevealWhenSettled(view) {
  const area = view.areaEl;
  if (!area) return;
  const win = winOf(area);
  win.clearTimeout(view._revealT);
  const width = () => (view.areaEl ? view.areaEl.clientWidth : 0);
  let last = width();
  const check = () => {
    if (!view.areaEl) return;
    const now = width();
    if (now !== last) { last = now; view._revealT = win.setTimeout(check, QIAOMU_READER_SETTLE_MS); return; }
    view.areaEl.removeClass("qiaomu-reader-booting");
    readerHud.hideVeil(view);
  };
  view._revealT = win.setTimeout(check, QIAOMU_READER_SETTLE_MS);
}
const QIAOMU_READER_SEL_HL = "qiaomu-reader-selection";
function qiaomuReaderPaintSelection(view, range) {
  try {
    if (!readerHud.isMobile(view.app)) return;
    if (view.pager && view.pager.scrollMode) return;
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight !== "function") return;
    CSS.highlights.set(QIAOMU_READER_SEL_HL, new Highlight(range.cloneRange()));
  } catch { /* decoration: never let it interrupt selecting */ }
}
function qiaomuReaderClearPaintedSelection() {
  try { if (typeof CSS !== "undefined" && CSS.highlights) CSS.highlights.delete(QIAOMU_READER_SEL_HL); }
  catch { /* nothing painted is a fine outcome */ }
}
// Reader layout and UI timing tunables.
const
  SHORT_PAGE_GAP = 0.35,
  FOUND_PAINT_MS = 4000,
  MAX_BOOK_COMMANDS = 60;
// Local calendar day (YYYY-MM-DD) backing every reading-log lookup.
const readerTodayKey = () => {
  const fallbackKey = () => new Date().toISOString().slice(0, 10);
  try { return window.moment ? window.moment().format("YYYY-MM-DD") : fallbackKey(); }
  catch { return fallbackKey(); }
};

function fmtReadTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  if (total < 60) {
    return total > 0 ? qiaomuReaderTranslate("less-than-a-minute") : "—";
  }
  const totalMin = Math.floor(total / 60);
  if (totalMin < 60) return qiaomuReaderTranslate("0-min", totalMin);
  const hours = Math.floor(totalMin / 60), spareMin = totalMin % 60;
  if (hours < 24) {
    return spareMin ? qiaomuReaderTranslate("0-h-1-min", hours, spareMin) : qiaomuReaderTranslate("0-h", hours);
  }
  const days = Math.floor(hours / 24), spareHours = hours % 24;
  return spareHours ? qiaomuReaderTranslate("0-d-1-h", days, spareHours) : qiaomuReaderTranslate("0-d", days);
}
function shiftDayKey(dayKey, dayDelta) {
  const anchor = new Date(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return dayKey;
  anchor.setUTCDate(anchor.getUTCDate() + dayDelta);
  return anchor.toISOString().slice(0, 10);
}
function readingStreak(dayLog, todayKey) {
  if (!dayLog) return 0;
  const readThatDay = (k) => (dayLog[k] || 0) > 0;
  let cursor = readThatDay(todayKey) ? todayKey : shiftDayKey(todayKey, -1);
  if (!readThatDay(cursor)) return 0;
  let streak = 0;
  while (streak < 4000 && readThatDay(cursor)) { streak += 1; cursor = shiftDayKey(cursor, -1); }
  return streak;
}
function readingStats(dayLog, lifetimeSeconds, todayKey) {
  const log = dayLog || {};
  const dayKeys = Object.keys(log);
  let loggedSeconds = 0, daysRead = 0, best = 0, bestDay = "";
  for (const k of dayKeys) {
    const sec = log[k] || 0;
    loggedSeconds += sec;
    if (sec > 0) daysRead += 1;
    if (sec > best) { best = log[k]; bestDay = k; }
  }
  const recent = Array.from({ length: 14 }, (_, idx) => {
    const key = shiftDayKey(todayKey, idx - 13);
    return { key, sec: log[key] || 0 };
  });
  return {
    total: Math.max(lifetimeSeconds || 0, loggedSeconds),
    today: log[todayKey] || 0,
    streak: readingStreak(log, todayKey),
    daysRead,
    best,
    bestDay,
    avgPerDay: daysRead ? Math.round(loggedSeconds / daysRead) : 0,
    recent,
  };
}
// Reading-time tracking. Each open reader runs one interval that accrues
// seconds into the plugin day/lifetime logs, flushing to disk every
// TIMER_FLUSH_TICKS ticks and once when the daily goal is first reached.












// iframe events do not bubble to the host's immersive chrome or tap zones.
// Convert section coordinates before reusing the reader's navigation rules.
async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* optional step; a failure here must not interrupt reading */ }
  try {
    const ta = activeDocument.createElement("textarea");
    ta.value = text;
    ta.addClass("qiaomu-reader-offscreen");
    activeDocument.body.appendChild(ta);
    ta.select();
    const ok = activeDocument.execCommand("copy");
    activeDocument.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

let workerReady = false;
async function setupWorker(app) {
  if (workerReady)
    return;
  try {
    const code = __PDF_WORKER_CODE__;
    if (!code) throw new Error("embedded pdf.worker is empty");
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
      new Blob([code], { type: "application/javascript" })
    );
    workerReady = true;
    return;
  } catch (e) {
    console.error("UV Reader: could not start the embedded pdf.worker", e);
    new Notice(qiaomuReaderTranslate("could-not-prepare-pdf-reading-please-reinstall-the-plugin"));
  }
  workerReady = true;
}
const { extractPdf } = createPdfDocument({ setupWorker, win: window });

const PdfPaginator = createPdfPaginatorClass({
  FONTS,
  READER_FONTS,
  SHORT_PAGE_GAP,
  currentLanguage: () => qiaomuReaderLanguage,
});
function createPdfPaginator(view) {
  const pager = new PdfPaginator();
  pager.loadFont = (doc, settings) => ensureSelectedReaderFont(doc, view.plugin, settings);
  pager.pdfZoom = clampPdfZoom(view.pdfZoom);
  pager.onSpreadChange = (cur, total) => {
    if (view._openingBook || view._layoutPromise || view._closed) return;
    (view.updateUI || view._updateUI).call(view, cur, total);
    if (view.file) view.plugin.saveProgress(view.file.path, cur, total, pager.currentBlockIndex());
  };
  return pager;
}
function readerPaginationMappingCollapsed(pager) {
  if (!pager || pager.scrollMode || pager.total < 4 || typeof pager._blocks !== "function") return false;
  const blocks = pager._blocks();
  if (!blocks || blocks.length < 8) return false;
  // During a sidebar/workspace transition Chromium can report the final book
  // width while its multicol geometry is still stale. The end marker then says
  // the book has many spreads, but every real text block maps to spread zero:
  // the first screen is blank until any later resize happens to repaginate it.
  const probes = [blocks.length - 1, Math.floor(blocks.length / 2), Math.floor(blocks.length / 4)];
  return probes.every((index) => pager.spreadForBlock(index) === 0);
}
const TRANSLATE_CHUNK_LIMIT = 1600;

// Splits oversized input on sentence ends, falling back to spaces, then to a
// hard cut. Each produced piece is at most `limit` characters long.
function splitTranslateChunks(text, limit) {
  const pieces = [];
  let rest = text;
  while (rest.length > limit) {
    const sentence = rest.lastIndexOf(". ", limit);
    const anchor = sentence >= limit * 0.4 ? sentence : rest.lastIndexOf(" ", limit);
    const width = anchor > 0 ? anchor + 1 : limit;
    pieces.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function translateRequestUrl(chunk, target) {
  return "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto"
    + `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(chunk)}`;
}

function translateHttpError(message, reason, status) {
  const err = new Error(message);
  err.qiaomuReaderReason = reason;
  if (status !== undefined) err.qiaomuReaderStatus = status;
  return err;
}

async function requestTranslatedSegment(chunk, target) {
  const res = await requestUrl({ url: translateRequestUrl(chunk, target), method: "GET", throw: false });
  if ([429, 503].includes(res.status)) throw translateHttpError("translate rate-limited", "limit");
  if (res.status < 200 || 300 <= res.status) {
    throw translateHttpError(`translate http ${res.status}`, "http", res.status);
  }
  const payload = res.json;
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) throw new Error("unexpected translate response");
  return payload[0].map((part) => (part && part[0]) || "").join("");
}

async function translateText(text, to = "ru") {
  const raw = text || "";
  const q = raw.replace(/\s+/g, " ").trim();
  if (!q.length) return "";
  let translated = "";
  for (const chunk of splitTranslateChunks(q, TRANSLATE_CHUNK_LIMIT)) {
    translated += await requestTranslatedSegment(chunk, to);
  }
  return translated.trim();
}
function updateEngineLocation(view, detail) {
  if (!detail || view._closed) return;
  view._engineLocation = detail;
  const pct = Math.round(Math.max(0, Math.min(1, detail.fraction || 0)) * 100);
  if (view.pbarFill) view.pbarFill.style.width = `${pct}%`;
  view.pctEl?.setText(`${pct}%`);
  view.locEl?.setText(detail.tocItem?.label || qiaomuReaderTranslate("reading-position"));
  if (view.pageInputEl) pageJump.update(view);
  syncReaderAiCapability(view);
  if (!view._openingBook) {
    syncOpenAiReaderContext(view);
    if (detail.cfi && Number.isFinite(detail.fraction)) {
      void view.plugin.saveEngineProgress(view.file.path, detail.fraction, detail.cfi);
    }
  }
}
function settleReader(view, delay = 220) {
  window.clearTimeout(view._contextSettleTimer);
  if (view.engine) {
    updateEngineLocation(view, view.engine.currentLocation());
    return;
  }
  view._contextSettleTimer = window.setTimeout(() => {
    if (view._openingBook || view._closed || view._layoutPromise || !view.pager?.flow?.isConnected || !view.areaEl?.clientWidth) return;
    if (Math.abs(view.areaEl.clientWidth - view.pager.builtWidth) >= 8) return;
    const moving = view.pager.flow.getAnimations?.().some((animation) => animation.playState === "running" || animation.pending);
    if (moving) { settleReader(view, 60); return; }
    view._readingAnchor = captureReadingAnchor(view.pager);
    syncOpenAiReaderContext(view);
    if (!readerIsPdf(view)) {
      const chapter = chapterForBlock(view.tocItems || [], view._readingAnchor?.block || 0);
      view.locEl?.setText(chapter || qiaomuReaderTranslate("reading-position"));
      view.locEl?.setAttribute("title", chapter || qiaomuReaderTranslate("reading-position"));
      view.pctEl?.setText(`${Math.round(view.pager.currentPct * 100)}%`);
    }
  }, delay);
}
function rememberReaderJump(view) {
  if (view.engine) {
    const cfi = view.engine.currentLocation()?.cfi;
    if (cfi) readerHud.showReturn(view, { cfi });
    return;
  }
  if (!readerIsPdf(view) || !view.pager?.flow) return;
  if (!view.pager.scrollMode) view.pager.applyTransform(false);
  const anchor = captureReadingAnchor(view.pager);
  readerHud.showReturn(view, anchor);
}
function addReaderNavigation(view, bot, findBtn, tocBtn, showTools = true) {
  if (showTools === false) return;
  bot.addClass("qiaomu-reader-navigation");
  const toggle = (name) => (view.togglePanel || view._togglePanel).call(view, name);
  const tools = bot.createDiv("qiaomu-reader-navigation-tools");
  view.tocBtn = tocBtn || tools.createEl("button", { cls: "qiaomu-reader-ibtn", attr: { type: "button", "aria-label": qiaomuReaderTranslate("table-of-contents") } });
  view.findBtn = findBtn || tools.createEl("button", { cls: "qiaomu-reader-ibtn", attr: { type: "button", "aria-label": qiaomuReaderTranslate("search-the-book") } });
  if (tocBtn) tools.appendChild(tocBtn);
  else { svgIcon(view.tocBtn, "list"); view.tocBtn.addEventListener("click", () => toggle("toc")); }
  if (findBtn) tools.appendChild(findBtn);
  else {
    svgIcon(view.findBtn, "search");
    view.findBtn.addEventListener("click", () => { toggle("find"); if (view.panelOpen === "find") view._findInput?.focus(); });
  }
  bot.prepend(tools);
}
function syncNavigationPanel(view, name) {
  if (name === "find") view._searchReturnSaved = false;
  view.contentEl?.toggleClass("qiaomu-reader-navigation-open", name === "find" || name === "toc");
  view.findPan?.toggleClass("qiaomu-reader-panel-open", name === "find");
  view.findBtn?.setAttribute("aria-expanded", String(name === "find"));
  view.tocBtn?.setAttribute("aria-expanded", String(name === "toc"));
}
async function jumpToAiQuote(plugin, file, quote) {
  plugin._aiQuoteJumpController?.abort();
  const controller = new AbortController();
  plugin._aiQuoteJumpController = controller;
  const current = () => !controller.signal.aborted;
  try {
    const target = plugin.app.vault.getAbstractFileByPath(file.path);
    if (!(target instanceof TFile)) throw new Error("Missing book");
    const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE).find(l => l.view.file?.path === target.path);
    const modal = plugin._openReaderModal;
    const view = modal?.file?.path === target.path ? modal : leaf?.view || await plugin.openFile(target);
    if (!current()) return;
    // Reveal before waiting: a background window can suspend the renderer's RAF.
    if (leaf && view === leaf.view) await plugin.app.workspace.revealLeaf(leaf);
    const valid = () => current() && !view?._closed && view?.file?.path === target.path;
    const deadline = Date.now() + 15000;
    while (valid() && Date.now() < deadline && (view._openingBook || (!view.engine && !view.pager?.flow))) {
      await new Promise(resolve => window.setTimeout(resolve, 100));
    }
    if (!valid()) return;
    if (view._openingBook || (!view.engine && !view.pager?.flow)) throw new Error("Book not ready");
    const engine = view.engine;
    const hits = [];
    if (engine) {
      // A citation lookup must not clear or cancel the user's book search.
      for await (const hit of engine.search(quote, { paint: false, limit: 2, signal: controller.signal })) {
        if (!valid() || view.engine !== engine) return;
        hits.push(hit);
        if (hits.length === 2) break;
      }
    } else hits.push(...searchBookBlocks(readerSearchTexts(view.pager.flow), quote, 2));
    if (!valid() || view.engine !== engine) return;
    if (hits.length !== 1) {
      if (view.panelOpen !== "find") (view.togglePanel || view._togglePanel).call(view, "find");
      view._findInput.value = quote;
      view._findInput.dispatchEvent(new (view._findInput.ownerDocument.defaultView.Event)("input"));
      view._findInput.focus();
      new Notice(qiaomuReaderTranslate("no-unique-source-location-found-please-check-the-search-results"));
      return;
    }
    if (engine) {
      await jumpToEngineHighlight(view, hits[0]);
      return;
    }
    rememberReaderJump(view);
    const [cur, total] = restoreReadingAnchor(view.pager, { block: hits[0].block, offset: hits[0].offset, pct: view.pager.currentPct });
    (view.updateUI || view._updateUI).call(view, cur, total);
    markFoundIn(view, quote);
    await plugin.saveProgress(target.path, cur, total, view.pager.currentBlockIndex());
  } catch {
    if (current()) new Notice(qiaomuReaderTranslate("cannot-locate-the-source-check-that-the-book-is-still-in-the-vau"));
  } finally {
    if (plugin._aiQuoteJumpController === controller) plugin._aiQuoteJumpController = null;
  }
}

function showLocationMarks(view) {
  const modal = new Modal(view.app);
  modal.onOpen = () => {
    const c = modal.contentEl;
    c.empty(); c.createEl("h3", { text: qiaomuReaderTranslate("location-bookmarks") });
    const marks = normalizeLocationMarks(view.plugin.settings.locationMarks).filter((item) => item.bookPath === view.file?.path
      && (view.engine ? !!item.anchor.cfi : readerIsPdf(view) && !item.anchor.cfi));
    if (!marks.length) c.createDiv({ text: qiaomuReaderTranslate("no-location-bookmarks-yet") });
    const save = async (items) => {
      const previous = view.plugin.settings.locationMarks;
      view.plugin.settings.locationMarks = items;
      try { await view.plugin.saveAll(); modal.onOpen(); }
      catch (error) { view.plugin.settings.locationMarks = previous; throw error; }
    };
    for (const mark of marks) {
      const row = c.createDiv("qiaomu-reader-location-mark");
      row.createEl("button", { cls: "qiaomu-reader-location-mark-open", text: mark.title }).addEventListener("click", () => {
        if (view.file?.path !== mark.bookPath) return;
        if (view.engine) {
          if (!mark.anchor.cfi) return;
          rememberReaderJump(view);
          void jumpToEngineHighlight(view, { cfi: mark.anchor.cfi })
            .then(() => modal.close())
            .catch(() => new Notice(qiaomuReaderTranslate("highlight-not-found")));
          return;
        }
        if (!readerIsPdf(view)) return;
        rememberReaderJump(view);
        const [cur, total] = restoreReadingAnchor(view.pager, mark.anchor);
        (view.updateUI || view._updateUI).call(view, cur, total);
        void view.plugin.saveProgress(view.file.path, cur, total, view.pager.currentBlockIndex());
        modal.close();
      });
      const rename = row.createEl("button", { cls: "qiaomu-reader-ibtn", attr: { "aria-label": qiaomuReaderTranslate("rename-bookmark") } });
      setIcon(rename, "pencil");
      rename.addEventListener("click", () => new ReaderNameModal(view.app, qiaomuReaderTranslate("rename-bookmark"), mark.title, (title) => save(normalizeLocationMarks(view.plugin.settings.locationMarks).map((item) => item.id === mark.id ? { ...item, title } : item))).open());
      const del = row.createEl("button", { cls: "qiaomu-reader-ibtn", attr: { "aria-label": qiaomuReaderTranslate("delete-bookmark") } });
      setIcon(del, "trash");
      del.addEventListener("click", () => new ConfirmModal(view.app, {
        title: qiaomuReaderTranslate("delete-bookmark"), body: mark.title, okText: qiaomuReaderTranslate("delete"), cancelText: qiaomuReaderTranslate("cancel"),
        onYes: async () => { try { await save(normalizeLocationMarks(view.plugin.settings.locationMarks).filter((item) => item.id !== mark.id)); } catch { new Notice(qiaomuReaderTranslate("saving-failed-check-vault-permissions-and-retry")); } },
      }).open());
    }
  };
  modal.open();
}

function addLocationMark(view) {
  if (!view.file || view._openingBook || view._closed) return;
  const file = view.file;
  const location = view.engine?.currentLocation();
  const anchor = view.engine ? (location?.cfi ? { cfi: location.cfi, pct: location.fraction } : null)
    : readerIsPdf(view) && view.pager?.flow ? captureReadingAnchor(view.pager) : null;
  if (!anchor) return;
  const excerpt = view.engine ? view.engine.visibleText().slice(0, 100)
    : view.pager.blockEl(anchor.block)?.textContent.slice(anchor.offset, anchor.offset + 100) || "";
  const label = view.engine ? location.tocItem?.label || qiaomuReaderTranslate("reading-position")
    : qiaomuReaderTranslate("page-0", anchor.pdfPage || 1);
  new ReaderNameModal(view.app, qiaomuReaderTranslate("bookmark-this-location"), label, async (title) => {
    const old = view.plugin.settings.locationMarks;
    view.plugin.settings.locationMarks = normalizeLocationMarks([...normalizeLocationMarks(old), { id: newAiSessionKey(), bookPath: file.path, title, excerpt, anchor }]);
    try { await view.plugin.saveAll(); }
    catch (error) { view.plugin.settings.locationMarks = old; throw error; }
  }).open();
}

function addReadingMenuActions(menu, view) {
  menu.addItem((it) => it.setTitle(qiaomuReaderTranslate("bookmark-this-location")).setIcon("bookmark-plus").onClick(() => addLocationMark(view)));
  menu.addItem((it) => it.setTitle(qiaomuReaderTranslate("location-bookmarks")).setIcon("bookmark").onClick(() => showLocationMarks(view)));
  if (view.plugin.settings.timerEnabled) menu.addItem((it) => it.setTitle(qiaomuReaderTranslate(view._running ? "pause-timer" : "start-timer")).setIcon(view._running ? "pause" : "play").onClick(() => readerTimer.toggle(view)));
}
function setReadingFocus(view, enabled) {
  if (view.app.isMobile) return;
  const workspace = view.app.workspace;
  if (enabled && !view._focusRestore) {
    if (!view.engine) {
      if (view.pager?.flow && !view.pager.scrollMode) view.pager.applyTransform(false);
      view._readingAnchor = captureReadingAnchor(view.pager);
    }
    const keepAiVisible = !workspace.rightSplit?.collapsed && workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE).some(
      (leaf) => leaf.getRoot() === workspace.rightSplit && leaf.view.containerEl.isShown()
    );
    view._focusRestore = [workspace.leftSplit, workspace.rightSplit].map((side) => ({ side, collapsed: side?.collapsed }));
    for (const { side } of view._focusRestore) {
      if (side !== workspace.rightSplit || !keepAiVisible) side?.collapse();
    }
  } else if (!enabled && view._focusRestore) {
    const restore = view._focusRestore;
    view._focusRestore = null;
    for (const { side, collapsed } of restore) {
      if (collapsed === false) side?.expand();
      else if (collapsed === true) side?.collapse();
    }
  }
  view.contentEl?.toggleClass("qiaomu-reader-reading-focus", !!view._focusRestore);
  if (view._focusRestore && !view._focusExit) {
    const exit = view.contentEl.createEl("button", { cls: "qiaomu-reader-ibtn qiaomu-reader-focus-exit", attr: { type: "button", "aria-label": qiaomuReaderTranslate("exit-focus-reading") } });
    setIcon(exit, "minimize");
    exit.addEventListener("click", () => setReadingFocus(view, false));
    view._focusExit = exit;
  } else if (!view._focusRestore) {
    view._focusExit?.remove();
    view._focusExit = null;
  }
  view.focusBtn?.setAttribute("aria-pressed", String(!!view._focusRestore));
  view.focusBtn?.setAttribute("aria-label", qiaomuReaderTranslate(view._focusRestore ? "exit-focus-reading" : "focus-reading"));
  if (view.focusBtn) setIcon(view.focusBtn, view._focusRestore ? "minimize" : "maximize");
}
function setupReaderSelection(view) {
  const area = view.areaEl;
  const doc = area.ownerDocument;
  const down = (event) => selectionHud.beginReaderSelection(view, event);
  const up = () => {
    if (!view._selectionDragging) return;
    view._selectionDragging = false;
    view._scheduleSelCheck();
  };
  // The selection popup carries every action; right-click only suppresses the
  // platform menu so no second, duplicated menu appears.
  const context = (event) => event.preventDefault();
  const outside = (event) => {
    if (view._selectionMenuOpen || view.hlPopup?.contains(event.target) || area.contains(event.target)) return;
    view._hideHlPopup();
  };
  area.addEventListener("contextmenu", context);
  doc.addEventListener("pointerdown", outside);
  area.addEventListener("pointerdown", down);
  doc.addEventListener("pointerup", up);
  doc.addEventListener("pointercancel", up);
  view._selectionCleanup = () => {
    view._hideHlPopup();
    view._selectionMenu?.hide();
    window.clearTimeout(view._selectionFeedbackTimer);
    view._selectionFeedback?.remove();
    area.removeEventListener("contextmenu", context);
    doc.removeEventListener("pointerdown", outside);
    area.removeEventListener("pointerdown", down);
    doc.removeEventListener("pointerup", up);
    doc.removeEventListener("pointercancel", up);
  };
}
function readerIsPdf(view) {
  const extension = String(view?.file?.extension || view?.ext || "").toLowerCase();
  return extension === "pdf" || /\.pdf$/i.test(String(view?.file?.path || ""));
}
function readerPdfPages(view) {
  return [...(view.pager?.flow?.querySelectorAll(".qiaomu-reader-pdf-page-break[data-pdf-page-no]") || [])];
}
function pdfVisiblePageLabel(view, first) {
  const count = readerPdfPages(view).length;
  const columns = view.pager?.scrollMode ? 1 : (view.pager?.cols || 1);
  const last = Math.min(count, first + columns - 1);
  return last > first ? `${first}–${last}` : first;
}

function openReaderPagePicker(view) {
  if (!view.file || !view.pager?.total) return;
  const pager = view.pager;
  const pages = readerIsPdf(view) ? readerPdfPages(view) : [];
  new GoToPageModal(view.app, pages.length || pager.total, pages.length ? (pager.currentPdfPageNumber() || 1) - 1 : pager.spread, (n) => {
    rememberReaderJump(view);
    if (pages.length && pager.scrollMode) {
      pager.clip.scrollTop += pages[n - 1].getBoundingClientRect().top - pager.clip.getBoundingClientRect().top;
      pager.spread = Math.min(pager.total - 1, Math.floor(pager.clip.scrollTop / Math.max(1, pager.clip.clientHeight)));
    } else if (pages.length) {
      const x = pages[n - 1].getBoundingClientRect().left - pager.flow.getBoundingClientRect().left;
      pager.jumpTo(Math.floor(Math.round(x / (pager.sw / (pager.cols || 1))) / (pager.cols || 1)));
    } else pager.jumpTo(n - 1);
    (view.updateUI || view._updateUI).call(view, pager.spread, pager.total);
    void view.plugin.saveProgress(view.file.path, pager.spread, pager.total, pager.currentBlockIndex());
  }).open();
}
function showPdfZoomMenu(view, event) {
  const menu = new Menu();
  addPdfZoomMenuItems(menu, view);
  menu.showAtMouseEvent(event);
}
class PdfZoomModal extends Modal {
  constructor(app, view) { super(app); this.view = view; }
  onOpen() {
    this.setTitle(qiaomuReaderTranslate("custom-pdf-zoom"));
    const input = this.contentEl.createEl("input", { type: "number", attr: { min: String(PDF_ZOOM_MIN * 100), max: String(PDF_ZOOM_MAX * 100), step: "5", "aria-label": qiaomuReaderTranslate("zoom-percentage") } });
    input.value = String(Math.round(clampPdfZoom(this.view.pdfZoom) * 100));
    const apply = () => {
      if (!input.checkValidity() || !input.value) { input.reportValidity(); return; }
      pdfZoom.apply(this.view, Number(input.value) / 100);
      this.close();
    };
    this.contentEl.createEl("button", { text: qiaomuReaderTranslate("apply"), cls: "mod-cta" }).addEventListener("click", apply);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") apply(); });
    readerHud.autoFocus(input);
  }
}
function createPdfZoomControls(parent, view) {
  const group = parent.createDiv("qiaomu-reader-pdf-zoom-control");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", qiaomuReaderTranslate("pdf-zoom"));
  const out = group.createEl("button", {
    cls: "qiaomu-reader-pdf-zoom-step",
    attr: { type: "button", "aria-label": qiaomuReaderTranslate("zoom-pdf-out") },
  });
  svgIcon(out, "minus");
  const label = group.createEl("button", { cls: "qiaomu-reader-pdf-zoom-value", attr: { type: "button" } });
  const input = group.createEl("button", {
    cls: "qiaomu-reader-pdf-zoom-step",
    attr: { type: "button", "aria-label": qiaomuReaderTranslate("zoom-pdf-in") },
  });
  svgIcon(input, "plus");
  out.addEventListener("click", () => pdfZoom.change(view, -1));
  label.addEventListener("click", (event) => showPdfZoomMenu(view, event));
  input.addEventListener("click", () => pdfZoom.change(view, 1));
  view.pdfZoomControlEl = group;
  view.pdfZoomOutEl = out;
  view.pdfZoomLabelEl = label;
  view.pdfZoomInEl = input;
  const pan = group.createEl("button", { cls: "qiaomu-reader-pdf-zoom-step", attr: { type: "button", "aria-label": qiaomuReaderTranslate("pan-pdf"), "aria-pressed": "false" } });
  setIcon(pan, "hand");
  pan.addEventListener("click", () => pdfZoom.setPanMode(view, !view.pdfPanMode));
  view.pdfPanButton = pan;
  pdfZoom.syncControls(view);
  return group;
}
function createPdfZoomSettings(parent, view) {
  const row = parent.createDiv("qiaomu-reader-sz-row qiaomu-reader-pdf-zoom-settings");
  const out = row.createEl("button", {
    cls: "qiaomu-reader-sz-btn",
    attr: { type: "button", "aria-label": qiaomuReaderTranslate("zoom-pdf-out") },
  });
  svgIcon(out, "minus");
  const label = row.createEl("button", {
    cls: "qiaomu-reader-sz-label qiaomu-reader-pdf-zoom-settings-value",
    attr: { type: "button", "aria-label": qiaomuReaderTranslate("fit-page") },
  });
  const input = row.createEl("button", {
    cls: "qiaomu-reader-sz-btn",
    attr: { type: "button", "aria-label": qiaomuReaderTranslate("zoom-pdf-in") },
  });
  svgIcon(input, "plus");
  out.addEventListener("click", () => pdfZoom.change(view, -1));
  label.addEventListener("click", (event) => showPdfZoomMenu(view, event));
  input.addEventListener("click", () => pdfZoom.change(view, 1));
  view.pdfZoomSettingsLabelEl = label;
  pdfZoom.syncControls(view);
  parent.createDiv("qiaomu-reader-pan-hint").setText(qiaomuReaderTranslate("100-fits-the-page-pan-or-scroll-after-zooming-in"));
}
function addPdfZoomMenuItems(menu, view) {
  if (!readerIsPdf(view)) return;
  const zoom = clampPdfZoom(view.pdfZoom);
  menu.addSeparator();
  menu.addItem((item) => item
    .setTitle(qiaomuReaderTranslate("zoom-pdf-out-0", pdfZoomPercent(zoom)))
    .setIcon("zoom-out")
    .setDisabled(zoom <= PDF_ZOOM_MIN + 0.001)
    .onClick(() => pdfZoom.change(view, -1)));
  menu.addItem((item) => item
    .setTitle(qiaomuReaderTranslate("fit-page-100"))
    .setIcon("scan")
    .setDisabled(Math.abs(zoom - PDF_ZOOM_DEFAULT) < 0.001)
    .onClick(() => pdfZoom.apply(view, PDF_ZOOM_DEFAULT, null, "page")));
  menu.addItem((item) => item.setTitle(qiaomuReaderTranslate("custom-pdf-zoom")).setIcon("percent").onClick(() => new PdfZoomModal(view.app, view).open()));
  menu.addItem((item) => item.setTitle(qiaomuReaderTranslate("pan-pdf")).setIcon("hand").setChecked(!!view.pdfPanMode).onClick(() => pdfZoom.setPanMode(view, !view.pdfPanMode)));
  menu.addItem((item) => item
    .setTitle(qiaomuReaderTranslate("zoom-pdf-in-0", pdfZoomPercent(zoom)))
    .setIcon("zoom-in")
    .setDisabled(zoom >= PDF_ZOOM_MAX - 0.001)
    .onClick(() => pdfZoom.change(view, 1)));
}
function setupPdfZoomInteractions(view) {
  const area = view?.areaEl;
  if (!area) return;
  let drag = null;
  area.addEventListener("pointerdown", (event) => {
    if (!readerIsPdf(view) || event.pointerType === "touch" || !(view.pdfPanMode || event.button === 1)) return;
    const page = event.target.closest?.(".qiaomu-reader-pdf-page-break");
    const scroller = view.pager.scrollMode ? view.pager.clip : page;
    if (!scroller) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { scroller, x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    view._pdfPanning = true;
    area.setPointerCapture(event.pointerId);
  }, true);
  area.addEventListener("pointermove", (event) => {
    if (!drag) return;
    event.preventDefault();
    drag.scroller.scrollLeft = drag.left + drag.x - event.clientX;
    drag.scroller.scrollTop = drag.top + drag.y - event.clientY;
  });
  const endDrag = () => { if (drag) view._pdfPanEndedAt = Date.now(); drag = null; view._pdfPanning = false; };
  area.addEventListener("pointerup", endDrag);
  area.addEventListener("pointercancel", endDrag);
  area.addEventListener("lostpointercapture", endDrag);
  area.addEventListener("click", (event) => {
    if (view.pdfPanMode || Date.now() - (view._pdfPanEndedAt || 0) < 300) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  area.addEventListener("wheel", (event) => {
    if (!readerIsPdf(view) || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    pdfZoom.apply(view, pdfZoomFromWheel(view.pdfZoom, event.deltaY), event);
  }, { passive: false });

  let pinchDistance = 0;
  let pinchZoom = PDF_ZOOM_DEFAULT;
  const distance = (touches) => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );
  area.addEventListener("touchstart", (event) => {
    if (!readerIsPdf(view) || event.touches.length !== 2) return;
    pinchDistance = distance(event.touches);
    pinchZoom = clampPdfZoom(view.pdfZoom);
  }, { passive: true });
  area.addEventListener("touchmove", (event) => {
    if (!readerIsPdf(view) || event.touches.length !== 2 || pinchDistance <= 0) return;
    event.preventDefault();
    pdfZoom.apply(view, pinchZoom * distance(event.touches) / pinchDistance, {
      clientX: (event.touches[0].clientX + event.touches[1].clientX) / 2,
      clientY: (event.touches[0].clientY + event.touches[1].clientY) / 2,
    });
  }, { passive: false });
  area.addEventListener("touchend", (event) => {
    if (event.touches.length < 2) pinchDistance = 0;
  }, { passive: true });
  area.addEventListener("touchcancel", () => { pinchDistance = 0; }, { passive: true });
}
// The desktop shell exposes its pi-ai runtime through the preload bridge; the
// reader only sees the stable aiExplain contract.
const aiRuntimeBridge = typeof window !== "undefined" && window.qbrDesktop ? window.qbrDesktop.ai || null : null;
const { aiExplainStream, aiExplain, aiTranslate, aiProbe } = createPiTransport({
  bridge: aiRuntimeBridge,
  aiConfig,
  aiMessages,
});

// --- AI attachments --------------------------------------------------------
// Images and small text files for the next turn. Only metadata and a
// thumbnail are persisted with the conversation; the bytes live in the data
// folder and are re-read when a saved chat is sent again.
function aiAttachmentFolder(settings) {
  const folder = String(settings?.dataFolder || "plugin").replace(/[\\/]+$/, "");
  return `${folder}/ai-files`;
}

async function ensureAiAttachmentFolder(plugin) {
  const folder = aiAttachmentFolder(plugin.settings);
  if (plugin.app.vault.getAbstractFileByPath(folder)) return folder;
  try { await plugin.app.vault.createFolder(folder); } catch { /* already there */ }
  return folder;
}

async function saveAiAttachment(plugin, attachment) {
  if (!attachment?.data || attachment.file) return attachment;
  const path = aiAttachmentPath(plugin.settings.dataFolder, attachment);
  try {
    await ensureAiAttachmentFolder(plugin);
    await plugin.app.vault.createBinary(path, bytesFromBase64(attachment.data).buffer);
    return { ...attachment, file: path };
  } catch {
    return attachment;
  }
}

// Whether any user turn carries an attachment; a text-only send then skips the
// async preparation entirely.
function aiTurnsHaveAttachments(turns) {
  return (turns || []).some((turn) => turn?.role === "user" && normalizeAiAttachments(turn.attachments).length > 0);
}

// The outbound history: previous turns re-read their stored image bytes so a
// follow-up question stays in context. An image turn also has to prove the
// model supports images first (detected or manually overridden); a model that
// does not gets no image request at all. `vision` tells the runtime whether the
// request may carry images.
async function prepareAiTurns(chat, turns) {
  const out = [];
  for (const turn of turns || []) {
    if (turn?.role !== "user" || !normalizeAiAttachments(turn.attachments).length) { out.push(turn); continue; }
    out.push({ ...turn, attachments: await hydrateAiAttachments(turn.attachments, (path) => readAiAttachmentBytes(chat.plugin, path)) });
  }
  const vision = out.some((turn) => turn?.attachments?.some((attachment) => attachment.kind === "image" && attachment.data));
  if (vision) {
    const plugin = chat.plugin;
    const cfg = aiConfig(plugin);
    const target = { id: cfg.id, base: cfg.base, model: cfg.model };
    let capability = effectiveCapability(plugin.settings, target, "image");
    if (capability.state === "unknown" && capability.source === "none") {
      try { capability = { state: (await detectAiCapability(plugin, "image")).state, source: "probe", at: Date.now() }; }
      catch (error) { if (!(error && error.qiaomuReaderReason)) throw error; }
    }
    if (capability.state === "no") {
      const error = new Error("the model does not support images");
      error.qiaomuReaderReason = "novision";
      throw error;
    }
  }
  return { turns: out, vision };
}

// A send that failed because the endpoint refused the image: remember that as
// the endpoint's real answer instead of retrying into the same wall.
async function noteAiImageFailure(chat) {
  const plugin = chat?.plugin;
  if (!plugin) return;
  const cfg = aiConfig(plugin);
  rememberCapability(plugin.settings, { id: cfg.id, base: cfg.base, model: cfg.model }, "image", "no");
  await plugin.saveAll();
  chat._renderAttachments?.();
}

async function readAiAttachmentBytes(plugin, path) {
  try {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!file) return "";
    return base64FromBytes(await plugin.app.vault.readBinary(file));
  } catch {
    return "";
  }
}

function aiAttachmentNotice(errors) {
  for (const error of errors || []) {
    const key = error.reason === "imagetooolarge" ? "image-is-too-large-keep-it-under-6-mb"
      : error.reason === "texttoolarge" ? "text-file-is-too-large-keep-it-under-200-kb"
        : error.reason === "unsupported" ? "only-images-and-small-text-files-can-be-attached"
          : "the-file-could-not-be-read";
    new Notice(qiaomuReaderTranslate(key), 6000);
  }
}

function aiAttachmentFile(entry) {
  const blob = blobFromBase64(entry.data, entry.mimeType || "");
  const ctor = typeof File === "function" ? File : null;
  if (!ctor) throw new Error("qiaomu-reader-file-unavailable");
  return new ctor([blob], entry.name || "image", { type: entry.mimeType || blob.type || "" });
}

async function attachAiFiles(chat, files, source = "pick") {
  const list = Array.from(files || []);
  if (!list.length) return;
  const room = MAX_AI_ATTACHMENTS - (chat.attachments?.length || 0);
  if (room <= 0) {
    new Notice(qiaomuReaderTranslate("at-most-4-attachments"), 6000);
    return;
  }
  const result = await intakeAiFiles(list.slice(0, room), { win: window, source });
  aiAttachmentNotice(result.errors);
  const saved = [];
  for (const attachment of result.attachments) saved.push(await saveAiAttachment(chat.plugin, attachment));
  chat.attachments = normalizeAiAttachments([...(chat.attachments || []), ...saved]);
  chat._renderAttachments?.();
}

async function pickAiAttachments(chat, kind = "image") {
  const bridge = typeof window !== "undefined" && window.qbrDesktop ? window.qbrDesktop.ai : null;
  if (bridge?.pickFiles) {
    let result = null;
    try { result = await bridge.pickFiles(kind); } catch { result = null; }
    if (!result) { new Notice(qiaomuReaderTranslate("the-file-could-not-be-read"), 6000); return; }
    const files = [];
    for (const entry of result.files || []) {
      if (!entry?.ok) { aiAttachmentNotice([{ reason: entry?.reason || "unreadable" }]); continue; }
      try { files.push(aiAttachmentFile(entry)); } catch { aiAttachmentNotice([{ reason: "unreadable" }]); }
    }
    if (files.length) await attachAiFiles(chat, files, "pick");
    return;
  }
  // Hosts without the desktop bridge (Obsidian, mobile): a hidden file input.
  const doc = docOf(chat.contentEl);
  const input = doc.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = kind === "image"
    ? "image/png,image/jpeg,image/webp,image/gif"
    : ".txt,.md,.markdown,.csv,.json,.log,image/png,image/jpeg,image/webp,image/gif";
  input.addEventListener("change", () => { void attachAiFiles(chat, input.files, "pick"); });
  input.click();
}

async function removeAiAttachment(chat, id) {
  const attachment = (chat.attachments || []).find((item) => item.id === id);
  chat.attachments = (chat.attachments || []).filter((item) => item.id !== id);
  chat._renderAttachments?.();
  if (!attachment?.file) return;
  try {
    const file = chat.plugin.app.vault.getAbstractFileByPath(attachment.file);
    if (file) await chat.plugin.app.vault.delete(file);
  } catch { /* an orphan file is harmless */ }
}

function bindAiAttachmentIntake(chat, host, input) {
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  host.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    host.addClass("qiaomu-reader-ai-drop");
  });
  host.addEventListener("dragleave", () => host.removeClass("qiaomu-reader-ai-drop"));
  host.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    host.removeClass("qiaomu-reader-ai-drop");
    void attachAiFiles(chat, event.dataTransfer?.files, "drop");
  });
  input?.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => String(file.type || "").startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void attachAiFiles(chat, files, "paste");
  });
}

// --- Screenshots -----------------------------------------------------------
// A drag-box screenshot of the reading area. The desktop shell captures the
// composited frame (so spreads, scroll mode and iframes all work); hosts
// without that bridge fall back to cropping the rendered PDF page images.
function screenshotName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `截图 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;
}

async function capturePdfRegion(view, region) {
  const flow = view?.pager?.flow;
  const doc = docOf(view?.areaEl || view?.contentEl);
  if (!flow || !doc) return null;
  const pages = [...flow.querySelectorAll(".qiaomu-reader-pdf-page-break[data-pdf-page-no]")];
  const entries = [];
  for (const page of pages) {
    const image = page.querySelector(".qiaomu-reader-pdf-page-img");
    const rect = (image || page).getBoundingClientRect();
    if (rect.bottom < region.y || rect.top > region.y + region.height
      || rect.right < region.x || rect.left > region.x + region.width) continue;
    let source = image;
    if (!source || !source.naturalWidth) {
      // A page that has not rasterised yet (or a text page): render it now.
      const pageNumber = Number(page.dataset.pdfPageNo) || 0;
      const rendered = pageNumber ? await view._pdfLazy?.render?.(pageNumber, doc).catch(() => null) : null;
      if (rendered?.src) {
        source = await new Promise((resolve) => {
          const img = doc.createElement("img");
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = rendered.src;
        });
      }
    }
    if (!source?.naturalWidth) continue;
    entries.push({
      rect: source.getBoundingClientRect(),
      imageWidth: source.naturalWidth,
      imageHeight: source.naturalHeight,
      node: source,
    });
  }
  const plan = planRegionStitch(region, entries);
  if (!plan) return null;
  const canvas = doc.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const item of plan.items) {
    ctx.drawImage(item.page.node, item.source.x, item.source.y, item.source.width, item.source.height,
      item.target.x, item.target.y, item.target.width, item.target.height);
  }
  const data = String(canvas.toDataURL("image/png")).split(",")[1] || "";
  canvas.width = 0;
  canvas.height = 0;
  if (!data) return null;
  return { data, mimeType: "image/png", bytes: Math.ceil((data.length * 3) / 4), width: plan.width, height: plan.height, source: "shot" };
}

// Draw a box over the reading area and attach the captured region. The
// capability gate from the attachment path decides whether images may go out
// at all, so the entry point can stay available.
async function captureAiScreenshot(chat) {
  const view = chat?.readerView?.areaEl?.isConnected ? chat.readerView : chat?.plugin?._openReaderModal;
  if (!view?.areaEl) {
    new Notice(qiaomuReaderTranslate("open-a-book-first"), 6000);
    return;
  }
  const overlay = openShotOverlay({ host: view.areaEl, translate: qiaomuReaderTranslate });
  const rect = await overlay.promise;
  if (!rect) return;
  const bridge = typeof window !== "undefined" && window.qbrDesktop ? window.qbrDesktop.ai : null;
  let entry = null;
  if (bridge?.captureRegion) {
    const result = await bridge.captureRegion(rect);
    if (!result?.ok) {
      new Notice(qiaomuReaderTranslate("screenshot-failed-try-again"), 6000);
      return;
    }
    entry = {
      data: result.data,
      mimeType: result.mimeType || "image/png",
      bytes: Number(result.bytes) || Math.ceil((String(result.data || "").length * 3) / 4),
      width: Number(result.width) || 0,
      height: Number(result.height) || 0,
      source: "shot",
    };
  } else {
    entry = await capturePdfRegion(view, rect);
    if (!entry) {
      new Notice(qiaomuReaderTranslate(readerIsPdf(view) ? "screenshot-failed-try-again" : "screenshots-in-this-format-need-the-desktop-app"), 8000);
      return;
    }
  }
  entry.name = screenshotName();
  await attachAiFiles(chat, [aiAttachmentFile(entry)], "shot");
}

// Detect whether the configured model accepts image parts or a tools array.
// The probe runs once per provider/base/model and the result is remembered, so
// the reader never claims a capability the endpoint did not prove.
async function detectAiCapability(plugin, kind) {
  const cfg = aiConfig(plugin);
  const target = { id: cfg.id, base: cfg.base, model: cfg.model };
  const probeImage = kind === "image"
    ? makeProbeImage(typeof window !== "undefined" ? window : globalThis)
    : null;
  if (kind === "image" && !probeImage) throw new Error("the probe image could not be created");
  const expected = kind === "image" ? probeImage.digits : "7";
  const result = await aiProbe(kind, plugin, { image: probeImage?.image || null, expected });
  const state = kind === "image" ? interpretImageProbe(result, expected) : interpretToolsProbe(result, expected);
  rememberCapability(plugin.settings, target, kind, state);
  await plugin.saveAll();
  return { state, result };
}

// The selection chip translates non-Han text with the configured AI service.
// The target language is the one chosen for the translate action.
function translateSelectionTarget(settings) {
  const choice = TRANSLATION_LANGUAGE_CHOICES.find(([value]) => value === (settings.translateTo || "zh-CN"))
    || TRANSLATION_LANGUAGE_CHOICES[0];
  return qiaomuReaderTranslate(choice[1]);
}
async function translateSelection(view, text) {
  const state = aiSetupState(view.plugin);
  if (!state.enabled) {
    const error = new Error("AI is not configured");
    error.qiaomuReaderReason = state.reason || "notconfigured";
    // Signals the chip to offer the AI conversation instead of a retry.
    error.qiaomuReaderSetup = true;
    throw error;
  }
  return aiTranslate(text, view.plugin, { target: translateSelectionTarget(view.plugin.settings) });
}
// Mobile uses the same attached-source composer as the desktop sidebar. The
// source is context for the next turn, not a permanent banner above the chat.
const AiExplainModal = createAiExplainModal({
  Component,
  Menu,
  Modal,
  Notice,
  aiExplain,
  aiLogFollowsTail,
  aiTurnsHaveAttachments,
  bindAiAttachmentIntake,
  bindAiSlashPrompts,
  bindReaderAiComposer,
  bookNoteLinkFor,
  captureAiScreenshot,
  copyToClipboard,
  createAiChatLog,
  createAiStreamingMarkdownRenderer,
  createNoteFromAiAnswer,
  jumpToAiQuote,
  newAiSessionKey,
  normalizeAiTurnContext,
  noteAiImageFailure,
  openAiAttachMenu,
  pickAiAttachments,
  prepareAiTurns,
  qiaomuReaderTranslate,
  readerHud,
  removeAiAttachment,
  renderAiAttachmentList,
  renderAiComposerPrompts,
  renderAiContextQuote,
  renderAiUserTurn,
  renderMobileAiHeader,
  stripAiAttachmentData: stripAttachmentData,
});
async function aiTestConnection(plugin) {
  const cfg = aiConfig(plugin);
  const started = Date.now();
  const answer = await aiExplain(
    "这是一条连接测试，不包含任何书籍内容。",
    plugin,
    [{ role: "user", content: "请只回答：连接成功" }],
    "",
    { connectionTest: true },
  );
  return {
    model: cfg.model || cfg.provider && cfg.provider.label || "AI",
    latency: Date.now() - started,
    answer,
  };
}
// Capture a specific open Markdown leaf before the popup takes focus. Never
// infer a destination from whichever tab happens to be active after translation.
function currentTranslationNote(plugin, target = null) {
  const leaf = target?.leaf || plugin._lastNoteLeaf;
  const file = target?.file || leaf?.view?.file;
  if (!(leaf?.view instanceof MarkdownView) || !(file instanceof TFile)
    || file.extension !== "md" || leaf.view.file !== file
    || !plugin.app.workspace.getLeavesOfType("markdown").includes(leaf)
    || plugin.app.vault.getAbstractFileByPath(file.path) !== file) return null;
  return { leaf, file };
}
function dailyNoteProvider(app) {
  // Obsidian exposes no public Daily Notes API. Keep this optional adapter
  // guarded; the core plugin creates its own note with its format and template.
  const daily = app.internalPlugins?.plugins?.["daily-notes"];
  return daily?.enabled && typeof daily.instance?.getDailyNote === "function" ? daily.instance : null;
}
function translationNoteBlock(plugin, bookFile, source, translation) {
  const original = source.text.trim().replace(/\r?\n/g, "\n> ");
  const link = highlightBacklink(plugin.app.vault.getName(), bookFile.path, { ...source, id: undefined });
  const attribution = plugin.app.fileManager.generateMarkdownLink(bookFile, "");
  return `> ${original}\n\n${translation.trim()}\n\n— ${attribution}${link ? ` [↩](${link})` : ""}`;
}
function saveTranslationNote(modal, destination, translation) {
  const { plugin, app } = modal;
  // Serialize target creation and appends, including two independent popups.
  const operation = async () => {
    const previous = destination === "new" ? modal.savedTargets.get(destination) : null;
    if (previous && app.vault.getAbstractFileByPath(previous.path) === previous) return previous;
    const block = translationNoteBlock(plugin, modal.bookFile, modal.source, translation);
    let file;
    if (destination === "current") {
      const target = modal.noteTarget && currentTranslationNote(plugin, modal.noteTarget);
      if (!target) throw new Error("The selected note is no longer open");
      const editor = target.leaf.view.editor;
      if (editor) {
        const text = editor.getValue();
        if (!text.includes(block)) editor.replaceRange(`${text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"}${block}\n`, editor.offsetToPos(text.length));
        return target.file;
      }
      file = target.file;
    } else if (destination === "daily") {
      const daily = dailyNoteProvider(app);
      if (!daily) throw new Error("Enable Daily Notes first");
      file = await daily.getDailyNote();
    } else if (destination === "book") {
      file = resolveBookNote(app, bookNoteLinkFor(plugin, modal.bookFile));
      if (!file) {
        const folder = bookNotesFolderPath(app) || notesFolderPath(app) || "";
        const base = sanitizeNoteTitle(modal.bookFile.basename);
        let name = base, suffix = 2;
        while (app.vault.getAbstractFileByPath(qiaomuReaderPath(`${folder}/${name}.md`))) name = `${base} ${suffix++}`;
        file = await plugin.createBookNote(modal.bookFile, name, folder);
      }
    } else if (destination === "new") {
      const folderChoice = plugin.settings.notesNextToBook ? modal.bookFile.parent?.path || null : null;
      const filename = firstFreeNoteName(app, sanitizeNoteTitle(suggestNoteTitle(modal.text)), folderChoice);
      const folder = await resolveNotesFolder(app, folderChoice);
      return createTemplatedNote(app, modal.bookFile, folder, filename, folderChoice, block);
    } else throw new Error("Unknown translation destination");
    if (!(file instanceof TFile) || file.extension !== "md" || isUnsafeReadingNote(app, file)) throw new Error("No writable note target");
    const open = app.workspace.getLeavesOfType("markdown").find(leaf => leaf.view.file === file && leaf.view.editor);
    if (open) {
      const editor = open.view.editor, text = editor.getValue();
      if (!text.includes(block)) editor.replaceRange(`\n\n${block}\n`, editor.offsetToPos(text.length));
    } else await app.vault.process(file, text => text.includes(block) ? text : `${text.trimEnd()}\n\n${block}\n`);
    return file;
  };
  const pending = (plugin._translationSaveChain || Promise.resolve()).catch(() => {}).then(operation);
  plugin._translationSaveChain = pending;
  return pending;
}

// The book does not lay out instantly; the veil (qiaomu-reader-booting) hides the half-ready page












function qiaomuReaderSelectionRect(range, areaEl) {
  let rects = [];
  try {
    rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
  } catch { /* optional step; a failure here must not interrupt reading */ }
  if (!rects.length) return range.getBoundingClientRect();
  const box = areaEl ? areaEl.getBoundingClientRect() : null;
  if (box) {
    const seen = rects.filter((r) => r.right > box.left + 1 && r.left < box.right - 1);
    if (seen.length) rects = seen;
  }
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top };
}
function qiaomuReaderRefreshHlPanel(view) {
  const fn = view.buildHlPanel || view._buildHlPanel;
  if (typeof fn === "function") fn.call(view);
}



// Block-anchored selection pipeline shared by the paged view and the modal.
// gatherSelectionParts walks the flow blocks touched by the range and, for each
// block holding usable text, records the slice plus the occurrence index and
// 32-char context needed to re-locate it later.
function gatherSelectionParts(range, blocks, firstIndex) {
  const out = [];
  for (let i = firstIndex; i < blocks.length; i++) {
    const el = blocks[i];
    const startsHere = i === firstIndex;
    const endsHere = el.contains(range.endContainer);
    if (!startsHere && !range.intersectsNode(el)) break;
    const full = el.textContent;
    const from = startsHere ? offsetInBlock(el, range.startContainer, range.startOffset) : 0;
    const to = endsHere ? offsetInBlock(el, range.endContainer, range.endOffset) : full.length;
    if (to > from) {
      const seg = full.slice(from, to);
      if (seg.trim()) {
        out.push({
          block: i,
          occ: countOccurrencesBefore(full, seg, from),
          text: seg,
          pre: full.slice(Math.max(0, from - 32), from),
          post: full.slice(to, to + 32),
        });
      }
    }
    if (endsHere) break;
  }
  return out;
}

// Resolves the active selection against the paginated flow; null means the
// popup must be dropped for this round.
function flowSelectionParts(view) {
  const sel = selOf(view.areaEl);
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const flow = view.pager.flow;
  if (!flow || !flow.contains(range.startContainer)) return null;
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const block = node ? node.closest(READER_BLOCK_SELECTOR) : null;
  if (!block || !flow.contains(block)) return null;
  const blocks = [...flow.querySelectorAll(READER_BLOCK_SELECTOR)];
  const at = blocks.indexOf(block);
  if (at < 0) return null;
  const parts = gatherSelectionParts(range, blocks, at);
  return parts.length ? { range, parts } : null;
}

// Stores the pending selection (first part spread in for back-compat, full
// slice list plus the joined text) and raises the popup over the range.
function raiseSelectionPopup(view, parts, range) {
  view._pendingSel = { ...parts[0], parts, text: parts.map((p) => p.text).join(" ") };
  view._editHlId = parts.length === 1 ? selectionHud.matchingSelectionHighlight(view, parts[0])?.id || null : null;
  qiaomuReaderPaintSelection(view, range);
  view._showHlPopup(qiaomuReaderSelectionRect(range, view.areaEl));
  syncOpenAiSelectionContext(view, range);
}

// All entry points share the same record, selection and menu actions. Keep the
// source document alive only while selecting; engine chapters are disposable.
const QUICK_HL_COLOR_IDS = ["yellow", "green", "pink"];





function openEngineHighlightPopup(view, hit) {
  if (view._selectionDragging || view._selectionMenuOpen || !hit?.id || !hit.range) return;
  const doc = hit.range.startContainer.ownerDocument;
  if (doc.getSelection()?.toString().trim()) return;
  view._hideHlPopup();
  view._editHlId = hit.id;
  view._selectionDoc = doc;
  view._showHlPopup(selectionHud.engineSelectionRect(doc, hit.range));
}

// Dismissal for the pinned-reading card. Clicks inside a book section never
// reach the main document, so the section listener calls this directly.
function hidePinPopup(view) {
  pinPopup.hide(view);
}

// Clicking a pinned reading reopens its card: full pinyin, the short
// definition and the one action that removes the pin.
function openEnginePinPopup(view, hit) {
  if (view._selectionDragging || view._selectionMenuOpen || !hit?.id || !hit.range || !view.file) return;
  const doc = hit.range.startContainer.ownerDocument;
  view._hideHlPopup();
  // Pins stored before the glossary table grew (or before a variant mapping
  // existed) may have no definition; look it up again when the card opens.
  const gloss = hit.gloss || lookupSelection(hit.text || "")?.gloss || "";
  pinPopup.show(view, { ...hit, gloss }, selectionHud.engineSelectionRect(doc, hit.range), (pin) => {
    view.plugin.removePin(view.file.path, pin.id);
    void view.engine?.removePin(pin.id);
  });
  if (!gloss) {
    void lookupWordGloss(hit.text || "").then((found) => {
      if (found) pinPopup.updateGloss(view, found);
    }).catch(() => {});
  }
}

// Clicking a pinned reading in the block flow (fixed-layout pages) reopens its
// card; the pin is anchored by block and offset here, not by a CFI.
function openFlowPinPopup(view, id) {
  const pin = view.file ? view.plugin.getPins(view.file.path).find((item) => item.id === id) : null;
  const span = view.pager?.flow?.querySelector(`[data-py-pin="${id}"]`);
  if (!pin || !span) return;
  view._hideHlPopup();
  pinPopup.show(view, pin, span.getBoundingClientRect(), (removed) => {
    view.plugin.removePin(view.file.path, removed.id);
    view._renderFlowPins?.();
  });
}













// Single skeleton for the highlights panel in both the paged view and the
// modal. The owner supplies the mutating callbacks, so late-bound state
// (file, plugin, app) is still read at event time exactly as before; delAria
// is optional because the modal historically ships without it.
// Where a highlight sits: the PDF page, the chapter of a reflowable book, or
// the chapter a CFI resolves to. Used as the [第 N 页] prefix of every entry.
function highlightWhere(owner, hl) {
  if (typeof hl?.block === "number") {
    if (owner.file?.extension === "pdf" && owner.pager?.flow) {
      const page = pageForBlock(owner.pager.flow, hl.block);
      if (page) return qiaomuReaderTranslate("page-0", page);
    }
    return chapterForBlock(owner.tocItems || [], hl.block);
  }
  if (hl?.cfi && typeof owner.engine?.labelForCfi === "function") {
    return owner.engine.labelForCfi(hl.cfi);
  }
  return "";
}

function renderHighlightPanel(p, owner, opts) {
  p.empty();
  const list = owner.file ? owner.plugin.getHighlights(owner.file.path) : [];
  // Same header as the contents panel and the AI companion: title on the left,
  // ordinary buttons on the right.
  const head = p.createDiv("qbr-panel-head");
  head.createDiv({ cls: "qbr-panel-title", text: qiaomuReaderTranslate("highlights") });
  const actions = head.createDiv("qbr-panel-actions");
  if (list.length) {
    const exp = actions.createEl("button", { attr: { type: "button", "aria-label": qiaomuReaderTranslate("export-to-notes-0", list.length) } });
    svgIcon(exp, "download");
    exp.addEventListener("click", (e) => owner.exportHighlights(e));
  }
  const close = actions.createEl("button", { attr: { type: "button", "aria-label": qiaomuReaderTranslate("close") } });
  svgIcon(close, "x");
  close.addEventListener("click", () => owner.hlDockPanel?.close());
  if (!list.length) {
    p.createDiv("qbr-panel-empty").setText(qiaomuReaderTranslate("no-highlights-yet-select-text-and-pick-a-color"));
    return;
  }
  const wrap = p.createDiv("qiaomu-reader-toc-list qiaomu-reader-hl-list");
  for (const hl of list) {
    const item = wrap.createDiv("qiaomu-reader-hl-item");
    const dot = item.createDiv("qiaomu-reader-hl-dot");
    dot.style.background = hlColorCss(hl.color);
    const body = item.createDiv("qiaomu-reader-hl-body");
    const txt = body.createDiv("qiaomu-reader-hl-text");
    const where = highlightWhere(owner, hl);
    if (where) txt.createSpan({ cls: "qiaomu-reader-hl-where", text: `[${where}]` });
    txt.createSpan({ text: hl.text.length > 160 ? hl.text.slice(0, 160) + "…" : hl.text });
    if (hl.comment) body.createDiv("qiaomu-reader-hl-comment").setText(hl.comment);
    const showMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!owner.file) return;
      const menu = new Menu();
      menu.addItem((it) => {
        it.setTitle(qiaomuReaderTranslate("create-note")).setIcon("file-plus");
        it.onClick(() => createNoteFromSelection(owner.app, owner.plugin, hl.text, owner.file, { extra: hlCommentMd(hl), color: hl.color, hl }));
      });
      menu.addItem((it) => {
        it.setTitle(qiaomuReaderTranslate("as-text-into-the-book-note")).setIcon("text-quote");
        it.onClick(() => sendQuoteToBookNote(owner, hl));
      });
      menu.showAtMouseEvent(e);
    };
    const more = item.createDiv("qiaomu-reader-hl-more");
    svgIcon(more, "more");
    more.setAttribute("aria-label", qiaomuReaderTranslate("more"));
    more.addEventListener("click", showMenu);
    const del = item.createDiv("qiaomu-reader-hl-del");
    svgIcon(del, "trash");
    if (opts.delAria) del.setAttribute("aria-label", opts.delAria);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!owner.file) return;
      owner.plugin.removeHighlight(owner.file.path, hl.id);
      owner._unwrapHighlight(hl.id);
      opts.rebuild();
    });
    item.addEventListener("click", () => owner.goToHighlight(hl.id));
    item.addEventListener("contextmenu", showMenu);
  }
}
function markFoundIn(view, query) {
  clearFoundIn(view);
  const flow = view.pager && view.pager.flow;
  const q = searchableQuery(query);
  if (!flow || !q) return;
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
  view._foundQuery = q;
  const ranges = [];
  const CAP = 2e3;
  try {
    for (const hit of searchBookBlocks(readerSearchTexts(flow), q, CAP)) {
      const block = view.pager.blockEl(hit.block);
      const start = textPoint(block, hit.offset), end = textPoint(block, hit.offset + hit.hit.length);
      if (!start || !end) continue;
      const r = docOf(flow).createRange();
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
      ranges.push(r);
    }
    if (ranges.length) CSS.highlights.set("qiaomu-reader-found", new Highlight(...ranges));
    window.clearTimeout(view._foundTimer);
    view._foundTimer = window.setTimeout(() => { if (view.panelOpen !== "find") clearFoundIn(view); }, FOUND_PAINT_MS);
  } catch { /* optional step; a failure here must not interrupt reading */ }
}
function clearFoundIn(view) {
  window.clearTimeout(view._foundTimer);
  view._foundQuery = "";
  try {
    if (typeof CSS !== "undefined" && CSS.highlights) CSS.highlights.delete("qiaomu-reader-found");
  } catch { /* optional step; a failure here must not interrupt reading */ }
}
function prepareNavigationPanel(panel, title) {
  panel.empty();
  panel.addClass("qiaomu-reader-navigation-panel");
  panel.createDiv("qiaomu-reader-pan-title").setText(title);
}
// Typing in the find field searches after a short pause; while an IME
// composition is in progress the countdown is suspended and the finished
// phrase is searched in one go.
function bindComposingSearch(input, ime, search) {
  let handle = 0;
  input.addEventListener("compositionstart", () => { ime.active = true; window.clearTimeout(handle); });
  input.addEventListener("compositionend", () => { ime.active = false; search(); });
  input.addEventListener("input", () => {
    window.clearTimeout(handle);
    if (ime.active) return;
    handle = window.setTimeout(search, 180);
  });
  return () => window.clearTimeout(handle);
}
const buildFindPanelFor = createBuildFindPanelFor({
  Notice,
  bindComposingSearch,
  chapterForBlock,
  clearFoundIn,
  markFoundIn,
  pageForBlock,
  prepareNavigationPanel,
  qiaomuReaderTranslate,
  readerIsPdf,
  readerSearchTexts,
  rememberReaderJump,
});
function buildTocPanelFor(view, panel, { close, jump: openItem }) {
  prepareNavigationPanel(panel, qiaomuReaderTranslate("contents"));
  panel.onkeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); view.tocBtn?.focus(); }
  };
  const marks = panel.createDiv("qiaomu-reader-find-controls");
  marks.createEl("button", { text: qiaomuReaderTranslate("bookmark-this-location") }).addEventListener("click", () => { close(); addLocationMark(view); });
  marks.createEl("button", { text: qiaomuReaderTranslate("location-bookmarks") }).addEventListener("click", () => { close(); showLocationMarks(view); });
  marks.createEl("button", { text: qiaomuReaderTranslate("close") }).addEventListener("click", () => { close(); view.tocBtn?.focus(); });
  const entries = view.tocItems || [];
  if (!entries.length) {
    panel.createDiv("qiaomu-reader-toc-empty").setText(qiaomuReaderTranslate("no-contents-and-no-headings-were-found-in-this-book"));
    return null;
  }
  let filterText = "";
  if (entries.length > 12) {
    // Its own classes: the find panel's search box uses the same styling but
    // must stay distinguishable from this table-of-contents filter.
    const box = panel.createDiv("qiaomu-reader-toc-filter");
    const input = box.createEl("input", { type: "text", cls: "qiaomu-reader-toc-filter-input" });
    input.placeholder = qiaomuReaderTranslate("filter-by-title");
    input.addEventListener("input", () => {
      filterText = input.value.trim().toLowerCase();
      redraw();
    });
  }
  const list = panel.createDiv("qiaomu-reader-toc-list");
  const redraw = () => {
    list.empty();
    const activeSpread = view.pager ? view.pager.spread : 0;
    let visible = 0;
    for (const entry of entries) {
      if (filterText && !entry.label.toLowerCase().includes(filterText)) continue;
      visible++;
      const node = list.createDiv("qiaomu-reader-toc-item");
      const row = node.createDiv("qiaomu-reader-toc-row");
      row.createSpan({ cls: "qiaomu-reader-toc-label", text: entry.label });
      const spread = !view.engine && view.pager && view.pager.spreadForBlock ? view.pager.spreadForBlock(entry.block) : null;
      const meta = [];
      if (entry.page) meta.push(qiaomuReaderTranslate("p-0", entry.page));
      if (typeof spread === "number") meta.push(qiaomuReaderTranslate("spr-0", spread + 1));
      if (meta.length) row.createSpan({ cls: "qiaomu-reader-toc-where", text: meta.join(" \xB7 ") });
      if (entry.level) node.style.paddingLeft = `${8 + entry.level * 12}px`;
      if (typeof spread === "number" && spread === activeSpread) node.addClass("active");
      node.addEventListener("click", () => {
        close();
        openItem(entry);
      });
    }
    if (!visible) list.createDiv("qiaomu-reader-toc-empty").setText(qiaomuReaderTranslate("nothing-found"));
  };
  redraw();
  return redraw;
}
function enrichHighlights(view, list) {
  const flow = view && view.pager ? view.pager.flow : null;
  const toc = view && view.tocItems || [];
  const blocks = flow ? flow.querySelectorAll(READER_BLOCK_SELECTOR) : [];
  const isPdf = view?.file?.extension === "pdf";
  return (list || []).map((hl) => {
    if (typeof hl.block !== "number") return hl;
    const anchor = resolveHighlightAnchor(blocks, hl, isPdf);
    const block = anchor ? anchor.index : hl.block;
    return {
      ...hl,
      block,
      chapter: hl.chapter || chapterForBlock(toc, block),
      page: hl.page || pageForBlock(flow, block)
    };
  });
}
function currentBookPage(view) {
  try {
    const pager = view && view.pager;
    const flow = pager ? pager.flow : null;
    if (!flow) return null;
    const pdfPage = pager.currentPdfPageNumber?.();
    if (Number.isFinite(pdfPage)) return pdfPage;
    const block = pager.currentBlockIndex();
    if (typeof block !== "number" || block < 0) return null;
    return pageForBlock(flow, block);
  } catch {
    return null;
  }
}
function resolveHighlightAnchor(blocks, hl, searchAll = false) {
  const preferred = typeof hl?.block === "number" ? blocks[hl.block] : null;
  if (preferred) {
    const loc = locateHl(preferred.textContent || "", hl);
    if (loc) return { block: preferred, index: hl.block, loc };
  }
  if (!searchAll || !hl?.text) return null;
  for (let index = 0; index < blocks.length; index++) {
    if (index === hl.block) continue;
    const block = blocks[index];
    const loc = locateHl(block.textContent || "", hl);
    if (loc) return { block, index, loc };
  }
  return null;
}
function sendQuoteToBookNote(view, hl) {
  if (!hl || !hl.text) return;
  const [full] = enrichHighlights(view, [hl]);
  exportHighlightsToBookNote(view.app, view.plugin, view.file, [full]);
}
const FIGURE_LAZY_SELECTOR = "img.qiaomu-reader-pdf-lazy";
const FIGURE_SURFACE_SELECTOR = ".qiaomu-reader-pdf-page-surface";
const FIGURE_RENDERING_CLASS = "qiaomu-reader-pdf-rendering";
const FIGURE_ERROR_CLASS = "qiaomu-reader-pdf-render-error";
const FIGURE_HEAVY_CLASS = "qiaomu-reader-pdf-heavy";
const FIGURE_ERROR_ATTR = "data-pdf-error";
const FIGURE_LOADED_ATTR = "data-loaded";
const FIGURE_TOO_HEAVY_SIGNAL = "qiaomu-reader-render-too-heavy";
const FIGURE_LOAD_SPAN = 2;
const FIGURE_DROP_SPAN = 6;

function figureSpreadGap(img, flowRect, columnWidth, spread, vertical) {
  const rect = img.getBoundingClientRect();
  const offset = vertical ? rect.top - flowRect.top : rect.left - flowRect.left;
  return Math.abs(Math.floor(offset / columnWidth + 0.01) - spread);
}

function figurePageNumber(img) {
  return parseInt(img.dataset.pdfPage);
}

function figureSweepReady(view, lazy) {
  return Boolean(lazy && !lazy._destroyed && !view._closed && view.pager?.flow
    && docOf(view.pager.flow).visibilityState !== "hidden");
}

function markFigureUnavailable(img, surface, error) {
  const pageNumber = figurePageNumber(img) || 0;
  const tooHeavy = String(error && error.message) === FIGURE_TOO_HEAVY_SIGNAL;
  const message = tooHeavy
    ? qiaomuReaderTranslate("this-page-is-too-heavy-to-draw")
    : qiaomuReaderTranslate("could-not-display-page-0", pageNumber);
  img.setAttribute(FIGURE_LOADED_ATTR, "skip");
  img.addClass(FIGURE_HEAVY_CLASS);
  img.alt = message;
  if (surface) {
    surface.addClass(FIGURE_ERROR_CLASS);
    surface.setAttribute(FIGURE_ERROR_ATTR, message);
  }
  console.error(`UV Reader: could not render PDF page ${pageNumber}`, error);
}

async function drawFigure(img, lazy, current = () => true) {
  const surface = img.closest(FIGURE_SURFACE_SELECTOR);
  if (surface) surface.addClass(FIGURE_RENDERING_CLASS);
  try {
    const rendered = await lazy.render(figurePageNumber(img), img.ownerDocument);
    if (!current()) return;
    img.src = rendered.src;
    const oldLayer = surface?.querySelector(".qiaomu-reader-pdf-text-layer");
    if (oldLayer && rendered.textLayer) oldLayer.replaceWith(rendered.textLayer);
    if (typeof img.decode === "function") await img.decode().catch(() => {});
    img.setAttribute(FIGURE_LOADED_ATTR, "1");
  } catch (e) {
    if (current()) markFigureUnavailable(img, surface, e);
  } finally {
    if (surface) surface.removeClass(FIGURE_RENDERING_CLASS);
  }
}

async function sweepReaderFigures(reader, lazy) {
  const { pager } = reader;
  const flow = pager.flow;
  const columnWidth = pager.sw || 1;
  const spread = pager.spread;
  const vertical = pager.scrollMode;
  const flowRect = flow.getBoundingClientRect();
  const gapOf = (img) => figureSpreadGap(img, flowRect, columnWidth, spread, vertical);
  const current = () => !reader._closed && reader._pdfLazy === lazy && !lazy._destroyed && reader.pager === pager;
  for (const img of [...flow.querySelectorAll(FIGURE_LAZY_SELECTOR)]) {
    if (!current()) return;
    const gap = gapOf(img);
    const loadState = img.getAttribute(FIGURE_LOADED_ATTR);
    if (gap <= FIGURE_LOAD_SPAN && loadState !== "1" && loadState !== "skip") {
      await drawFigure(img, lazy, current);
    } else if (gap > FIGURE_DROP_SPAN && loadState === "1") {
      if (img.hasAttribute("src")) img.removeAttribute("src");
      const surface = img.closest(FIGURE_SURFACE_SELECTOR);
      const layer = surface?.querySelector(".qiaomu-reader-pdf-text-layer");
      if (layer) {
        layer.textContent = lazy.textFor(figurePageNumber(img));
        layer.className = "qiaomu-reader-pdf-text-layer qiaomu-reader-pdf-text-placeholder";
        layer.setAttribute("data-pdf-selectable", "false");
      }
      img.setAttribute(FIGURE_LOADED_ATTR, "0");
    }
  }
}

async function renderVisibleFigures(reader) {
  const { _pdfLazy: lazy } = reader;
  if (!figureSweepReady(reader, lazy)) return;
  if (reader._figBusy) { reader._figPending = reader._figBusy; return; }
  Object.assign(reader, { _figBusy: true });
  try {
    await sweepReaderFigures(reader, lazy);
  } finally {
    const rerun = reader._figPending;
    reader._figBusy = reader._figPending = false;
    reader._renderFlowHighlights?.();
    if (reader._foundQuery) markFoundIn(reader, reader._foundQuery);
    if (rerun) renderVisibleFigures(reader);
  }
}
function offsetInBlock(block, container, offset) {
  try {
    const r = docOf(block).createRange();
    r.setStart(block, 0);
    r.setEnd(container, offset);
    return r.toString().length;
  } catch {
    return 0;
  }
}
function nthIndexOf(text, sub, occ) {
  let idx = -1;
  for (let i = 0; i <= occ; i++) {
    idx = text.indexOf(sub, idx + 1);
    if (idx < 0) return -1;
  }
  return idx;
}
function countOccurrencesBefore(text, sub, limit) {
  if (!sub) return 0;
  let n = 0, idx = -1;
  while ((idx = text.indexOf(sub, idx + 1)) >= 0 && idx < limit) n++;
  return n;
}
function _hlNormMap(s) {
  s = s || "";
  let norm = "";
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (c === "\xA0" || c === " " || /\s/.test(c)) {
      if (prevSpace) continue;
      norm += " ";
      map.push(i);
      prevSpace = true;
      continue;
    }
    prevSpace = false;
    if (c === "‘" || c === "’" || c === "‚" || c === "‛") c = "'";
    else if (c === "“" || c === "”" || c === "„" || c === "‟") c = '"';
    else if (c === "–" || c === "—" || c === "−") c = "-";
    norm += c;
    map.push(i);
  }
  return { norm, map };
}
// True when the text just before/at idx continues with the highlight's
// stored prefix and is followed by its stored suffix, as far as they exist.
function hlAffixesMatchAt(blockText, idx, hl) {
  const len = hl.text.length;
  if (hl.pre) {
    const from = Math.max(0, idx - hl.pre.length);
    if (!blockText.slice(from, idx).endsWith(hl.pre)) return false;
  }
  if (hl.post) {
    const to = idx + len + hl.post.length;
    if (!blockText.slice(idx + len, to).startsWith(hl.post)) return false;
  }
  return true;
}

// Scans every occurrence of the exact text and keeps the one whose
// surroundings match the recorded context. Returns null when no affix
// context is stored or none of the occurrences fits it.
function findHlAnchoredOccurrence(blockText, hl) {
  if (hl.pre == null && hl.post == null) return null;
  for (let from = 0, idx; (idx = blockText.indexOf(hl.text, from)) >= 0; from = idx + 1) {
    if (hlAffixesMatchAt(blockText, idx, hl)) return { start: idx, len: hl.text.length };
  }
  return null;
}

// Last resort: repeat the search on whitespace/quote/dash-normalized copies
// of the block and the highlight, mapping the hit back to raw offsets.
function findHlNormalizedOccurrence(blockText, hl) {
  const blockMap = _hlNormMap(blockText);
  const normBlock = blockMap.norm;
  const normIndex = blockMap.map;
  const normText = _hlNormMap(hl.text).norm.trim();
  if (!normText) return null;
  const normPre = hl.pre ? _hlNormMap(hl.pre).norm.trim() : "";
  let at = -1;
  if (normPre) {
    const anchor = normBlock.indexOf(normPre);
    if (anchor >= 0) at = normBlock.indexOf(normText, Math.max(0, anchor + normPre.length - 1));
  }
  if (at < 0) at = normBlock.indexOf(normText);
  if (at < 0 || at >= normIndex.length) return null;
  const last = Math.min(at + normText.length - 1, normIndex.length - 1);
  const rawStart = normIndex[at];
  const rawEnd = normIndex[last] + 1;
  return rawEnd > rawStart ? { start: rawStart, len: rawEnd - rawStart } : null;
}

function locateHl(blockText, hl) {
  if (!hl?.text) return null;
  const occurrence = typeof hl.occ === "number" ? hl.occ : 0;
  const direct = nthIndexOf(blockText, hl.text, occurrence);
  if (direct >= 0) return { start: direct, len: hl.text.length };
  return findHlAnchoredOccurrence(blockText, hl) || findHlNormalizedOccurrence(blockText, hl);
}
function unwrapAllHighlights(flow) {
  if (!flow) return;
  flow.querySelectorAll("[data-hl-id]").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}
// Pinned readings inside the block flow used by fixed-layout PDFs. Highlights
// and pins use different markers so each list can be repainted on its own.
function unwrapAllPins(flow) {
  if (!flow) return;
  flow.querySelectorAll("[data-py-pin]").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}
// Collects the text nodes covered by [start, end), each trimmed to the part
// that overlaps the range. Collection finishes before any DOM mutation so
// the offsets stay valid while walking.
function hlSplitTargets(owner, block, start, end) {
  const slices = [];
  const walker = owner.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const size = node.textContent.length;
    const nodeEnd = offset + size;
    if (nodeEnd > start && offset < end) {
      slices.push({ node, s: Math.max(0, start - offset), e: Math.min(size, end - offset) });
    }
    offset = nodeEnd;
  }
  return slices;
}

// Isolates node[from, to) with splitText and wraps exactly that part in a
// highlight or pinned-reading span.
function wrapHlSlice(owner, node, from, to, spec) {
  let n = node;
  if (to < n.textContent.length) n.splitText(to);
  if (from > 0) n = n.splitText(from);
  const span = owner.createElement("span");
  if (spec.pin) {
    span.className = "qiaomu-reader-flow-pin";
    span.dataset.pyPin = spec.id;
    span.dataset.py = spec.pinyin || "";
    span.setAttribute("role", "button");
    span.setAttribute("tabindex", "0");
    span.setAttribute("aria-label", `${spec.pinyin || ""} ${spec.text || ""}`.trim());
  } else {
    span.className = "qiaomu-reader-hl";
    span.style.background = spec.color;
    span.dataset.hlId = spec.id;
  }
  const parent = n.parentNode;
  parent.insertBefore(span, n);
  span.appendChild(n);
}

function wrapBlockRange(block, start, end, hl) {
  if (start >= end) return;
  const owner = docOf(block);
  for (const t of hlSplitTargets(owner, block, start, end)) {
    wrapHlSlice(owner, t.node, t.s, t.e, hl);
  }
}
const buildBookSettings = createBuildBookSettings({
  Notice,
  BookNotePicker,
  TemplatePicker,
  allBookTags: libraryData.allBookTags,
  bookNoteFiles,
  bookNotesFolderPath,
  bookTagsOf: libraryData.bookTagsOf,
  notesFolderPath,
  parseBookTags: libraryData.parseBookTags,
  qiaomuReaderTranslate,
  writeBookProperty,
});
const CreateFolderModal = createCreateFolderModal({
  Modal,
  Notice,
  Setting,
  TFolder,
  qiaomuReaderPath,
  qiaomuReaderTranslate,
  readerHud,
});
const ReadSettingsModal = createReadSettingsModal({
  Modal,
  Setting,
  FONTS,
  aiConfig,
  aiSetupMessage,
  aiSetupState,
  bindSettingsTabKeys,
  buildCustomFontInput,
  buildPageButtonsSetting,
  buildReaderExtraSettings,
  createPdfZoomSettings,
  ensureSelectedReaderFont,
  openPluginAiSettings,
  panelSection,
  persistCurrentReaderPosition,
  qiaomuReaderDeviceKey,
  qiaomuReaderFontLabel,
  qiaomuReaderReaderFonts,
  qiaomuReaderTheme,
  qiaomuReaderTranslate,
  readerHud,
  readerIsPdf,
  readerThemeLabel,
  selectedReaderTheme,
  setReaderTheme,
});


const NoteTitleModal = createNoteTitleModal({
  Modal,
  FolderSuggest,
  allVaultTags,
  bookNoteLinkFor,
  notesFolderPath,
  parseNoteTags,
  qiaomuReaderPath,
  qiaomuReaderTranslate,
  readerHud,
  sanitizeNoteTitle,
  suggestNoteTitle,
});
// Templater's cursor placeholder marks the spot where the excerpt is inserted;
// any remaining markers (multi-cursor form included) are stripped afterwards.
const ConfirmModal = createConfirmModal({
  Modal,
  qiaomuReaderTranslate,
});

const AiChatHistoryModal = createAiChatHistoryModal({
  Modal,
  setIcon,
  ConfirmModal,
  ReaderNameModal,
  normalizeAiChatHistory,
  qiaomuReaderLocale,
  qiaomuReaderTranslate,
});
const GoToPageModal = createGoToPageModal({
  Modal,
  qiaomuReaderTranslate,
  readerHud,
});
// One group per chapter, preserving first-appearance order of chapters.
const HighlightExportModal = createHighlightExportModal({
  Modal,
  exportHighlightsSeparate,
  exportHighlightsToBookNote,
  qiaomuReaderTranslate,
  splitExportedHighlights,
});
const InfoModal = createInfoModal({
  Modal,
  qiaomuReaderTranslate,
});
// Store keys so reopening the guide uses the current interface language.
const ONBOARD_SLIDES = [
  { icon: "library", title: "welcome-library-title", body: "welcome-library-body" },
  { icon: "sliders-horizontal", title: "welcome-reading-title", body: "welcome-reading-body" },
  { icon: "highlighter", title: "welcome-highlight-title", body: "welcome-highlight-body" },
  { icon: "notebook-pen", title: "welcome-notes-title", body: "welcome-notes-body" },
  { icon: "sparkles", title: "welcome-ai-title", body: "welcome-ai-body" },
];

const WHATS_NEW = createWhatsNew({
  qiaomuReaderTranslate,
});
const BookSetupModal = createBookSetupModal({
  Modal,
  Notice,
  FolderSuggest,
  allBookTags: libraryData.allBookTags,
  bookNoteFiles,
  bookNotesFolderPath,
  bookTagsOf: libraryData.bookTagsOf,
  notesFolderPath,
  parseBookTags: libraryData.parseBookTags,
  qiaomuReaderTranslate,
  readerHud,
  sanitizeNoteTitle,
  writeBookProperty,
});
const OnboardingModal = createOnboardingModal({
  Modal,
  setIcon,
  ONBOARD_SLIDES,
  qiaomuReaderTranslate,
});

const WhatsNewModal = createWhatsNewModal({
  Modal,
  OnboardingModal,
  qiaomuReaderTranslate,
});
async function navigateEngineToc(reader, href) {
  const engine = reader.engine;
  try { await engine.goToTocItem(href); }
  catch (error) {
    if (reader.engine !== engine || reader._closed) return;
    console.warn("UV Reader: could not navigate to chapter", error);
    new Notice(qiaomuReaderTranslate("could-not-open-this-book"));
  }
}
async function restoreEngineHistory(reader, snap) {
  const engine = reader.engine;
  const path = reader.file?.path;
  const current = () => reader.engine === engine && reader.file?.path === path && !reader._closed;
  try {
    let restored = false;
    if (snap.cfi) {
      try { await engine.goTo(snap.cfi); restored = true; }
      catch { /* old anchors can become invalid after a book is replaced */ }
    }
    if (!current()) return;
    if (!restored) await engine.goToFraction(typeof snap.pct === "number" ? snap.pct : (snap.percent || 0) / 100);
    if (!current()) return;
    (reader.closePanel || reader._closePanel)?.call(reader);
    new Notice(qiaomuReaderTranslate("jumped-back-to-0", snap.percent));
  } catch (error) {
    if (!current()) return;
    console.warn("UV Reader: could not restore reading history", error);
    new Notice(qiaomuReaderTranslate("could-not-open-this-book"));
  }
}
async function persistCurrentReaderPosition(reader) {
  if (!(reader && reader.plugin && reader.file && reader.bookHtml && reader.pager) || reader._openingBook) return;
  // An engine book has no legacy pager geometry. Never replace its CFI with
  // the empty pager's 0/1 position, including close during an unfinished load.
  if (reader.engine || reader.bookHtml === "engine") {
    const location = reader.engine?.currentLocation() || reader._engineLocation;
    if (location?.cfi && Number.isFinite(location.fraction)) {
      await reader.plugin.saveEngineProgress(reader.file.path, location.fraction, location.cfi);
    }
    return;
  }
  const pager = reader.pager;
  const total = Math.max(1, pager.total || 1);
  let current = Math.max(0, Math.min(pager.spread || 0, total - 1));
  // The final scroll event may still be inside the paginator's debounce window
  // when the reader closes. Read the scroller directly so that last movement is
  // not lost just because the tab was closed quickly.
  if (pager.scrollMode && pager.clip) {
    const height = pager.clip.clientHeight || 1;
    current = Math.max(0, Math.min(Math.round(pager.clip.scrollTop / height), total - 1));
    pager.spread = current;
  }
  const saved = reader.plugin.getProgress(reader.file.path);
  let block = saved && typeof saved.block === "number" ? saved.block : null;
  // Obsidian detaches a leaf before onClose runs. Geometry reads on a detached
  // flow all collapse to zero, which makes currentBlockIndex return the final
  // paragraph in the book. Only refresh the anchor while the layout is live;
  // otherwise preserve the last anchor confirmed by a page/scroll event.
  if (pager.flow && pager.flow.isConnected && pager.clip && pager.clip.isConnected) {
    block = pager.currentBlockIndex();
  }
  try {
    await reader.plugin.saveProgress(reader.file.path, current, total, block);
  } catch (error) {
    console.warn("UV Reader: could not save the final reading position", error);
  }
}
async function loadReaderDocument(file, app, settings, onProgress, options = {}) {
  throwIfReaderLoadAborted(options.signal);
  if (ENGINE_EXTENSIONS.includes(file.extension)) {
    // Format is sniffed from the bytes by the library itself.
    const bytes = await app.vault.readBinary(file);
    throwIfReaderLoadAborted(options.signal);
    return { engine: true, bytes, name: file.name, html: "", lazy: null, outline: null };
  }
  return extractPdf(file, app, settings, onProgress, options);
}
function renderReaderLoadError(reader, error, retry) {
  reader.bookHtml = "";
  const area = reader.areaEl;
  if (!area) return;
  area.empty();
  const state = area.createDiv("qiaomu-reader-load-state");
  const icon = state.createDiv("qiaomu-reader-load-state-icon");
  setIcon(icon, "book-x");
  state.createEl("h3", { text: qiaomuReaderTranslate("could-not-open-this-book") });
  state.createEl("p", { text: qiaomuReaderTranslate("the-file-may-be-damaged-password-protected-or-not-fully-download") });
  const message = String((error == null ? void 0 : error.message) || error || "Unknown error").trim();
  if (message) {
    const details = state.createEl("details", { cls: "qiaomu-reader-load-state-details" });
    details.createEl("summary", { text: qiaomuReaderTranslate("technical-details") });
    details.createEl("code", { text: message.slice(0, 500) });
  }
  const actions = state.createDiv("qiaomu-reader-load-state-actions");
  const retryButton = actions.createEl("button", { cls: "mod-cta", text: qiaomuReaderTranslate("try-again") });
  retryButton.addEventListener("click", () => void retry());
  const libraryButton = actions.createEl("button", { text: qiaomuReaderTranslate("back-to-library") });
  libraryButton.addEventListener("click", () => {
    if (reader instanceof ReaderModal) reader.close();
    void reader.plugin.openLibrary();
  });
}
const ReaderView = createReaderView({
  ItemView,
  Notice,
  TFile,
  setIcon,
  AI_CHAT_VIEW_TYPE,
  BookSetupModal,
  FONTS,
  InfoModal,
  ReadSettingsModal,
  VIEW_TYPE,
  addBookFileMenu,
  attachEngineChrome,
  attachReaderContentClick,
  attachReaderSwipeNav,
  bookNoteAction,
  buildFindPanelFor,
  buildReaderPageArea,
  buildReaderPanels,
  buildReaderSettPanelBody,
  buildReaderTopBar,
  buildTocItems,
  buildTocPanelFor,
  clearAiSource,
  clearFoundIn,
  createPdfPaginator,
  createPdfZoomControls,
  currentBookPage,
  enrichHighlights,
  ensureSelectedReaderFont,
  exportHighlightsMenu,
  flowSelectionParts,
  handleReaderWheel,
  hlColorCss,
  loadReaderDocument,
  locateHl,
  markFoundIn,
  navigateEngineToc,
  openEngineHighlightPopup,
  openEnginePinPopup,
  hidePinPopup,
  openOrCreateBookNoteBeside,
  pageJump,
  pdfVisiblePageLabel,
  pdfZoom,
  persistCurrentReaderPosition,
  qiaomuReaderClearPaintedSelection,
  qiaomuReaderLocale,
  qiaomuReaderRevealWhenSettled,
  qiaomuReaderTheme,
  qiaomuReaderTranslate,
  raiseSelectionPopup,
  readerAiPanelContext,
  readerHud,
  readerIsPdf,
  readerPaginationMappingCollapsed,
  readerPdfPages,
  readerTimer,
  rememberReaderJump,
  renderHighlightPanel,
  renderReaderLoadError,
  renderVisibleFigures,
  resolveHighlightAnchor,
  restoreAiSource,
  restoreEngineHistory,
  selectionHud,
  setReaderTitle,
  setReadingFocus,
  settleReader,
  syncNavigationPanel,
  syncOpenAiReaderContext,
  syncOpenAiSelectionContext,
  syncReaderAiCapability,
  unwrapAllHighlights,
  unwrapAllPins,
  updateEngineLocation,
  wireReaderChrome,
  wrapBlockRange,
});

const AiChatView = createAiChatView({
  ItemView,
  Notice,
  TFile,
  setIcon,
  AI_CHAT_VIEW_TYPE,
  AiChatHistoryModal,
  ReadSettingsModal,
  ReaderView,
  aiChatTitle,
  aiConfig,
  aiConnectionErrorMessage,
  aiSetupState,
  aiTurnsHaveDocumentContext,
  bindAiAttachmentIntake,
  bindAiSlashPrompts,
  bindReaderAiComposer,
  bookNoteLinkFor,
  captureAiScreenshot,
  clearAiSource,
  createAiChatLog,
  newAiSessionKey,
  normalizeAiChatHistory,
  normalizeAiTurnContext,
  openAiAttachMenu,
  openPluginAiSettings,
  pickAiAttachments,
  qiaomuReaderTranslate,
  readerAiPanelContext,
  readerDefaultAiContext,
  readerHud,
  renderAiComposerPrompts,
  renderAiContextQuote,
  renderAiHeadMeta,
  renderAiMarkdown,
  renderAiUserTurn,
  stripAiAttachmentData: stripAttachmentData,
  testAndEnableAi,
});

for (const method of ["_setSending", "_buildEmpty", "_scroll", "_consumePendingContext", "_actions", "_send", "_renderAttachments", "_finishAttachments"]) {
  AiChatView.prototype[method] = AiExplainModal.prototype[method];
}
const LibraryModal = createLibraryModal({
  Menu,
  Modal,
  Notice,
  TFile,
  BOOK_EXTENSIONS,
  IMPORT_MIME_EXT,
  addBookFileMenu,
  bookNoteLinkFor,
  bookStatusOf: libraryData.bookStatusOf,
  bookTagsOf: libraryData.bookTagsOf,
  buildLibChips: libraryData.buildLibChips,
  deleteBookFromVault,
  filterLibBooks: libraryData.filterLibBooks,
  openOrCreateBookNoteBeside,
  qiaomuReaderLibTheme,
  qiaomuReaderLocale,
  qiaomuReaderPath,
  qiaomuReaderTranslate,
  readerHud,
  resolveBookNote,
  setupWorker,
});
// ── Mobile full-screen reader modal ───────────────────────────────────────────
// ── Mobile full-screen reader modal (section-based, no CSS columns) ──────────
// The library as a TAB, not a dialog.
//
// A modal is capped by Obsidian's own sizing and cannot leave the main window.
// A leaf can: it docks, splits, resizes with the window, and — the thing that
// was actually asked for — Obsidian can move it into its own OS window, where
// it can be maximised like any other. Same code draws both: the drawing never
// cared whether it lived in a dialog, only that it had an element to draw into
// and a way to close itself.
const LIB_VIEW_TYPE = "qiaomu-reader-library";
const LibraryView = class extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return LIB_VIEW_TYPE; }
  getDisplayText() { return qiaomuReaderTranslate("library"); }
  getIcon() { return "library"; }
  async onOpen() {
    this.modalEl = this.containerEl;
    this.containerEl.addClass("qiaomu-reader-modal-lib", "qiaomu-reader-lib-as-view");
    await LibraryModal.prototype.onOpen.call(this);
  }
  close() { /* a tab stays put */ }
  onClose() {
    this._libraryRender = null;
    this.contentEl.empty();
  }
};
for (const name of Object.getOwnPropertyNames(LibraryModal.prototype)) {
  if (["constructor", "onOpen", "onClose", "close"].includes(name)) continue;
  Object.defineProperty(LibraryView.prototype, name,
    Object.getOwnPropertyDescriptor(LibraryModal.prototype, name));
}
const ReaderModal = createReaderModal({
  Modal,
  Notice,
  BookSetupModal,
  FONTS,
  InfoModal,
  ReadSettingsModal,
  addPdfZoomMenuItems,
  attachEngineChrome,
  attachReaderContentClick,
  attachReaderSwipeNav,
  bookNoteAction,
  buildFindPanelFor,
  buildReaderBotNav,
  buildReaderMoreButton,
  buildReaderPageArea,
  buildReaderPanels,
  buildReaderSettPanelBody,
  buildReaderTopBar,
  buildTocItems,
  buildTocPanelFor,
  clearAiSource,
  clearFoundIn,
  createPdfPaginator,
  currentBookPage,
  enrichHighlights,
  ensureSelectedReaderFont,
  exportHighlightsMenu,
  flowSelectionParts,
  hlColorCss,
  loadReaderDocument,
  locateHl,
  markFoundIn,
  navigateEngineToc,
  openEngineHighlightPopup,
  openEnginePinPopup,
  hidePinPopup,
  openOrCreateBookNoteBeside,
  pdfVisiblePageLabel,
  pdfZoom,
  persistCurrentReaderPosition,
  qiaomuReaderClearPaintedSelection,
  qiaomuReaderLocale,
  qiaomuReaderRevealWhenSettled,
  qiaomuReaderTheme,
  qiaomuReaderTranslate,
  raiseSelectionPopup,
  readerHud,
  readerIsPdf,
  readerPaginationMappingCollapsed,
  readerPdfPages,
  readerTimer,
  rememberReaderJump,
  renderHighlightPanel,
  renderReaderLoadError,
  renderVisibleFigures,
  resolveHighlightAnchor,
  restoreAiSource,
  restoreEngineHistory,
  selectionHud,
  settleReader,
  syncNavigationPanel,
  syncOpenAiSelectionContext,
  syncReaderAiCapability,
  unwrapAllHighlights,
  unwrapAllPins,
  updateEngineLocation,
  wireReaderChrome,
  wrapBlockRange,
});
const SettingsGroupModal = createSettingsGroupModal({
  Modal,
  qiaomuReaderTranslate,
});
function aiConnectionErrorMessage(error) {
  const why = error?.qiaomuReaderReason;
  if (why === "notconfigured") return qiaomuReaderTranslate("choose-an-ai-service-first");
  if (why === "nokey") return qiaomuReaderTranslate("select-or-create-an-api-key-first");
  if (why === "desktop") return qiaomuReaderTranslate("use-local-cli-providers-from-obsidian-desktop");
  if (why === "model") return qiaomuReaderTranslate("the-model-name-is-unavailable-leave-it-empty-to-use-the-cli-defa");
  if (why === "timeout") return qiaomuReaderTranslate("the-ai-request-timed-out-try-again-later");
  if (why === "auth") return qiaomuReaderTranslate("the-api-key-was-rejected");
  if (why === "forbidden") return qiaomuReaderTranslate("the-service-refused-the-request-403-this-may-be-a-content-restri");
  if (why === "limit") return qiaomuReaderTranslate("the-service-is-rate-limiting-wait-a-minute-and-try-again");
  if (why === "local") return qiaomuReaderTranslate("the-local-model-did-not-respond-make-sure-its-server-is-running");
  // Local providers report plain messages instead of HTTP statuses; surfacing a
  // short excerpt keeps model/name mistakes diagnosable from the UI.
  if (why === "http") {
    const detail = error.qiaomuReaderStatus ?? String(error?.message || "").replace(/\s+/g, " ").trim().slice(0, 140);
    return qiaomuReaderTranslate("the-service-returned-error-0", detail);
  }
  return qiaomuReaderTranslate("connection-failed-check-the-network-base-url-and-model-name");
}
async function testAndEnableAi(plugin, onStage = () => {}) {
  const cfg = aiConfig(plugin);
  if (!cfg.provider) {
    const error = new Error("AI provider is not configured");
    error.qiaomuReaderReason = "notconfigured";
    throw error;
  }
  onStage(qiaomuReaderTranslate("testing"));
  const result = await aiTestConnection(plugin);
  plugin.settings.aiEnabled = true;
  plugin.settings.aiNeedsVerification = false;
  await plugin.saveAll();
  return result;
}
function openPluginAiSettings(app, plugin, onReady) {
  const tab = plugin && plugin.settingsTab;
  if (!tab || typeof tab._groupAi !== "function") {
    new Notice(qiaomuReaderTranslate("open-qiaomu-book-reader-ai-translation-in-obsidian-plugin-settin"));
    return;
  }
  let modal;
  const finish = (result) => {
    if (typeof onReady === "function") onReady(result);
    if (typeof tab._redraw === "function") tab._redraw();
  };
  modal = new SettingsGroupModal(app, qiaomuReaderTranslate("set-up-ai-assistance"), (body, redraw) => {
    tab._groupAi(body, redraw, {
      enableOnSuccess: true,
      onReady: (result) => {
        modal.close();
        finish(result);
      },
    });
  }, {
    doneText: () => qiaomuReaderTranslate(aiSetupState(plugin).enabled ? "confirm" : "ai-start-using"),
    onDone: async (setButtonText) => {
      const state = aiSetupState(plugin);
      if (state.ready && state.enabled) {
        finish();
        return true;
      }
      try {
        const result = await testAndEnableAi(plugin, setButtonText);
        new Notice(qiaomuReaderTranslate("ai-assistance-enabled-0-1-ms", result.model, result.latency));
        finish(result);
        return true;
      } catch (error) {
        const feedback = modal.bodyEl.querySelector(".qiaomu-reader-ai-setup-feedback");
        if (feedback) {
          feedback.empty();
          feedback.setAttribute("role", "alert");
          feedback.createSpan({ text: aiConnectionErrorMessage(error) });
          const help = feedback.createEl("button", { text: qiaomuReaderTranslate("ai-show-connection-settings") });
          help.addEventListener("click", () => {
            for (const details of modal.bodyEl.querySelectorAll("details[data-ai-advanced], details[data-ai-connection]")) details.open = true;
            modal.bodyEl.querySelector("[data-ai-connection]")?.scrollIntoView({ block: "nearest" });
          });
        } else new Notice(aiConnectionErrorMessage(error), 9000);
        return false;
      }
    },
  });
  modal.open();
}
function withSliderValue(slider, digits = 0) {
  const value = slider.sliderEl.parentElement.querySelector(".slider-value")
    || slider.sliderEl.ownerDocument.createElement("span");
  value.classList.add("qiaomu-reader-slider-value");
  if (!value.parentElement) slider.sliderEl.before(value);
  const update = () => { value.textContent = Number(slider.getValue()).toFixed(digits); };
  slider.sliderEl.addEventListener("input", update);
  update();
  return slider;
}
const SettingsTab = createSettingsTab({
  Notice,
  Platform,
  PluginSettingTab,
  SecretComponent,
  Setting,
  setIcon,
  HL_COLORS,
  OnboardingModal,
  QUOTE_TEMPLATE_DEFAULT,
  SettingsGroupModal,
  TRANSLATION_LANGUAGE_CHOICES,
  VIEW_TYPE,
  WHATS_NEW,
  WhatsNewModal,
  addFolderPathControl,
  addMarkdownFilePathControl,
  aiConfig,
  aiConnectionErrorMessage,
  aiSetupMessage,
  aiSetupState,
  aiTestConnection,
  aiCapabilityState: effectiveCapability,
  bindSettingsTabKeys,
  detectAiCapability,
  buildCustomFontInput,
  buildPageButtonsSetting,
  copyToClipboard,
  fmtReadTime,
  openPluginAiSettings,
  qiaomuReaderDeviceKey,
  qiaomuReaderFontLabel,
  qiaomuReaderReaderFonts,
  qiaomuReaderSetLanguage,
  qiaomuReaderTranslate,
  readerThemeLabel,
  readerTimer,
  readerTodayKey,
  readingStats,
  selectedReaderTheme,
  setReaderTheme,
  testAndEnableAi,
  withSliderValue,
});
const QiaomuBookReader = createPlugin({
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  AI_CHAT_VIEW_TYPE,
  AiChatView,
  AiExplainModal,
  BOOK_EXTENSIONS,
  BookQuickOpen,
  DEFAULT,
  LIB_VIEW_TYPE,
  LibraryView,
  MAX_BOOK_COMMANDS,
  OnboardingModal,
  ReaderModal,
  ReaderView,
  SettingsTab,
  VIEW_TYPE,
  WhatsNewModal,
  aiSetupState,
  applyDeviceProfile,
  bookNoteFiles,
  bookNoteLinkFor,
  bookNoteTemplatePath,
  bookNotesFolderPath,
  captureDeviceProfile,
  flattenSelectionText,
  hlMark,
  isMarkedReadingNote,
  isUnsafeReadingNote,
  normalizeAiChatHistory,
  notesFolderPath,
  openPluginAiSettings,
  processTemplateManually,
  qiaomuReaderPath,
  qiaomuReaderSetLanguage,
  qiaomuReaderTranslate,
  readerAiPanelContext,
  readerDefaultAiContext,
  readerHud,
  readerSupportsAiContext,
  readerTodayKey,
  rememberReaderJump,
  resolveBookNote,
  sanitizeNoteTitle,
  selectedReaderTheme,
  stripGeneratedReadingNoteTitle,
  syncHighlightsToReadingNote,
  whatsNewSince,
  writeBookProperty,
  writeWhatsNewNote,
});

export default QiaomuBookReader;

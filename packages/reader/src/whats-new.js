// WHATS_NEW lives here so the reader logic stays host-agnostic.

export function createWhatsNew({
  qiaomuReaderTranslate,
}) {
  const WHATS_NEW = [
  { v: "4.0.1", items: [
    qiaomuReaderTranslate("ai-assistance-now-binds-to-the-newly-opened-book-immediately-so"),
    qiaomuReaderTranslate("fixed-blank-first-screens-collapsed-pagination-during-sidebar-ch"),
    qiaomuReaderTranslate("cli-setup-now-establishes-a-real-acp-session-and-sends-a-minimal"),
    qiaomuReaderTranslate("unreadable-or-empty-synced-json-files-are-protected-with-recover")
  ]},
  { v: "4.0.0", items: [
    qiaomuReaderTranslate("pdfs-now-retain-their-original-pages-with-50-300-zoom-text-pages"),
    qiaomuReaderTranslate("ai-assistance-now-provides-a-separate-chat-for-each-book-live-ma"),
    qiaomuReaderTranslate("codex-claude-grok-kimi-and-zcode-now-use-persistent-acp-sessions"),
    qiaomuReaderTranslate("expired-acp-sessions-or-interrupted-processes-are-safely-rebuilt"),
    qiaomuReaderTranslate("five-redistributable-chinese-fonts-are-now-bundled-with-refined")
  ]},
  { v: "3.9.1", items: [
    qiaomuReaderTranslate("manually-appended-excerpts-are-no-longer-overwritten-by-later-hi"),
    qiaomuReaderTranslate("traditional-chinese-pdfs-from-taiwan-and-hong-kong-now-use-bundl")
  ]},
  { v: "3.8.0", items: [
    qiaomuReaderTranslate("reading-progress-settings-and-highlights-now-save-in-order-so-ra"),
    qiaomuReaderTranslate("unreadable-reading-data-is-no-longer-overwritten-and-the-origina"),
    qiaomuReaderTranslate("book-opening-failures-now-show-a-retryable-error-page-instead-of"),
    qiaomuReaderTranslate("primary-library-and-reader-actions-are-keyboard-focusable-and-ob")
  ]},
  { v: "3.7.0", items: [
    qiaomuReaderTranslate("cli-ai-now-remembers-model-and-reasoning-effort-separately-for-c"),
    qiaomuReaderTranslate("claude-code-and-grok-now-stream-token-by-token-with-reasoning-ke"),
    qiaomuReaderTranslate("removed-the-leftover-russian-word-from-the-default-copied-excerp"),
    qiaomuReaderTranslate("reading-settings-no-longer-scrolls-horizontally-or-lets-its-scro"),
    qiaomuReaderTranslate("the-appearance-page-now-includes-theme-font-size-and-line-spacin")
  ]},
  { v: "3.6.0", items: [
    qiaomuReaderTranslate("after-appending-an-excerpt-the-reader-asks-whether-to-open-the-r"),
    qiaomuReaderTranslate("ai-quick-prompts-can-now-be-added-edited-deleted-and-restored-to"),
    qiaomuReaderTranslate("the-ai-dialog-now-links-directly-to-prompt-settings-and-includes")
  ] },
  { v: "3.5.1", items: [
    qiaomuReaderTranslate("the-selection-toolbar-now-has-a-more-menu-for-excerpt-notes-addi"),
    qiaomuReaderTranslate("comments-now-stay-beside-the-passage-showing-a-three-line-expand"),
    qiaomuReaderTranslate("ai-setup-now-shows-only-essentials-by-default-with-model-and-end"),
    qiaomuReaderTranslate("english-font-names-no-longer-carry-redundant-chinese-suffixes-an")
  ] },
  { v: "3.5.0", items: [
    qiaomuReaderTranslate("ai-answers-now-stream-live-reasoning-is-shown-separately-and-col"),
    qiaomuReaderTranslate("ai-chat-now-includes-six-common-reading-prompts-and-remains-open"),
    qiaomuReaderTranslate("reading-themes-now-affect-only-the-page-the-top-toolbar-and-bott"),
    qiaomuReaderTranslate("plugin-settings-have-been-regrouped-with-clearer-chinese-copy-ma"),
    qiaomuReaderTranslate("fixed-api-requests-failing-to-include-an-already-saved-key")
  ] },
  { v: "3.4.0", items: [
    qiaomuReaderTranslate("added-codex-cli-claude-code-cli-and-grok-cli-using-existing-loca"),
    qiaomuReaderTranslate("cli-requests-run-in-isolated-temporary-directories-with-tools-fi"),
    qiaomuReaderTranslate("settings-can-auto-detect-cli-paths-check-login-status-and-send-a"),
    qiaomuReaderTranslate("cli-generation-can-be-stopped-at-any-time-and-the-full-subproces")
  ] },
  { v: "3.3.0", items: [
    qiaomuReaderTranslate("added-provider-presets-for-deepseek-kimi-qwen-glm-minimax-silico"),
    qiaomuReaderTranslate("api-keys-now-use-obsidian-secretstorage-with-a-built-in-connecti"),
    qiaomuReaderTranslate("redesigned-reading-themes-paper-white-warm-paper-celadon-night-a"),
    qiaomuReaderTranslate("rebuilt-the-ai-reading-prompt-for-chinese-readers-and-removed-th")
  ] },
  { v: "3.2.3", items: [
    qiaomuReaderTranslate("fixed-reading-note-title-migration-when-legacy-link-names-differ")
  ] },
  { v: "3.2.2", items: [
    qiaomuReaderTranslate("fixed-migration-of-duplicate-book-title-headings-in-existing-rea")
  ] },
  { v: "3.2.1", items: [
    qiaomuReaderTranslate("simplified-chinese-is-now-the-default-interface-for-new-installs"),
    qiaomuReaderTranslate("reading-progress-is-saved-automatically-the-redundant-restore-po"),
    qiaomuReaderTranslate("the-reader-now-has-a-reading-note-button-it-creates-the-note-whe"),
    qiaomuReaderTranslate("automatically-created-reading-notes-no-longer-repeat-the-book-ti")
  ] },
  { v: "3.2.0", items: [
    qiaomuReaderTranslate("a-new-chinese-interface-plus-source-han-serif-and-source-han-san"),
    qiaomuReaderTranslate("links-from-notes-back-to-the-book-now-use-one-quiet-icon-without"),
    qiaomuReaderTranslate("the-library-now-has-a-calm-editorial-layout-without-emoji-glow-e"),
    qiaomuReaderTranslate("the-plugin-is-now-qiaomu-book-reader-maintained-by-qiaomu")
  ] },
  { v: "3.1.0", items: [
    qiaomuReaderTranslate("the-plugin-loads-again-where-it-used-to-say-failed-to-load-older"),
    qiaomuReaderTranslate("quotes-can-pile-up-in-one-book-note-the-title-dialog-now-has-an"),
    qiaomuReaderTranslate("the-wording-of-the-to-this-spot-in-the-book-link-is-yours-now-se"),
    qiaomuReaderTranslate("tapping-a-highlight-in-the-list-takes-you-to-its-place-in-the-bo"),
    qiaomuReaderTranslate("the-selection-bar-no-longer-jumps-to-empty-space-at-the-start-of"),
    qiaomuReaderTranslate("on-android-the-top-bar-no-longer-slides-under-the-clock-if-the-p"),
    qiaomuReaderTranslate("what-s-new-is-saved-as-a-note-in-your-vault-so-there-is-nothing")
  ] },
  { v: "3.0.2", items: [
    qiaomuReaderTranslate("report-a-bug-or-suggest-a-feature-and-we-will-follow-up-on-githu"),
    qiaomuReaderTranslate("explaining-a-passage-is-a-conversation-now-your-own-question-you"),
    qiaomuReaderTranslate("the-reader-adapts-to-the-device-phone-tablet-and-desktop-each-ge"),
    qiaomuReaderTranslate("reader-and-library-themes-switch-instantly-and-can-follow-your-o"),
    qiaomuReaderTranslate("the-pdf-engine-has-been-updated-opening-books-is-more-reliable")
  ] },
  { v: "2.0.1", items: [
    qiaomuReaderTranslate("pdf-paragraphs-are-kept-as-in-the-original-the-text-no-longer-gl"),
    qiaomuReaderTranslate("library-an-add-a-book-button-and-drag-and-drop-of-files-pdf-epub"),
    qiaomuReaderTranslate("the-pdf-engine-is-now-bundled-in-books-open-offline-nothing-is-f"),
    qiaomuReaderTranslate("in-the-highlights-list-a-comment-no-longer-breaks-the-quote-it-s")
  ] },
  { v: "2.0.0", items: [
    qiaomuReaderTranslate("search-the-whole-book-magnifier-icon-at-the-top-with-a-match-lis"),
    qiaomuReaderTranslate("the-matched-word-is-painted-right-in-the-text-so-you-don-t-have"),
    qiaomuReaderTranslate("comment-on-a-highlight-a-short-thought-stays-with-the-quote-inst"),
    qiaomuReaderTranslate("contents-finally-works-it-had-the-data-but-never-showed-it-fixed"),
    qiaomuReaderTranslate("quote-export-now-groups-by-chapter-and-labels-the-page-number"),
    qiaomuReaderTranslate("pictures-now-show-up-straight-away-previously-you-had-to-open-an"),
    qiaomuReaderTranslate("a-note-made-from-a-highlight-can-go-straight-into-the-folder-you"),
    qiaomuReaderTranslate("highlights-are-exported-selectively-tick-boxes-select-all-new-on"),
    qiaomuReaderTranslate("e-ink-reader-mode-no-animations-or-shadows-pure-black-on-white-b"),
    qiaomuReaderTranslate("the-guide-has-grown-it-now-walks-through-every-setting-with-exam"),
    qiaomuReaderTranslate("open-a-book-by-command-each-book-gets-its-own-command-and-hotkey"),
    qiaomuReaderTranslate("reading-stats-all-time-total-day-streak-and-a-two-week-chart"),
    qiaomuReaderTranslate("page-turns-go-straight-sideways-instead-of-drifting-into-the-cor"),
    qiaomuReaderTranslate("lines-fill-the-page-to-the-bottom-no-more-blank-gaps-at-the-foot"),
    qiaomuReaderTranslate("re-layout-when-sidebars-open-or-close-now-fades-instead-of-jumpi"),
    qiaomuReaderTranslate("new-format-fb2-including-older-files-in-windows-1251-encoding"),
    qiaomuReaderTranslate("technical-books-read-properly-code-tables-and-formulas-no-longer"),
    qiaomuReaderTranslate("code-listings-are-recognised-even-where-the-book-declares-no-mon"),
    qiaomuReaderTranslate("margin-notes-are-no-longer-glued-into-the-middle-of-code-lines"),
    qiaomuReaderTranslate("contents-pages-with-dot-leaders-come-out-as-a-tidy-list"),
    qiaomuReaderTranslate("a-short-page-can-be-centred-vertically-instead-of-pinned-to-the"),
    qiaomuReaderTranslate("contents-are-taken-from-the-pdf-itself-and-on-desktop-it-finally"),
    qiaomuReaderTranslate("pdfs-show-the-illustrations-themselves-rather-than-a-screenshot"),
    qiaomuReaderTranslate("translation-of-a-selected-passage-switched-on-in-the-settings"),
    qiaomuReaderTranslate("library-categories-by-genre-and-folder-plus-a-reading-finished-f"),
    qiaomuReaderTranslate("on-a-book-s-first-open-you-can-now-create-its-note-not-only-pick"),
    qiaomuReaderTranslate("settings-are-split-across-tabs-with-the-rarely-used-ones-tucked"),
    qiaomuReaderTranslate("the-text-re-flows-by-itself-when-panels-open-without-losing-your"),
    qiaomuReaderTranslate("fixed-typing-a-path-in-the-settings-created-a-folder-per-keystro"),
    qiaomuReaderTranslate("the-plugin-is-nearly-4-mb-lighter")
  ] }
];
  return WHATS_NEW;
}

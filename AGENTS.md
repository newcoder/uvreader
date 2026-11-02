# UV Reader — agent notes

Standalone Electron reader (EPUB/PDF/FB2/MOBI/AZW3/CBZ + images) with highlights, notes and optional AI. Product name **UV Reader / 纽扣**; UI copy, README and docs are Chinese-first. The Obsidian plugin packaging is gone, but the reader core still runs behind a desktop host shim.

## Setup and commands

- Node **>=22.19** (`pdfjs-dist` needs 22.13+, `pi-ai` 22.19+); the workshop engine additionally needs Python. Run `npm ci` first: `postinstall` applies the pdf.js sentence-period and foliate sandbox/lenient-XHTML patches, and a fresh install reverts them — do not hand-edit `node_modules`.
- Install the shell's own deps before desktop work: `npm ci --prefix apps/desktop` (or `npm run desktop:install`; behind a blocked network set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`). `test:desktop` imports `@earendil-works/pi-ai` from there, and `desktop:build` needs its esbuild.
- Build/run: `npm run desktop:build` then `npm run desktop:start`. `desktop:dev` is **watch-build only** and does not launch the app (README says otherwise); run `desktop:start` separately.
- Packaging: `desktop:dist` / `desktop:dist:dir` write `apps/desktop/release/`; `desktop:smoke:packaged` exercises the packaged app.
- `npm test` runs `tests/*.test.mjs` (reader core). Focus one file with `node --test tests/core-config.test.mjs`, one test with `node --test --test-name-pattern="…" tests/core-config.test.mjs` (the flag must come before the file). `npm run test:shim` / `npm run test:desktop` cover the shim / shell; `node --test <file>` works for a single file there too.
- `npm run check:i18n` checks 9 languages and also asserts exact source substrings, so copy/markup changes can fail it without dictionary edits. New UI strings need entries in `i18n-en.js`, `i18n-zh.js` and every `locales/*.js` pack; all seven packs are checked.
- Lint exactly as CI does: `npx eslint packages/reader/src packages/host-shim apps/desktop/src apps/desktop/test apps/desktop/scripts apps/desktop/build.mjs tests scripts --max-warnings=0`. Warnings fail; `no-unused-vars` is on (use `_` prefixes).
- `npm run desktop:e2e` builds then runs Playwright-Electron; `QBR_E2E_ONLY=workshop,library` narrows it. `npm run desktop:smoke` opens a starter book and exits 0/1. `npm run check:epub -- <book.epub>` validates an EPUB product.
- `npm run desktop:matrix` needs real external tools and defaults to a dev-only sample outside the repo: set `QBR_MATRIX_PDF` + `QBR_MATRIX_PDF_MARKER`, `QBR_OCR_SIDECAR`, `QBR_OCR_PYTHON`; narrow with `QBR_MATRIX_ONLY=dv:docx->pdf,pdf-text->docx`; `QBR_MATRIX_MINERU=1` adds MinerU; route through an engine with `QBR_MATRIX_ENGINE_URL`/`_TOKEN` and verify via its `/v1/jobs`.
- CI (`.github/workflows/ci.yml`): an `engine` job runs pytest + engine e2e; `verify` runs `npm ci` → `npm ci --prefix apps/desktop` → test → test:shim → test:desktop → check:i18n → eslint → build → smoke under xvfb.
- Release: bump the root **and** `apps/desktop/package.json` versions, push `v<version>`; `scripts/check-release-tag.mjs` guards the tag. `.github/workflows/release.yml` builds Windows and macOS x64/arm64 only (no Linux). Engine releases use independent `engine-v*` tags.

## Layout

- `packages/reader/src/` — reader core. `main.js` is a thin `export { default } from "./wire.js"`; `wire.js` is the only reader module importing `obsidian` and holds helper wiring; `plugin.js` / `settings-tab.js` are host-agnostic factories. Put new testable logic in pure modules here.
- `packages/host-shim/` — Obsidian API compatibility layer; the desktop renderer imports `obsidian` through the esbuild alias to it.
- `apps/desktop/src/` — `main/index.js` (IPC/services/workshop/AI), `preload/index.js` (bridge), `renderer/entry.js` (boots the shim + reader), `shared/` (pure book/format helpers). `build.mjs` emits `dist/main.cjs`, `preload.cjs`, `renderer.js`.
- AI: `main/ai-runtime.js` bundles pi-ai in the main process; preload exposes `qbrDesktop.ai`, and `packages/reader/src/ai-pi.js` adapts it to `aiExplain`. Never import `@earendil-works/pi-ai` from reader modules.
- `engine/` — optional Python workshop service (next section).

## Workshop engine (`engine/`)

- It is a separate FastAPI service, not part of the Electron bundle. The app talks HTTP via `apps/desktop/src/main/engine-client.js` and prefers the engine for workshop jobs, falling back to local Python/Calibre spawns; keep the fallback and `via` reporting intact.
- Dev run: `cd engine && python -m engine serve --port 8760 [--token …]`. Run from `engine/`, otherwise the outer directory becomes a namespace package. Config lives at `ENGINE_CONFIG` or `~/.uvreader-engine/config.json`, is read once at startup (restart after manual edits), and is updated live via `PATCH /v1/config`.
- Tests: `pip install -r engine/requirements.txt -r engine/requirements-dev.txt`, then `python -m pytest engine/tests -q`; `node scripts/engine-e2e.mjs --require` starts the real service with fake external tools (`--python` / `QBR_ENGINE_PYTHON`; without `--require` it skips when deps are missing). CI runs both.
- Keep `engine/requirements*.txt` ASCII-only (pip decodes with the system locale on Windows). Keep `pymupdf<2`; 2.x pulls pymupdf4llm/pymupdf-layout. RapidOCR + onnxruntime are bundled for the text layer (the engine bundle is ~160 MB); `engineOcrReady` only auto-wires the engine sidecar when `rapidocr` is present, so older bundles fall back to manual settings.
- A copied MinerU venv can keep a valid `mineru-kit.exe` while its `pyvenv.cfg` points at another machine's Python. Validate with `mineru-kit --version` before using or syncing it; otherwise pdf_tool fails every extraction with exit 103.
- Engine version is `engine/engine/__init__.py`; `engine/engine/engine.json` is a dev manifest (`platform: "dev"`) ignored by `/v1/health` and not packed. `engine/vendor/pdf_tool` is a pinned snapshot — refresh with `node scripts/vendor-pdf-tool.mjs --from <pdf_tool dir>`, never hand-edit.
- Optional components install into `<bundle>/components`, not the interpreter's site-packages (Windows locks in-use packages). Bundle: `node scripts/build-engine.mjs --platform win32-x64`, then `node scripts/check-engine-bundle.mjs dist/engine --platform win32-x64`; `.github/workflows/engine.yml` publishes Windows/macOS only.

## Constraints

- The Obsidian extraction is done. Do not recreate root `main.js`/`styles.css`; build output lives in `apps/desktop/dist/`, `apps/desktop/release/` and root `dist/` (engine bundles).
- Keep `packages/host-shim` behavior-compatible: `setViewState` must call `view.setState`; `Modal` needs a close button/backdrop/Esc stack and must not clobber `Modal.scope` (history filtering uses `filterScope`); `Setting` needs `settingEl`; components need `selectEl/toggleEl/sliderEl`; `SecretStorage.getSecret` is synchronous.
- Do not re-add EPUB scrolled-mode section stacking: upstream foliate mounts one section at a time; rationale in `docs/scroll-mode-design.md`. PDF scrolling uses the reader's own `pdf-paginator`.
- Generated files — do not hand-edit: `pdf-cmaps-data.js` / `pdf-wasm-data.js` (`scripts/generate-pdf-cmaps.mjs` / `generate-pdf-wasm.mjs`), `hanzi-dict-data.js` / `word-dict-data.js` (`scripts/generate-hanzi-dict.mjs`), pinned `assets/starter-books/` (`npm run build:books`), `apps/desktop/assets/icons/` and `logo.png` / `build/icon.png` (`npm run build:icons` / `build:icon`). Sliced icons are CSS masks so they take `currentColor`.
- esbuild aliases node builtins and `localforage` to `build-stubs/empty.js`; `__PDF_WORKER_CODE__` and `__QBR_ENGINE_VIEW_TAG__` are build defines. Reader sources must not import node builtins.
- Desktop main-process cleanup of user paths: use `removeFile` / `removeTree` from `apps/desktop/src/main/paths.js`, not `fs.rmSync` / `rmdirSync` — on Windows + non-ASCII names those silently no-op.
- Tests and `check:i18n` read source text and assert exact substrings; grep for the string before rewording it.

## Docs

- Trust `package.json`, CI workflows and code over prose. `CONTRIBUTING.md` is Obsidian-era (its `npm run build`, `src/`, and MIT references are stale).
- `docs/` is dated design/QA history; status headers can lag the code (e.g. the engine plan still says "not started" after E1–E5).

## Product interaction preferences

- Optimize for reading, highlighting and taking notes; minimize setup steps and cognitive load.
- Use progressive disclosure. Show service/model choices, required inputs and real readiness first. Fold paths, protocols, installation commands, response customization, storage internals and maintenance. Surface blocking errors with a specific recovery action.
- Prefer existing accounts, verified defaults, standard icons and short visible labels. Do not claim a connection works before checking it.
- Unnecessary hover tooltips are off by default, including Obsidian tooltips generated from `aria-label`, `setTooltip` and native `title`. Preserve accessible names with `aria-labelledby` or visually hidden labels, keyboard focus, visible slider values and useful error feedback. Do not hide tooltips globally or affect other plugins.
- A tooltip exception needs a concrete usability reason; do not add one just to repeat an icon label or visible text. Keep it scoped to the relevant control.

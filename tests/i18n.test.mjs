import assert from "node:assert/strict";
import test from "node:test";
import { QIAOMU_READER_EN } from "../packages/reader/src/i18n-en.js";
import { QIAOMU_READER_ZH_CN } from "../packages/reader/src/i18n-zh.js";
import { UI_LANGUAGES, UI_TRANSLATIONS, normalizeUiLanguage, uiLanguageMetadata } from "../packages/reader/src/i18n-languages.js";
import { isReadingHighlightsHeading, replaceManagedReadingHighlights } from "../packages/reader/src/reading-note.js";
import { translateUiText } from "../packages/reader/src/i18n-runtime.js";

const translate = (language, source) => translateUiText(language, source, QIAOMU_READER_EN, QIAOMU_READER_ZH_CN);

test("language choices include six new locales and preserve Chinese as the default", () => {
  assert.deepEqual(UI_LANGUAGES.map((language) => language.id), ["zh", "en", "ru", "ja", "es", "fr", "de", "ko", "pt"]);
  assert.equal(normalizeUiLanguage("JA-jp"), "ja");
  assert.equal(normalizeUiLanguage("pt_BR"), "pt");
  assert.equal(normalizeUiLanguage(" fr-FR "), "fr");
  assert.equal(normalizeUiLanguage("unknown"), "zh");
  assert.equal(normalizeUiLanguage(null), "zh");
  assert.equal(uiLanguageMetadata("ja").locale, "ja-JP");
  assert.equal(uiLanguageMetadata("pt").locale, "pt-BR");
  assert.equal(uiLanguageMetadata("ko").cjk, true);
  assert.equal(uiLanguageMetadata("fr").cjk, false);
  for (const language of UI_LANGUAGES) {
    assert.equal(Intl.DateTimeFormat.supportedLocalesOf([language.locale]).length, 1);
  }
});

test("all new language packs resolve every canonical key instead of silently falling back", () => {
  const keys = Object.keys(QIAOMU_READER_EN).sort();
  for (const [language, dictionary] of Object.entries(UI_TRANSLATIONS)) {
    assert.deepEqual(Object.keys(dictionary).sort(), keys, language);
    for (const key of keys) {
      assert.equal(typeof dictionary[key], "string", `${language}: ${key}`);
      assert.ok(dictionary[key].trim(), `${language}: ${key}`);
      assert.equal(translate(language, key), dictionary[key]);
    }
    assert.notEqual(translate(language, "library"), QIAOMU_READER_EN["library"]);
    assert.notEqual(translate(language, "reading-settings"), QIAOMU_READER_EN["reading-settings"]);
  }
});

test("missing strings use English without changing existing Russian and Chinese behavior", () => {
  const english = { "未来功能": "Future feature" };
  assert.equal(translateUiText("ja", "未来功能", english, {}), "Future feature");
  assert.equal(translateUiText("xx", "未来功能", english, {}), "Future feature");
  assert.equal(translateUiText("ru", "未来功能", english, {}), "Future feature");
  assert.equal(translateUiText("zh", "未来功能", english, {}), "未来功能");
  assert.equal(translateUiText("ja", "123.456", english, {}), "123.456");
});


test("localized highlight sections remain idempotent when syncing or switching languages", () => {
  const headings = ["## 划线与批注", "## Quotes", "## Цитаты", ...Object.values(UI_TRANSLATIONS).map((dictionary) => dictionary["quotes"])];
  for (const heading of headings) {
    assert.equal(isReadingHighlightsHeading(heading), true, heading);
    const before = `# Book\n\n${heading}\n\n> Old highlight\n\n## My thoughts\n\nKeep this paragraph.\n`;
    const block = "## Quotes\n\n> Updated highlight";
    const after = replaceManagedReadingHighlights(before, block, "Previous highlights");
    assert.equal(replaceManagedReadingHighlights(after, block, "Previous highlights"), after);
    assert.equal((after.match(/Updated highlight/g) || []).length, 1);
    assert.doesNotMatch(after, /Old highlight/);
    assert.match(after, /Keep this paragraph/);
    assert.match(after, /## My thoughts/);
  }
  assert.equal(isReadingHighlightsHeading("## My thoughts"), false);
});

import ja from "./locales/ja.js";
import es from "./locales/es.js";
import fr from "./locales/fr.js";
import de from "./locales/de.js";
import ko from "./locales/ko.js";
import pt from "./locales/pt.js";
import ru from "./locales/ru.js";

export const UI_LANGUAGES = Object.freeze([
  { id: "zh", label: "简体中文", locale: "zh-CN", cjk: true },
  { id: "en", label: "English", locale: "en-US", cjk: false },
  { id: "ru", label: "Русский", locale: "ru-RU", cjk: false },
  { id: "ja", label: "日本語", locale: "ja-JP", cjk: true },
  { id: "es", label: "Español", locale: "es-ES", cjk: false },
  { id: "fr", label: "Français", locale: "fr-FR", cjk: false },
  { id: "de", label: "Deutsch", locale: "de-DE", cjk: false },
  { id: "ko", label: "한국어", locale: "ko-KR", cjk: true },
  { id: "pt", label: "Português (Brasil)", locale: "pt-BR", cjk: false },
]);

export const UI_TRANSLATIONS = Object.freeze({ ja, es, fr, de, ko, pt, ru });

export function normalizeUiLanguage(value) {
  const id = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  return UI_LANGUAGES.some((language) => language.id === id) ? id : "zh";
}

export function uiLanguageMetadata(value) {
  return UI_LANGUAGES.find((language) => language.id === normalizeUiLanguage(value));
}

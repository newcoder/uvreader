import { UI_TRANSLATIONS } from "./i18n-languages.js";

const HAN = /[\u3400-\u9fff]/;
const CYRILLIC = /[А-Яа-яЁё]/;

export function isChineseSourceText(value) {
  const text = String(value || "");
  return HAN.test(text) && !CYRILLIC.test(text);
}

export function translateUiText(language, source, english, chinese) {
  const text = String(source ?? "");
  if (language === "zh") return chinese?.[text] ?? text;
  if (language === "en") return english?.[text] ?? text;
  // Russian now has a real pack: keys are semantic slugs, values keep the inherited
  // Russian wording (Chinese-first feature keys are translated to Russian there).
  // Strings missing from the pack keep the historical fallbacks: Chinese-source
  // text shows the English copy, everything else shows the text itself.
  if (language === "ru") {
    const russian = UI_TRANSLATIONS.ru?.[text];
    if (typeof russian === "string" && russian) return russian;
    if (isChineseSourceText(text)) return english?.[text] ?? text;
    return text;
  }
  return UI_TRANSLATIONS[language]?.[text] || english?.[text] || text;
}

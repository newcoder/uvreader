// Deterministic Simplified/Traditional Chinese conversion for the book
// builder. Unlike translation this does not call AI and never produces a
// source/translation pair; code, tables and figures stay untouched.
import OpenCC from "opencc-js";

const converters = new Map();

function converterFor(target) {
  const key = target === "s" ? "t2s" : "s2tw";
  let convert = converters.get(key);
  if (!convert) {
    convert = target === "s"
      ? OpenCC.Converter({ from: "t", to: "cn" })
      : OpenCC.Converter({ from: "cn", to: "tw" });
    converters.set(key, convert);
  }
  return convert;
}

export function convertChineseScript(text, target = "t") {
  const value = String(text == null ? "" : text);
  if (!value) return "";
  return converterFor(target === "s" ? "s" : "t")(value);
}

export function scriptTargetLabel(target) {
  return target === "s" ? "简体" : "繁體";
}

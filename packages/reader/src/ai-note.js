export function composeAiAnswerNote({
  answer,
  sourceText = "",
  attribution = "",
  sourceHeading = "Original",
  tagLine = "",
  meta = "",
}) {
  const body = String(answer || "").trim();
  const source = String(sourceText || "").trim();
  const credit = String(attribution || "").trim();
  const metaLine = String(meta || "").trim();
  const sourceQuote = source
    ? `\n\n## ${sourceHeading}\n\n> ${source.replace(/\n/g, "\n> ")}${credit ? `\n>\n> ${credit}` : ""}`
    : credit ? `\n\n${credit}` : "";
  return `${tagLine}${metaLine ? `${metaLine}\n\n` : ""}${body}${sourceQuote}`;
}

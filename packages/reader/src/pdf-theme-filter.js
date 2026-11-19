// Installs the SVG colour filter used by PDF pages. CSS filter functions cannot
// map white and black to arbitrary theme colours without tinting the scanned
// paper (beige paper turned brown under invert/hue-rotate), so this filter
// desaturates the page, stretches its paper/ink levels, then maps the two ends
// to the theme's panel background and text colour.
import { pdfPageFilterSpec } from "./reader-themes.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const PDF_THEME_FILTER_ID = "qiaomu-reader-pdf-theme-filter";
const SVG_ID = "qiaomu-reader-pdf-theme-filter-svg";

function componentTransfer(doc, name, values, result) {
  const transfer = doc.createElementNS(SVG_NS, "feComponentTransfer");
  transfer.setAttribute("in", name);
  if (result) transfer.setAttribute("result", result);
  ["R", "G", "B"].forEach((channel, index) => {
    const func = doc.createElementNS(SVG_NS, `feFunc${channel}`);
    func.setAttribute("type", "linear");
    func.setAttribute("slope", String(values[index].slope));
    func.setAttribute("intercept", String(values[index].intercept));
    transfer.appendChild(func);
  });
  return transfer;
}

export function applyPdfPageThemeFilter(doc, settings) {
  const spec = pdfPageFilterSpec(settings);
  if (!spec || !doc?.body) return "none";
  const url = `url(#${PDF_THEME_FILTER_ID})`;
  let svg = doc.getElementById(SVG_ID);
  if (svg?.dataset.theme === spec.id && doc.getElementById(PDF_THEME_FILTER_ID)) return url;
  if (!svg) {
    svg = doc.createElementNS(SVG_NS, "svg");
    svg.id = SVG_ID;
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.style.position = "absolute";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.overflow = "hidden";
    svg.style.pointerEvents = "none";
    doc.body.appendChild(svg);
  }
  doc.getElementById(PDF_THEME_FILTER_ID)?.remove();

  const filter = doc.createElementNS(SVG_NS, "filter");
  filter.id = PDF_THEME_FILTER_ID;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  filter.setAttribute("x", "0");
  filter.setAttribute("y", "0");
  filter.setAttribute("width", "100%");
  filter.setAttribute("height", "100%");

  const gray = doc.createElementNS(SVG_NS, "feColorMatrix");
  gray.setAttribute("type", "saturate");
  gray.setAttribute("values", "0");
  gray.setAttribute("in", "SourceGraphic");
  gray.setAttribute("result", "gray");
  filter.appendChild(gray);

  const levels = Array.from({ length: 3 }, () => spec.levels);
  filter.appendChild(componentTransfer(doc, "gray", levels, "levels"));
  filter.appendChild(componentTransfer(doc, "levels", spec.channels, ""));
  svg.appendChild(filter);
  svg.dataset.theme = spec.id;
  return url;
}

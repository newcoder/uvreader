export const READER_THEMES = {
  white: {
    label: "white",
    bg: "#ffffff",
    text: "#1f2328",
    ui: "#f4f5f6",
    border: "#d8dce0",
    accent: "#496c7b",
    muted: "#6b7280",
  },
  paper: {
    label: "paper-white",
    bg: "#f8f6f0",
    text: "#24231f",
    ui: "#efebe2",
    border: "#dcd5c8",
    accent: "#4f6758",
    muted: "#746f66",
  },
  warm: {
    label: "warm-paper",
    bg: "#f3ebdd",
    text: "#30291f",
    ui: "#e9decb",
    border: "#d5c5ab",
    accent: "#755d3c",
    muted: "#776b59",
  },
  celadon: {
    label: "celadon",
    bg: "#eaf0e8",
    text: "#243029",
    ui: "#dfe8dd",
    border: "#c6d3c4",
    accent: "#4f6d5a",
    muted: "#667269",
  },
  moon: {
    label: "moon-white",
    bg: "#eef2f3",
    text: "#263238",
    ui: "#e2e8ea",
    border: "#c9d2d5",
    accent: "#516c78",
    muted: "#5f6d74",
  },
  night: {
    label: "night",
    bg: "#181a1b",
    text: "#d9d7d1",
    ui: "#222526",
    border: "#383c3d",
    accent: "#91ab9a",
    muted: "#9a9a94",
  },
  "warm-night": {
    label: "warm-night",
    bg: "#1b1714",
    text: "#d8ccbc",
    ui: "#241f1a",
    border: "#3b332b",
    accent: "#b79b76",
    muted: "#a89b8b",
  },
  "slate-night": {
    label: "slate-night",
    bg: "#1a2228",
    text: "#d5e0e6",
    ui: "#232d34",
    border: "#37454e",
    accent: "#86a9ba",
    muted: "#9aadb8",
  },
  eink: {
    label: "e-ink-2",
    bg: "#ffffff",
    text: "#000000",
    ui: "#ffffff",
    border: "#000000",
    accent: "#000000",
    muted: "#444444",
  },
};

export const READER_THEME_CHOICES = [
  "white",
  "paper",
  "warm",
  "celadon",
  "moon",
  "night",
  "warm-night",
  "slate-night",
];

// PDF pages are one opaque raster: changing their fonts would destroy the
// layout, but a display filter can still map them onto the reading theme.
// The page is first desaturated, then its paper/ink levels are stretched, and
// finally paper maps to the panel colour (`ui`) while ink maps to the theme
// text colour. This makes the page rectangle match the TOC/panel instead of
// looking like a separately tinted scan.
const PDF_PAGE_LEVELS = { slope: 1.3158, intercept: -0.1579 };

function hexChannels(value) {
  const hex = String(value || "").replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return [0, 0, 0];
  return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
}

// Accept either a theme id or the reader settings object. Returns null when the
// page should stay untouched (e-ink mode).
export function pdfPageFilterSpec(value) {
  if (value && typeof value === "object" && value.einkMode === true) return null;
  if (value === "eink") return null;
  const id = value && typeof value === "object" ? migrateReaderTheme(value.theme) : migrateReaderTheme(value);
  const theme = READER_THEMES[id] || READER_THEMES.paper;
  const text = hexChannels(theme.text);
  const bg = hexChannels(theme.ui);
  return {
    id,
    levels: { ...PDF_PAGE_LEVELS },
    channels: text.map((textValue, index) => ({
      slope: (bg[index] - textValue) / 255,
      intercept: textValue / 255,
    })),
  };
}

export function migrateReaderTheme(value) {
  // Older versions had an "auto" theme wired to Obsidian variables. The
  // standalone shell default is dark, so freeze those users on the closest
  // fixed palette instead of silently switching them to a light page.
  if (value === "auto") return "night";
  if (value === "light") return "paper";
  if (value === "sepia") return "warm";
  if (value === "dark") return "night";
  if (value === "eink") return "moon";
  return READER_THEMES[value] ? value : "paper";
}

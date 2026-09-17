// One palette for the inline color picker, book overlays, and exported notes.
export const HIGHLIGHT_PAINTS = Object.freeze({
  yellow: "rgba(255,206,64,.45)",
  green: "rgba(118,214,108,.42)",
  blue: "rgba(96,165,250,.42)",
  pink: "rgba(248,123,168,.42)",
  red: "rgba(245,168,160,.42)",
  purple: "rgba(213,184,255,.42)",
});
export const HL_COLOR_SWATCHES = ["yellow", "green", "blue", "pink"]
  .map(id => [id, id, HIGHLIGHT_PAINTS[id]]);

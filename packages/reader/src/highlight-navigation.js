export async function jumpToEngineHighlight(view, highlight) {
  if (!highlight?.cfi || !view.engine) throw new Error("Highlight has no CFI");
  const engine = view.engine;
  await engine.goTo(highlight.cfi);
  if (view.engine !== engine || view._closed) return;
  if (highlight.id) await engine.addHighlight(highlight.id, highlight.cfi, highlight.color);
  (view.closePanel || view._closePanel)?.call(view);
  view._armImmersive?.();
}

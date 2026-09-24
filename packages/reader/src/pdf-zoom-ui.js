// PDF zoom state and layout math. Pure DOM work: the host supplies only the
// translated labels and its PDF check, so the module can be unit tested.
import { PDF_ZOOM_DEFAULT, PDF_ZOOM_MAX, PDF_ZOOM_MIN, clampPdfZoom, pdfZoomPercent, stepPdfZoom } from "./pdf-zoom.js";
import { zoomAnchorOffset } from "./reader-experience.js";

export function createPdfZoomUi({ translate, isPdf }) {
  function syncControls(view) {
    const pdf = isPdf(view);
    const zoom = clampPdfZoom(view?.pdfZoom);
    if (view?.contentEl) view.contentEl.toggleClass("qiaomu-reader-pdf-document", pdf);
    if (view?.pdfZoomLabelEl) {
      const label = pdfZoomPercent(zoom);
      view.pdfZoomLabelEl.setText(label);
      view.pdfZoomLabelEl.setAttribute("aria-label", translate("pdf-zoom-options-0", label));
      view.pdfZoomLabelEl.setAttribute("title", translate(view.pdfZoomMode === "width" ? "fit-width" : "pdf-zoom-options-0", label));
    }
    if (view?.pdfZoomSettingsLabelEl) view.pdfZoomSettingsLabelEl.setText(pdfZoomPercent(zoom));
    if (view?.pdfZoomOutEl) view.pdfZoomOutEl.disabled = !pdf || zoom <= PDF_ZOOM_MIN + 0.001;
    if (view?.pdfZoomInEl) view.pdfZoomInEl.disabled = !pdf || zoom >= PDF_ZOOM_MAX - 0.001;
  }

  function visiblePageScrollers(view) {
    const flow = view?.pager?.flow;
    const clip = view?.pager?.clip;
    if (!flow || !clip) return [];
    const viewport = clip.getBoundingClientRect();
    return [...flow.querySelectorAll(".qiaomu-reader-pdf-page-break")].filter((page) => {
      const rect = page.getBoundingClientRect();
      return rect.right > viewport.left + 1 && rect.left < viewport.right - 1
        && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1;
    });
  }

  function apply(view, value, point = null, mode = "custom") {
    if (!isPdf(view)) return;
    const pager = view?.pager;
    const flow = pager?.flow;
    const next = clampPdfZoom(value);
    const previous = clampPdfZoom(view.pdfZoom);
    view.pdfZoomMode = mode;
    if (Math.abs(next - previous) < 0.0005) {
      syncControls(view);
      return;
    }

    const ratio = next / previous;
    const clip = pager?.clip;
    const pageScrollers = flow && clip ? visiblePageScrollers(view).map((page) => {
      const surface = page.querySelector(".qiaomu-reader-pdf-page-surface");
      const bounds = page.getBoundingClientRect();
      const viewport = clip.getBoundingClientRect();
      const x = point?.clientX ?? (Math.max(bounds.left, viewport.left) + Math.min(bounds.right, viewport.right)) / 2;
      const y = point?.clientY ?? (Math.max(bounds.top, viewport.top) + Math.min(bounds.bottom, viewport.bottom)) / 2;
      return { page, surface, old: surface?.getBoundingClientRect(), x, y };
    }).filter((anchor) => anchor.old && (!point || (anchor.x >= anchor.old.left && anchor.x <= anchor.old.right && anchor.y >= anchor.old.top && anchor.y <= anchor.old.bottom))) : [];

    view.pdfZoom = next;
    if (pager) pager.pdfZoom = next;
    if (flow) {
      flow.style.setProperty("--qiaomu-reader-pdf-zoom", String(next));
      // Read once after the custom property update so the following scroll
      // offsets use the new page geometry rather than a stale layout frame.
      void flow.offsetHeight;
      if (pager.scrollMode && clip) {
        const anchor = pageScrollers[0];
        if (anchor) {
          const nextRect = anchor.surface.getBoundingClientRect();
          clip.scrollTop += zoomAnchorOffset(anchor.old.top, nextRect.top, anchor.y, ratio);
          clip.scrollLeft += zoomAnchorOffset(anchor.old.left, nextRect.left, anchor.x, ratio);
        }
        const viewHeight = clip.clientHeight || 1;
        pager.total = Math.max(1, Math.ceil((clip.scrollHeight || viewHeight) / viewHeight));
        pager.spread = Math.max(0, Math.min(Math.round(clip.scrollTop / viewHeight), pager.total - 1));
      } else {
        for (const anchor of pageScrollers) {
          const nextRect = anchor.surface.getBoundingClientRect();
          anchor.page.scrollLeft += zoomAnchorOffset(anchor.old.left, nextRect.left, anchor.x, ratio);
          anchor.page.scrollTop += zoomAnchorOffset(anchor.old.top, nextRect.top, anchor.y, ratio);
        }
      }
    }
    syncControls(view);
    if (view?.bookHtml && pager) {
      (view.updateUI || view._updateUI)?.call(view, pager.spread, pager.total);
    }
  }

  function change(view, direction) {
    apply(view, stepPdfZoom(view?.pdfZoom, direction));
  }

  function fitWidth(view) {
    const page = view.pager?.currentPdfPageElement?.();
    const figure = page?.querySelector(".qiaomu-reader-pdf-native-page");
    const width = parseFloat(figure?.style.getPropertyValue("--qiaomu-reader-pdf-fit-width"));
    if (width) apply(view, Math.max(1, (page.clientWidth - 4) / width), null, "width");
  }

  function setPanMode(view, enabled) {
    view.pdfPanMode = enabled;
    view.contentEl?.toggleClass("qiaomu-reader-pdf-pan", enabled);
    view.pdfPanButton?.setAttribute("aria-pressed", String(enabled));
    view._hideHlPopup?.();
  }

  return { syncControls, visiblePageScrollers, apply, change, fitWidth, setPanMode };
}

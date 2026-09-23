// Reader chrome scaffolding shared by the desktop view and the mobile modal:
// iframe chrome wiring, wheel paging, immersive auto-hide, top/bottom bars,
// slide-in panels, the reading-settings panel body, clipboard and lightbox.
//
// Everything host-specific is injected; the functions mutate the passed view
// exactly as the in-wire versions did.

export function createReaderChrome({
  translate,
  Menu,
  Scope,
  svgIcon,
  iconLabel,
  docOf,
  selOf,
  window: win,
  readerIsPdf,
  clampPdfZoom,
  PDF_ZOOM_DEFAULT,
  readerHud,
  selectionHud,
  addReadingMenuActions,
  openReaderPagePicker,
  syncPageButtons,
  addReaderNavigation,
  setupReaderSelection,
  setupPdfZoomInteractions,
  buildPageButtonsSetting,
  buildBookSettings,
  buildCustomFontInput,
  createPdfZoomSettings,
  READER_THEME_CHOICES,
  readerThemeLabel,
  selectedReaderTheme,
  setReaderTheme,
  qiaomuReaderReaderFonts,
  qiaomuReaderFontLabel,
  ensureBundledReaderFont,
}) {
  function attachEngineChrome(view, doc, index) {
    doc.addEventListener("pointerdown", (event) => {
      view._armImmersive?.();
      selectionHud.beginReaderSelection(view, event);
    });
    const release = () => { view._selectionDragging = false; };
    doc.addEventListener("pointerup", release);
    doc.addEventListener("pointercancel", release);
    // Right-click inside a book must not raise a second menu: the selection
    // popup already carries the actions.
    doc.addEventListener("contextmenu", (event) => event.preventDefault());
    doc.addEventListener("pointermove", (event) => {
      const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
      if (!frame) return;
      const rect = view.areaEl.getBoundingClientRect();
      const y = event.clientY + frame.top;
      if (y <= rect.top + 64 || y >= rect.bottom - 64) view._armImmersive?.();
    });
    doc.addEventListener("click", (event) => {
      const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
      if (!frame) return;
      if (selectionHud.handleAreaNavClick(view, {
        target: event.target, defaultPrevented: event.defaultPrevented,
        clientX: event.clientX + frame.left,
      })) event.preventDefault();
    });
    doc.addEventListener("wheel", (event) => handleReaderWheel(view, event), { passive: false });
  }

  // Wheel paging: in paged layout any wheel gesture turns the page; in scrolling
  // layout the wheel scrolls normally and only turns once the reader reaches the
  // top or bottom edge of the current screen.
  const WHEEL_TURN_COOLDOWN_MS = 450;
  function engineWheelScroller(doc) {
    try {
      const root = doc?.defaultView?.frameElement?.getRootNode?.();
      return root?.getElementById?.("container") || null;
    } catch {
      return null;
    }
  }

  function handleReaderWheel(view, event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !event.deltaY) return;
    if (!view.bookHtml || view._openingBook || view._closed || readerIsPdf(view)) return;
    if (view.panelOpen || view._selectionMenuOpen || view._commentEditing) return;
    if (view.hlPopup?.classList.contains("qiaomu-reader-hl-popup-on")) return;
    if (event.target?.closest?.(".qiaomu-reader-panel,.qiaomu-reader-hl-popup,.menu,.modal-container")) return;
    const dir = event.deltaY > 0 ? "next" : "prev";
    const scrolled = view.engine
      ? view.plugin.settings.readMode === "scroll"
      : view.pager?.scrollMode === true;
    if (scrolled) {
      const scroller = view.engine
        ? engineWheelScroller(event.target?.ownerDocument || docOf(view.areaEl))
        : view.pager?.clip;
      if (!scroller) return;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      const atStart = scroller.scrollTop <= 2;
      if ((dir === "next" && !atEnd) || (dir === "prev" && !atStart)) return;
      event.preventDefault();
    }
    const now = Date.now();
    if (view._wheelTurnAt && now - view._wheelTurnAt < WHEEL_TURN_COOLDOWN_MS) {
      event.preventDefault();
      return;
    }
    view._wheelTurnAt = now;
    event.preventDefault();
    view.nav(dir);
  }

  // Reader chrome lives above the page rather than reserving rows around it. In
  // immersive mode it retracts after a short pause and returns through several
  // equivalent inputs: touch/click, the top or bottom pointer edge, or keyboard
  // focus. Panels, selection tools and focused controls keep it visible so an
  // auto-hide timer can never take the active UI away from the reader.
  function setupImmersiveChrome(view, root) {
    const chromeBusy = () => {
      const doc = docOf(root);
      const active = doc && doc.activeElement;
      const activeInChrome = active instanceof win.HTMLElement
        && !!active.closest(".qiaomu-reader-top,.qiaomu-reader-bot,.qiaomu-reader-panel-open,.qiaomu-reader-hl-popup-on");
      const pointerInChrome = [root.querySelector(".qiaomu-reader-top"), root.querySelector(".qiaomu-reader-bot")]
        .some((el) => el && el.matches(":hover"));
      return activeInChrome
        || pointerInChrome
        || !!root.querySelector(".qiaomu-reader-panel-open,.qiaomu-reader-overlay-on,.qiaomu-reader-hl-popup-on");
    };
    const scheduleHide = () => {
      win.clearTimeout(view._immTimer);
      view._immTimer = win.setTimeout(() => {
        if (!view.plugin.settings.immersive || !view.bookHtml) return;
        if (chromeBusy()) {
          scheduleHide();
          return;
        }
        root.addClass("qiaomu-reader-immersive");
      }, 2600);
    };
    const reveal = () => {
      if (!view.plugin.settings.immersive) {
        win.clearTimeout(view._immTimer);
        root.removeClass("qiaomu-reader-immersive");
        return;
      }
      root.removeClass("qiaomu-reader-immersive");
      scheduleHide();
    };
    const revealFromEdge = (event) => {
      if (!view.plugin.settings.immersive) return;
      const rect = root.getBoundingClientRect();
      if (event.clientY <= rect.top + 64 || event.clientY >= rect.bottom - 64) reveal();
    };
    root.addEventListener("pointermove", revealFromEdge);
    root.addEventListener("pointerdown", reveal);
    root.addEventListener("touchstart", reveal, { passive: true });
    root.addEventListener("focusin", reveal);
    view._armImmersive = reveal;
    reveal();
  }

  // ---- Reader chrome scaffolding shared by the desktop view and the mobile modal ----

  // Top bar: back button, truncated book title, right-hand button tray.
  function buildReaderTopBar(view, opts) {
    const bar = view.contentEl.createDiv("qiaomu-reader-top");
    const back = bar.createEl("button", { cls: "qiaomu-reader-ibtn", attr: opts.backAttr });
    svgIcon(back, "arrow-left");
    back.addEventListener("click", opts.onBack);
    view.titleEl = bar.createDiv("qiaomu-reader-top-title");
    setReaderTitle(view.titleEl, opts.title);
    return bar.createDiv("qiaomu-reader-top-right");
  }

  // Compact overflow button; the host decides which entries the menu carries.
  function buildReaderMoreButton(tray, view, fill) {
    const more = tray.createEl("button", { cls: "qiaomu-reader-ibtn qiaomu-reader-b-more", attr: { type: "button" } });
    svgIcon(more, "more-horizontal");
    more.setAttribute("aria-label", translate("more"));
    more.addEventListener("click", (ev) => {
      const list = new Menu();
      addReadingMenuActions(list, view);
      fill(list, (title, icon, run) => list.addItem((item) => item.setTitle(translate(title)).setIcon(icon).onClick(run)));
      list.showAtMouseEvent(ev);
    });
  }

  // Page surface plus the click-to-turn navigation class.
  function buildReaderPageArea(view, root, areaCls) {
    view.areaEl = root.createDiv(areaCls);
    const navMode = view.plugin.settings.navMode || "buttons";
    if (navMode === "click") root.addClass("qiaomu-reader-navclick");
  }

  // Bottom strip: prev / page locator / percent / next, then the host extras.
  // The modal additionally marks its buttons type="button" and pages through
  // _nav instead of nav.
  function buildReaderBotNav(view, root, bot, opts = {}) {
    const kind = opts.buttonType ? { type: "button" } : {};
    const turn = (dir) => (view.nav ? view.nav(dir) : view._nav(dir));
    const prev = bot.createEl("button", { cls: "qiaomu-reader-navbtn", attr: { ...kind, "aria-label": translate("back-3") } });
    svgIcon(prev, "chevron-left");
    prev.addEventListener("click", () => turn("prev"));
    const strip = bot.createDiv("qiaomu-reader-bot-center");
    view.locEl = strip.createEl("button", { cls: "qiaomu-reader-loc qiaomu-reader-loc-clickable", attr: kind });
    view.locEl.setAttribute("aria-label", translate("go-to-page"));
    view.locEl.addEventListener("click", () => openReaderPagePicker(view));
    view.pctEl = strip.createDiv("qiaomu-reader-pct");
    view.pctEl.setText("0%");
    const next = bot.createEl("button", { cls: "qiaomu-reader-navbtn", attr: { ...kind, "aria-label": translate("next-2") } });
    svgIcon(next, "chevron-right");
    next.addEventListener("click", () => turn("next"));
    view._pageButtons = { root, toolbar: bot, previous: prev, next };
    syncPageButtons(view);
    addReaderNavigation(view, bot, opts.findBtn, opts.tocBtn, opts.showTools !== false);
  }

  // Overlay plus the four slide-in panels and the highlight popup.
  function buildReaderPanels(view, root, hooks) {
    view.overlayEl = root.createDiv("qiaomu-reader-overlay");
    view.overlayEl.addEventListener("click", () => hooks.dismiss());
    view.settPan = root.createDiv("qiaomu-reader-panel");
    view.tocPan = root.createDiv("qiaomu-reader-panel qiaomu-reader-toc-panel");
    view.hlPan = root.createDiv("qiaomu-reader-panel qiaomu-reader-toc-panel qiaomu-reader-hl-panel");
    view.findPan = root.createDiv("qiaomu-reader-panel qiaomu-reader-toc-panel qiaomu-reader-find-panel");
    hooks.buildPanelContents();
    view.hlPopup = root.createDiv("qiaomu-reader-hl-popup");
    hooks.buildPopup();
    setupReaderSelection(view);
  }

  // Clicks landing on the page: footnote refs, embedded images and saved
  // highlights each claim the event before plain text falls through.
  function attachReaderContentClick(view) {
    view.areaEl.addEventListener("click", (ev) => {
      const el = ev.target instanceof win.HTMLElement ? ev.target : null;
      const ref = el ? el.closest("[data-qiaomu-reader-ref]") : null;
      if (ref) {
        ev.preventDefault();
        ev.stopPropagation();
        if (readerHud.follow(view, ref.getAttribute("data-qiaomu-reader-ref"))) return;
      }
      const img = el ? el.closest("img") : null;
      if (img && img.src) {
        ev.preventDefault();
        openImageLightbox(img.currentSrc || img.src, view.app, img);
        return;
      }
      const mark = el ? el.closest(".qiaomu-reader-hl") : null;
      if (mark) {
        ev.preventDefault();
        view._openHlEdit(mark.getAttribute("data-hl-id"));
      } else if (view._editHlId) view._hideHlPopup();
    });
  }

  // Horizontal swipe pages forward or back; multi-touch, a zoomed PDF, a live
  // selection or a long press all defer to vertical scrolling instead.
  function attachReaderSwipeNav(view) {
    const turn = (dir) => (view.nav ? view.nav(dir) : view._nav(dir));
    let originX = 0, originY = 0, axis = null, holdTimer = null, longPress = false, hadSelection = false;
    const onStart = (ev) => {
      if (ev.touches.length > 1) { axis = "v"; return; }
      if (readerIsPdf(view) && clampPdfZoom(view.pdfZoom) > PDF_ZOOM_DEFAULT + 0.001) { axis = "v"; return; }
      originX = ev.touches[0].clientX;
      originY = ev.touches[0].clientY;
      axis = null;
      longPress = false;
      const current = selOf(view.areaEl);
      hadSelection = !!(current && !current.isCollapsed);
      win.clearTimeout(holdTimer);
      holdTimer = win.setTimeout(() => { longPress = true; }, 350);
    };
    const onMove = (ev) => {
      if (axis !== null) {
        if (axis === "h") ev.preventDefault();
        return;
      }
      const dx = Math.abs(ev.touches[0].clientX - originX);
      const dy = Math.abs(ev.touches[0].clientY - originY);
      if (Math.max(dx, dy) < 8) return;
      win.clearTimeout(holdTimer);
      const current = selOf(view.areaEl);
      if (longPress || hadSelection || (current && !current.isCollapsed)) { axis = "v"; return; }
      axis = dx > dy ? "h" : "v";
      if (axis === "h") ev.preventDefault();
    };
    const onEnd = (ev) => {
      win.clearTimeout(holdTimer);
      if (axis !== "h") return;
      const travel = ev.changedTouches[0].clientX - originX;
      if (Math.abs(travel) > 44) turn(travel < 0 ? "next" : "prev");
    };
    view.areaEl.addEventListener("touchstart", onStart, { passive: true });
    view.areaEl.addEventListener("touchmove", onMove, { passive: false });
    view.areaEl.addEventListener("touchend", onEnd, { passive: true });
    view.areaEl.addEventListener("click", (ev) => selectionHud.handleAreaNavClick(view, ev));
  }

  // Zoom gestures and immersive chrome behave the same once either host's DOM
  // is in place.
  function wireReaderChrome(view, root) {
    setupPdfZoomInteractions(view);
    setupImmersiveChrome(view, root);
  }

  function setReaderTitle(el, value, limit = 18) {
    const full = String(value || "").trim();
    const glyphs = Array.from(full);
    el.setText(glyphs.length > limit ? `${glyphs.slice(0, limit).join("")}…` : full);
    el.setAttribute("aria-label", full);
  }

  function panelSection(view, p, { label, emoji, settingKey, defaultOpen = false }) {
    const hdr = p.createDiv("qiaomu-reader-pan-adv-hdr");
    if (emoji) hdr.createSpan({ cls: "qiaomu-reader-pan-adv-ic", text: emoji });
    hdr.createSpan({ cls: "qiaomu-reader-pan-adv-lbl", text: label });
    const count = hdr.createSpan({ cls: "qiaomu-reader-pan-adv-count" });
    const car = hdr.createSpan({ cls: "qiaomu-reader-pan-adv-car", text: "›" });
    const wrap = p.createDiv("qiaomu-reader-pan-adv");
    const body = wrap.createDiv("qiaomu-reader-pan-adv-body");
    body._qiaomuReaderCount = count;
    const stored = view.plugin.settings[settingKey];
    if (stored === void 0 ? defaultOpen : stored) {
      wrap.addClass("qiaomu-reader-pan-adv-on");
      car.addClass("qiaomu-reader-pan-adv-car-on");
    }
    hdr.addEventListener("click", async () => {
      const on = wrap.hasClass("qiaomu-reader-pan-adv-on");
      wrap.toggleClass("qiaomu-reader-pan-adv-on", !on);
      car.toggleClass("qiaomu-reader-pan-adv-car-on", !on);
      view.plugin.settings[settingKey] = !on;
      await view.plugin._saveLocalData();
    });
    return body;
  }

  function buildReaderExtraSettings(view, p, showPageButtons = true) {
    const s = view.plugin.settings;
    const section = (label) => p.createDiv("qiaomu-reader-pan-sec").setText(translate(label));
    const hint = (label, ...args) => p.createDiv("qiaomu-reader-pan-hint").setText(translate(label, ...args));
    const persist = () => view.plugin.saveAll();

    // A labelled row of exclusive buttons mirroring one settings string.
    function segmented(label, key, fallback, choices, apply) {
      section(label);
      const row = p.createDiv("qiaomu-reader-col-row");
      const clearActive = () => row.querySelectorAll(".qiaomu-reader-col-btn").forEach((b) => b.removeClass("active"));
      for (const [value, textKey] of choices) {
        const btn = row.createDiv("qiaomu-reader-col-btn");
        btn.setText(translate(textKey));
        if ((s[key] ?? fallback) === value) btn.addClass("active");
        btn.addEventListener("click", async () => {
          s[key] = value;
          await persist();
          clearActive();
          btn.addClass("active");
          apply?.(value);
        });
      }
      return row;
    }

    if (showPageButtons) buildPageButtonsSetting(p, view.plugin);

    segmented("page-turning", "navMode", "buttons", [
      ["buttons", "buttons"],
      ["click", "by-click"],
    ], (v) => (view.contentEl || view.containerEl).classList.toggle("qiaomu-reader-navclick", v === "click"));
    hint("by-click-clicking-the-left-part-of-the-page-goes-back-the-right");

    if (!readerIsPdf(view)) {
      segmented("text-alignment", "textAlign", "left", [
        ["left", "left"],
        ["justify", "justify"],
        ["center", "center"],
        ["right", "right"],
      ], () => {
        if (view.bookHtml && typeof view.repaginate === "function") void view.repaginate();
        else if (view.bookHtml && typeof view._repaginate === "function") void view._repaginate();
      });


    }

    buildBookSettings(view, p);
  }

  // Shared body of the in-book reading-settings panel: ReaderView.buildSettPanel
  // and ReaderModal._buildSettPanel only supply their differing hooks.
  function readerSettThemeRow(host, view, onApplied) {
    const save = () => view.plugin.saveAll();
    const row = host.createDiv("qiaomu-reader-theme-row");
    const clearActive = () => row.querySelectorAll(".qiaomu-reader-theme-btn").forEach((b) => b.removeClass("active"));
    for (const t of READER_THEME_CHOICES) {
      const opt = row.createDiv(`qiaomu-reader-theme-btn qiaomu-reader-theme-${t}`);
      opt.setText(readerThemeLabel(t));
      if (selectedReaderTheme(view.plugin.settings) === t) opt.addClass("active");
      opt.addEventListener("click", async () => {
        setReaderTheme(view.plugin.settings, t);
        await save();
        await onApplied();
        clearActive();
        opt.addClass("active");
      });
    }
  }

  function readerSettAdvSection(host, view) {
    const head = host.createDiv("qiaomu-reader-pan-adv-hdr");
    head.createSpan({ cls: "qiaomu-reader-pan-adv-ic", text: "⚙️" });
    head.createSpan({ cls: "qiaomu-reader-pan-adv-lbl", text: translate("more-settings") });
    const car = head.createSpan({ cls: "qiaomu-reader-pan-adv-car", text: "›" });
    const wrap = host.createDiv("qiaomu-reader-pan-adv");
    const body = wrap.createDiv("qiaomu-reader-pan-adv-body");
    const saveLocal = () => view.plugin._saveLocalData();
    if (view.plugin.settings.readerAdvOpen) {
      wrap.addClass("qiaomu-reader-pan-adv-on");
      car.addClass("qiaomu-reader-pan-adv-car-on");
    }
    head.addEventListener("click", async () => {
      const on = wrap.hasClass("qiaomu-reader-pan-adv-on");
      wrap.toggleClass("qiaomu-reader-pan-adv-on", !on);
      car.toggleClass("qiaomu-reader-pan-adv-car-on", !on);
      view.plugin.settings.readerAdvOpen = !on;
      await saveLocal();
    });
    return body;
  }

  function readerSettFontRow(host, view, onApplied) {
    const save = () => view.plugin.saveAll();
    const row = host.createDiv("qiaomu-reader-ff-row");
    const clearActive = () => row.querySelectorAll(".qiaomu-reader-ff-btn").forEach((b) => b.removeClass("active"));
    for (const font of qiaomuReaderReaderFonts()) {
      const opt = row.createDiv("qiaomu-reader-ff-btn");
      opt.setText(qiaomuReaderFontLabel(font));
      opt.style.fontFamily = font.stack;
      void ensureBundledReaderFont(docOf(opt), font.id);
      if (view.plugin.settings.fontFamily === font.id) opt.addClass("active");
      opt.addEventListener("click", async () => {
        view.plugin.settings.fontFamily = font.id;
        refreshCustomFont();
        await save();
        await onApplied();
        clearActive();
        opt.addClass("active");
      });
    }
    const refreshCustomFont = buildCustomFontInput(host, view.plugin, async () => {
      await save();
      if (!view.bookHtml) return;
      if (typeof view.repaginate === "function") await view.repaginate();
      else await view._repaginate();
    });
  }

  function readerSettLineHeightRow(host, view, onApplied) {
    const save = () => view.plugin.saveAll();
    const row = host.createDiv("qiaomu-reader-lh-row");
    const clearActive = () => row.querySelectorAll(".qiaomu-reader-lh-btn").forEach((b) => b.removeClass("active"));
    for (const lh of [1.4, 1.6, 1.8, 2.1]) {
      const opt = row.createDiv("qiaomu-reader-lh-btn");
      opt.setText(`${lh}`);
      if (Math.abs(view.plugin.settings.lineHeight - lh) < 0.05) opt.addClass("active");
      opt.addEventListener("click", async () => {
        view.plugin.settings.lineHeight = lh;
        await save();
        await onApplied();
        clearActive();
        opt.addClass("active");
      });
    }
  }

  function buildReaderSettPanelBody(view, host, opts) {
    host.empty();
    host.createDiv("qiaomu-reader-pan-title").setText(opts.title);
    const section = (label) => host.createDiv("qiaomu-reader-pan-sec").setText(label);
    section(translate("theme"));
    readerSettThemeRow(host, view, opts.onThemeApplied);
    if (readerIsPdf(view)) {
      section(translate("pdf-zoom"));
      createPdfZoomSettings(host, view);
    } else {
      section(translate("font-size"));
      opts.buildFontSizeRow(host);
    }
    const adv = readerSettAdvSection(host, view);
    adv.createDiv("qiaomu-reader-pan-sec").setText(translate("font"));
    readerSettFontRow(adv, view, opts.onTextStyleApplied);
    adv.createDiv("qiaomu-reader-pan-sec").setText(translate("line-spacing"));
    readerSettLineHeightRow(adv, view, opts.onTextStyleApplied);
    if (opts.buildExtraAdvRows) opts.buildExtraAdvRows(adv);
    buildReaderExtraSettings(view, adv);
    const hist = panelSection(view, host, {
      settingKey: "readerHistOpen", emoji: "\u{1F516}",
      label: translate("jump-back"),
    });
    view._histRow = hist.createDiv("qiaomu-reader-hist-row");
    view._renderHistory();
    section(translate("actions"));
    const actRow = host.createDiv("qiaomu-reader-act-row");
    const info = actRow.createDiv("qiaomu-reader-act-btn");
    iconLabel(info, "info", translate("help"));
    info.addEventListener("click", () => opts.openInfo());
  }

  function buildLightboxLayer(doc, src) {
    const layer = doc.createElement("div");
    layer.className = "qiaomu-reader-lightbox";
    const img = layer.createEl("img");
    img.setAttribute("src", src);
    const closer = layer.createDiv("qiaomu-reader-lightbox-close");
    closer.setText("✕");
    layer.createDiv("qiaomu-reader-lightbox-hint").setText(translate("tap-the-image-to-zoom-background-or-to-close"));
    return { layer, img, closer };
  }

  function pushEscapeScope(app, onEscape) {
    const keymap = app && app.keymap;
    if (!keymap || !Scope) return null;
    try {
      const escapeScope = new Scope();
      escapeScope.register([], "Escape", () => { onEscape(); return false; });
      keymap.pushScope(escapeScope);
      return escapeScope;
    } catch {
      return null;
    }
  }

  function popEscapeScope(app, escapeScope) {
    if (!escapeScope || !app || !app.keymap) return;
    try { app.keymap.popScope(escapeScope); } catch { /* keymap may already be gone */ }
  }

  function openImageLightbox(srcUrl, app, ownerEl) {
    if (!srcUrl) return;
    const ownerDoc = docOf(ownerEl);
    const { layer, img, closer } = buildLightboxLayer(ownerDoc, srcUrl);
    let dismissed = false;
    let scope;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      popEscapeScope(app, scope);
      ownerDoc.removeEventListener("keydown", onDocKey, true);
      layer.remove();
    };
    const onDocKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      dismiss();
    };
    scope = pushEscapeScope(app, dismiss);
    ownerDoc.addEventListener("keydown", onDocKey, true);
    closer.addEventListener("click", (e) => { e.stopPropagation(); dismiss(); });
    layer.addEventListener("click", (e) => { if (e.target === layer) dismiss(); });
    img.addEventListener("click", (e) => {
      e.stopPropagation(); img.classList.toggle("qiaomu-reader-lightbox-zoom");
    });
    ownerDoc.body.appendChild(layer);
    win.requestAnimationFrame(() => layer.classList.add("qiaomu-reader-lightbox-on"));
  }

  return {
    attachEngineChrome,
    engineWheelScroller,
    handleReaderWheel,
    setupImmersiveChrome,
    buildReaderTopBar,
    buildReaderMoreButton,
    buildReaderPageArea,
    buildReaderBotNav,
    buildReaderPanels,
    attachReaderContentClick,
    attachReaderSwipeNav,
    wireReaderChrome,
    setReaderTitle,
    panelSection,
    buildReaderExtraSettings,
    readerSettThemeRow,
    readerSettAdvSection,
    readerSettFontRow,
    readerSettLineHeightRow,
    buildReaderSettPanelBody,
    buildLightboxLayer,
    pushEscapeScope,
    popEscapeScope,
    openImageLightbox,
  };
}

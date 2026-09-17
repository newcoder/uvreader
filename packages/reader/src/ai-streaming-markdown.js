// createAiStreamingMarkdownRenderer lives here so the reader logic stays host-agnostic.

export function createAiStreamingMarkdownRendererFactory({
  Component, MarkdownRenderer, AI_MARKDOWN_RENDER_INTERVAL_MS, enhanceAiMarkdown,
}) {
  function createAiStreamingMarkdownRenderer(owner, element, sourcePath = "", options = {}) {
  const lifecycle = owner._markdownComponent || owner;
  element.addClass("qiaomu-reader-ai-markdown");
  let source = "";
  let requestedVersion = 0;
  let renderedVersion = 0;
  let lastRenderedAt = 0;
  let timer = null;
  let running = null;
  let renderComponent = null;
  let disposed = false;

  const removeRenderComponent = () => {
    if (!renderComponent) return;
    try { lifecycle.removeChild(renderComponent); }
    catch { try { renderComponent.unload(); } catch { /* already unloaded */ } }
    renderComponent = null;
  };
  const renderNow = async (forceLatest = false) => {
    if (disposed) return;
    if (running) {
      await running;
      if (!disposed && renderedVersion < requestedVersion) {
        if (forceLatest) await renderNow(true);
        else schedule();
      }
      return;
    }
    const version = requestedVersion;
    const snapshot = source;
    const renderState = options.beforeRender?.();
    running = (async () => {
      removeRenderComponent();
      const component = new Component();
      lifecycle.addChild(component);
      renderComponent = component;
      element.removeClass("qiaomu-reader-ai-markdown-fallback");
      element.empty();
      try {
        await MarkdownRenderer.render(owner.app, snapshot, element, sourcePath, component);
        if (!disposed) enhanceAiMarkdown(element);
      } catch (error) {
        console.error("UV Reader: streaming Markdown rendering failed", error);
        if (!disposed) {
          element.addClass("qiaomu-reader-ai-markdown-fallback");
          element.setText(snapshot);
        }
      }
      renderedVersion = version;
      lastRenderedAt = Date.now();
      if (!disposed) options.afterRender?.(renderState);
    })();
    try { await running; }
    finally { running = null; }
    if (!disposed && renderedVersion < requestedVersion) {
      if (forceLatest) await renderNow(true);
      else schedule();
    }
  };
  const schedule = (immediate = false) => {
    if (disposed || timer !== null || running) return;
    const elapsed = Date.now() - lastRenderedAt;
    const wait = immediate ? 0 : Math.max(0, AI_MARKDOWN_RENDER_INTERVAL_MS - elapsed);
    timer = window.setTimeout(() => {
      timer = null;
      void renderNow(false);
    }, wait);
  };
  const setSource = (markdown) => {
    source = String(markdown || "");
    requestedVersion += 1;
  };
  return {
    update(markdown) {
      setSource(markdown);
      schedule(renderedVersion === 0);
    },
    async finish(markdown) {
      setSource(markdown);
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      await renderNow(true);
    },
    dispose() {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      removeRenderComponent();
    },
  };
}
  return createAiStreamingMarkdownRenderer;
}

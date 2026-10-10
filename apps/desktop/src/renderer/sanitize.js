// Markdown → HTML sanitizer for the desktop renderer.
//
// The renderer runs with Node integration (that is how the host shim reads
// files), so every string that reaches innerHTML must be treated as untrusted:
// book text flows into reading notes and AI answers, and both are rendered
// through this function. It drops active-content elements and only lets safe
// URL schemes through instead of trusting marked's output.
//
// Relative URLs stay (anchors, vault paths); a URL with no scheme is inert in
// the renderer's context.

const DROP_SELECTOR = "script,iframe,frame,object,embed,link,style,meta,base,form";
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
const MEDIA_SCHEMES = new Set(["http:", "https:", "blob:", "file:"]);
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src", "poster"]);
const BLOCKED_ATTRIBUTES = new Set(["srcdoc", "ping", "srcset", "action", "formaction", "background"]);

// Browsers ignore control characters and whitespace inside schemes, so
// "java\tscript:" executes too; collapse them before matching.
function schemeOf(value) {
  const collapsed = String(value ?? "").replace(/[\u0000-\u0020]+/g, "");
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(collapsed);
  return match ? `${match[1].toLowerCase()}:` : "";
}

export function sanitizeHtml(hostDocument, html) {
  const template = hostDocument.createElement("template");
  template.innerHTML = String(html ?? "");
  const content = template.content;

  for (const element of content.querySelectorAll(DROP_SELECTOR)) element.remove();

  for (const element of content.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || BLOCKED_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (!URL_ATTRIBUTES.has(name)) continue;
      const raw = String(attribute.value ?? "");
      const scheme = schemeOf(raw);
      if (!scheme) continue;
      if (scheme === "data:") {
        // Inline images are fine; inline documents and scripts are not.
        const isMedia = name === "src" || name === "poster";
        if (!isMedia || !/^data:image\//i.test(raw.replace(/[\u0000-\u0020]+/g, ""))) {
          element.removeAttribute(attribute.name);
        }
        continue;
      }
      const allowed = name === "src" || name === "poster" ? MEDIA_SCHEMES : LINK_SCHEMES;
      if (!allowed.has(scheme)) element.removeAttribute(attribute.name);
    }
  }

  return template.innerHTML;
}

// True when an anchor href must never run as navigation (javascript: URLs and
// friends). Used by the click guard so a stray URL cannot execute even if the
// sanitizer missed it.
export function isBlockedHref(value) {
  const scheme = schemeOf(value);
  return Boolean(scheme) && !LINK_SCHEMES.has(scheme);
}

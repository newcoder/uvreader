// Desktop reading notes still use Obsidian's [[wikilink]] syntax. The app has
// no Obsidian resolver, so turn those text nodes into internal note links that
// the renderer can open in the note panel. The walker skips code and existing
// anchors, and every label is written with textContent (never innerHTML).
const WIKILINK_RE = /\[\[([^[\]\n]{1,500})\]\]/g;

function splitWikilink(raw) {
  const pipe = raw.indexOf("|");
  const targetPart = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
  const label = (pipe >= 0 ? raw.slice(pipe + 1) : raw).trim() || targetPart;
  const hash = targetPart.indexOf("#");
  return {
    target: (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim(),
    fragment: hash >= 0 ? targetPart.slice(hash + 1).trim() : "",
    label: label || targetPart,
  };
}

export function decorateWikilinks(root) {
  if (!root) return 0;
  const doc = root.ownerDocument;
  const view = doc?.defaultView;
  if (!doc || !view?.NodeFilter) return 0;
  const walker = doc.createTreeWalker(root, view.NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!String(node.nodeValue || "").includes("[[")) return view.NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (parent?.closest?.("a, code, pre, script, style, textarea")) return view.NodeFilter.FILTER_REJECT;
      return view.NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let changed = 0;
  for (const node of nodes) {
    const text = String(node.nodeValue || "");
    const replacement = doc.createDocumentFragment();
    let cursor = 0;
    let matched = false;
    WIKILINK_RE.lastIndex = 0;
    for (const match of text.matchAll(WIKILINK_RE)) {
      const { target, fragment, label } = splitWikilink(match[1]);
      const start = match.index ?? 0;
      // ![[image.png]] is an Obsidian embed, not a note link. Leave it intact
      // instead of turning the filename into a dead link.
      if (!target || (start > 0 && text[start - 1] === "!")) continue;
      matched = true;
      if (start > cursor) replacement.append(doc.createTextNode(text.slice(cursor, start)));
      const link = doc.createElement("a");
      link.className = "qbr-wikilink";
      link.setAttribute("href", "#");
      link.setAttribute("data-wikilink", target);
      if (fragment) link.setAttribute("data-fragment", fragment);
      link.textContent = label;
      replacement.append(link);
      cursor = start + match[0].length;
    }
    if (!matched) continue;
    if (cursor < text.length) replacement.append(doc.createTextNode(text.slice(cursor)));
    node.replaceWith(replacement);
    changed += 1;
  }
  return changed;
}

// Host-agnostic DOM lookups shared by the reader UI modules.

export function docOf(el) { return (el && el.ownerDocument) || document; }
export function winOf(el) { return docOf(el).defaultView || window; }
export function selOf(el) { return winOf(el).getSelection(); }

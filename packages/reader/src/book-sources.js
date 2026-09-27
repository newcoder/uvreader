// Book download sources: a per-source query builder and a normalizer into one
// result shape, so the library's online search can mix any number of sources.
// The module is pure: the main process performs the requests, the renderer only
// sees normalized results.
//
// Kinds:
//   gutenberg        Gutendex JSON (Project Gutenberg)
//   standard-ebooks  OPDS Atom feed
//   archive          Internet Archive advancedsearch JSON (download resolved
//                    later through the item's metadata)
//   openlibrary      Open Library search JSON (downloadable when a public scan
//                    exists, resolved through Internet Archive)
//   zlib             Z-Library search page (HTML; parsed by the main process,
//                    downloads use the app's hidden window session)
export const BOOK_SOURCE_KINDS = Object.freeze([
  "gutenberg", "standard-ebooks", "archive", "openlibrary", "zlib",
]);

export const DEFAULT_BOOK_SOURCES = Object.freeze([
  { id: "gutenberg", name: "Project Gutenberg", url: "https://gutendex.com", kind: "gutenberg", enabled: true },
  { id: "standard-ebooks", name: "Standard Ebooks", url: "https://standardebooks.org/feeds/opds", kind: "standard-ebooks", enabled: true },
  { id: "archive", name: "Internet Archive", url: "https://archive.org", kind: "archive", enabled: true },
  { id: "openlibrary", name: "Open Library", url: "https://openlibrary.org", kind: "openlibrary", enabled: true },
  { id: "zlib", name: "Z-Library", url: "https://z-library.sk", kind: "zlib", enabled: true },
]);

export const BOOK_SEARCH_LIMIT = 20;
export const BOOK_SOURCE_LIMIT = 24;

const FORMAT_ORDER = ["epub", "pdf", "mobi", "azw3", "fb2", "txt"];

function clean(value, limit = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function absolute(url, base) {
  const value = clean(url, 800);
  if (!value) return "";
  try { return new URL(value, base).toString(); }
  catch { return ""; }
}

function stripTags(value) {
  return clean(String(value ?? "").replace(/<[^>]*>/g, " "), 400);
}

// User-configured sources: keep the shape, drop the unusable entries, keep the
// order (it doubles as result priority).
export function normalizeBookSources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value.slice(0, BOOK_SOURCE_LIMIT)) {
    const kind = BOOK_SOURCE_KINDS.includes(item?.kind) ? item.kind : "";
    const url = clean(item?.url, 500);
    const id = clean(item?.id, 60) || clean(kind || url, 60);
    if (!kind || !url || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: clean(item?.name, 80) || id,
      url,
      kind,
      enabled: item?.enabled !== false,
    });
  }
  return out;
}

export function enabledBookSources(sources) {
  return (Array.isArray(sources) ? sources : []).filter((source) => source?.enabled !== false);
}

// What the main process should request for one source and query. zlib has no
// JSON API; the caller parses the HTML or falls back to the hidden window.
export function bookSearchRequest(source, query) {
  const q = clean(query, 200);
  if (!source || !q) return null;
  const base = String(source.url || "").replace(/\/+$/, "");
  switch (source.kind) {
    case "gutenberg":
      return { kind: "json", url: `${base}/books/?search=${encodeURIComponent(q)}`, source };
    case "standard-ebooks":
      return { kind: "opds", url: `${base}/search?query=${encodeURIComponent(q)}`, source };
    case "archive":
      return {
        kind: "json",
        url: `${base}/advancedsearch.php?q=${encodeURIComponent(`${q} AND mediatype:texts`)}`
          + "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=year&fl%5B%5D=language"
          + `&rows=${BOOK_SEARCH_LIMIT}&page=1&output=json`,
        source,
      };
    case "openlibrary":
      return {
        kind: "json",
        url: `${base}/search.json?q=${encodeURIComponent(q)}&limit=${BOOK_SEARCH_LIMIT}`
          + "&fields=key,title,author_name,first_publish_year,language,ia,public_scan_b,ebook_access",
        source,
      };
    case "zlib":
      return { kind: "html", url: `${base}/s/${encodeURIComponent(q)}`, source };
    default:
      return null;
  }
}

export function pickDownloadFormat(formats = {}) {
  const entries = [];
  for (const [mime, url] of Object.entries(formats || {})) {
    const value = clean(url, 800);
    if (!value) continue;
    const format = /epub/i.test(mime) ? "epub"
      : /pdf/i.test(mime) ? "pdf"
        : /mobi|kindle/i.test(mime) ? "mobi"
          : /azw3/i.test(mime) ? "azw3"
            : /text\/plain/i.test(mime) ? "txt"
              : "";
    if (format) entries.push({ format, url: value });
  }
  for (const wanted of FORMAT_ORDER) {
    const hit = entries.find((entry) => entry.format === wanted);
    if (hit) return hit;
  }
  return null;
}

function resultsFromGutendex(json, source) {
  return (Array.isArray(json?.results) ? json.results : []).map((book) => {
    const picked = pickDownloadFormat(book?.formats);
    return {
      source: source.id,
      sourceName: source.name,
      title: clean(book?.title),
      author: (Array.isArray(book?.authors) ? book.authors : []).map((a) => clean(a?.name, 120)).filter(Boolean).join(", "),
      language: (Array.isArray(book?.languages) ? clean(book.languages[0], 12) : ""),
      year: "",
      format: picked?.format || "",
      url: picked?.url || "",
      info: absolute(`/ebooks/${Number(book?.id) || 0}`, source.url),
      license: "public-domain",
      downloadable: Boolean(picked?.url),
    };
  });
}

// Minimal OPDS Atom reader: enough for Standard Ebooks entries (title, author,
// acquisition link, language).
export function resultsFromOpds(xml, source) {
  const text = String(xml || "");
  const out = [];
  for (const match of text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const entry = match[0];
    const title = stripTags(entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    if (!title) continue;
    const author = stripTags(entry.match(/<author[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>/i)?.[1]);
    const language = clean(entry.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i)?.[1], 12)
      || clean(entry.match(/<language[^>]*>([\s\S]*?)<\/language>/i)?.[1], 12);
    const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map((link) => link[0]);
    let picked = null;
    for (const wanted of ["application/epub+zip", "application/pdf"]) {
      const href = links.find((link) => link.includes(`type="${wanted}"`))
        ?.match(/href="([^"]+)"/i)?.[1];
      if (href) { picked = { format: wanted.includes("epub") ? "epub" : "pdf", url: absolute(href, source.url) }; break; }
    }
    out.push({
      source: source.id,
      sourceName: source.name,
      title,
      author,
      language,
      year: "",
      format: picked?.format || "",
      url: picked?.url || "",
      info: "",
      license: "public-domain",
      downloadable: Boolean(picked?.url),
    });
  }
  return out;
}

export function resultsFromArchive(json, source) {
  return (Array.isArray(json?.response?.docs) ? json.response.docs : []).map((doc) => {
    const identifier = clean(doc?.identifier, 200);
    return {
      source: source.id,
      sourceName: source.name,
      title: clean(doc?.title),
      author: (Array.isArray(doc?.creator) ? doc.creator : [doc?.creator]).map((name) => clean(name, 120)).filter(Boolean).join(", "),
      language: clean(Array.isArray(doc?.language) ? doc.language[0] : doc?.language, 12),
      year: clean(Array.isArray(doc?.year) ? doc.year[0] : doc?.year, 8),
      format: "",
      url: "",
      info: identifier ? `https://archive.org/details/${identifier}` : "",
      license: "public-domain",
      // The item page is known; the actual file is resolved through the item's
      // metadata at download time.
      downloadable: Boolean(identifier),
    };
  });
}

export function resultsFromOpenLibrary(json, source) {
  return (Array.isArray(json?.docs) ? json.docs : []).map((doc) => {
    const ia = clean(Array.isArray(doc?.ia) ? doc.ia[0] : doc?.ia, 200);
    const downloadable = doc?.public_scan_b !== false && Boolean(ia);
    return {
      source: source.id,
      sourceName: source.name,
      title: clean(doc?.title),
      author: (Array.isArray(doc?.author_name) ? doc.author_name : []).map((name) => clean(name, 120)).filter(Boolean).join(", "),
      language: clean(Array.isArray(doc?.language) ? doc.language[0] : doc?.language, 12),
      year: clean(doc?.first_publish_year, 8),
      format: downloadable ? "pdf" : "",
      url: "",
      info: downloadable ? `https://archive.org/details/${ia}` : absolute(doc?.key, source.url),
      license: downloadable ? "public-domain" : "borrow",
      downloadable,
    };
  });
}

export function resultsFromSource(source, payload) {
  if (!source || !payload) return [];
  if (source.kind === "gutenberg") return resultsFromGutendex(payload, source);
  if (source.kind === "standard-ebooks") return resultsFromOpds(payload, source);
  if (source.kind === "archive") return resultsFromArchive(payload, source);
  if (source.kind === "openlibrary") return resultsFromOpenLibrary(payload, source);
  return [];
}

export function normalizeBookResult(item) {
  return {
    source: clean(item?.source, 60),
    sourceName: clean(item?.sourceName, 80),
    title: clean(item?.title),
    author: clean(item?.author, 200),
    language: clean(item?.language, 12),
    year: clean(item?.year, 8),
    format: clean(item?.format, 12),
    url: clean(item?.url, 800),
    info: clean(item?.info, 800),
    license: clean(item?.license, 20) || "unknown",
    downloadable: item?.downloadable === true && Boolean(clean(item?.url, 800) || clean(item?.info, 800)),
  };
}

// One row per work: the first source in priority order wins, later duplicates
// only fill in a missing download link.
export function dedupeBookResults(results) {
  const out = [];
  const seen = new Map();
  for (const item of (Array.isArray(results) ? results : []).map(normalizeBookResult)) {
    if (!item.title) continue;
    const key = `${item.title.toLowerCase()}|${item.author.toLowerCase()}`;
    const existing = seen.get(key);
    if (!existing) { seen.set(key, item); out.push(item); continue; }
    if (!existing.downloadable && item.downloadable) {
      existing.url = item.url || existing.url;
      existing.format = item.format || existing.format;
      existing.source = item.source || existing.source;
      existing.sourceName = item.sourceName || existing.sourceName;
      existing.license = item.license || existing.license;
      if (!existing.info) existing.info = item.info;
      existing.downloadable = true;
    }
  }
  return out;
}

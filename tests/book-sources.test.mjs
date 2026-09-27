import assert from "node:assert/strict";
import test from "node:test";

import {
  bookSearchRequest,
  dedupeBookResults,
  DEFAULT_BOOK_SOURCES,
  downloadLinkFromZlibPage,
  enabledBookSources,
  normalizeBookSources,
  pickDownloadFormat,
  resultsFromOpds,
  resultsFromSource,
} from "../packages/reader/src/book-sources.js";

test("the z-library book page yields the best download link", () => {
  const html = [
    '<a href="/book/123/abc">详情</a>',
    '<a href="/dl/123/abc/file.pdf">PDF</a>',
    '<a href="/dl/123/abc/file.epub">EPUB</a>',
    '<a href="javascript:;">下载</a>',
  ].join("");
  const picked = downloadLinkFromZlibPage(html, "https://z-library.sk", ["epub", "pdf"]);
  assert.deepEqual(picked, { url: "https://z-library.sk/dl/123/abc/file.epub", format: "epub" });
  const pdfOnly = downloadLinkFromZlibPage('<a href="/dl/1/a/file.pdf">PDF</a>', "https://z-library.sk", ["epub"]);
  assert.equal(pdfOnly.format, "pdf");
  assert.equal(downloadLinkFromZlibPage("<p>nothing here</p>", "https://z-library.sk"), null);
});

test("default sources include z-library and the four public catalogues", () => {
  const kinds = DEFAULT_BOOK_SOURCES.map((source) => source.kind);
  for (const kind of ["gutenberg", "standard-ebooks", "archive", "openlibrary", "zlib"]) {
    assert.ok(kinds.includes(kind), kind);
  }
  const zlib = DEFAULT_BOOK_SOURCES.find((source) => source.kind === "zlib");
  assert.equal(zlib.url, "https://z-library.sk");
  assert.equal(zlib.enabled, true);
});

test("user sources keep their order, edits and enable flags", () => {
  const normalized = normalizeBookSources([
    { id: "zlib", name: "Z-Library", url: "https://z-library.sk/", kind: "zlib", enabled: false },
    { id: "mine", name: "我的源", url: "https://example.com/opds", kind: "standard-ebooks" },
    { id: "bad", url: "", kind: "gutenberg" },
    { id: "weird", url: "https://x", kind: "unknown" },
  ]);
  assert.deepEqual(normalized.map((source) => source.id), ["zlib", "mine"]);
  assert.equal(normalized[0].enabled, false);
  assert.equal(normalized[1].enabled, true, "missing flag means enabled");
  assert.equal(enabledBookSources(normalized).length, 1);
});

test("search requests are built per source kind", () => {
  const [gutenberg, standard, archive, openlibrary, zlib] = DEFAULT_BOOK_SOURCES;
  assert.match(bookSearchRequest(gutenberg, "dune").url, /gutendex\.com\/books\/\?search=dune$/);
  assert.match(bookSearchRequest(standard, "dune").url, /search\?query=dune$/);
  const archiveUrl = decodeURIComponent(bookSearchRequest(archive, "dune").url);
  assert.match(archiveUrl, /AND mediatype:texts/);
  assert.match(archiveUrl, /output=json/);
  assert.match(bookSearchRequest(openlibrary, "dune").url, /search\.json\?q=dune/);
  const zlibRequest = bookSearchRequest(zlib, "三体");
  assert.equal(zlibRequest.kind, "html");
  assert.match(zlibRequest.url, /z-library\.sk\/s\/%E4%B8%89%E4%BD%93$/);
  assert.equal(bookSearchRequest(gutenberg, ""), null);
});

test("gutendex results map into the common shape with epub preferred", () => {
  const [gutenberg] = DEFAULT_BOOK_SOURCES;
  const [book] = resultsFromSource(gutenberg, {
    results: [{
      id: 84,
      title: "Frankenstein",
      authors: [{ name: "Shelley, Mary" }],
      languages: ["en"],
      formats: {
        "text/plain; charset=us-ascii": "https://www.gutenberg.org/files/84/84-0.txt",
        "application/pdf": "https://www.gutenberg.org/files/84/84-pdf.pdf",
        "application/epub+zip": "https://www.gutenberg.org/ebooks/84.epub.images",
      },
    }],
  });
  assert.equal(book.title, "Frankenstein");
  assert.equal(book.author, "Shelley, Mary");
  assert.equal(book.format, "epub");
  assert.equal(book.downloadable, true);
  assert.equal(book.license, "public-domain");
  assert.match(book.info, /gutendex\.com\/ebooks\/84$/);
});

test("standard ebooks OPDS entries map into the common shape", () => {
  const [, standard] = DEFAULT_BOOK_SOURCES;
  const xml = `<?xml version="1.0"?><feed><entry>
    <title>Wuthering Heights</title>
    <author><name>Emily Brontë</name></author>
    <dc:language>en-GB</dc:language>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" href="/ebooks/emily-bronte/wuthering-heights/downloads/wuthering-heights.epub"/>
  </entry></feed>`;
  const [book] = resultsFromSource(standard, xml);
  assert.equal(book.title, "Wuthering Heights");
  assert.equal(book.author, "Emily Brontë");
  assert.equal(book.language, "en-GB");
  assert.equal(book.downloadable, true);
  assert.match(book.url, /standardebooks\.org\/ebooks\/emily-bronte\/wuthering-heights/);
});

test("archive results point at the item page for a later resolve", () => {
  const [, , archive] = DEFAULT_BOOK_SOURCES;
  const [item] = resultsFromSource(archive, {
    response: { docs: [{ identifier: "mobydick_201408", title: "Moby Dick", creator: ["Melville, Herman"], year: "1851" }] },
  });
  assert.equal(item.title, "Moby Dick");
  assert.equal(item.downloadable, true);
  assert.equal(item.format, "");
  assert.equal(item.info, "https://archive.org/details/mobydick_201408");
});

test("open library keeps public scans downloadable and borrow-only out", () => {
  const [, , , openlibrary] = DEFAULT_BOOK_SOURCES;
  const results = resultsFromSource(openlibrary, {
    docs: [
      { key: "/works/OL1W", title: "Public Scan", ia: ["pubscan01"], public_scan_b: true, author_name: ["A. Author"] },
      { key: "/works/OL2W", title: "Borrow Only", ia: [], public_scan_b: false, ebook_access: "borrowable" },
      { key: "/works/OL3W", title: "No Scan" },
    ],
  });
  assert.equal(results[0].downloadable, true);
  assert.equal(results[0].license, "public-domain");
  assert.equal(results[1].downloadable, false);
  assert.equal(results[1].license, "borrow");
  assert.equal(results[2].downloadable, false);
  assert.match(results[2].info, /openlibrary\.org\/works\/OL3W$/);
});

test("format picking follows epub > pdf > mobi and dedupe keeps source priority", () => {
  assert.equal(pickDownloadFormat({
    "application/x-mobipocket-ebook": "https://x/mobi",
    "application/pdf": "https://x/pdf",
    "application/epub+zip": "https://x/epub",
  }).format, "epub");
  assert.equal(pickDownloadFormat({ "text/plain": "https://x/txt" }).format, "txt");
  assert.equal(pickDownloadFormat({ "image/png": "https://x/png" }), null);

  const merged = dedupeBookResults([
    { source: "openlibrary", sourceName: "Open Library", title: "Dune", author: "Frank Herbert", downloadable: false, info: "https://openlibrary.org/x" },
    { source: "zlib", sourceName: "Z-Library", title: "Dune", author: "Frank Herbert", format: "epub", url: "https://z-lib/dune", downloadable: true },
    { source: "gutenberg", sourceName: "Project Gutenberg", title: "Dune Messiah", author: "Frank Herbert", downloadable: true, url: "https://g/dune-messiah" },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].downloadable, true, "a later downloadable duplicate fills the link");
  assert.equal(merged[0].source, "zlib", "and names the source the file comes from");
  assert.equal(merged[0].info, "https://openlibrary.org/x", "the catalogue page is kept");
  assert.equal(merged[1].title, "Dune Messiah");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bookFileLooksValid, createBookDownloads, pickArchiveFile, uniqueBookName } from "../src/main/book-downloads.js";

const SOURCES = [
  { id: "gutenberg", name: "Project Gutenberg", url: "http://127.0.0.1:0", kind: "gutenberg", enabled: true },
  { id: "standard-ebooks", name: "Standard Ebooks", url: "http://127.0.0.1:0", kind: "standard-ebooks", enabled: true },
  { id: "slow", name: "Slow", url: "http://127.0.0.1:0", kind: "gutenberg", enabled: true },
];

function startServer() {
  const epub = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(4096, 7)]);
  const html = Buffer.from("<!DOCTYPE html><html><body>not a book</body></html>");
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/books/") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        results: [{
          id: 84, title: "Frankenstein", authors: [{ name: "Shelley, Mary" }], languages: ["en"],
          formats: { "application/epub+zip": `http://127.0.0.1:${server.address().port}/files/frankenstein.epub` },
        }],
      }));
      return;
    }
    if (url.pathname === "/opds/search") {
      response.end(`<feed><entry><title>Frankenstein</title><author><name>Shelley, Mary</name></author>
        <dc:language>en</dc:language>
        <link type="application/epub+zip" href="http://127.0.0.1:${server.address().port}/files/frankenstein.epub"/></entry></feed>`);
      return;
    }
    if (url.pathname === "/slow/books/") { setTimeout(() => response.end("{}"), 5000); return; }
    if (url.pathname === "/files/frankenstein.epub") {
      response.setHeader("content-type", "application/epub+zip");
      response.setHeader("content-length", String(epub.length));
      response.end(epub);
      return;
    }
    if (url.pathname === "/files/fake.epub") { response.end(html); return; }
    if (url.pathname === "/metadata/ia-book") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ files: [
        { name: "ia-book.pdf" }, { name: "ia-book.epub" }, { name: "ia-book_djvu.txt" }, { name: "ia-book_meta.xml" },
      ] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("book files are validated by magic bytes and html is rejected", () => {
  const epub = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(2048, 1)]);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7", "latin1"), Buffer.alloc(2048, 1)]);
  assert.equal(bookFileLooksValid(epub, "a.epub"), true);
  assert.equal(bookFileLooksValid(pdf, "a.pdf"), true);
  assert.equal(bookFileLooksValid(Buffer.from("<!DOCTYPE html><html>"), "a.epub"), false);
  assert.equal(bookFileLooksValid(Buffer.from("PK\x03\x04tiny"), "a.epub"), false, "too small");
  assert.equal(bookFileLooksValid(pdf, "a.epub"), false, "magic mismatch");
  assert.equal(bookFileLooksValid(Buffer.from("hello world".repeat(100)), "notes.txt"), true);
});

test("archive metadata resolves to epub first", () => {
  const picked = pickArchiveFile({ files: [{ name: "x.pdf" }, { name: "x.epub" }, { name: "x_meta.xml" }] }, "x");
  assert.equal(picked.format, "epub");
  assert.match(picked.url, /archive\.org\/download\/x\/x\.epub$/);
});

test("duplicate file names get a suffix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-books-"));
  fs.writeFileSync(path.join(dir, "book.epub"), "x");
  assert.equal(uniqueBookName(dir, "book.epub"), "book (2).epub");
  fs.writeFileSync(path.join(dir, "book (2).epub"), "x");
  assert.equal(uniqueBookName(dir, "book.epub"), "book (3).epub");
});

test("search merges sources, dedupes works and reports failing sources", async () => {
  const server = await startServer();
  const port = server.address().port;
  const sources = SOURCES.map((source) => ({ ...source, url: `http://127.0.0.1:${port}${source.kind === "standard-ebooks" ? "/opds" : source.id === "slow" ? "/slow" : ""}` }));
  const books = createBookDownloads({ downloadRoot: fs.mkdtempSync(path.join(os.tmpdir(), "qbr-books-")) });
  try {
    const { results, errors } = await books.search({ sources, query: "frankenstein" }, { timeout: 800 });
    assert.equal(results.length, 1, "one row per work across sources");
    assert.equal(results[0].title, "Frankenstein");
    assert.equal(results[0].downloadable, true);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].source, "slow");
    assert.equal(errors[0].message, "超时");
  } finally {
    server.close();
  }
});

test("downloads land in the library folder with progress and validated bytes", async () => {
  const server = await startServer();
  const port = server.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-books-"));
  const books = createBookDownloads({ downloadRoot: root });
  const progress = [];
  try {
    const done = await new Promise((resolve) => {
      books.download("job-1", {
        source: "gutenberg", title: "Frankenstein", format: "epub",
        url: `http://127.0.0.1:${port}/files/frankenstein.epub`,
      }, {
        onProgress: (value) => progress.push(value.received),
        onDone: resolve,
      });
    });
    assert.equal(done.ok, true);
    assert.equal(path.dirname(done.path), root);
    assert.equal(fs.existsSync(done.path), true);
    assert.ok(done.bytes > 4000);
    assert.ok(progress.length >= 1, "streamed progress");
    assert.equal(books.jobs.size, 0);

    const bad = await new Promise((resolve) => {
      books.download("job-2", {
        source: "zlib", title: "Fake", format: "epub", url: `http://127.0.0.1:${port}/files/fake.epub`,
      }, { onDone: resolve });
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /有效书籍文件/);
  } finally {
    server.close();
  }
});

test("cancelling a queued download stops it and reports back", async () => {
  const server = await startServer();
  const port = server.address().port;
  const books = createBookDownloads({ downloadRoot: fs.mkdtempSync(path.join(os.tmpdir(), "qbr-books-")) });
  try {
    const outcome = await new Promise((resolve) => {
      books.download("job-3", {
        source: "gutenberg", title: "Slow", format: "epub", url: `http://127.0.0.1:${port}/files/frankenstein.epub`,
      }, { onDone: resolve });
      books.cancel("job-3");
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.cancelled, true);
  } finally {
    server.close();
  }
});

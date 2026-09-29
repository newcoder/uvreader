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
    if (url.pathname === "/ebooks") {
      response.end(`<ol class="ebooks-list"><li typeof="schema:Book" about="/ebooks/mary-shelley/frankenstein">
        <p><a href="/ebooks/mary-shelley/frankenstein" property="schema:url"><span property="schema:name">Frankenstein</span></a></p>
        <p class="author" typeof="schema:Person"><a href="/ebooks/mary-shelley" property="schema:url"><span property="schema:name">Shelley, Mary</span></a></p></li></ol>`);
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
  const sources = SOURCES.map((source) => ({ ...source, url: `http://127.0.0.1:${port}${source.id === "slow" ? "/slow" : ""}` }));
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

test("search streams per-source updates so rows can render early", async () => {
  const server = await startServer();
  const port = server.address().port;
  const sources = [
    { id: "gutenberg", name: "Project Gutenberg", url: `http://127.0.0.1:${port}`, kind: "gutenberg", enabled: true },
    { id: "standard-ebooks", name: "Standard Ebooks", url: `http://127.0.0.1:${port}`, kind: "standard-ebooks", enabled: true },
  ];
  const books = createBookDownloads({ downloadRoot: fs.mkdtempSync(path.join(os.tmpdir(), "qbr-books-")) });
  const updates = [];
  try {
    const { results } = await books.search({ sources, query: "frankenstein" }, { onSource: (update) => updates.push(update) });
    assert.equal(results.length, 1);
    assert.equal(updates.length, 2);
    assert.equal(updates[0].done, 1);
    assert.equal(updates[1].done, 2);
    assert.equal(updates[1].total, 2);
    assert.equal(updates.every((update) => update.error === ""), true);
    assert.equal(updates.some((update) => (update.results || []).length === 1), true);
  } finally {
    server.close();
  }
});

test("a session download that fails twice forgets the dead login", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-books-"));
  let calls = 0;
  const forgotten = [];
  const books = createBookDownloads({
    downloadRoot: root,
    fileDownload: async () => {
      calls += 1;
      throw new Error("下载失败");
    },
    forgetSession: async (url) => { forgotten.push(url); },
  });
  const outcome = await new Promise((resolve) => {
    books.download("job-auth", {
      source: "zlib", title: "Auth Wall", format: "epub", needsSession: true,
      url: "https://z-library.sk/dl/abc123",
      info: "https://z-library.sk/book/abc/def.html",
    }, { onDone: resolve });
  });
  assert.equal(outcome.ok, false);
  assert.equal(calls, 2, "the transient retry runs once");
  assert.deepEqual(forgotten, ["https://z-library.sk/dl/abc123"]);
});

test("an explicit 204 auth wall skips the retry and forgets the session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-books-"));
  let calls = 0;
  const forgotten = [];
  const books = createBookDownloads({
    downloadRoot: root,
    pageDownload: async () => {
      calls += 1;
      throw new Error("来源没有开始下载（/dl/ 返回 204，通常表示未登录；请先用「登录后下载」登录该来源）");
    },
    forgetSession: async (url) => { forgotten.push(url); },
  });
  const outcome = await new Promise((resolve) => {
    books.download("job-auth", {
      source: "zlib", title: "Auth Wall", format: "epub", needsSession: true,
      info: "https://z-library.sk/book/abc/def.html",
    }, { onDone: resolve });
  });
  assert.equal(outcome.ok, false);
  assert.equal(calls, 1, "the auth wall is not retried");
  assert.deepEqual(forgotten, ["https://z-library.sk/book/abc/def.html"]);
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

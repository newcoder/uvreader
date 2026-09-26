import assert from "node:assert/strict";
import test from "node:test";

import { collectMissingHighlights } from "../packages/reader/src/highlight-recovery.js";

test("collects only highlight ids missing from the current lists", () => {
  const backups = {
    "Books/a.pdf": [
      { ts: 1, items: [{ id: "h1", created: 20 }, { id: "h2", created: 10 }] },
      { ts: 2, items: [{ id: "h2", created: 10 }] },
    ],
    "Books/b.pdf": [{ ts: 3, items: [] }],
    "Books/c.pdf": [{ ts: 4, items: [{ id: "h9", created: 5 }] }],
  };
  const current = { "Books/a.pdf": [{ id: "h2" }], "Books/c.pdf": [{ id: "h9" }] };
  const report = collectMissingHighlights(backups, current);
  assert.equal(report.total, 1);
  assert.equal(report.books.length, 1);
  assert.equal(report.books[0].bookPath, "Books/a.pdf");
  assert.deepEqual(report.books[0].items.map((item) => item.id), ["h1"]);
});

test("sorts recovered highlights by creation time and tolerates junk", () => {
  const report = collectMissingHighlights({
    "Books/a.pdf": [
      { items: [{ id: "new", created: 30 }, { id: "old", created: 1 }, null, { noId: true }] },
      "junk",
    ],
  }, {});
  assert.deepEqual(report.books[0].items.map((item) => item.id), ["old", "new"]);
  assert.equal(report.total, 2);
  assert.deepEqual(collectMissingHighlights(null, null), { books: [], total: 0 });
});

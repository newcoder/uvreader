import assert from "node:assert/strict";
import test from "node:test";

import { compareHighlights, sortHighlightsByPosition } from "../packages/reader/src/highlight-order.js";

test("highlights sort by document position instead of insertion order", () => {
  const cfi = (step) => `epubcfi(/6/2!/4/${step},/1:0,/1:4)`;
  const list = [
    { id: "late", cfi: cfi(10) },
    { id: "early", cfi: cfi(2) },
    { id: "middle", cfi: cfi(4) },
  ];
  assert.deepEqual(sortHighlightsByPosition(list).map((h) => h.id), ["early", "middle", "late"]);
});

test("block anchors sort by block and occurrence, before any CFI record", () => {
  const list = [
    { id: "b5-1", block: 5, occ: 1 },
    { id: "cfi", cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)" },
    { id: "b2", block: 2, occ: 0 },
    { id: "b5-0", block: 5, occ: 0 },
  ];
  assert.deepEqual(sortHighlightsByPosition(list).map((h) => h.id), ["b2", "b5-0", "b5-1", "cfi"]);
});

test("unparseable records keep their relative order", () => {
  const same = [{ id: "a", cfi: "epubcfi(broken" }, { id: "b", cfi: "epubcfi(broken" }];
  assert.deepEqual(sortHighlightsByPosition(same).map((h) => h.id), ["a", "b"]);
  assert.equal(compareHighlights({ id: "a" }, { id: "b" }), 0);
});

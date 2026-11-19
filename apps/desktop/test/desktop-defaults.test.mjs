import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_POLISH_TAG, DESKTOP_DATA_DEFAULTS } from "../src/shared/desktop-defaults.js";

test("a fresh desktop profile enables the workshop and bundled-engine flow", () => {
  assert.equal(DESKTOP_DATA_DEFAULTS.workshopEnabled, true);
  assert.equal(DESKTOP_DATA_DEFAULTS.engineAutoStart, true);
  assert.equal(DESKTOP_DATA_DEFAULTS.engineUrl, "");
  assert.equal(DESKTOP_DATA_DEFAULTS.engineToken, "");
});

test("polish output defaults to the 精修 suffix", () => {
  assert.equal(DEFAULT_POLISH_TAG, "精修");
  assert.equal(DESKTOP_DATA_DEFAULTS.polishTag, DEFAULT_POLISH_TAG);
});

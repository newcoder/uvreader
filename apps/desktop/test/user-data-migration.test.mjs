import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LEGACY_USER_DATA_NAME,
  MIGRATION_MARKER,
  USER_DATA_NAME,
  migrateUserData,
} from "../src/main/user-data-migration.js";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-user-data-"));
  const appData = path.join(root, "Roaming");
  fs.mkdirSync(appData, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    appData,
    oldDir: path.join(appData, LEGACY_USER_DATA_NAME),
    newDir: path.join(appData, USER_DATA_NAME),
  };
}

test("migration moves the old tree and rewrites absolute paths", (t) => {
  const { appData, oldDir, newDir } = setup(t);
  fs.mkdirSync(path.join(oldDir, "library", "Spaces", "A"), { recursive: true });
  fs.writeFileSync(path.join(oldDir, "spaces.json"), JSON.stringify({
    spaces: [{ root: path.join(oldDir, "library", "Spaces", "A") }],
  }));
  fs.writeFileSync(path.join(oldDir, "data.json"), JSON.stringify({ library: path.join(oldDir, "library") }));
  fs.writeFileSync(path.join(oldDir, "library", "book.bin"), Buffer.from(`binary ${oldDir}`));

  const result = migrateUserData({ appData });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "move");
  assert.equal(result.userData, newDir);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(newDir), true);
  const spaces = JSON.parse(fs.readFileSync(path.join(newDir, "spaces.json"), "utf8"));
  assert.match(spaces.spaces[0].root, /uvreader-desktop/);
  assert.doesNotMatch(spaces.spaces[0].root, /qiaomu-reader-desktop/);
  assert.equal(fs.readFileSync(path.join(newDir, "library", "book.bin"), "utf8"), `binary ${oldDir}`);
  assert.equal(fs.existsSync(path.join(newDir, MIGRATION_MARKER)), true);
  assert.match(result.rewrite.backupRoot, /\.migration-backup-/);
});

test("a locked old tree falls back to copying without losing the source", (t) => {
  const { appData, oldDir, newDir } = setup(t);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "data.json"), JSON.stringify({ root: oldDir }));
  let calls = 0;

  const result = migrateUserData({
    appData,
    rename: (from, to) => {
      calls += 1;
      if (calls === 1) throw new Error("EBUSY");
      fs.renameSync(from, to);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "copy");
  assert.equal(fs.existsSync(oldDir), true);
  assert.equal(fs.existsSync(newDir), true);
  assert.match(fs.readFileSync(path.join(newDir, "data.json"), "utf8"), /uvreader-desktop/);
});

test("a failed copy leaves no half-migrated target", (t) => {
  const { appData, oldDir, newDir } = setup(t);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "data.json"), "{}");

  const result = migrateUserData({
    appData,
    rename: () => { throw new Error("EBUSY"); },
    copy: () => { throw new Error("EACCES"); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "failed");
  assert.equal(result.userData, oldDir);
  assert.equal(fs.existsSync(newDir), false);
});

test("an existing new tree is backed up instead of mixed with the old one", (t) => {
  const { appData, oldDir, newDir } = setup(t);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "data.json"), JSON.stringify({ source: oldDir }));
  fs.writeFileSync(path.join(oldDir, "notes.md"), `# note\n${oldDir}`);
  fs.writeFileSync(path.join(newDir, "data.json"), JSON.stringify({ source: "new" }));
  fs.writeFileSync(path.join(newDir, "keep.txt"), "keep");

  const result = migrateUserData({ appData });

  assert.equal(result.mode, "move");
  assert.match(result.previousTarget, /uvreader-desktop\.before-migration-/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(newDir, "data.json"), "utf8")), { source: oldDir.replace(/qiaomu-reader-desktop/g, "uvreader-desktop") });
  assert.match(fs.readFileSync(path.join(newDir, "notes.md"), "utf8"), /uvreader-desktop/);
  assert.equal(fs.existsSync(path.join(newDir, "keep.txt")), false);
  assert.equal(fs.readFileSync(path.join(result.previousTarget, "keep.txt"), "utf8"), "keep");
});

test("the migration marker makes subsequent launches a no-op", (t) => {
  const { appData, oldDir, newDir } = setup(t);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "data.json"), "{}");
  assert.equal(migrateUserData({ appData }).mode, "move");

  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "later.json"), "{}");
  const result = migrateUserData({ appData });

  assert.equal(result.mode, "current");
  assert.equal(fs.existsSync(path.join(newDir, "later.json")), false);
});

test("a fresh install creates the new directory", (t) => {
  const { appData, newDir } = setup(t);
  const result = migrateUserData({ appData });
  assert.equal(result.mode, "created");
  assert.equal(result.userData, newDir);
  assert.equal(fs.existsSync(newDir), true);
});

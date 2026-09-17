import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { FileSystemAdapter, Vault, createApp, normalizePath } from "../src/index.js";
import { setupHost } from "./helpers.mjs";

test("normalizePath keeps absolute paths and cleans separators", () => {
  assert.equal(normalizePath("notes\\a.md"), "notes/a.md");
  assert.equal(normalizePath("C:\\Books\\a.epub"), "C:/Books/a.epub");
  assert.equal(normalizePath("//a///b/"), "/a/b");
  assert.equal(normalizePath("  "), "");
});

test("adapter reads, writes, processes and checks files", async () => {
  const env = setupHost();
  try {
    const adapter = new FileSystemAdapter({ root: env.vaultRoot });
    assert.equal(await adapter.exists("notes/a.md"), false);
    await adapter.write("notes/a.md", "one");
    assert.equal(await adapter.exists("notes/a.md"), true);
    assert.equal(await adapter.read("notes/a.md"), "one");
    const next = await adapter.process("notes/a.md", (current) => `${current}+two`);
    assert.equal(next, "one+two");
    assert.equal(await adapter.read("notes/a.md"), "one+two");
    assert.equal(await adapter.readBinary("notes/a.md").then((b) => b.byteLength), "one+two".length);
  } finally {
    env.cleanup();
  }
});

test("vault exposes TFile metadata for absolute book paths", async () => {
  const env = setupHost();
  try {
    const external = path.join(env.root, "outside", "sample.epub");
    fs.mkdirSync(path.dirname(external), { recursive: true });
    fs.writeFileSync(external, Buffer.from([1, 2, 3, 4]));
    const vault = new Vault(new FileSystemAdapter({ root: env.vaultRoot }));
    const file = vault.getAbstractFileByPath(normalizePath(external));
    assert.equal(file?.extension, "epub");
    assert.equal(file?.basename, "sample");
    const bytes = await vault.readBinary(file);
    assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3, 4]);
    assert.equal(vault.getAbstractFileByPath("missing/file.epub"), null);
  } finally {
    env.cleanup();
  }
});

test("vault lists created files and reports markdown only", async () => {
  const env = setupHost();
  try {
    const vault = new Vault(new FileSystemAdapter({ root: env.vaultRoot }));
    await vault.create("notes/book.md", "# Note");
    await vault.create("books/sample.epub", "epub");
    const files = vault.getFiles().map((file) => file.path).sort();
    assert.deepEqual(files, ["books/sample.epub", "notes/book.md"]);
    assert.deepEqual(vault.getMarkdownFiles().map((file) => file.path), ["notes/book.md"]);
  } finally {
    env.cleanup();
  }
});

test("vault rename updates the file and emits the vault event", async () => {
  const env = setupHost();
  try {
    const vault = new Vault(new FileSystemAdapter({ root: env.vaultRoot }));
    const file = await vault.create("notes/old.md", "x");
    const seen = [];
    vault.on("rename", (renamed, oldPath) => seen.push([renamed.path, oldPath]));
    await vault.rename(file, "notes/new.md");
    assert.equal(file.path, "notes/new.md");
    assert.deepEqual(seen, [["notes/new.md", "notes/old.md"]]);
  } finally {
    env.cleanup();
  }
});

test("first-run plugin data is created with desktop defaults inside settings", async () => {
  const env = setupHost();
  try {
    const app = createApp({ dataDefaults: { onboarded: true, language: "zh", bookNotesFolder: "notes" } });
    const loaded = await app._loadPluginData();
    assert.deepEqual(loaded.settings, { onboarded: true, language: "zh", bookNotesFolder: "notes" });
  } finally {
    env.cleanup();
  }
});

test("plugin data splits AI chat history into per-conversation files", async () => {
  const env = setupHost();
  try {
    const app = createApp({ dataDefaults: { onboarded: true, language: "zh" } });
    await app._savePluginData({
      settings: {
        onboarded: true,
        aiChatHistory: [{ id: "c1", title: "T", book: "B", messages: [{ role: "user", text: "hi" }] }],
      },
      progressBackups: {},
    });
    const settings = JSON.parse(fs.readFileSync(path.join(env.dataRoot, "data.json"), "utf8"));
    assert.equal(settings.settings.aiChatHistory, undefined);
    assert.equal(settings.settings.onboarded, true);
    assert.deepEqual(settings.progressBackups, {});
    const index = JSON.parse(fs.readFileSync(path.join(env.dataRoot, "chat", "index.json"), "utf8"));
    assert.deepEqual(index, [{ id: "c1", title: "T", book: "B", createdAt: 0, updatedAt: 0 }]);
    const chat = JSON.parse(fs.readFileSync(path.join(env.dataRoot, "chat", "c1.json"), "utf8"));
    assert.equal(chat.messages[0].text, "hi");

    const loaded = await app._loadPluginData();
    assert.equal(loaded.settings.aiChatHistory[0].id, "c1");
    assert.equal(loaded.settings.language, "zh");
  } finally {
    env.cleanup();
  }
});

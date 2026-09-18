import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../packages/reader/src/wire.js', import.meta.url), 'utf8');
const pluginSource = fs.readFileSync(new URL("../packages/reader/src/plugin.js", import.meta.url), "utf8");
class TFile {
  constructor(path) { this.path = path; this.basename = path.split('/').at(-1).replace(/\.md$/, ''); this.extension = 'md'; }
}
function setup(paths) {
  const files = paths.map(p => new TFile(p));
  const app = { vault: { getAbstractFileByPath: path => files.find(f => f.path === path), getMarkdownFiles: () => files }, metadataCache: { getFirstLinkpathDest: () => files[0] } };
  const start = source.indexOf('function resolveBookNote(app, name) {');
  const code = source.slice(start, source.indexOf('\nconst BookNotePicker', start));
  const resolve = vm.runInNewContext(`${code}; resolveBookNote`, { TFile, qiaomuReaderPath: p => p });
  return { app, files, resolve };
}
test('full reading-note paths disambiguate same-name notes and never redirect deleted targets', () => {
  const { app, files, resolve } = setup(['A/笔记.md', 'B/笔记.md']);
  assert.equal(resolve(app, 'A/笔记.md'), files[0]);
  assert.equal(resolve(app, 'B/笔记.md'), files[1]);
  assert.equal(resolve(app, 'Missing/笔记.md'), null);
  assert.equal(resolve(app, '笔记'), null);
});
test('unambiguous legacy reading-note links remain readable', () => {
  const { app, files, resolve } = setup(['A/笔记.md']);
  assert.equal(resolve(app, '笔记'), files[0]);
});
test('creating same-name notes in separate folders persists and writes to each exact file', async () => {
  const { app, files } = setup(['A/笔记.md', 'B/笔记.md']);
  const start = pluginSource.indexOf('  async createBookNote(file, title, folder) {');
  const code = pluginSource.slice(start, pluginSource.indexOf('  async _materializeBookNote(', start));
  const writes = [];
  const create = vm.runInNewContext(`({${code}}).createBookNote`, { TFile, qiaomuReaderPath: p => p, sanitizeNoteTitle: p => p, writeBookProperty: async (app, path, book) => writes.push([path, book.path]) });
  const plugin = { app, settings: {}, saveAll: async () => {} };
  await create.call(plugin, { path: 'a.epub' }, '笔记', 'A');
  await create.call(plugin, { path: 'b.epub' }, '笔记', 'B');
  assert.equal(plugin.settings.bookNoteLinks['a.epub'], files[0].path);
  assert.equal(plugin.settings.bookNoteLinks['b.epub'], files[1].path);
  assert.deepEqual(writes, [['A/笔记.md','a.epub'],['B/笔记.md','b.epub']]);
});
test('renaming a note or its folder updates exact links without touching similarly named paths', () => {
  const start = pluginSource.indexOf('  _watchBookFiles() {');
  const code = pluginSource.slice(start, pluginSource.indexOf('  _scheduleFirstRunFlow()', start));
  const callbacks = {};
  let saves = 0;
  const watch = vm.runInNewContext(`({${code}})._watchBookFiles`, { window: {}, BOOK_EXTENSIONS: new Set() });
  const plugin = { settings: { bookNoteLinks: { a: 'A/笔记.md', b: 'AB/笔记.md', c: 'B/笔记.md' } }, app: { vault: { on: (name, fn) => { (callbacks[name] ||= []).push(fn); } } }, registerEvent() {}, registerBookCommands() {}, _saveLocalData: () => saves++ };
  watch.call(plugin);
  callbacks.rename[0]({ path: '移动后' }, 'A');
  assert.equal(plugin.settings.bookNoteLinks.a, '移动后/笔记.md');
  assert.equal(plugin.settings.bookNoteLinks.b, 'AB/笔记.md');
  callbacks.rename[0]({ path: 'B/新名字.md' }, 'B/笔记.md');
  assert.equal(plugin.settings.bookNoteLinks.c, 'B/新名字.md');
  assert.equal(saves, 2);
});
test('two books requesting the same note filename receive separate notes', async () => {
  const { app, files } = setup(['笔记.md']);
  const start = pluginSource.indexOf('  async createBookNote(file, title, folder) {');
  const code = pluginSource.slice(start, pluginSource.indexOf('  async _materializeBookNote(', start));
  const create = vm.runInNewContext(`({${code}}).createBookNote`, { TFile, qiaomuReaderPath: p => p, sanitizeNoteTitle: p => p, writeBookProperty: async () => {} });
  const plugin = { app, settings: { bookNoteLinks: { 'first.epub': '笔记.md' } }, saveAll: async () => {}, _materializeBookNote: async path => { const f = new TFile(path); files.push(f); return f; } };
  const made = await create.call(plugin, { path: 'second.epub' }, '笔记', '');
  assert.equal(made.path, '笔记 (2).md');
  assert.equal(plugin.settings.bookNoteLinks['first.epub'], '笔记.md');
  assert.equal(plugin.settings.bookNoteLinks['second.epub'], made.path);
});

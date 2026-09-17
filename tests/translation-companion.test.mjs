import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { highlightBacklink } from '../packages/reader/src/highlight-navigation.js';
const source = fs.readFileSync(new URL('../packages/reader/src/main.js', import.meta.url), 'utf8');
const viewSource = fs.readFileSync(new URL('../packages/reader/src/reader-view.js', import.meta.url), 'utf8');
class TFile { constructor(path) { this.path = path; this.extension = path.split('.').at(-1); this.basename = path.split('/').at(-1).replace(/\.[^.]+$/, ''); } }
class MarkdownView {}
function harness() {
  const files = new Map(), contents = new Map(), leaves = [];
  const note = new TFile('Notes/current.md'); files.set(note.path, note);
  let text = 'Unsaved personal draft', dailyCalls = 0;
  const editor = { getValue: () => text, offsetToPos: x => x, replaceRange: (extra, at) => { text = text.slice(0, at) + extra + text.slice(at); } };
  const leaf = { view: Object.assign(new MarkdownView(), { file: note, editor }) }; leaves.push(leaf);
  const app = { workspace: { getLeavesOfType: () => leaves }, vault: { getName: () => '中文 & QA', getAbstractFileByPath: path => files.get(path), process: async (file, fn) => contents.set(file.path, fn(contents.get(file.path) || '')) }, fileManager: { generateMarkdownLink: f => `[[${f.path}]]` }, internalPlugins: { plugins: { 'daily-notes': { enabled: true, instance: { getDailyNote: async () => { dailyCalls++; const file = new TFile('Daily/custom-date.md'); files.set(file.path,file); contents.set(file.path,contents.get(file.path) || 'Daily template\n'); return file; } } } } } };
  const plugin = { app, settings: {}, _lastNoteLeaf: leaf };
  const sandbox = { TFile, MarkdownView, highlightBacklink, isUnsafeReadingNote: () => false };
  const code = source.slice(source.indexOf('function currentTranslationNote('), source.indexOf('const TranslateModal'));
  const api = vm.runInNewContext(`${code}; ({currentTranslationNote, dailyNoteProvider, translationNoteBlock, saveTranslationNote})`, sandbox);
  const book = new TFile('Books/A & B.epub'); files.set(book.path,book);
  const modal = { plugin, app, bookFile: book, text:'Original', source:{text:'Original', cfi:'epubcfi(/6/4!/4/2:0)'}, noteTarget: api.currentTranslationNote(plugin), savedTargets:new Map() };
  return { api, modal, files, contents, leaves, leaf, editor, dailyCalls:()=>dailyCalls };
}
test('translation saves to captured editor, preserving unsaved text and preventing duplicates', async()=>{
  const h=harness();
  h.modal.plugin._lastNoteLeaf = null;
  await h.api.saveTranslationNote(h.modal,'current','译文');
  await h.api.saveTranslationNote(h.modal,'current','译文');
  assert.ok(h.editor.getValue().startsWith('Unsaved personal draft'));
  assert.equal(h.editor.getValue().split('译文').length,2);
  assert.match(h.editor.getValue(), /obsidian:\/\/qiaomu-reader\?vault=/);
  assert.match(h.editor.getValue(), /cfi=epubcfi%28/);
});
test('closed or changed current-note targets fail rather than write somewhere else', async()=>{
  const h=harness();h.leaf.view.file=new TFile('different.md');
  await assert.rejects(h.api.saveTranslationNote(h.modal,'current','译文'));
  assert.equal(h.editor.getValue(),'Unsaved personal draft');
  h.leaf.view.file=h.modal.noteTarget.file;h.leaves.length=0;
  assert.equal(h.api.currentTranslationNote(h.modal.plugin,h.modal.noteTarget),null);
});
test('daily destination uses core template and path, serializes writes, and respects disabled plugin', async()=>{
  const h=harness();
  await Promise.all([h.api.saveTranslationNote(h.modal,'daily','一'),h.api.saveTranslationNote(h.modal,'daily','二')]);
  const text=h.contents.get('Daily/custom-date.md');
  assert.ok(text.startsWith('Daily template'));
  assert.match(text,/一/);assert.match(text,/二/);assert.equal(h.dailyCalls(),2);
  h.modal.app.internalPlugins.plugins['daily-notes'].enabled=false;
  await assert.rejects(h.api.saveTranslationNote(h.modal,'daily','三'));
});
test('translation source is a stable snapshot and does not reference a highlight ID',()=>{
  const h=harness();h.modal.source.id='deleted-highlight';
  const text=h.api.translationNoteBlock(h.modal.plugin,h.modal.bookFile,h.modal.source,'译文');
  assert.ok(!text.includes('highlight='));assert.ok(text.includes('book=Books%2FA%20%26%20B.epub'));
});
test('automatic companion respects mobile, narrow windows, closed preference, loading and active book',async()=>{
  const start=source.indexOf('  async _showCompanionForBook(');
  const method=source.slice(start,source.indexOf('  _watchQuietUiDocument(',start));
  const p=vm.runInNewContext(`({${method}})`,{readerAiPanelContext:v=>({readerView:v,text:'page'}),console});
  let calls=0;p.openAiChat=async(_c,o)=>{assert.equal(o.automatic,true);calls++;};
  p.app={workspace:{}};p.settings={aiCompanionVisible:null};
  const view={bookHtml:'text',containerEl:{ownerDocument:{defaultView:{innerWidth:1200}}},leaf:{}};p.app.workspace.activeLeaf=view.leaf;
  await p._showCompanionForBook(view);assert.equal(calls,1);
  p.settings.aiCompanionVisible=false;await p._showCompanionForBook(view);
  p.settings.aiCompanionVisible=true;p.app.isMobile=true;await p._showCompanionForBook(view);
  p.app.isMobile=false;view.containerEl.ownerDocument.defaultView.innerWidth=390;await p._showCompanionForBook(view);
  view.containerEl.ownerDocument.defaultView.innerWidth=1200;view._openingBook={};await p._showCompanionForBook(view);
  view._openingBook=null;p.app.workspace.activeLeaf={};await p._showCompanionForBook(view);
  assert.equal(calls,1);
});

test('a note opened after translation started never becomes the current-note target',async()=>{
  const h=harness();h.modal.noteTarget=null;
  await assert.rejects(h.api.saveTranslationNote(h.modal,'current','译文'));
  assert.equal(h.editor.getValue(),'Unsaved personal draft');
});


test('reader companion entry renders an icon and opens setup before configuration',()=>{
  const dom=new JSDOM('<div id="tray"></div>'), document=dom.window.document;
  const tray=document.querySelector('#tray');
  tray.createEl=(tag,spec)=>{const el=document.createElement(tag);el.className=spec.cls;for(const [key,value] of Object.entries(spec.attr))el.setAttribute(key,value);tray.append(el);return el;};
  let opened=0;
  const view={plugin:{openAiChat:()=>opened++}};
  const helper=viewSource.slice(viewSource.indexOf('    const trayButton ='),viewSource.indexOf('    trayButton("reading-note"'));
  const entry=viewSource.slice(viewSource.indexOf('    this.aiBtn = trayButton('),viewSource.indexOf('    this.fitBtn = trayButton('));
  vm.runInNewContext(`(function(){${helper}${entry}}).call(view)`,{view,tray,svgIcon:()=>{},setIcon:(el,name)=>{assert.equal(name,'sparkles');el.append(document.createElementNS('http://www.w3.org/2000/svg','svg'));},qiaomuReaderTranslate:x=>x,readerAiPanelContext:()=>({})});
  assert.ok(view.aiBtn.querySelector('svg'));
  assert.equal(view.aiBtn.hidden,false);
  view.aiBtn.click();assert.equal(opened,1);
  dom.window.close();
});

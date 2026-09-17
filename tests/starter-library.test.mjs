import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { createStarterLibraryInstaller } from "../packages/reader/src/starter-library.js";

function setup(initialState) {
  const files = new Map(); let state = initialState; let failPath; let savesFail = false;
  const vault = {
    getAbstractFileByPath: p => files.get(p),
    async createFolder(p) { files.set(p, { children: [] }); },
    async createBinary(p, bytes) {
      if (p === failPath) throw Error("read only");
      if (files.has(p)) throw Error("exists");
      files.set(p, { bytes });
    },
  };
  const ensure = createStarterLibraryInstaller({
    vault, books: ["one", "two"].map(id=>({filename:id+".epub",data:btoa(id)})),
    getState: () => state,
    saveState: async s => { if (savesFail) throw Error("settings read only"); state=s; },
    getFolder: () => "Books/Starter Library",
  });
  return { ensure, files, state:()=>state, fail:p=>{failPath=p;}, failSaves:()=>{savesFail=true;} };
}

test("first empty library gets offline books once; concurrent opens do not duplicate them", async () => {
  const s=setup();
  await Promise.all([s.ensure(),s.ensure()]);
  assert.equal(s.files.size,4);
  assert.equal(s.state().version,1);
  s.files.delete("Books/Starter Library/one.epub");
  s.files.delete("Books/Starter Library/two.epub");
  assert.deepEqual(await s.ensure(),[],"intentional deletion is respected");
  assert.equal(s.files.size,2);
  assert.equal((await s.ensure(true)).length,2,"explicit add can restore samples");
});

test("existing libraries and same-name files are not overwritten", async () => {
  const s=setup(); const original={bytes:new Uint8Array([42]).buffer};
  s.files.set("Books/Starter Library/one.epub",original);
  s.files.set("Attachments/existing.pdf", { bytes: new Uint8Array([7]).buffer });
  const added=await s.ensure();
  assert.equal(added.length,1);
  assert.equal(s.files.get("Books/Starter Library/one.epub"),original);
  assert.equal(s.state().skipped,undefined);
  assert.ok(s.files.has("Attachments/existing.pdf"));
});

test("upgrade repairs legacy skipped installs once without changing other books", async () => {
  const s = setup({ version: 1, skipped: true });
  const original = { bytes: new Uint8Array([42]).buffer };
  s.files.set("Existing/book.mobi", original);
  assert.equal((await s.ensure()).length, 2);
  assert.equal(s.files.get("Existing/book.mobi"), original);
  assert.deepEqual(s.state(), { version: 1, folder: "Books/Starter Library" });
  s.files.delete("Books/Starter Library/one.epub");
  assert.deepEqual(await s.ensure(), [], "later deletion stays respected");
});

test("failed skipped-state repair resumes in the journaled folder", async () => {
  const s = setup({ version: 1, skipped: true, pending: true, folder: "Books/Original" });
  s.fail("Books/Original/two.epub");
  await assert.rejects(s.ensure(), /read only/);
  const first = s.files.get("Books/Original/one.epub");
  s.fail();
  assert.deepEqual(await s.ensure(), ["Books/Original/two.epub"]);
  assert.equal(s.files.get("Books/Original/one.epub"), first);
  assert.deepEqual(s.state(), { version: 1, folder: "Books/Original" });
});

test("interrupted explicit restore retries even after an earlier successful install", async () => {
  const s = setup({ version: 1, pending: true, folder: "Books/Original" });
  assert.equal((await s.ensure()).length, 2);
  assert.equal(s.state().pending, undefined);
});

test("partial installation resumes without replacing completed files", async () => {
  const s=setup();s.fail("Books/Starter Library/two.epub");
  await assert.rejects(s.ensure(),/read only/);
  const first=s.files.get("Books/Starter Library/one.epub");
  assert.equal(s.state().pending,true);
  s.fail();
  assert.equal((await s.ensure()).length,1);
  assert.equal(s.files.get("Books/Starter Library/one.epub"),first);
  assert.equal(s.state().pending,undefined);
});

test("failed journal writes create no book files", async () => {
  const s=setup();s.failSaves();await assert.rejects(s.ensure(),/settings read only/);
  assert.equal(s.files.size,0);
});

test("all six EPUBs have a lightweight cover, stable reading spine, complete source text and full licenses", async () => {
  const base=new URL("../assets/starter-books/",import.meta.url);
  const editions=JSON.parse(await fs.readFile(new URL("editions.json",base),"utf8"));
  assert.equal(editions.length,6);
  const compact=s=>s.replace(/\s/g,"");
  let total=0;
  for(const book of editions) {
    const raw=await fs.readFile(new URL(`${book.id}.epub`,base)); total+=raw.length;
    const zip=await JSZip.loadAsync(raw);
    assert.equal(await zip.file("mimetype").async("string"),"application/epub+zip");
    assert.deepEqual(Object.keys(zip.files).filter(p=>/\.(png|jpe?g|svg|gif|woff2?)$/i.test(p)), ["EPUB/cover.jpg"]);
    const xml=new JSDOM(await zip.file("EPUB/package.opf").async("string"),{contentType:"application/xml"});
    const doc=xml.window.document;
    assert.equal(doc.querySelector("parsererror"),null);
    const cover = doc.querySelector('item[properties="cover-image"]');
    assert.equal(cover?.getAttribute("media-type"), "image/jpeg");
    const artwork = await zip.file("EPUB/" + cover.getAttribute("href")).async("nodebuffer");
    assert.ok(artwork.length < 30000);
    assert.equal(artwork.readUInt16BE(0), 0xffd8);
    assert.equal(artwork.readUInt16BE(artwork.length - 2), 0xffd9);
    assert.deepEqual(artwork, await fs.readFile(new URL(`covers/${book.id}.jpg`, base)));
    assert.match(await zip.file("EPUB/cover-credits.txt").async("string"), /https:\/\//);
    const manifest=new Map([...doc.querySelectorAll("manifest item")].map(e=>[e.id,e.getAttribute("href")]));
    let content="",license="";
    for(const [i,ref] of [...doc.querySelectorAll("spine itemref")].entries()) {
      const path="EPUB/"+manifest.get(ref.getAttribute("idref"));assert.ok(zip.file(path),path);
      const chapter=new JSDOM(await zip.file(path).async("string"),{contentType:"application/xhtml+xml"});
      assert.equal(chapter.window.document.querySelector("parsererror, img, svg, script"),null);
      const value=chapter.window.document.querySelector("body").textContent;
      if(i===book.sections-1)license=value;else content+=value;
      chapter.window.close();
    }
    xml.window.close();
    const source=(await fs.readFile(new URL(`${book.id}.txt`,base),"utf8")).replaceAll("\r\n","\n").replace(/^\uFEFF/,"");
    const start=/\*\*\* START OF THE PROJECT GUTENBERG EBOOK .*?\*\*\*/.exec(source);
    const end=/\*\*\* END OF THE PROJECT GUTENBERG EBOOK .*?\*\*\*/.exec(source);
    assert.equal(compact(content),compact(source.slice(start.index+start[0].length,end.index)),book.title);
    assert.equal(compact(license),compact(source.slice(0,start.index+start[0].length)+source.slice(end.index)),book.title);
    assert.match(compact(license),/FULLPROJECTGUTENBERGLICENSE/i);
  }
  assert.ok(total<750000,`offline books weigh ${total} bytes`);
});

// Builds the three desktop bundles without touching the committed plugin
// artifacts at the repository root. Renderer aliases `obsidian` to the host
// shim so src/main.js can run unchanged.
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { foliateElements } from "../../scripts/foliate-elements.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const dist = path.join(here, "dist");
const watch = process.argv.includes("--watch");
const prod = process.argv.includes("--production");

const shim = path.join(repoRoot, "packages/host-shim/src/index.js");
const stub = path.join(repoRoot, "build-stubs/empty.js");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
const foliate = foliateElements(repoRoot);

const fontLicense = fs.readFileSync(path.join(repoRoot, "fonts/OFL.txt"), "utf8");
const fontData = fs.readFileSync(path.join(repoRoot, "fonts/QiaomuReadingFangsong.woff2")).toString("base64");

// Mirrors esbuild.config.mjs: the pdf.js worker is embedded into the bundle so
// PDFs work without shipping a separate worker file.
function loadPatchedWorker() {
  const candidates = [
    path.join(repoRoot, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.join(repoRoot, "node_modules/pdfjs-dist/build/pdf.worker.mjs"),
    path.join(repoRoot, "node_modules/pdfjs-dist/build/pdf.worker.js"),
    path.join(repoRoot, "node_modules/pdfjs-dist/legacy/build/pdf.worker.js"),
  ];
  const workerPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!workerPath) throw new Error("pdf.worker.mjs not found — run `npm ci` in the repository root first");
  let code = fs.readFileSync(workerPath, "utf8");
  const OLD = "/^(\\s)|(\\p{Mn})|(\\p{Cf})$/u";
  const NEW = "/^(\\s+)$|(\\p{Mn})|(\\p{Cf})$/u";
  if (!code.includes(NEW) && code.includes(OLD)) code = code.split(OLD).join(NEW);
  return code.replace(/\nexport \{[^}]*\};\s*$/, "\n");
}

const workerCode = (
  await esbuild.transform(loadPatchedWorker(), {
    target: "es2018",
    charset: "utf8",
    minifyWhitespace: prod,
    minifySyntax: prod,
    minifyIdentifiers: prod,
    legalComments: "inline",
  })
).code;

const banner = `/*
GENERATED BUNDLE — UV Reader Desktop
Source: https://github.com/newcoder/uvreader
Bundled font license: SIL OFL 1.1
*/`;

const rendererConfig = {
  entryPoints: [path.join(here, "src/renderer/entry.js")],
  outfile: path.join(dist, "renderer.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  charset: "utf8",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
  banner: { js: banner },
  loader: { ".gz": "dataurl", ".epub": "base64" },
  alias: {
    obsidian: shim,
    fs: stub,
    http: stub,
    https: stub,
    url: stub,
    zlib: stub,
    stream: stub,
    canvas: stub,
    localforage: stub,
  },
  define: {
    __PDF_WORKER_CODE__: JSON.stringify(workerCode),
    __QBR_VERSION__: JSON.stringify(manifest.version),
    ...foliate.define,
  },
  plugins: [foliate.plugin],
};

const mainConfig = {
  entryPoints: [path.join(here, "src/main/index.js")],
  outfile: path.join(dist, "main.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["electron"],
  sourcemap: prod ? false : "inline",
  logLevel: "info",
};

const preloadConfig = {
  entryPoints: [path.join(here, "src/preload/index.js")],
  outfile: path.join(dist, "preload.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["electron"],
  sourcemap: prod ? false : "inline",
  logLevel: "info",
};

function writeAssets() {
  fs.mkdirSync(dist, { recursive: true });
  const css = fs.readFileSync(path.join(repoRoot, "src/styles.css"), "utf8")
    + `\n/* Bundled reading subset: SIL OFL 1.1\n${fontLicense}\n*/\n`
    + `@font-face { font-family: 'QBR Zhuque Fangsong'; src: url('data:font/woff2;base64,${fontData}') format('woff2'); font-style: normal; font-weight: 400; font-display: swap; }\n`;
  fs.writeFileSync(path.join(dist, "styles.css"), css);
  fs.copyFileSync(path.join(here, "src/renderer/index.html"), path.join(dist, "index.html"));
  fs.copyFileSync(path.join(here, "src/renderer/base.css"), path.join(dist, "base.css"));
  console.log(`desktop assets written to ${path.relative(repoRoot, dist)}`);
}

if (watch) {
  const contexts = await Promise.all([rendererConfig, mainConfig, preloadConfig].map((config) => esbuild.context(config)));
  await Promise.all(contexts.map((context) => context.watch()));
  writeAssets();
  console.log("watching desktop sources…");
} else {
  await Promise.all([rendererConfig, mainConfig, preloadConfig].map((config) => esbuild.build(config)));
  writeAssets();
}

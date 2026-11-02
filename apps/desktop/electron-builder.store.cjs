// Microsoft Store / MSIX build.
//
// This target is deliberately separate from the NSIS/portable release: the
// Store package bundles the Windows engine zip and exposes only the AppX target.
// The Store re-signs MSIX/AppX packages, so this config does not need a code
// signing certificate. Partner Center identity values can be supplied through
// environment variables when the real reservation is available.
const fs = require("fs");
const path = require("path");

const base = require("./electron-builder.config.cjs");

const engineDir = path.resolve(__dirname, "../../dist/engine");
const engineArchives = (() => {
  try {
    return fs.readdirSync(engineDir)
      .filter((name) => /^uvreader-engine-.+-win32-x64\.zip$/.test(name))
      .map((name) => path.join(engineDir, name))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  } catch {
    return [];
  }
})();

if (!engineArchives.length) {
  throw new Error("缺少 Windows 引擎包:先运行 node scripts/build-engine.mjs --platform win32-x64");
}

const identityName = String(process.env.QBR_STORE_IDENTITY || "com.uvreader.app");
const publisher = String(process.env.QBR_STORE_PUBLISHER || "CN=UV Reader Test");
const publisherDisplayName = String(process.env.QBR_STORE_PUBLISHER_NAME || "UV Reader");

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: "release-store",
  },
  win: {
    ...base.win,
    target: [{ target: "appx", arch: ["x64"] }],
  },
  extraResources: [
    {
      from: engineArchives[0],
      to: `engine/${path.basename(engineArchives[0])}`,
    },
  ],
  appx: {
    identityName,
    publisher,
    publisherDisplayName,
    applicationId: "UVReader",
    displayName: "UV Reader",
    languages: ["zh-CN", "en-US"],
    capabilities: ["runFullTrust"],
  },
};

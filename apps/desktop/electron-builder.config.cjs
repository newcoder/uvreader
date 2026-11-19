// electron-builder configuration for the desktop shell. The app version is
// taken from the root package.json so the installer, the About dialog and the
// release tag always agree.
const fs = require("fs");
const path = require("path");
const rootPackage = require("../../package.json");

// 完整安装包：如果 dist/engine 里有当前平台的引擎包，就一起放进
// resources/engine/。应用首次启动会把它安装到用户目录（版本更高时覆盖旧引擎），
// 用户不需要再手动设置 QBR_ENGINE_ROOT。
const engineDir = path.resolve(__dirname, "../../dist/engine");
const enginePlatform = process.platform === "win32"
  ? `win32-${process.arch}`
  : `darwin-${process.arch}`;
const engineArchives = (() => {
  try {
    return fs.readdirSync(engineDir)
      .filter((name) => name.includes(enginePlatform) && /\.(zip|tar\.gz)$/.test(name))
      .map((name) => path.join(engineDir, name))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  } catch {
    return [];
  }
})();
const extraResources = engineArchives.length
  ? [{ from: engineArchives[0], to: `engine/${path.basename(engineArchives[0])}` }]
  : [];

// The release workflow builds each Mac architecture on its own runner so one
// scarce arm64 runner cannot stall both DMGs. Local builds keep both targets.
const requestedMacArch = String(process.env.QBR_MAC_ARCH || "").trim();
const macArchs = requestedMacArch === "arm64"
  ? ["arm64"]
  : requestedMacArch === "x64"
    ? ["x64"]
    : ["arm64", "x64"];

module.exports = {
  appId: "com.uvreader.app",
  productName: "UV Reader",
  copyright: "Copyright © 2026 newcoder · GPL-3.0 · Fork of qiaomu-reader",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "package.json"],
  extraResources,
  extraMetadata: { version: rootPackage.version },
  asar: true,
  win: {
    icon: "build/icon.png",
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: "UV Reader",
    artifactName: "UV-Reader-${version}-setup.${ext}",
  },
  portable: { artifactName: "UV-Reader-${version}-portable.${ext}" },
  mac: {
    icon: "build/icon.png",
    category: "public.app-category.books",
    target: [{ target: "dmg", arch: macArchs }],
  },
  dmg: { artifactName: "UV-Reader-${version}-${arch}.${ext}" },
  // Linux 目标先不产出(AppImage 留待以后);配置留着便于恢复。
  fileAssociations: [
    { ext: ["epub"], name: "EPUB 电子书", role: "Viewer" },
    { ext: ["pdf"], name: "PDF 文档", role: "Viewer" },
    { ext: ["mobi"], name: "MOBI 电子书", role: "Viewer" },
    { ext: ["azw"], name: "AZW 电子书", role: "Viewer" },
    { ext: ["azw3"], name: "AZW3 电子书", role: "Viewer" },
    { ext: ["fb2"], name: "FB2 电子书", role: "Viewer" },
    { ext: ["fbz"], name: "FB2 压缩包", role: "Viewer" },
    { ext: ["cbz"], name: "CBZ 漫画", role: "Viewer" },
  ],
};

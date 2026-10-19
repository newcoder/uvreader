// 书坊引擎打包:私有 Python 运行时 + 依赖 + 引擎代码 + pdf_tool → 可独立部署的包(zip / tar.gz)。
//
// 用法(本机打 Windows 包):
//   node scripts/build-engine.mjs --pdf-tool D:/projects/auto_chat
// 用法(CI 三平台):
//   node scripts/build-engine.mjs --platform linux-x64 --pdf-tool ./vendor/pdf_tool_src
//
// 产物:<out>/uvreader-engine-<version>-<platform>.{zip,tar.gz} + .sha256 + engine.json 摘要。
// 许可:依赖全部按 wheel 安装(--only-binary),并生成 licenses.json;GPL 组件(Calibre / boko)不进包。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const engineRoot = path.join(repoRoot, "engine");

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const PYTHON_VERSION = "3.11.9";        // Windows:python.org 的 embeddable
const PYTHON_MINOR = "3.11";
// macOS/Linux 用 python-build-standalone:钉死 release tag 与 cpython 版本(不再查 API —— 匿名会被限流)。
const STANDALONE_TAG = "20261013";
const STANDALONE_VERSION = "3.11.17";

const hostPlatform = `${process.platform}-${process.arch}`;
const platform = flag("platform", hostPlatform);
const outDir = path.resolve(flag("out", path.join(repoRoot, "dist", "engine")));
const pdfToolDir = flag("pdf-tool", path.join(engineRoot, "vendor", "pdf_tool"));
const keepStage = args.includes("--keep-stage");

const PIP_PLATFORM = {
  "win32-x64": "win_amd64",
  "linux-x64": "manylinux2014_x86_64",
  "linux-arm64": "manylinux2014_aarch64",
  "darwin-x64": "macosx_11_0_x86_64",
  "darwin-arm64": "macosx_11_0_arm64",
}[platform];
if (!PIP_PLATFORM) {
  console.error(`✗ 不支持的平台:${platform}(可用:${Object.keys({ "win32-x64": 1, "linux-x64": 1, "linux-arm64": 1, "darwin-x64": 1, "darwin-arm64": 1 }).join(", ")})`);
  process.exit(1);
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout: 1800_000, ...options });
  if (result.status !== 0) {
    console.error(`✗ ${command} ${commandArgs.slice(0, 4).join(" ")} 失败:`, String(result.stderr || result.stdout || "").slice(-600));
    process.exit(1);
  }
  return String(result.stdout || "").trim();
};

const engineVersion = (/__version__\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(engineRoot, "engine", "__init__.py"), "utf8")) || [])[1] || "0.0.0";
console.log(`· 打包书坊引擎 ${engineVersion} · ${platform} → ${outDir}`);

// ── 1. 舞台目录 ─────────────────────────────────────────────────────
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-engine-stage-"));
const copyTree = (from, to, { skip = () => false } = {}) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    if (skip(source, entry)) continue;
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, { skip });
    else fs.copyFileSync(source, target);
  }
};

// 引擎代码(去掉 __pycache__;dev 清单不进包 —— 包根的 engine.json 才是真的,
// 里面那份会带着开发版本号,server.load_manifest 也只认非 dev 的)
copyTree(path.join(engineRoot, "engine"), path.join(stage, "engine"), {
  skip: (source) => path.basename(source) === "__pycache__" || source === path.join(engineRoot, "engine", "engine.json"),
});

// pdf_tool(可选):--pdf-tool 给「仓库根」或「pdf_tool 包目录」都行
if (pdfToolDir) {
  const source = path.resolve(pdfToolDir);
  const packageDir = fs.existsSync(path.join(source, "pdf_tool", "pdf_to_doc.py"))
    ? path.join(source, "pdf_tool")
    : source;
  if (!fs.existsSync(path.join(packageDir, "pdf_to_doc.py"))) {
    console.error(`✗ ${source} 里没有 pdf_to_doc.py(给仓库根或 pdf_tool 包目录)`);
    process.exit(1);
  }
  // 注意嵌套一层:pdf_to_doc.py 里 `from pdf_tool.convert.cli import main`,要求
  // <bundle>/pdf-tool 在 sys.path 上、包目录叫 pdf_tool/。
  copyTree(packageDir, path.join(stage, "pdf-tool", "pdf_tool"), { skip: (value) => /__pycache__|\.pyc$/.test(value) });
  let commit = "";
  try {
    commit = run("git", ["-C", packageDir, "rev-parse", "HEAD"]);
  } catch { /* 不是 git 目录就算了 */ }
  fs.writeFileSync(path.join(stage, "pdf-tool", "SOURCE.txt"), `来源: ${packageDir}\ncommit: ${commit}\n`, "utf8");
  console.log(`· 带上 pdf_tool(${commit.slice(0, 8) || "无 commit"})`);
}

// ── 2. 私有 Python 运行时 ───────────────────────────────────────────
const runtimeDir = path.join(stage, "python");
fs.mkdirSync(runtimeDir, { recursive: true });
if (platform.startsWith("win32")) {
  const url = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
  const file = path.join(stage, "python-embed.zip");
  console.log("· 下载 Windows embeddable:", url);
  run("curl", ["-sSL", "-o", file, url]);
  run("tar", ["-xf", file, "-C", runtimeDir]);
  fs.rmSync(file, { force: true });
  // embeddable 默认禁用 site-packages,而且 ._pth 会忽略 PYTHONPATH:
  // 引擎包和依赖目录都得写进这里。
  const pth = fs.readdirSync(runtimeDir).find((name) => /^python\d+\._pth$/.test(name));
  if (pth) {
    const file2 = path.join(runtimeDir, pth);
    const lines = fs.readFileSync(file2, "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line !== "import site");
    lines.push("..", "..\\site-packages", "..\\pdf-tool", "import site");
    fs.writeFileSync(file2, lines.join("\r\n") + "\r\n", "utf8");
    console.log("· 已改", pth, "指向 .. / ..\\site-packages / ..\\pdf-tool");
  }
} else {
  // python-build-standalone(install_only):钉死 tag + 版本,直接拼下载地址
  const triple = {
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
  }[platform];
  const asset = `cpython-${STANDALONE_VERSION}+${STANDALONE_TAG}-${triple}-install_only.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${STANDALONE_TAG}/${asset}`;
  const file = path.join(stage, "python-standalone.tar.gz");
  console.log("· 下载 python-build-standalone:", asset);
  run("curl", ["-sSL", "-o", file, url]);
  run("tar", ["-xzf", file, "-C", stage]);
  fs.rmSync(file, { force: true });
  // 解压出来是 python/ 目录(install_only 的约定)
  const extracted = path.join(stage, "python");
  if (!fs.existsSync(path.join(extracted, "bin", "python3"))) {
    console.error("✗ 解压后没有 python/bin/python3");
    process.exit(1);
  }
}

// ── 3. 依赖(wheel only;GPL 组件不进包)──────────────────────────────
// Windows 的 embeddable 靠 ._pth 指到 <bundle>/site-packages;
// macOS/Linux 的 python-build-standalone 不读 ._pth —— 直接装进它自己的 site-packages。
const sitePackages = platform.startsWith("win32")
  ? path.join(stage, "site-packages")
  : path.join(runtimeDir, "lib", `python${PYTHON_MINOR}`, "site-packages");
fs.mkdirSync(sitePackages, { recursive: true });
// 用户 pip 配置里常有 install.user=yes(与 --target 冲突):用环境变量压掉,同时保留镜像源。
const pipEnv = { ...process.env, PIP_USER: "0" };
console.log("· 安装依赖(pip --target,--only-binary)…");
run("python", [
  "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
  "--target", sitePackages,
  // 只指定 Python 版本,平台用宿主机的标签(manylinux 的标签名各版本不一,硬写 --platform 会挑不到轮子)
  "--python-version", PYTHON_MINOR,
  "--implementation", "cp",
  "--only-binary=:all:",
  "-r", path.join(engineRoot, "requirements.txt"),
], { env: pipEnv });

// 包里带上 pip:引擎要能自己装可选组件(DocVortex 等),而 python.org 的 embeddable 不带 pip
// (python-build-standalone 本来就带,这里统一再装一次)。装到 --target 里,`python -m pip` 就能用。
run("python", [
  "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--upgrade",
  "--target", sitePackages, "pip",
], { env: pipEnv });

// 许可清单(读 .dist-info/METADATA)
const licenses = [];
for (const entry of fs.readdirSync(sitePackages)) {
  if (!entry.endsWith(".dist-info")) continue;
  const meta = fs.readFileSync(path.join(sitePackages, entry, "METADATA"), "utf8");
  const field = (name) => (new RegExp(`^${name}:\\s*(.+)$`, "m").exec(meta) || [])[1] || "";
  licenses.push({ name: field("Name"), version: field("Version"), license: field("License") || field("Classifier").replace(/^License :: OSI Approved :: /, "") });
}
fs.writeFileSync(path.join(stage, "licenses.json"), JSON.stringify(licenses.sort((a, b) => a.name.localeCompare(b.name)), null, 2), "utf8");
console.log(`· 许可清单:${licenses.length} 个包`);

// ── 4. 清单 / 启动器 / 说明 ─────────────────────────────────────────
// 清单要**如实**:自带什么、什么还要另外装(别让用户以为装上引擎就什么都有了)。
const manifest = {
  schemaVersion: 1,
  engineVersion,
  platform,
  python: { version: PYTHON_VERSION },
  packages: Object.fromEntries(licenses.map((item) => [item.name, item.version])),
  pdfTool: { bundled: Boolean(pdfToolDir), source: fs.existsSync(path.join(stage, "pdf-tool", "SOURCE.txt")) ? fs.readFileSync(path.join(stage, "pdf-tool", "SOURCE.txt"), "utf8").trim() : "" },
  bundled: {
    python: true,
    pymupdf: true,
    pillow: true,
    latex2mathml: true,
    pdfTool: Boolean(pdfToolDir),
    docvortex: false,
    mineru: false,
    calibre: false,
    boko: false,
  },
  external: [
    { name: "DocVortex", need: "文档互转(Office / OFD / HTML / EPUB)与内容提取", how: "引擎目录下 python -m pip install docvortex,或在引擎配置里填 docvortexPath" },
    { name: "MinerU", need: "公式 / 视觉提取", how: "本地 MinerU 服务(可选组件,模型按需下载),或在引擎配置里填云端 token" },
    { name: "Calibre", need: "EPUB → AZW3 / MOBI(老格式)", how: "可选;装完在引擎配置里填 calibrePath,或放进 PATH" },
    { name: "boko", need: "EPUB → AZW3 / KFX 的轻量替代", how: "可选;装完在引擎配置里填 bokoPath,或放进 PATH" },
  ],
};
fs.writeFileSync(path.join(stage, "engine.json"), JSON.stringify(manifest, null, 2), "utf8");

if (platform.startsWith("win32")) {
  fs.writeFileSync(path.join(stage, "run-engine.cmd"), [
    "@echo off",
    "setlocal",
    "set \"HERE=%~dp0\"",
    "set \"PYTHONPATH=%HERE%engine\"",
    "\"%HERE%python\\python.exe\" -m engine serve --port %QBR_ENGINE_PORT% --token \"%QBR_ENGINE_TOKEN%\" %*",
  ].join("\r\n"), "utf8");
} else {
  const script = path.join(stage, "run-engine.sh");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    "HERE=$(cd \"$(dirname \"$0\")\" && pwd)",
    "export PYTHONPATH=\"$HERE\"",
    "exec \"$HERE/python/bin/python3\" -m engine serve --port \"${QBR_ENGINE_PORT:-8760}\" --token \"${QBR_ENGINE_TOKEN:-}\" \"$@\"",
  ].join("\n") + "\n", "utf8");
  fs.chmodSync(script, 0o755);
}
fs.writeFileSync(path.join(stage, "README.txt"), [
  "UV Reader 书坊引擎(独立部署的本地 HTTP 服务)",
  "",
  "启动:",
  platform.startsWith("win32")
    ? "  set QBR_ENGINE_PORT=8760 & set QBR_ENGINE_TOKEN=<令牌> & run-engine.cmd"
    : "  QBR_ENGINE_PORT=8760 QBR_ENGINE_TOKEN=<令牌> ./run-engine.sh",
  "然后在 UV Reader 的「设置 → 书坊 → 书坊引擎」里填服务地址与同一个令牌。",
  "(应用里也有「下载并安装引擎 / 从本地包安装」,会自动填好地址与令牌。)",
  "",
  "── 这个包里自带什么(装完不用再装)─────────────────────────────",
  `  · 私有 Python ${PYTHON_VERSION}(不碰你机器上的 Python)`,
  "  · PyMuPDF / Pillow / latex2mathml(文字层、图片→PDF、公式)",
  `  · pdf_tool${pdfToolDir ? "(自带快照,commit 见 pdf-tool/SOURCE.txt)" : ""}`,
  "  · FastAPI + uvicorn(服务本体)",
  "",
  "── 还需要另外装(引擎会用它们,但不随包发)──────────────────────",
  "  · DocVortex —— 文档互转(Office / OFD / HTML / EPUB)与内容提取",
  "      大小:下载约 71 MB,装完约 250 MB(onnxruntime / numpy / magika 的模型占大头)",
  "      最省事:在应用里点「装到引擎」(装进引擎自己的 components/,不碰系统 Python)",
  "      或手动:python -m pip install docvortex(装在引擎的 Python 里),或在引擎配置里填 docvortexPath",
  "      注意:不能只挑一部分装 —— 实测去掉 onnxruntime 后连 html → docx 都会失败",
  "      (DocVortex 的输入类型探测走 magika,而 magika 依赖 onnxruntime)。",
  "  · MinerU —— 公式 / 视觉提取",
  "      本地 MinerU 服务(可选组件;模型首次使用时按需下载,几百 MB ~ GB)",
  "      或在引擎配置里填云端 MinerU token",
  "",
  "── 可选组件(不装也能用其它功能)────────────────────────────────",
  "  · Calibre(ebook-convert)—— EPUB → AZW3 / MOBI(老格式);装完填 calibrePath",
  "  · boko —— EPUB → AZW3 / KFX 的轻量替代;装完填 bokoPath",
  "",
  "── 为什么这些不随包发 ──────────────────────────────────────────",
  "  DocVortex 依赖 onnxruntime 等,装进来会让包大一倍以上;MinerU 的模型是 GB 级;",
  "  Calibre / boko 是 GPL-3,按「外部程序」处理。引擎只负责调用它们。",
  "",
  "配置:~/.uvreader-engine/config.json(ENGINE_CONFIG 可改位置);pdf_tool 自带在 pdf-tool/。",
  `引擎版本:${engineVersion} · 平台:${platform} · Python:${PYTHON_VERSION}`,
].join("\n"), "utf8");

// ── 5. 打包 + sha256 ────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });
const base = `uvreader-engine-${engineVersion}-${platform}`;
const archive = path.join(outDir, platform.startsWith("win32") ? `${base}.zip` : `${base}.tar.gz`);
fs.rmSync(archive, { force: true });
if (platform.startsWith("win32")) run("tar", ["-a", "-c", "-f", archive, "-C", stage, "."]);
else run("tar", ["-czf", archive, "-C", stage, "."]);
const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`, "utf8");
console.log(`\n✓ 产物:${archive}(${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  sha256:${digest}`);
console.log(`  清单:engine.json · 许可:licenses.json`);
if (!keepStage) fs.rmSync(stage, { recursive: true, force: true });
else console.log("  舞台目录(未删):", stage);

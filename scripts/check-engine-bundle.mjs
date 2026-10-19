// 校验引擎包:清单 / 引擎代码 / 启动器 / 许可 / sha256;本机平台对得上就顺手 import 一下。
// 用法:node scripts/check-engine-bundle.mjs <dist-dir> [--platform win32-x64]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const distDir = path.resolve(args[0] || path.join("dist", "engine"));
const flagIndex = args.indexOf("--platform");
const platform = flagIndex >= 0 ? args[flagIndex + 1] : `${process.platform}-${process.arch}`;

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const archives = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter((name) => name.includes(platform) && /\.(zip|tar\.gz)$/.test(name))
  : [];
check("找到对应平台的包", archives.length === 1, archives.join(", ") || `(${distDir} 里没有 ${platform})`);
if (archives.length !== 1) process.exit(1);
const archive = path.join(distDir, archives[0]);

// sha256
const shaFile = `${archive}.sha256`;
check("有 sha256 文件", fs.existsSync(shaFile));
if (fs.existsSync(shaFile)) {
  const expected = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  check("sha256 对得上", expected === actual, `${actual.slice(0, 16)}…`);
}

// 解压
const work = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-engine-check-"));
const extracted = spawnSync("tar", ["-xf", archive, "-C", work], { encoding: "utf8", timeout: 600_000 });
check("能解压", extracted.status === 0, String(extracted.stderr || "").slice(0, 200));
if (extracted.status !== 0) process.exit(1);

const has = (rel) => fs.existsSync(path.join(work, rel));
check("有 engine.json", has("engine.json"));
const manifest = has("engine.json") ? JSON.parse(fs.readFileSync(path.join(work, "engine.json"), "utf8")) : {};
check("清单里有版本与平台", Boolean(manifest.engineVersion) && manifest.platform === platform, `${manifest.engineVersion || "?"} · ${manifest.platform || "?"}`);
check("清单里有依赖版本", Object.keys(manifest.packages || {}).length >= 5, Object.keys(manifest.packages || {}).length + " 个包");
check("引擎代码在", has("engine/__init__.py") && has("engine/server.py") && has("engine/kinds.py") && has("engine/scripts/pdf_text.py"));
check("启动器在", has("run-engine.cmd") || has("run-engine.sh"));
check("许可清单在", has("licenses.json"));
if (has("licenses.json")) {
  const licenses = JSON.parse(fs.readFileSync(path.join(work, "licenses.json"), "utf8"));
  const copyleft = licenses.filter((item) => /GPL|AGPL|LGPL/i.test(String(item.license || ""))).map((item) => `${item.name}(${item.license})`);
  check("许可清单非空", licenses.length >= 5, `${licenses.length} 个包`);
  // AGPL/GPL 只报告不拦:引擎是独立程序,和 Calibre 一样属于「外部工具」范畴。
  console.log(`  · copyleft 依赖:${copyleft.length ? copyleft.join(", ") : "无"}`);
}

// 本机平台一致时,真跑一下包里的解释器
const hostPlatform = `${process.platform}-${process.arch}`;
if (platform === hostPlatform) {
  // 依赖该在解释器自己的 site-packages 里:Windows 是 <bundle>/site-packages(._pth 指过去),
  // macOS/Linux 是 <bundle>/python/lib/python3.x/site-packages。
  const sitePackages = platform.startsWith("win32")
    ? [path.join(work, "site-packages")]
    : fs.existsSync(path.join(work, "python", "lib"))
      ? fs.readdirSync(path.join(work, "python", "lib"))
        .filter((name) => name.startsWith("python"))
        .map((name) => path.join(work, "python", "lib", name, "site-packages"))
        .filter((dir) => fs.existsSync(dir))
      : [];
  const hasFitz = sitePackages.some((dir) => fs.existsSync(path.join(dir, "fitz")) || fs.existsSync(path.join(dir, "pymupdf")));
  check("依赖落在解释器的 site-packages 里", sitePackages.length > 0 && hasFitz, sitePackages.join(", ") || "(没找到 site-packages)");

  const python = path.join(work, "python", process.platform === "win32" ? "python.exe" : path.join("bin", "python3"));
  if (fs.existsSync(python)) {
    // 引擎包在 <bundle>/engine,import engine 需要 <bundle> 在路径上(Windows 由 ._pth 提供)
    const probeEnv = { ...process.env, PYTHONPATH: work };
    const probe = spawnSync(python, ["-c", "import engine, fitz, PIL, latex2mathml, fastapi, uvicorn; print('ok')"], { encoding: "utf8", timeout: 120_000, env: probeEnv });
    // stdout 的最后一行是 ok;警告(pymupdf 的 FutureWarning 等)走 stderr,不算失败,但要打出来。
    const probeOk = String(probe.stdout || "").trim().split(/\r?\n/).pop() === "ok";
    const probeDetail = `${String(probe.stdout || "").trim().slice(-200)} ${String(probe.stderr || "").trim().slice(-300)}`.trim();
    check("包内解释器能 import 引擎与依赖", probeOk, probeDetail);
    const version = spawnSync(python, ["-m", "engine", "--version"], { encoding: "utf8", timeout: 120_000, env: probeEnv });
    check("包内能跑 python -m engine", /workshop engine/.test(String(version.stdout || version.stderr || "")), String(version.stdout || version.stderr || "").trim().slice(0, 80));
  } else {
    console.log("  · 包里没有本机解释器(跳过 import 检查)");
  }
} else {
  console.log(`  · 平台不同(${platform} ≠ ${hostPlatform}),跳过包内解释器检查`);
}

fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n✗ 校验失败 ${failed} 项` : "\n✓ 引擎包校验通过");
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// LLM 答题页实验:读取 Markdown + 固定提示词,调用 OpenAI 兼容接口,保存原始输出。
// 这个脚本只做实验采集,不把模型输出用于生产;图片/公式/判分由后续检查处理。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PROMPT_FILE = path.join(ROOT, "docs", "quiz-llm-prompt.txt");
const DEFAULT_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";

function usage() {
  console.log(`Usage:
  node scripts/quiz-llm-experiment.mjs <source.md> --id <id> [options]

Options:
  --id <id>           run id (default: basename)
  --title <title>     document title shown in prompt
  --model <model>     default ${DEFAULT_MODEL}
  --base <url>        default ${DEFAULT_BASE}
  --out <dir>         default experiments/quiz-llm/runs
  --prompt <file>     default ${PROMPT_FILE}
  --max-tokens <n>    default 100000
  --dry-run           write the prompt but do not call the API
  --all               run every source.md under experiments/quiz-llm/inputs
`);
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function readSources() {
  const inputs = path.join(ROOT, "experiments", "quiz-llm", "inputs");
  if (!fs.existsSync(inputs)) return [];
  return fs.readdirSync(inputs)
    .map((id) => path.join(inputs, id, "source.md"))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ id: path.basename(path.dirname(file)), file }));
}

function stripFence(text) {
  const value = String(text || "").trim();
  const match = /^```(?:html)?\s*\n([\s\S]*?)\n```$/i.exec(value);
  return match ? match[1].trim() : value;
}

async function main() {
  const sources = flag("all")
    ? readSources()
    : [{ id: arg("id") || path.basename(String(process.argv[2] || ""), ".md"), file: String(process.argv[2] || "") }];
  if (!sources.length || sources.some((source) => !source.file || !fs.existsSync(source.file))) {
    usage();
    process.exit(1);
  }
  const model = arg("model") || DEFAULT_MODEL;
  const base = (arg("base") || DEFAULT_BASE).replace(/\/+$/, "");
  const outRoot = path.resolve(ROOT, arg("out") || path.join("experiments", "quiz-llm", "runs"));
  const promptFile = path.resolve(ROOT, arg("prompt") || PROMPT_FILE);
  const promptTemplate = fs.readFileSync(promptFile, "utf8");
  const promptHash = crypto.createHash("sha256").update(promptTemplate).digest("hex").slice(0, 12);

  for (const source of sources) {
    const markdown = fs.readFileSync(source.file, "utf8");
    const title = arg("title") || source.id;
    const prompt = promptTemplate.replace(/\{\{TITLE\}\}/g, title).replace(/\{\{MARKDOWN\}\}/g, markdown);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(outRoot, source.id, model, stamp);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "prompt.txt"), prompt, "utf8");
    fs.writeFileSync(path.join(outDir, "source.md"), markdown, "utf8");
    fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({
      id: source.id,
      source: path.resolve(source.file),
      sourceSha256: crypto.createHash("sha256").update(markdown).digest("hex"),
      prompt: path.resolve(promptFile),
      promptSha256: promptHash,
      model,
      base,
      title,
      createdAt: new Date().toISOString(),
    }, null, 2), "utf8");
    if (flag("dry-run")) {
      console.log("dry", source.id, outDir);
      continue;
    }
    const key = String(process.env.DEEPSEEK_API_KEY || "").trim();
    if (!key) throw new Error("missing DEEPSEEK_API_KEY");
    console.log("request", source.id, model, `${Math.round(prompt.length / 1024)} KB prompt`);
    const started = Date.now();
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: Number(arg("max-tokens") || 100000),
        stream: false,
      }),
    });
    const raw = await response.text();
    fs.writeFileSync(path.join(outDir, "response.raw.txt"), raw, "utf8");
    if (!response.ok) {
      console.error("failed", source.id, response.status, raw.slice(0, 300));
      fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({
        id: source.id, source: path.resolve(source.file), promptSha256: promptHash, model, base,
        createdAt: new Date().toISOString(), error: response.status,
      }, null, 2), "utf8");
      continue;
    }
    const body = JSON.parse(raw);
    const choice = body.choices?.[0] || {};
    const content = stripFence(choice.message?.content || "");
    fs.writeFileSync(path.join(outDir, "page.html"), content, "utf8");
    const meta = {
      id: source.id,
      source: path.resolve(source.file),
      sourceSha256: crypto.createHash("sha256").update(markdown).digest("hex"),
      prompt: path.resolve(promptFile),
      promptSha256: promptHash,
      model,
      base,
      title,
      createdAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      finishReason: choice.finish_reason || "",
      usage: body.usage || {},
      outputBytes: Buffer.byteLength(content, "utf8"),
      hasDoctype: /<!doctype html/i.test(content),
      hasPaper: /id=["']paper["']/i.test(content),
      hasExternalHttp: /(?:src|href)=["']https?:/i.test(content),
    };
    fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    console.log("done", source.id, meta.finishReason, `${meta.outputBytes} bytes`, `${meta.elapsedMs} ms`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

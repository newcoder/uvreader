// 书坊的 LLM 辅助(W2-1):AI 元数据推断 / AI 封面文案。
// 走桌面壳已有的 AI 运行时(与伴读同一套供应商 / 模型 / 密钥,不新增设置项),
// 以任务队列 runner 的形式跑:进度进任务行、取消转发给 AI 运行时、失败只影响这条任务。
// 结果只作为「建议」返回(result;不落盘、不改文件),由面板显式「应用」——可选、可撤销。
import { createAiRuntime } from "./ai-runtime.js";
import fs from "node:fs";
import { applyChapterRule, collectChapterCandidates, describeChapterRule, normalizeChapterRule } from "../shared/chapter-rules.js";
import { decodeText } from "../shared/text-encoding.js";

// 提示词要求模型只吐 JSON;解析在 parseAiJson 里容错(围栏、前后废话都能剥掉)。
const JSON_RULES = "只输出一个 JSON 对象,不要解释、不要 Markdown 代码围栏。";

function trimText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// 元数据:书名 / 作者 / 语言 / 丛书 / 标签。空字段给空串(面板按「只填空的」应用)。
export function normalizeAiMetadata(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const tags = Array.isArray(data.tags)
    ? data.tags.map((tag) => trimText(tag, 24)).filter(Boolean).slice(0, 5)
    : [];
  return {
    title: trimText(data.title, 80),
    author: trimText(data.author, 60),
    language: trimText(data.language, 12).toLowerCase(),
    series: trimText(data.series, 60),
    tags,
  };
}

// 封面文案:书名 / 副标题 / 系列(与封面模板的三个文案位对应)。
export function normalizeAiCoverCopy(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  return {
    title: trimText(data.title, 80),
    subtitle: trimText(data.subtitle, 40),
    series: trimText(data.series, 60),
  };
}

export function buildMetadataMessages({ text = "", fileName = "" } = {}) {
  return [
    { role: "system", content: `你是中文图书编辑,从书稿里推断元数据。${JSON_RULES}` },
    {
      role: "user",
      content: [
        "从下面这本书的开头推断元数据。",
        "JSON 字段:title(书名,书稿里写了就用书稿的)、author(作者,没有就留空)、",
        "language(语言代码,如 zh / en)、series(丛书 / 系列,没有就留空)、tags(最多 5 个主题标签)。",
        "",
        `文件名:${fileName || "(未知)"}`,
        "书稿开头:",
        text,
      ].join("\n"),
    },
  ];
}

export function buildCoverCopyMessages({ text = "", fileName = "" } = {}) {
  return [
    { role: "system", content: `你是中文图书封面文案编辑。${JSON_RULES}` },
    {
      role: "user",
      content: [
        "为这本书的封面写文案。",
        "JSON 字段:title(封面书名,20 字以内最好)、subtitle(一句话副标题,20 字以内,要具体、说清这本书讲什么)、",
        "series(系列名,没有就留空)。",
        "不要用「一本好书」「不可错过」这类空话。",
        "",
        `文件名:${fileName || "(未知)"}`,
        "书稿开头:",
        text,
      ].join("\n"),
    },
  ];
}

// 从模型回答里抠出 JSON:剥掉代码围栏与前后废话,只取第一个成对的花括号块。
export function parseAiJson(answer) {
  let text = String(answer ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export const AI_TASK_SPECS = Object.freeze({
  "ai-metadata": Object.freeze({
    title: "AI 推断元数据",
    maxChars: 8000,
    timeoutMs: 120_000,
    messages: buildMetadataMessages,
    normalize: normalizeAiMetadata,
    summary: (data) => [data.title && `《${data.title}》`, data.author, data.language].filter(Boolean).join(" · ") || "(没有推断出书名)",
    detail: (data) => (data.tags?.length ? `标签:${data.tags.join(" / ")}` : "书名 / 作者"),
  }),
  "ai-cover-copy": Object.freeze({
    title: "AI 封面文案",
    maxChars: 8000,
    timeoutMs: 120_000,
    messages: buildCoverCopyMessages,
    normalize: normalizeAiCoverCopy,
    summary: (data) => [data.title && `《${data.title}》`, data.subtitle].filter(Boolean).join(" · ") || "(没有给出文案)",
    detail: (data) => (data.series ? `系列:${data.series}` : "封面书名 / 副标题"),
  }),
});

// 面板传来的配置就是伴读那份(见 ai-pi.js 的 runtimeConfig):这里只做白名单拷贝,
// 免得把设置里的别的字段带进运行时。
export function normalizeAiConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(config.id || ""),
    name: String(config.name || config.id || ""),
    base: String(config.base || ""),
    model: String(config.model || ""),
    thinking: config.thinking === true,
    supportsThinking: config.supportsThinking === true,
    compat: config.compat && typeof config.compat === "object" ? config.compat : null,
    key: String(config.key || ""),
    needsKey: config.needsKey === true,
  };
}

export function aiFailureText(result = {}) {
  const reason = String(result?.reason || "");
  if (reason === "cancelled") return "已取消";
  if (reason === "nokey") return "AI 还没有密钥:在「设置 → AI 助读」里填好密钥";
  if (reason === "notconfigured") return "AI 还没配置好:先在「设置 → AI 助读」里选供应商与模型";
  const message = String(result?.message || reason || "").trim();
  return `AI 请求失败${message ? `:${message.slice(0, 160)}` : ""}`;
}

export function createAiRunner({ aiRuntime = createAiRuntime(), log = () => {} } = {}) {
  return async function runAiTask(kind, { payload = {}, report = () => {}, signal } = {}) {
    const spec = AI_TASK_SPECS[String(kind || "")];
    if (!spec) throw new Error(`未知的 AI 任务:${kind || "(空)"}`);
    const config = normalizeAiConfig(payload.config);
    if (!config.id || !config.base || !config.model) {
      throw new Error("AI 还没配置好:先在「设置 → AI 助读」里选供应商与模型");
    }
    const text = String(payload.text || "").slice(0, spec.maxChars);
    if (text.trim().length < 20) {
      throw new Error("没有可用的正文:PDF / Office 书稿请先跑一次「内容提取」,或直接选 txt / Markdown 书稿");
    }
    const requestId = `workshop-ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // 取消:任务被取消时把 abort 转发给 AI 运行时(与伴读同一个请求表)。
    // 进来时就已经取消(排队期间被点掉)的,不发请求。
    if (signal?.aborted) throw new Error("已取消");
    const onAbort = () => aiRuntime.abort(requestId);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    report({ label: "AI 请求中…" });
    let result;
    try {
      result = await aiRuntime.stream({
        requestId,
        config,
        messages: spec.messages({ text, fileName: String(payload.fileName || "") }),
        options: { timeoutMs: spec.timeoutMs },
      });
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
    if (!result?.ok) throw new Error(aiFailureText(result));
    const parsed = parseAiJson(result.answer);
    if (!parsed) throw new Error("AI 返回的不是可用的 JSON(可以重试一次)");
    const data = spec.normalize(parsed);
    log("[workshop-ai]", kind, spec.summary(data));
    return { output: spec.summary(data), detail: spec.detail(data), result: data };
  };
}

export function registerAiRunners(workshop, { aiRuntime = createAiRuntime(), vaultRoot = "", log = () => {} } = {}) {
  const run = createAiRunner({ aiRuntime, log });
  const disposers = Object.keys(AI_TASK_SPECS).map((kind) => workshop.register(kind, (request) => run(kind, request)));
  // AI 分章建议:读源文件、抽候选行,让模型归纳**规则**,本地套回全书并验证(见 shared/chapter-rules.js)。
  const chapters = createChapterRunner({ aiRuntime, readSource: createSourceReader({ vaultRoot }), log });
  disposers.push(workshop.register("ai-chapters", (request) => chapters(request)));
  return () => disposers.forEach((dispose) => dispose());
}

// ── AI 分章建议(ai-chapters)────────────────────────────────────────────
// 整本 15MB 的书不可能喂给模型,所以:本地抽「像标题的行」→ 模型只回答规则(封闭集合)→
// 本地套用 + 验证 → 只回传规则与预览(章数 / 前几个 / 末几个标题),正文不进结果。

// 主进程读书稿:txt / md 直接读(按编码解码);PDF / Office 读同目录「内容提取」的 md 产物。
// 书库里的书稿给的是相对路径,这里用 vaultRoot 补成绝对路径。
export function createSourceReader({ fsImpl = fs, vaultRoot = "" } = {}) {
  const resolvePath = (source) => {
    const value = String(source || "").replace(/\\/g, "/");
    if (!value || /^[a-zA-Z]:\//.test(value) || value.startsWith("//")) return value;
    const root = String(vaultRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return root ? `${root}/${value}` : value;
  };
  return async function readSource(source) {
    const target = resolvePath(source);
    if (!target) return "";
    if (/\.(txt|md|markdown)$/i.test(target)) {
      try { return decodeText(fsImpl.readFileSync(target)); } catch { return ""; }
    }
    const sibling = target.replace(/\.[^./\\]+$/, ".md");
    try { return fsImpl.existsSync(sibling) ? decodeText(fsImpl.readFileSync(sibling)) : ""; } catch { return ""; }
  };
}

// 判断风格用的正文片段:开头 + 中间 + 结尾各取一段(卷首说明/目录页常在开头,单看开头会误判)。
export function sourceSample(text, { head = 700, mid = 400, tail = 400 } = {}) {
  const value = String(text ?? "");
  if (value.length <= head + mid + tail) return value;
  const middle = Math.floor(value.length / 2);
  return [value.slice(0, head), value.slice(middle, middle + mid), value.slice(-tail)].join("\n…\n");
}

export function buildChapterMessages({ candidates = [], total = 0, truncated = false, sample = "", fileName = "" } = {}) {
  const list = candidates.map((item) => `${item.no}\t${item.text}`).join("\n");
  return [
    { role: "system", content: `你是中文图书编辑,判断一本 TXT 书的章节标题形态。${JSON_RULES}` },
    {
      role: "user",
      content: [
        "下面是从这本书里抽出来的「像标题的行」(行号 + 原文;整行、独立成段、不超过 40 字)。",
        truncated ? `共 ${total} 行,这里是均匀采样。` : `共 ${total} 行,全部列出。`,
        "请判断这本书的章节标题长什么样,只输出 JSON:",
        '{"kind":"numbered|prefixed","number":"arabic|chinese|padded","prefix":"","suffix":"","separator":"","accept":[行号],"note":"一句话"}',
        "- kind=numbered:标题是「编号 + 分隔符 + 名字」(如 12 起风 / 1. 拜师);separator 写实际用的字符(空格就写一个空格)",
        "- kind=prefixed:标题是「前缀 + 编号 + 后缀 + 名字」(如 第12章 起风:prefix=第、suffix=章;Chapter 3 The Return:prefix=Chapter、suffix 留空)",
        "- number:编号是阿拉伯数字 / 中文数字 / 补零数字",
        "- accept:清单里你判断确实是章节标题的行号(交叉验证用)",
        "- 如果这些行都不是章节标题,kind 给空字符串",
        "",
        `文件名:${fileName || "(未知)"}`,
        "正文片段(判断风格用,可能包含卷首说明或目录页):",
        sample,
        "",
        "候选行:",
        list,
      ].join("\n"),
    },
  ];
}

export function createChapterRunner({ aiRuntime = createAiRuntime(), readSource = createSourceReader(), log = () => {} } = {}) {
  return async function runChapterTask({ payload = {}, report = () => {}, signal } = {}) {
    const config = normalizeAiConfig(payload.config);
    if (!config.id || !config.base || !config.model) {
      throw new Error("AI 还没配置好:先在「设置 → AI 助读」里选供应商与模型");
    }
    const source = String(payload.source || "");
    if (!source) throw new Error("没有书稿:先选一份书稿");
    report({ label: "读书稿…" });
    const text = await readSource(source);
    if (!text || text.trim().length < 200) {
      throw new Error("读不到书稿正文:PDF / Office 请先跑一次「内容提取」,或直接选 txt / Markdown");
    }
    const candidates = collectChapterCandidates(text);
    if (candidates.total < 2) throw new Error("这本书里没找到像章节标题的行");
    report({ label: "AI 判断章名形态…" });
    if (signal?.aborted) throw new Error("已取消");
    const requestId = `workshop-ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const onAbort = () => aiRuntime.abort(requestId);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    let result;
    try {
      result = await aiRuntime.stream({
        requestId,
        config,
        messages: buildChapterMessages({
          candidates: candidates.lines,
          total: candidates.total,
          truncated: candidates.truncated,
          sample: sourceSample(text),
          fileName: String(payload.fileName || ""),
        }),
        options: { timeoutMs: 120_000 },
      });
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
    if (!result?.ok) throw new Error(aiFailureText(result));
    const parsed = parseAiJson(result.answer);
    const rule = normalizeChapterRule(parsed);
    if (!rule) throw new Error("AI 没给出可用的章名规则(可以重试一次)");
    report({ label: "按规则切章…" });
    const applied = applyChapterRule(text, rule);
    if (applied.error) throw new Error(`按 AI 给的规则切不出章节:${applied.error}`);
    const shape = describeChapterRule(rule);
    log("[workshop-ai] ai-chapters", applied.count, shape);
    return {
      output: `${applied.count} 章 · ${shape}`,
      detail: `${applied.first[0] || ""} … ${applied.last[applied.last.length - 1] || ""}`,
      result: {
        rule,
        count: applied.count,
        first: applied.first,
        last: applied.last,
        candidates: candidates.total,
        truncated: candidates.truncated,
      },
    };
  };
}

// DeepSeek web tools (Search + Fetch) for the AI companion.
//
// These are raw JSON APIs, not the provider-native server tools: they work with
// any chat model and can coexist with the reader's local tools. The API key is
// passed in from the renderer (SecretStorage); this module never persists it.
import { performance } from "node:perf_hooks";

const DEFAULT_BASE = "https://api.deepseek.com";
const SEARCH_TTL_MS = 5 * 60 * 1000;
const FETCH_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const searchCache = new Map();
const fetchCache = new Map();

export class WebSearchError extends Error {
  constructor(message, { code = "web", status = 0, cause = null } = {}) {
    super(String(message || "联网搜索失败"));
    this.name = "WebSearchError";
    this.code = code;
    this.status = Number(status) || 0;
    if (cause) this.cause = cause;
  }
}

function normalizeBase(value) {
  let base = String(value || "").trim().replace(/\/+$/, "");
  if (!base) base = DEFAULT_BASE;
  if (!/^https?:\/\//i.test(base)) throw new WebSearchError("搜索服务地址必须是 HTTP/HTTPS URL", { code: "base" });
  if (/\/v1$/i.test(base)) base = base.slice(0, -3);
  return base;
}

function endpoint(base, path) {
  return `${normalizeBase(base)}${path}`;
}

function boundedCount(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 5;
  return Math.max(1, Math.min(10, number));
}

function cacheGet(cache, key, ttl, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(cache, key, value, now) {
  cache.set(key, { at: now, value });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

function errorCodeForStatus(status) {
  if (status === 401) return "auth";
  if (status === 402) return "balance";
  if (status === 403) return "forbidden";
  if (status === 404) return "notfound";
  if (status === 408) return "timeout";
  if (status === 429) return "limit";
  if (status >= 500) return "server";
  return "http";
}

async function requestJson(url, { apiKey, body, fetchImpl, signal, timeoutMs }) {
  const key = String(apiKey || "").trim();
  if (!key) throw new WebSearchError("还没有配置 DeepSeek Search Key", { code: "nokey" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const message = data?.error?.message || `联网搜索服务返回 ${response.status}`;
      throw new WebSearchError(message, {
        code: errorCodeForStatus(response.status),
        status: response.status,
      });
    }
    return data && typeof data === "object" ? data : {};
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    if (controller.signal.aborted) {
      throw new WebSearchError(signal?.aborted ? "联网搜索已取消" : "联网搜索超时", {
        code: signal?.aborted ? "cancelled" : "timeout",
        cause: error,
      });
    }
    throw new WebSearchError(String(error?.message || error), { code: "network", cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function normalizeResult(item, index) {
  if (!item || typeof item !== "object") return null;
  const url = String(item.url || "").trim();
  if (!url) return null;
  return {
    rank: index + 1,
    title: String(item.title || url).trim(),
    url,
    snippet: String(item.snippet || "").trim(),
    summary: String(item.summary || "").trim(),
    content: String(item.content || "").trim(),
    siteName: String(item.site_name || "").trim(),
    date: String(item.date || "").trim(),
    authority: Number.isFinite(Number(item.authority)) ? Number(item.authority) : -1,
    score: Number.isFinite(Number(item.rerank_score)) ? Number(item.rerank_score) : null,
  };
}

export async function deepseekSearch({
  apiKey = "",
  base = DEFAULT_BASE,
  query = "",
  count = 5,
  oriQuestion = "",
  needContent = false,
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
} = {}) {
  const text = String(query || "").trim();
  if (!text) throw new WebSearchError("请提供搜索关键词", { code: "query" });
  const key = String(apiKey || "").trim();
  if (!key) throw new WebSearchError("还没有配置 DeepSeek Search Key", { code: "nokey" });
  if (typeof fetchImpl !== "function") throw new WebSearchError("当前环境不支持联网搜索", { code: "fetch" });
  const safeCount = boundedCount(count);
  const question = String(oriQuestion || "").trim().slice(0, 128);
  const cacheKey = [
    normalizeBase(base),
    text,
    safeCount,
    question,
    needContent ? "content" : "summary",
  ].join("|");
  const cached = cacheGet(searchCache, cacheKey, SEARCH_TTL_MS, now);
  if (cached) return { ...cached, cached: true };

  const data = await requestJson(endpoint(base, "/v1/tools/search"), {
    apiKey: key,
    fetchImpl,
    signal,
    timeoutMs,
    body: {
      query: text,
      count: safeCount,
      ...(question ? { ori_question: question } : {}),
      need_content: needContent === true,
    },
  });
  const results = (Array.isArray(data.results) ? data.results : [])
    .map(normalizeResult)
    .filter(Boolean);
  const value = {
    ok: true,
    query: text,
    count: results.length,
    results,
    cached: false,
  };
  cacheSet(searchCache, cacheKey, value, now);
  return value;
}

export async function deepseekFetch({
  apiKey = "",
  base = DEFAULT_BASE,
  url = "",
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
} = {}) {
  const target = String(url || "").trim();
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new WebSearchError("网页地址无效", { code: "url" });
  }
  if (!/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new WebSearchError("只能读取公开的 HTTP/HTTPS 网页", { code: "url" });
  }
  const key = String(apiKey || "").trim();
  if (!key) throw new WebSearchError("还没有配置 DeepSeek Search Key", { code: "nokey" });
  if (typeof fetchImpl !== "function") throw new WebSearchError("当前环境不支持网页抓取", { code: "fetch" });
  const cacheKey = `${normalizeBase(base)}|${parsed.toString()}`;
  const cached = cacheGet(fetchCache, cacheKey, FETCH_TTL_MS, now);
  if (cached) return { ...cached, cached: true };

  const data = await requestJson(endpoint(base, "/v1/tools/fetch"), {
    apiKey: key,
    fetchImpl,
    signal,
    timeoutMs,
    body: { url: parsed.toString() },
  });
  const value = {
    ok: true,
    url: parsed.toString(),
    title: String(data.title || "").trim(),
    content: String(data.content || ""),
    cached: false,
  };
  cacheSet(fetchCache, cacheKey, value, now);
  return value;
}

export function clearWebSearchCache() {
  searchCache.clear();
  fetchCache.clear();
}

export function webSearchTiming(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

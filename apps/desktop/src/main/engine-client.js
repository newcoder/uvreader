// 书坊引擎的客户端:应用只通过 HTTP 与引擎说话(界面与功能解耦,见 docs/workshop-engine-plan.md)。
// 默认 http://127.0.0.1:8760;令牌可选(引擎侧设了才要),由设置里的 engineToken 传入。
export const DEFAULT_ENGINE_URL = "http://127.0.0.1:8760";

export function normalizeEngineUrl(value) {
  const raw = String(value || "").trim() || DEFAULT_ENGINE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

// 状态行文案:/v1/health 的返回 → 一句话(应用各处共用)。
export function describeEngineHealth(health = {}) {
  const version = String(health.engineVersion || "").trim() || "未知版本";
  const capabilities = health.capabilities || {};
  const labels = {
    pdfTool: "pdf_tool",
    docvortex: "DocVortex",
    mineruLocal: "本地 MinerU",
    calibre: "Calibre",
    boko: "boko",
  };
  const ready = Object.entries(labels)
    .filter(([key]) => capabilities[key] === true)
    .map(([, label]) => label);
  const kinds = Array.isArray(capabilities.jobKinds) ? capabilities.jobKinds.length : 0;
  return `引擎 ${version}${ready.length ? ` · ${ready.join(" / ")}` : ""}${kinds ? ` · ${kinds} 类作业` : ""}`;
}

export function createEngineClient({ fetchImpl = (...args) => fetch(...args), timeoutMs = 8000 } = {}) {
  async function call(settings, path, { method = "GET", body = null, timeout = timeoutMs } = {}) {
    const base = normalizeEngineUrl(settings?.engineUrl);
    const token = String(settings?.engineToken || "").trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeout) || timeoutMs));
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!response.ok) {
        const detail = String(data?.detail || data?.error || text || "").slice(0, 200);
        return { ok: false, status: response.status, error: detail || `HTTP ${response.status}` };
      }
      return { ok: true, status: response.status, data };
    } catch (error) {
      const aborted = error?.name === "AbortError";
      return { ok: false, status: 0, error: aborted ? "连接超时" : String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // 能力探测(设置页「检测」与各处可用性判断共用)。
    health: (settings = {}) => call(settings, "/v1/health"),
    // 作业:提交 → 轮询 → 取结果 / 取消(与应用任务队列语义对齐)。
    submit: (settings, kind, args = {}) => call(settings, "/v1/jobs", { method: "POST", body: { kind, args } }),
    status: (settings, jobId) => call(settings, `/v1/jobs/${encodeURIComponent(String(jobId || ""))}`),
    result: (settings, jobId) => call(settings, `/v1/jobs/${encodeURIComponent(String(jobId || ""))}/result`),
    cancel: (settings, jobId) => call(settings, `/v1/jobs/${encodeURIComponent(String(jobId || ""))}`, { method: "DELETE" }),
    // 轻量同步接口。
    math: (settings, latex = []) => call(settings, "/v1/math", { method: "POST", body: { latex } }),
  };
}

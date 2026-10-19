// 书坊引擎的客户端:应用只通过 HTTP 与引擎说话(界面与功能解耦,见 docs/workshop-engine-plan.md)。
// 默认 http://127.0.0.1:8760;令牌可选(引擎侧设了才要),由设置里的 engineToken 传入。
export const DEFAULT_ENGINE_URL = "http://127.0.0.1:8760";

export function normalizeEngineUrl(value) {
  const raw = String(value || "").trim() || DEFAULT_ENGINE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

// 状态行文案:/v1/health 的返回 → 一句话(应用各处共用)。
// 能力项是 { ok, detail }(引擎自己探出来的);jobKinds 说明引擎能跑哪些作业。
export function describeEngineHealth(health = {}) {
  const version = String(health.engineVersion || "").trim() || "未知版本";
  const capabilities = health.capabilities || {};
  const labels = {
    pdfTool: "pdf_tool",
    docvortex: "DocVortex",
    mineru: "MinerU",
    calibre: "Calibre",
    boko: "boko",
  };
  const ready = Object.entries(labels)
    .filter(([key]) => capabilities[key]?.ok === true)
    .map(([, label]) => label);
  const kinds = Array.isArray(capabilities.jobKinds) ? capabilities.jobKinds.length : 0;
  return `引擎 ${version}${ready.length ? ` · ${ready.join(" / ")}` : ""}${kinds ? ` · ${kinds} 类作业` : ""}`;
}

// 设置页的能力清单:按「先内置、后外部」排序,给 { label, ok, detail }。
export function engineCapabilityRows(health = {}) {
  const capabilities = health?.capabilities || {};
  const order = ["python", "pymupdf", "pillow", "latex2mathml", "pdfTool", "docvortex", "mineru", "calibre", "boko"];
  const labels = {
    python: "Python",
    pymupdf: "PyMuPDF(文字层 / 文本型提取)",
    pillow: "Pillow(图片 → PDF)",
    latex2mathml: "latex2mathml(公式)",
    pdfTool: "pdf_tool(PDF → Doc JSON)",
    docvortex: "DocVortex(文档互转)",
    mineru: "MinerU(OCR / 公式)",
    calibre: "Calibre(EPUB → MOBI)",
    boko: "boko(EPUB → AZW3 / KFX)",
  };
  return order
    .filter((key) => capabilities[key])
    .map((key) => ({
      key,
      label: labels[key] || key,
      ok: capabilities[key]?.ok === true,
      detail: String(capabilities[key]?.detail || ""),
    }));
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
    // 能力探测(设置页「检测」与各处可用性判断共用);refresh 强制重探。
    health: (settings = {}, { refresh = false } = {}) => call(settings, `/v1/health${refresh ? "?refresh=1" : ""}`),
    // 引擎自己的配置(路径 / 凭据 / 并发):配置的单一来源在引擎,应用只做 UI。
    config: (settings = {}) => call(settings, "/v1/config"),
    saveConfig: (settings = {}, patch = {}) => call(settings, "/v1/config", { method: "PATCH", body: { patch } }),
    // 作业:提交 → 轮询 → 取结果 / 取消(与应用任务队列语义对齐)。
    submit: (settings, kind, args = {}) => call(settings, "/v1/jobs", { method: "POST", body: { kind, args } }),
    status: (settings, jobId) => call(settings, `/v1/jobs/${encodeURIComponent(String(jobId || ""))}`),
    result: (settings, jobId) => call(settings, `/v1/jobs/${encodeURIComponent(String(jobId || ""))}/result`),
    cancel: (settings, jobId) => call(settings, `/v1/jobs/${encodeURIComponent(String(jobId || ""))}`, { method: "DELETE" }),
    // 轻量同步接口。
    math: (settings, latex = []) => call(settings, "/v1/math", { method: "POST", body: { latex } }),
    // 跑一个作业并等到结束:提交 → 轮询(进度回调)→ 取结果;取消/超时都会尽力取消作业。
    // 应用侧所有「优先走引擎、失败回退本机」的链路都用这一个入口。
    async runJob(settings, kind, args = {}, { onProgress = () => {}, signal = null, intervalMs = 500, timeoutMs = 30 * 60_000 } = {}) {
      const submitted = await this.submit(settings, kind, args);
      if (!submitted.ok) return { ok: false, error: submitted.error };
      const jobId = String(submitted.data?.jobId || "");
      if (!jobId) return { ok: false, error: "引擎没有返回 jobId" };
      const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 0);
      for (;;) {
        if (signal?.aborted) {
          await this.cancel(settings, jobId);
          return { ok: false, cancelled: true, error: "已取消" };
        }
        const status = await this.status(settings, jobId);
        if (!status.ok) return { ok: false, error: status.error };
        const data = status.data || {};
        onProgress({ status: data.status, done: data.done, total: data.total, label: data.label });
        if (data.status === "done" || data.status === "failed" || data.status === "cancelled") {
          if (data.status !== "done") {
            return { ok: false, cancelled: data.status === "cancelled", error: data.error || `作业${data.status === "cancelled" ? "已取消" : "失败"}` };
          }
          const result = await this.result(settings, jobId);
          if (!result.ok) return { ok: false, error: result.error };
          return { ok: true, result: result.data?.result ?? null };
        }
        if (Date.now() > deadline) {
          await this.cancel(settings, jobId);
          return { ok: false, error: "引擎作业超时" };
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };
}

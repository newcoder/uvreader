// 引擎的「自动接线」:应用已经知道的本机东西,顺手写进引擎配置,省得用户两头填。
//
// 现在同步三项(都**只在引擎侧为空时写**,绝不覆盖用户填的):
// - `mineruLocalUrl`:本机有活着的本地 MinerU 服务时;
// - `mineruLocalExe`:能找到 mineru-kit(引擎的 pdf_tool helper 靠它对 venv);
// - `mineruToken`:云端凭据 —— **只发给本机引擎**(127.0.0.1 / localhost),不把凭据发到别的机器。
// 本机服务不活就不写 URL,避免把一个死地址写进引擎、回头任务全超时。
export async function syncLocalMineru({ settings = {}, engine, resolveBackend, resolveKit, log = () => {} } = {}) {
  if (!engine?.saveConfig || !engine?.config) return null;
  const config = await Promise.resolve()
    .then(() => engine.config(settings))
    .then((result) => (result?.ok ? (result.data?.config || {}) : null))
    .catch(() => null);
  if (!config) return null;

  const patch = {};
  const backend = await Promise.resolve()
    .then(() => resolveBackend?.(settings))
    .catch(() => null);
  const url = String(backend?.url || "").trim(); // resolveLocalBackend 只给探测过、活着的地址
  if (url && !String(config.mineruLocalUrl || "").trim()) patch.mineruLocalUrl = url;

  const exe = typeof resolveKit === "function" ? String(resolveKit(settings) || "").trim() : "";
  if (exe && !String(config.mineruLocalExe || "").trim()) patch.mineruLocalExe = exe;

  const engineUrl = String(settings.engineUrl || "").trim();
  const loopback = !engineUrl || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(engineUrl);
  const token = String(settings.mineruToken || "").trim();
  if (token && loopback && config.hasMineruToken !== true) patch.mineruToken = token;

  if (!Object.keys(patch).length) return null;
  const saved = await Promise.resolve()
    .then(() => engine.saveConfig(settings, patch))
    .catch(() => null);
  if (!saved?.ok) return null;
  log("[engine] local MinerU synced to the engine:", Object.keys(patch).join(", "));
  return { patch, capabilities: saved.data?.capabilities || null };
}

// 引擎的「自动接线」:应用已经知道的本机东西,顺手写进引擎配置,省得用户两头填。
//
// 目前只有一条:本机有**活着的**本地 MinerU 服务时,把地址写进引擎配置。
// 两条护栏:① 引擎自己已经配了地址就不动(不覆盖用户填的);② 本机服务不活就不写
// (免得把一个死地址写进引擎,回头任务全超时)。
export async function syncLocalMineruAddress({ settings = {}, engine, resolveBackend, log = () => {} } = {}) {
  if (!engine?.saveConfig || typeof resolveBackend !== "function") return null;
  const backend = await Promise.resolve()
    .then(() => resolveBackend(settings))
    .catch(() => null);
  const url = String(backend?.url || "").trim();
  if (!url) return null; // resolveLocalBackend 只给「探测过、活着」的地址
  const saved = await Promise.resolve()
    .then(() => engine.saveConfig(settings, { mineruLocalUrl: url }))
    .catch(() => null);
  if (!saved?.ok) return null;
  log("[engine] local MinerU address synced to the engine", url);
  return { url, capabilities: saved.data?.capabilities || null };
}

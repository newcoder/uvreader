import test from "node:test";
import assert from "node:assert/strict";

import { syncLocalMineru } from "../src/main/engine-wiring.js";

const engineWith = ({ config = {}, saveOk = true } = {}) => {
  const calls = { config: 0, saved: [] };
  return {
    calls,
    config: async () => {
      calls.config += 1;
      return { ok: true, data: { config } };
    },
    saveConfig: async (settings, patch) => {
      calls.saved.push({ settings, patch });
      return saveOk ? { ok: true, data: { capabilities: { mineru: { ok: true } } } } : { ok: false, error: "引擎拒绝了" };
    },
  };
};

test("syncLocalMineru fills the empty MinerU fields the app already knows", async () => {
  const engine = engineWith({ config: { mineruLocalUrl: "", mineruLocalExe: "", hasMineruToken: false } });
  const synced = await syncLocalMineru({
    settings: { engineUrl: "http://127.0.0.1:8760", engineToken: "t", mineruToken: "cloud-token" },
    engine,
    resolveBackend: async () => ({ url: "http://127.0.0.1:8123" }),
    resolveKit: () => "C:/mineru_env/Scripts/mineru-kit.exe",
  });
  assert.deepEqual(synced.patch, {
    mineruLocalUrl: "http://127.0.0.1:8123",
    mineruLocalExe: "C:/mineru_env/Scripts/mineru-kit.exe",
    mineruToken: "cloud-token",
  });
  assert.equal(engine.calls.saved.length, 1);
  assert.equal(engine.calls.saved[0].patch.mineruToken, "cloud-token");
  assert.equal(synced.capabilities.mineru.ok, true, "把写完之后的能力带回去,面板不用再探一次");
});

test("syncLocalMineru never overwrites what the engine already has", async () => {
  const engine = engineWith({
    config: { mineruLocalUrl: "http://10.0.0.9:8123", mineruLocalExe: "C:/other/mineru-kit.exe", hasMineruToken: true },
  });
  const synced = await syncLocalMineru({
    settings: { engineUrl: "http://127.0.0.1:8760", mineruToken: "cloud-token" },
    engine,
    resolveBackend: async () => ({ url: "http://127.0.0.1:8123" }),
    resolveKit: () => "C:/mineru_env/Scripts/mineru-kit.exe",
  });
  assert.equal(synced, null, "三项都已有值 → 什么都不写");
  assert.equal(engine.calls.saved.length, 0);
});

test("syncLocalMineru skips a dead local service but still fills the other two", async () => {
  const engine = engineWith({ config: { mineruLocalUrl: "" } });
  const synced = await syncLocalMineru({
    settings: { engineUrl: "http://127.0.0.1:8760", mineruToken: "cloud-token" },
    engine,
    // resolveLocalBackend 只给探测过、活着的地址:没有就说明本机服务没在跑。
    resolveBackend: async () => ({ url: "", exe: "C:/mineru_env/Scripts/mineru-kit.exe" }),
    resolveKit: () => "C:/mineru_env/Scripts/mineru-kit.exe",
  });
  assert.equal(synced.patch.mineruLocalUrl, undefined, "不把死地址写进引擎");
  assert.equal(synced.patch.mineruLocalExe, "C:/mineru_env/Scripts/mineru-kit.exe");
});

test("syncLocalMineru never sends the cloud token to a non-loopback engine", async () => {
  const engine = engineWith({ config: { mineruLocalUrl: "" } });
  const synced = await syncLocalMineru({
    settings: { engineUrl: "http://192.168.1.5:8760", mineruToken: "cloud-token" },
    engine,
    resolveBackend: async () => ({ url: "http://127.0.0.1:8123" }),
    resolveKit: () => "",
  });
  assert.equal(synced.patch.mineruLocalUrl, "http://127.0.0.1:8123");
  assert.equal(synced.patch.mineruToken, undefined, "凭据只发给本机引擎,不发到别的机器");
});

test("syncLocalMineru never throws on a failing save or a broken resolver", async () => {
  assert.equal(await syncLocalMineru({
    settings: { mineruToken: "x" },
    engine: engineWith({ config: { mineruLocalUrl: "" }, saveOk: false }),
    resolveBackend: async () => ({ url: "http://127.0.0.1:8123" }),
  }), null);
  assert.equal(await syncLocalMineru({
    settings: { engineUrl: "http://127.0.0.1:8760" },
    engine: engineWith({ config: {} }),
    resolveBackend: async () => { throw new Error("boom"); },
    resolveKit: () => "",
  }), null);
  assert.equal(await syncLocalMineru({}), null, "没给引擎客户端就什么都不做");
});

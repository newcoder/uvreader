import test from "node:test";
import assert from "node:assert/strict";

import { syncLocalMineruAddress } from "../src/main/engine-wiring.js";

test("syncLocalMineruAddress writes a live local MinerU address into the engine config", async () => {
  const saved = [];
  const result = await syncLocalMineruAddress({
    settings: { engineUrl: "http://127.0.0.1:8760", engineToken: "t" },
    engine: {
      saveConfig: async (settings, patch) => {
        saved.push({ settings, patch });
        return { ok: true, data: { capabilities: { mineru: { ok: true, detail: "本地服务在跑" } } } };
      },
    },
    resolveBackend: async () => ({ url: "http://127.0.0.1:8123", exe: "C:/mineru-kit.exe" }),
  });
  assert.equal(result.url, "http://127.0.0.1:8123");
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].patch, { mineruLocalUrl: "http://127.0.0.1:8123" });
  assert.equal(saved[0].settings.engineToken, "t", "写引擎配置要带同一份设置(地址 + 令牌)");
  assert.equal(result.capabilities.mineru.ok, true, "把写完之后的能力带回去,面板不用再探一次");
});

test("syncLocalMineruAddress stays out of the way when there is no live service", async () => {
  let calls = 0;
  const result = await syncLocalMineruAddress({
    engine: { saveConfig: async () => { calls += 1; return { ok: true }; } },
    // resolveLocalBackend 只给探测过、活着的地址:没有就说明本机没有可用的本地 MinerU。
    resolveBackend: async () => ({ url: "", exe: "C:/mineru-kit.exe" }),
  });
  assert.equal(result, null);
  assert.equal(calls, 0, "没有活着的本地服务就不该写引擎配置");
});

test("syncLocalMineruAddress never throws on a failing save or a broken backend", async () => {
  const failingSave = await syncLocalMineruAddress({
    engine: { saveConfig: async () => ({ ok: false, error: "引擎拒绝了" }) },
    resolveBackend: async () => ({ url: "http://127.0.0.1:8123" }),
  });
  assert.equal(failingSave, null);
  const throwing = await syncLocalMineruAddress({
    engine: { saveConfig: async () => ({ ok: true }) },
    resolveBackend: async () => { throw new Error("boom"); },
  });
  assert.equal(throwing, null);
  assert.equal(await syncLocalMineruAddress({}), null, "没给引擎客户端就什么都不做");
});

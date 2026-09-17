// Host services are injected by the desktop shell (or by tests) so every shim
// module stays free of static Node imports and can run in Node, jsdom or the
// Electron renderer.
const runtime = {
  fs: null,
  path: null,
  os: null,
  vaultRoot: "",
  dataRoot: "",
  vaultName: "Qiaomu Library",
  isMobile: false,
  fetchImpl: null,
  iconResolver: null,
  renderMarkdown: null,
  secrets: null,
  shell: null,
};

export function configureHost(patch = {}) {
  Object.assign(runtime, patch);
  return runtime;
}

export function host() {
  return runtime;
}

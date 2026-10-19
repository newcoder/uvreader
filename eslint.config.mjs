// The Obsidian plugin shell is gone, so the lint setup is now a small flat
// config: reader sources keep browser globals and must not import node
// builtins; tests and scripts run in Node.
const NODE_BUILTINS = [
  "assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https",
  "net", "os", "path", "process", "querystring", "stream", "string_decoder",
  "tls", "url", "util", "worker_threads", "zlib",
];

export default [
  {
    ignores: ["pdf.worker.js", "node_modules/**", "promo-video/**", "apps/desktop/dist/**"],
  },
  {
    files: ["packages/reader/src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Replaced at build time by esbuild's `define` with the pdf.js worker
        // source, so it never exists as a variable in the shipped file.
        __PDF_WORKER_CODE__: "readonly",
        __QBR_ENGINE_VIEW_TAG__: "readonly",
        // CSS Custom Highlight API, used for the in-book search paint.
        Highlight: "readonly",
        CSS: "readonly",
        AbortController: "readonly",
        atob: "readonly",
        btoa: "readonly",
        navigator: "readonly",
        File: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        ReadableStream: "readonly",
        MutationObserver: "readonly",
        Option: "readonly",
        queueMicrotask: "readonly",
        // Provided by the desktop host at runtime rather than imported.
        activeDocument: "readonly",
        activeWindow: "readonly",
        document: "readonly",
        window: "readonly",
        globalThis: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        DOMParser: "readonly",
        FileReader: "readonly",
        Node: "readonly",
        NodeFilter: "readonly",
        HTMLElement: "readonly",
        Event: "readonly",
        ResizeObserver: "readonly",
        performance: "readonly",
        fetch: "readonly",
        Blob: "readonly",
        Response: "readonly",
        DecompressionStream: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "error",
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true, caughtErrors: "none" }],
      "no-restricted-imports": ["error", { paths: NODE_BUILTINS.map((name) => ({ name, message: "Reader sources must stay host-agnostic; use the host ports instead." })) }],
    },
  },
  {
    // 主进程 / preload / shared 是「会真的在 Node 里跑」的代码:开 no-undef,
    // 免得再出现引用不存在的变量(2026-10-19 的 `log is not defined` 就是这么漏掉的)。
    files: ["apps/desktop/src/main/**/*.js", "apps/desktop/src/preload/**/*.js", "apps/desktop/src/shared/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        setImmediate: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        queueMicrotask: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
        structuredClone: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        __dirname: "readonly",
        // preload 跑在渲染进程的隔离世界里:window 是它的宿主(不是 Node 全局)。
        window: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
  {
    files: ["tests/**/*.mjs", "scripts/**/*.mjs", "packages/host-shim/**/*.js", "packages/host-shim/**/*.mjs", "apps/desktop/**/*.js", "apps/desktop/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { setImmediate: "readonly", process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", __dirname: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true, caughtErrors: "none" }],
    },
  },
];

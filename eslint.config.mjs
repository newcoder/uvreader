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
        URL: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "error",
      "no-restricted-imports": ["error", { paths: NODE_BUILTINS.map((name) => ({ name, message: "Reader sources must stay host-agnostic; use the host ports instead." })) }],
    },
  },
  {
    files: ["tests/**/*.mjs", "scripts/**/*.mjs", "packages/host-shim/**/*.mjs", "apps/desktop/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { setImmediate: "readonly", process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly", __dirname: "readonly" },
    },
  },
];

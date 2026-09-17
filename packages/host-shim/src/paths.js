export function normalizePath(value) {
  let out = String(value == null ? "" : value).trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return out;
}

export function isAbsolutePath(value) {
  const path = normalizePath(value);
  return /^[a-zA-Z]:\//.test(path) || path.startsWith("/");
}

export function extensionOf(value) {
  const name = normalizePath(value).split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function basenameOf(value) {
  const name = normalizePath(value).split("/").pop() || "";
  return name.replace(/\.[^.]+$/, "");
}

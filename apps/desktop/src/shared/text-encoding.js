// 文本解码:中文 TXT(旧站下载的「校对版」小说等)常见 GB18030,一律按 UTF-8 读会整本乱码。
// 顺序:BOM(UTF-8 / UTF-16)→ 含 NUL 的按 UTF-16 两序试解、取文本质量高的 → 严格 UTF-8 → GB18030。
// 纯函数、不碰 fs:主进程与渲染层共用(渲染层的 node 内置模块是构建期桩)。
export function stripBom(text) {
  return String(text ?? "").replace(/^\uFEFF/, "");
}

// 采样里的 0x00 占比:UTF-16 的 ASCII / 常见汉字低位字节里 0 不少,普通 UTF-8 / GBK 文本几乎为 0。
function nulRatio(bytes, sample = 16384) {
  let zeros = 0;
  const total = Math.min(bytes.length, sample);
  for (let i = 0; i < total; i += 1) if (bytes[i] === 0) zeros += 1;
  return total ? zeros / total : 0;
}

// 文本质量:可读字符(ASCII 可见 / 汉字 / 中文标点 / 全角)加分,控制符与私用区等减分。
// 用于在无 BOM 的 UTF-16 里挑字节序(错序解出来几乎全是私用区 / 拉丁扩展的怪字)。
export function textQuality(text) {
  let score = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (code === 0x0a || code === 0x0d || code === 0x09) score += 1;
    else if (code >= 0x20 && code <= 0x7e) score += 2;
    else if (code >= 0x4e00 && code <= 0x9fff) score += 3;
    else if ((code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) score += 3;
    else if (code >= 0x2000 && code <= 0x206f) score += 1;
    else if (code < 0x20 || code === 0xfffd) score -= 6;
    else score -= 2;
  }
  return score;
}

export function decodeText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer ?? []);
  if (!bytes.length) return "";
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return stripBom(new TextDecoder("utf-8").decode(bytes));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripBom(new TextDecoder("utf-16le").decode(bytes.subarray(2)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return stripBom(new TextDecoder("utf-16be").decode(bytes.subarray(2)));
  }
  if (nulRatio(bytes) > 0.05) {
    const le = stripBom(new TextDecoder("utf-16le").decode(bytes));
    const be = stripBom(new TextDecoder("utf-16be").decode(bytes));
    return textQuality(le) >= textQuality(be) ? le : be;
  }
  try {
    // 严格模式:能解出来就是合法 UTF-8(GBK 中文通常很快失败)。
    return stripBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { /* 不是 UTF-8:走 GB18030 */ }
  try {
    return stripBom(new TextDecoder("gb18030").decode(bytes));
  } catch {
    return stripBom(new TextDecoder("utf-8").decode(bytes));
  }
}

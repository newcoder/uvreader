// 发送到 Kindle(send-to-kindle):SMTP 投递 + 50MB 上限自动 ZIP + 可操作错误映射。
// 邮件密码只由调用方从 SecretStorage 读出后传入,不落设置、不进日志(见 docs/workshop-implementation.md W1-4)。
import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import nodemailer from "nodemailer";

export const KINDLE_MAX_BYTES = 50 * 1024 * 1024;

// 设置 → 连接配置。secure 默认 465/SSL;端口 587 视为 STARTTLS。
export function kindleConfig(settings = {}, { password = "" } = {}) {
  const port = Number(settings.smtpPort) || 465;
  const secure = settings.smtpSecure === false ? false : port !== 587;
  const user = String(settings.smtpUser || "").trim();
  return {
    host: String(settings.smtpHost || "").trim(),
    port,
    secure,
    user,
    password: String(password || ""),
    to: String(settings.kindleEmail || "").trim(),
    from: String(settings.smtpFrom || "").trim() || user,
  };
}

// SMTP / Amazon 的报错 → 可操作提示(测试里按真实返回文本覆盖)。
export function kindleErrorHint(error) {
  const raw = String(error?.response || error?.message || error || "");
  if (/535|Username and Password not accepted|Invalid login|authentication failed|\bAUTH\b/i.test(raw)) {
    return "SMTP 认证失败:邮箱的「授权码 / 应用专用密码」不对(不是登录密码;QQ / 163 邮箱在网页版设置里生成授权码)。";
  }
  if (/not authorized|not approved|not permitted|sender.*(rejected|refused)|address not verified/i.test(raw)) {
    return "Amazon 拒收了:去「管理您的内容和设备 → 个人文档设置」把发件地址加入已批准的个人文档邮箱列表。";
  }
  if (/552|message size|exceeds|too large|maximum/i.test(raw)) {
    return "附件超过 50MB 上限:先把书压小(封面 / 转 EPUB),再发送。";
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNECTION|Greeting never received|connect/i.test(raw)) {
    return "连不上 SMTP 服务器:检查服务器 / 端口 / 加密方式(465=SSL,587=STARTTLS),以及本机网络。";
  }
  if (/no such user|user unknown|does not exist|recipient address rejected/i.test(raw)) {
    return "收件地址不对:Kindle 地址形如 name_xxxx@kindle.com(在 Amazon「个人文档设置」里查看)。";
  }
  return raw.split("\n")[0].slice(0, 200) || "发送失败";
}

function baseName(file) {
  return path.basename(String(file || "")) || "book";
}

export function createKindleSender({
  nodemailerImpl = nodemailer,
  fsImpl = fs,
  zipFactory = () => new JSZip(),
  maxBytes = KINDLE_MAX_BYTES,
  log = (...args) => console.log("[kindle]", ...args),
} = {}) {
  function transport(config) {
    return nodemailerImpl.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user && config.password ? { user: config.user, pass: config.password } : undefined,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 90_000,
    });
  }

  // 「检测 SMTP」:只做 verify(),不发信。
  async function probe(settings = {}, { password = "" } = {}) {
    const config = kindleConfig(settings, { password });
    if (!config.host) return { ok: false, detail: "还没填 SMTP 服务器" };
    try {
      await transport(config).verify();
      return { ok: true, detail: `SMTP 可用 · ${config.host}:${config.port}${config.secure ? " SSL" : " STARTTLS"}` };
    } catch (error) {
      return { ok: false, detail: kindleErrorHint(error) };
    }
  }

  // 发送:单个文件且不超限就直接附;多个文件或超限先打包成 zip(仍超限则拒发并说明)。
  async function send(settings = {}, { files = [], password = "", subject = "", note = "" } = {}) {
    const config = kindleConfig(settings, { password });
    if (!config.host) return { ok: false, error: "还没填 SMTP 服务器(设置 → 发送到 Kindle)" };
    if (!config.to) return { ok: false, error: "还没填 Kindle 收件地址(形如 name_xxxx@kindle.com)" };
    const targets = (Array.isArray(files) ? files : []).map((file) => String(file || "")).filter((file) => file && fsImpl.existsSync(file));
    if (!targets.length) return { ok: false, error: "没有可发送的文件" };
    const total = targets.reduce((sum, file) => sum + Number(fsImpl.statSync(file).size || 0), 0);
    let attachments = targets.map((file) => ({ filename: baseName(file), path: file }));
    let zipped = false;
    if (targets.length > 1 || total > maxBytes) {
      const zip = zipFactory();
      for (const file of targets) zip.file(baseName(file), fsImpl.readFileSync(file));
      const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
      if (buffer.length > maxBytes) {
        return {
          ok: false,
          tooLarge: true,
          error: `打包后 ${Math.round(buffer.length / 1024 / 1024)}MB,仍超过 50MB 上限:请压缩图片或先转成 EPUB 再发送。`,
        };
      }
      attachments = [{ filename: `${(subject || baseName(targets[0]).replace(/\.[^.]+$/, ""))}.zip`, content: buffer }];
      zipped = true;
    }
    try {
      const info = await transport(config).sendMail({
        from: config.from,
        to: config.to,
        subject: subject || `UV Reader:${baseName(targets[0])}`,
        text: note || "由 UV Reader 发送到 Kindle。",
        attachments,
      });
      log("sent", config.to, attachments.map((item) => item.filename).join(", "), zipped ? "(zipped)" : "");
      return { ok: true, zipped, count: attachments.length, attachment: attachments[0].filename, messageId: String(info?.messageId || "") };
    } catch (error) {
      return { ok: false, error: kindleErrorHint(error) };
    }
  }

  return { probe, send };
}

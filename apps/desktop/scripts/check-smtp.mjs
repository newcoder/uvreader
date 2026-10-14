// 独立排查「发送到 Kindle」的 SMTP 登录:绕开界面,直接看服务器怎么回。
//
//   node apps/desktop/scripts/check-smtp.mjs --host smtp.qq.com --user you@qq.com [--port 465] [--from you@qq.com]
//
// 授权码不回显、不进历史记录,放在环境变量里:
//
//   $env:QBR_SMTP_PASS = "你的授权码"; node apps/desktop/scripts/check-smtp.mjs --host smtp.qq.com --user you@qq.com
//
// 只做 verify()(建连 + 登录),不发信;失败时打印可操作提示与服务器原话。
import process from "node:process";

import { createKindleSender } from "../src/main/kindle-send.js";

function argOf(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const host = argOf("host", "smtp.qq.com");
const user = argOf("user");
const port = argOf("port", "465");
const password = process.env.QBR_SMTP_PASS || "";

if (!user) {
  console.error("缺少 --user(完整邮箱地址),例如:--user you@qq.com");
  process.exit(2);
}
if (!password) {
  console.error("缺少授权码:先设置环境变量 QBR_SMTP_PASS(QQ / 163 用网页设置里生成的授权码,不是登录密码)。");
  process.exit(2);
}

const sender = createKindleSender({ log: () => {} });
const settings = { smtpHost: host, smtpPort: port, smtpUser: user, smtpFrom: argOf("from") };
const started = Date.now();
const result = await sender.probe(settings, { password });

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (result.ok) {
  console.log(`✓ ${result.detail}(${seconds}s)`);
  process.exit(0);
}
console.log(`✗ ${result.detail}(${seconds}s)`);
console.log("  排查顺序:① 授权码是不是网页版生成的(不是登录密码)② 「设置 → 账户 → IMAP/SMTP 服务」开了吗 ③ 账号写的是完整邮箱吗 ④ 端口 465 用 SSL、587 用 STARTTLS ⑤ 失败太多次会被限频,等 15 分钟再试。");
process.exit(1);

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { KINDLE_MAX_BYTES, createKindleSender, kindleConfig, kindleErrorDetail, kindleErrorHint } from "../src/main/kindle-send.js";

// 最小 SMTP 服务器:EHELO / AUTH PLAIN / MAIL / RCPT / DATA / QUIT,捕获整封邮件。
// 测试只连回环地址的真实端口,走 nodemailer 的真实协议实现。
function startSmtpMock({ acceptAuth = true } = {}) {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.write("220 mock ESMTP\r\n");
    let inData = false;
    let current = "";
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\r\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(current);
            current = "";
            socket.write("250 2.0.0 Ok: queued\r\n");
            continue;
          }
          current += `${line}\n`;
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) {
          socket.write("250-mock\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        } else if (command.startsWith("AUTH PLAIN")) {
          socket.write(acceptAuth ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Authentication credentials invalid\r\n");
        } else if (command.startsWith("MAIL") || command.startsWith("RCPT")) {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (command.startsWith("DATA")) {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (command.startsWith("QUIT")) {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, messages, close: () => server.close() }));
  });
}

// 从一封原始邮件里取出附件的 base64 内容(测试用,够用就好)。
// 注意:nodemailer 对非 ASCII 文件名做 RFC 2231 编码,按 Content-Disposition 认附件更稳。
function attachmentBase64(raw) {
  const boundary = raw.match(/boundary="?([^"\r\n;]+)"?/i)?.[1];
  const parts = boundary ? raw.split(`--${boundary}`) : [raw];
  for (const part of parts) {
    if (!/content-disposition:\s*attachment/i.test(part)) continue;
    const body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n");
    return body.replace(/[\r\n]/g, "").replace(/=+$/, "");
  }
  return "";
}

const settings = {
  smtpHost: "127.0.0.1",
  smtpUser: "reader@example.com",
  kindleEmail: "reader_abc@kindle.com",
  smtpSecure: false,
};

test("kindleConfig: 465 defaults to SSL, 587 to STARTTLS, from falls back to the user", () => {
  assert.deepEqual(kindleConfig({ smtpHost: "smtp.qq.com", smtpUser: "a@qq.com" }), {
    host: "smtp.qq.com", port: 465, secure: true, user: "a@qq.com", password: "", to: "", from: "a@qq.com",
  });
  assert.equal(kindleConfig({ smtpHost: "smtp.qq.com", smtpPort: 587 }).secure, false);
  assert.equal(kindleConfig({ smtpHost: "smtp.qq.com", smtpPort: 465 }).secure, true);
  assert.equal(kindleConfig({ smtpHost: "h", smtpSecure: false, smtpPort: 465 }).secure, false);
  assert.equal(KINDLE_MAX_BYTES, 50 * 1024 * 1024);
});

test("kindleErrorHint turns SMTP and Amazon replies into actions", () => {
  assert.match(kindleErrorHint({ response: "535 5.7.8 Username and Password not accepted" }), /授权码/);
  assert.match(kindleErrorHint("550 5.7.1 Your message was not authorized"), /已批准/);
  assert.match(kindleErrorHint("552 5.3.4 Message size exceeds fixed maximum"), /50MB/);
  assert.match(kindleErrorHint({ message: "connect ENOTFOUND smtp.qq.com" }), /连不上 SMTP/);
  assert.match(kindleErrorHint("550 5.1.1 User unknown"), /kindle\.com/);
  assert.equal(kindleErrorHint("something else\nsecond line"), "something else");
});

test("send delivers one attachment through a real SMTP conversation", async () => {
  const mock = await startSmtpMock();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-kindle-"));
    const book = path.join(dir, "样书.epub");
    fs.writeFileSync(book, "EPUB-BYTES");
    const sender = createKindleSender({ log: () => {} });
    const result = await sender.send({ ...settings, smtpPort: mock.port }, { files: [book], password: "code" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.zipped, false);
    assert.equal(result.attachment, "样书.epub");
    assert.equal(mock.messages.length, 1, "服务器收到一封");
    const raw = mock.messages[0];
    assert.match(raw, /To: reader_abc@kindle\.com/);
    assert.match(raw, /From: reader@example\.com/);
    assert.match(raw, /Subject: /);
    // 非 ASCII 文件名会按 RFC 2231 编码,这里解码回来核对。
    const encodedName = raw.match(/filename\*0\*=utf-8''([^\s;]+)/i)?.[1] || "";
    assert.ok(encodedName, "邮件里带 RFC 2231 编码的附件名");
    assert.equal(decodeURIComponent(encodedName), "样书.epub");
    assert.ok(Buffer.from(attachmentBase64(raw), "base64").toString("utf8").includes("EPUB-BYTES"), "附件内容是原文件");
  } finally {
    mock.close();
  }
});

test("send zips multiple files and reports the packed size", async () => {
  const mock = await startSmtpMock();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-kindle-zip-"));
    const one = path.join(dir, "a.txt");
    const two = path.join(dir, "b.txt");
    fs.writeFileSync(one, "AAA");
    fs.writeFileSync(two, "BBB");
    const sender = createKindleSender({ log: () => {} });
    const result = await sender.send({ ...settings, smtpPort: mock.port }, { files: [one, two], password: "code", subject: "两本" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.zipped, true);
    assert.equal(result.attachment, "两本.zip");
    const zip = await JSZip.loadAsync(Buffer.from(attachmentBase64(mock.messages[0]), "base64"));
    assert.deepEqual(Object.keys(zip.files).sort(), ["a.txt", "b.txt"]);
    assert.equal(await zip.file("a.txt").async("string"), "AAA");
  } finally {
    mock.close();
  }
});

test("send refuses when even the zip exceeds the limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbr-kindle-big-"));
  const big = path.join(dir, "big.bin");
  // 随机数据压不动,才能稳定触发「打包后仍超限」。
  fs.writeFileSync(big, crypto.randomBytes(4096));
  const sender = createKindleSender({ maxBytes: 2000, log: () => {} });
  const result = await sender.send({ ...settings, smtpPort: 9 }, { files: [big], password: "code" });
  assert.equal(result.ok, false);
  assert.equal(result.tooLarge, true);
  assert.match(result.error, /50MB|上限/);
});

test("probe verifies the SMTP login and maps a rejected password", async () => {
  const good = await startSmtpMock();
  const bad = await startSmtpMock({ acceptAuth: false });
  try {
    const sender = createKindleSender({ log: () => {} });
    const ok = await sender.probe({ ...settings, smtpPort: good.port }, { password: "code" });
    assert.equal(ok.ok, true, ok.detail);
    assert.match(ok.detail, /SMTP 可用/);
    const rejected = await sender.probe({ ...settings, smtpPort: bad.port }, { password: "wrong" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.detail, /授权码/);
    const missing = await sender.probe({}, {});
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /SMTP 服务器/);
  } finally {
    good.close();
    bad.close();
  }
});

test("send asks for the missing pieces instead of throwing", async () => {
  const sender = createKindleSender({ log: () => {} });
  assert.match((await sender.send({}, { files: [] })).error, /SMTP 服务器/);
  const noLogin = await sender.send({ smtpHost: "127.0.0.1", smtpUser: "me@qq.com" }, { files: [] });
  assert.match(noLogin.error, /授权码/, "空授权码先说要填授权码,别去连服务器");
  const noTo = await sender.send({ smtpHost: "127.0.0.1", smtpUser: "me@qq.com", kindleEmail: "" }, { files: [], password: "code" });
  assert.match(noTo.error, /Kindle 收件地址/);
  const noFiles = await sender.send({ smtpHost: "127.0.0.1", smtpUser: "me@qq.com", kindleEmail: "a@kindle.com" }, { files: [], password: "code" });
  assert.match(noFiles.error, /没有可发送的文件/);
});

test("probe names the missing account or code before dialling", async () => {
  const sender = createKindleSender({ log: () => {} });
  const noUser = await sender.probe({ smtpHost: "smtp.qq.com" }, { password: "code" });
  assert.match(noUser.detail, /SMTP 账号/, "没账号就别连");
  const noCode = await sender.probe({ smtpHost: "smtp.qq.com", smtpUser: "me@qq.com" }, {});
  assert.match(noCode.detail, /授权码/, "没授权码时直接说要授权码");
});

test("failures carry the server line next to the hint", () => {
  // QQ 的真实回应:四种可能原因都写在服务器那一行里。
  const qq = kindleErrorDetail({ response: "535 Login fail. Account is abnormal, service is not open, password is incorrect" });
  assert.match(qq, /授权码/);
  assert.match(qq, /\(服务器:535 Login fail/, "服务器原话要带上");
  const connect = kindleErrorDetail({ message: "connect ECONNREFUSED 127.0.0.1:465" });
  assert.match(connect, /连不上 SMTP/);
  assert.match(connect, /ECONNREFUSED/);
  assert.equal(kindleErrorDetail(""), "发送失败");
});

// A mail catcher for tests: a minimal SMTP server that keeps every message in
// memory, and an HTTP endpoint where tests read them. The mail test server
// sends to it, so tests can follow emailed invites and check notices. Plain
// SMTP on localhost only, no TLS and no auth, no dependencies.
import http from "node:http";
import net from "node:net";

import { mailHttpPort, smtpPort } from "./paths.mjs";

/** @type {{ to: string[]; subject: string; text: string; html: string; raw: string }[]} */
const messages = [];

function decodeQuotedPrintable(s) {
  const bytes = Buffer.from(
    s
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      ),
    "latin1",
  );
  return bytes.toString("utf8");
}

function decodeBody(headers, body) {
  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  if (encoding === "base64")
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  return body;
}

function parseHeaders(block) {
  const headers = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0)
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/** The text and HTML parts of a message, decoded, from any nesting of multipart parts. */
function parts(headers, body, found = { text: "", html: "" }) {
  const type = headers["content-type"] ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (type.startsWith("multipart/") && boundary) {
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break;
      const split = chunk.search(/\r?\n\r?\n/);
      if (split < 0) continue;
      parts(
        parseHeaders(chunk.slice(0, split)),
        chunk.slice(split).replace(/^\r?\n\r?\n/, ""),
        found,
      );
    }
  } else if (type.startsWith("text/html")) {
    found.html += decodeBody(headers, body);
  } else if (type.startsWith("text/plain")) {
    found.text += decodeBody(headers, body);
  }
  return found;
}

function store(to, raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(raw.slice(0, split));
  const { text, html } = parts(
    headers,
    raw.slice(split).replace(/^\r?\n\r?\n/, ""),
  );
  messages.push({ to, subject: headers.subject ?? "", text, html, raw });
}

net
  .createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let data = "";
    let to = [];
    const reply = (line) => socket.write(`${line}\r\n`);
    reply("220 mail-catcher ready");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        data = buffer.slice(0, end).replace(/^\.\./gm, ".");
        buffer = buffer.slice(end + 5);
        inData = false;
        store(to, data);
        to = [];
        reply("250 OK");
      }
      let newline;
      while (!inData && (newline = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") reply("250 mail-catcher");
        else if (verb === "HELO") reply("250 mail-catcher");
        else if (verb === "MAIL") reply("250 OK");
        else if (verb === "RCPT") {
          to.push((/<([^>]*)>/.exec(line)?.[1] ?? "").toLowerCase());
          reply("250 OK");
        } else if (verb === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
          if (buffer.length) socket.emit("data", "");
        } else if (verb === "RSET") {
          to = [];
          reply("250 OK");
        } else if (verb === "NOOP") reply("250 OK");
        else if (verb === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else reply("502 Not implemented");
      }
    });
    socket.on("error", () => {});
  })
  .listen(Number(smtpPort), "127.0.0.1");

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/alive") {
      res.end('"ok"');
    } else if (url.pathname === "/messages") {
      const to = url.searchParams.get("to")?.toLowerCase();
      res.end(JSON.stringify(messages.filter((m) => !to || m.to.includes(to))));
    } else {
      res.statusCode = 404;
      res.end("null");
    }
  })
  .listen(Number(mailHttpPort), "127.0.0.1");

// Stop with whatever started us.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
}, 1000).unref();

// Serves the autofill corpus over real HTTPS, so the extension sees real
// network traffic (its submit detection watches requests). Browsers in the
// tests resolve *.example.test (and *.elsewhere.test, another site) to this server. Any path serves the fixture
// file of the same name, for GET and POST: /otp-masked.html, and so on.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleChangePassword } from "./change-password-site.mjs";
import { fixturePort } from "./paths.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "tests", "fixtures", "autofill");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-fixtures-"));
const cert = path.join(tmp, "cert.pem");
const key = path.join(tmp, "key.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
  "-keyout", key, "-out", cert, "-subj", "/CN=*.example.test",
  "-addext", "subjectAltName=DNS:*.example.test,IP:127.0.0.1",
], { stdio: "ignore" });

const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, async (req, res) => {
  // Change-password test sites (change-password-site.mjs), by their hosts.
  if (await handleChangePassword(req, res)) return;
  const name = path.basename(new URL(req.url, "https://x").pathname);
  const file = path.join(root, name === "" ? "index.html" : name);
  if (name === "alive") return res.writeHead(200).end("ok");
  // Redirects for Open and fill (open-and-fill.spec.ts): one to this site's
  // sign-in page, one to another site's.
  const redirects = {
    "to-sign-in": "/simple-login.html",
    "to-elsewhere": "https://login.elsewhere.test/simple-login.html",
  };
  if (Object.hasOwn(redirects, name)) return res.writeHead(302, { location: redirects[name] }).end();
  if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404).end("not found");
  req.resume();
  req.on("end", () => {
    // Every answer comes at once, sign-ins too, as from a fast site. The save
    // prompt must show up all the same (DESIGN.md, "Missed save prompts on
    // fast sites").
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(file));
  });
});
server.listen(Number(fixturePort), "127.0.0.1");

const stop = () => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    stop();
  }
}, 1000).unref();

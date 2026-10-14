// Serves the autofill corpus over real HTTPS, so the extension sees real
// network traffic (its submit detection watches requests). Browsers in the
// tests resolve *.example.test to this server. Any path serves the fixture
// file of the same name, for GET and POST: /otp-masked.html, and so on.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
  const name = path.basename(new URL(req.url, "https://x").pathname);
  const file = path.join(root, name === "" ? "index.html" : name);
  if (name === "alive") return res.writeHead(200).end("ok");
  if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404).end("not found");
  req.resume();
  req.on("end", () => {
    // Real sites take a while to answer a sign-in. An instant answer races the
    // extension's own messages and it drops the prompt (see DESIGN.md).
    const delay = req.method === "POST" ? 300 : 0;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(file));
    }, delay);
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

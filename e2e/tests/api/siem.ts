// Stand-ins for the security tools organizations send their events to
// (DESIGN.md, "Sending events to security tools"): an HTTPS webhook receiver,
// a syslog collector over TLS (RFC 5425 framing), and Microsoft Sentinel's
// token and Logs Ingestion endpoints. Each runs in the test's own process on
// 127.0.0.1 with a throwaway certificate, which the destination is told to
// trust, so nothing leaves the machine.
import { execFileSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { expect } from "@playwright/test";

import { siemPort } from "../../paths.mjs";

export type Cert = { cert: string; key: string };

/** A throwaway certificate for 127.0.0.1: a server's, not a CA's, as rustls wants. */
export function throwawayCert(): Cert {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-siem-"));
  try {
    const cert = path.join(dir, "cert.pem");
    const key = path.join(dir, "key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-addext",
        "basicConstraints=critical,CA:FALSE",
        "-addext",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "-addext",
        "extendedKeyUsage=serverAuth",
      ],
      { stdio: "ignore" },
    );
    return { cert: fs.readFileSync(cert, "utf8"), key: fs.readFileSync(key, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export type Received = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** Waits until `pick` finds something in what arrived. */
export async function waitFor<T, R>(
  list: T[],
  pick: (items: T[]) => R | undefined,
  what: string,
  timeout = 20_000,
): Promise<R> {
  const until = Date.now() + timeout;
  for (;;) {
    const found = pick(list);
    if (found !== undefined && found !== null && (!Array.isArray(found) || found.length > 0)) {
      return found;
    }
    if (Date.now() > until) {
      throw new Error(`Timed out waiting for ${what}; got ${JSON.stringify(list).slice(0, 2000)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** An HTTPS server that records every request and answers with `status()`. */
export async function httpsReceiver(
  cert: Cert,
  answer: (req: Received) => { status: number; body?: string; delayMs?: number } = () => ({ status: 200 }),
  port = 0,
) {
  const received: Received[] = [];
  const server = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const r = { path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(r);
      const a = answer(r);
      setTimeout(() => {
        res.writeHead(a.status, { "Content-Type": "application/json" });
        res.end(a.body ?? "");
      }, a.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = (server.address() as AddressInfo).port;
  return {
    received,
    port: actualPort,
    url: (p: string) => `https://127.0.0.1:${actualPort}${p}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Checks a webhook request's signature the Standard Webhooks way, as a
 * receiver would: HMAC-SHA256 over "<id>.<timestamp>.<body>" with the
 * secret's key bytes, a recent timestamp, and the id matching the event's.
 */
export function verifyWebhook(r: Received, secret: string) {
  const id = String(r.headers["webhook-id"]);
  const timestamp = Number(r.headers["webhook-timestamp"]);
  const signatures = String(r.headers["webhook-signature"]).split(" ");
  expect(Math.abs(Date.now() / 1000 - timestamp), "timestamp is recent").toBeLessThan(300);
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${r.body}`).digest();
  const ok = signatures.some((s) => {
    const [version, sig] = s.split(",");
    const given = Buffer.from(sig ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
  expect(ok, `signature ${signatures.join(" ")}`).toBe(true);
  const event = JSON.parse(r.body);
  expect(event.id).toBe(id);
  return event;
}

export type SyslogMessage = {
  pri: number;
  version: string;
  time: string;
  host: string;
  app: string;
  procId: string;
  msgId: string;
  structuredData: string;
  message: string;
};

/** Parses one RFC 5424 message (no structured data, as PassBundle sends). */
export function parseSyslog(text: string): SyslogMessage {
  const m = /^<(\d+)>(\d) (\S+) (\S+) (\S+) (\S+) (\S+) (-) ([\s\S]*)$/.exec(text);
  if (!m) {
    throw new Error(`Not an RFC 5424 message: ${text}`);
  }
  return {
    pri: Number(m[1]),
    version: m[2],
    time: m[3],
    host: m[4],
    app: m[5],
    procId: m[6],
    msgId: m[7],
    structuredData: m[8],
    message: m[9],
  };
}

/** A syslog collector over TLS that splits RFC 5425's octet-counted frames. */
export async function syslogReceiver(cert: Cert) {
  const messages: string[] = [];
  const server = tls.createServer({ cert: cert.cert, key: cert.key }, (socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const space = buffer.indexOf(0x20);
        if (space < 0) {
          break;
        }
        const length = Number(buffer.subarray(0, space).toString("ascii"));
        if (!Number.isInteger(length) || buffer.length < space + 1 + length) {
          break;
        }
        messages.push(buffer.subarray(space + 1, space + 1 + length).toString("utf8"));
        buffer = buffer.subarray(space + 1 + length);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    messages,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The certificate the main test server trusts for Sentinel
 * (EVENT_STREAMING_AZURE_CA_FILE), made by server.mjs.
 */
export function sentinelCert(): Cert {
  const dir = path.join(os.tmpdir(), `keykeeper-e2e-siem-${siemPort}`);
  return {
    cert: fs.readFileSync(path.join(dir, "cert.pem"), "utf8"),
    key: fs.readFileSync(path.join(dir, "key.pem"), "utf8"),
  };
}

/**
 * Microsoft Entra's token endpoint and Azure Monitor's Logs Ingestion API on
 * the port the test server sends Sentinel's sign-in to (KK_SIEM_PORT, set in
 * server.mjs), answering like the real ones, with the certificate the server
 * was told to trust.
 */
export async function sentinelStandIn(cert: Cert = sentinelCert()) {
  const tokens: Record<string, string>[] = [];
  const uploads: { path: string; authorization: string; rows: Record<string, unknown>[] }[] = [];
  const receiver = await httpsReceiver(
    cert,
    (r) => {
      if (r.path.endsWith("/oauth2/v2.0/token")) {
        const form = Object.fromEntries(new URLSearchParams(r.body));
        tokens.push({ ...form, path: r.path });
        if (form.client_secret !== "app-secret-value") {
          return { status: 401, body: JSON.stringify({ error: "invalid_client" }) };
        }
        return { status: 200, body: JSON.stringify({ access_token: "stand-in-token", expires_in: 3599 }) };
      }
      if (r.path.includes("/dataCollectionRules/")) {
        uploads.push({ path: r.path, authorization: String(r.headers.authorization), rows: JSON.parse(r.body) });
        return { status: 204 };
      }
      return { status: 404 };
    },
    Number(siemPort),
  );
  return { ...receiver, tokens, uploads };
}

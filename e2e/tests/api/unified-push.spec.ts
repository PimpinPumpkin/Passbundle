// Push to phones over UnifiedPush, the server's side (DESIGN.md, "Push to
// phones"). A tiny push service on 127.0.0.1 stands in for the one a phone's
// distributor (ntfy, for example) runs. A phone registers its endpoint with
// keys of its own, as the distributor's library makes them; another device
// signing in on a new device, and asking to sign in with a device, each
// sends it exactly one message, which opens with the phone's keys (here, with
// Node's own crypto) to the kind and nothing else, signed with the server's
// VAPID key; the device that asked gets none; a push service that never
// answers doesn't slow the request; and one that answers 410 has the endpoint
// removed. On the main test server, which keeps the defaults: the endpoints
// the server refuses, and that a device registers and removes only its own.
import { type ChildProcess, spawn } from "node:child_process";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, request as apiRequest, test } from "@playwright/test";

import { unifiedPushServerPort } from "../../paths.mjs";

import { type Cert, throwawayCert } from "./siem";
import { Api, encString, publicKey } from "./support";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(fs.readFileSync(path.join(e2eDir, "../docs/vectors/web-push-rfc8291.json"), "utf8"));
const b64u = (s: string) => Buffer.from(s, "base64url");

const ANDROID = "0";
const FIREFOX = "10";
const ROUTE = "/api/keykeeper/push/unified-push";

/** A phone's push keys, as the distributor's library makes them. */
type Phone = { privateKey: Buffer; publicKey: Buffer; auth: Buffer };

function phoneKeys(): Phone {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth: randomBytes(16) };
}

/**
 * Opens a message as the phone does (RFC 8291, with RFC 8188's one record):
 * the plaintext, or an exception if it doesn't open with these keys.
 */
function openPush(body: Buffer, phone: Phone): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body[20];
  const serverKey = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  expect(recordSize).toBe(4096);
  expect(idLength).toBe(65);
  expect(record.length).toBeLessThanOrEqual(recordSize);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(phone.privateKey);
  const secret = ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), phone.publicKey, serverKey]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, phone.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) {
    end -= 1;
  }
  expect(padded[end], "the last record's delimiter").toBe(2);
  return padded.subarray(0, end);
}

/** Checks a message's VAPID header (RFC 8292) with the key it names, which must be the server's. */
function checkVapid(header: string, serverKey: string, audience: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(match, header).toBeTruthy();
  const [, jwt, k] = match!;
  expect(k).toBe(serverKey);
  const [head, claims, signature] = jwt.split(".");
  expect(JSON.parse(b64u(head).toString())).toEqual({ typ: "JWT", alg: "ES256" });
  const point = b64u(k);
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  expect(
    verify("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, b64u(signature)),
    "signed with the server's VAPID key",
  ).toBe(true);
  const said = JSON.parse(b64u(claims).toString());
  expect(said.aud).toBe(audience);
  expect(said.sub).toBe(`https://127.0.0.1:${unifiedPushServerPort}`);
  const now = Date.now() / 1000;
  expect(said.exp).toBeGreaterThan(now);
  expect(said.exp).toBeLessThanOrEqual(now + 24 * 3600);
}

type Message = { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer };

/** The stand-in push service: keeps every message, and answers each path as told. */
async function pushService(cert: Cert) {
  const messages: Message[] = [];
  const answers = new Map<string, number | "never">();
  const server = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      messages.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      const answer = answers.get(path) ?? 201;
      if (answer !== "never") {
        res.writeHead(answer);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    messages,
    answers,
    origin: `https://127.0.0.1:${port}`,
    url: (p: string) => `https://127.0.0.1:${port}${p}`,
    to: (p: string) => messages.filter((m) => m.path === p),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let server: ChildProcess;
let dataDir: string;
let http: APIRequestContext;
let service: Awaited<ReturnType<typeof pushService>>;
const cert = throwawayCert();

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-unified-push-"));
  const ca = path.join(dataDir, "push-ca.pem");
  fs.writeFileSync(ca, cert.cert);
  service = await pushService(cert);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: unifiedPushServerPort,
      KK_DATA_DIR: dataDir,
      // The new-device check on, so a sign-in on a new device is one of the
      // things a phone hears of.
      KK_NEW_DEVICE: "1",
      KK_UNIFIED_PUSH_CA: ca,
    },
    stdio: "ignore",
  });
  http = await apiRequest.newContext({
    baseURL: `https://127.0.0.1:${unifiedPushServerPort}`,
    ignoreHTTPSErrors: true,
  });
  await expect
    .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
    .toBe(200);
});

test.afterAll(async () => {
  await http?.dispose();
  if (server) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  await service?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Device = { id: string; type: string; token?: string };

/** A password sign-in, as an app makes it, from a device. */
async function signIn(
  request: APIRequestContext,
  who: { email: string; password: string },
  d: Device,
  extra: Record<string, string> = {},
) {
  const response = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: who.email,
      password: who.password,
      scope: "api offline_access",
      client_id: d.type === ANDROID ? "mobile" : "web",
      deviceType: d.type,
      deviceIdentifier: d.id,
      deviceName: d.type === ANDROID ? "pixel" : "firefox",
      ...(d.token ? { twoFactorProvider: "5", twoFactorToken: d.token } : {}),
      ...extra,
    },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

/** An account on the push server, with nothing signed in yet. */
async function register(name: string) {
  const email = `${name}-${randomUUID().slice(0, 8)}@api.example.test`;
  const password = Buffer.from(`hash-${email}`).toString("base64");
  const verifying = await http.post("/identity/accounts/register/send-verification-email", {
    data: { email, name, receiveMarketingEmails: false },
    headers: { Accept: "application/json" },
  });
  expect(verifying.status(), await verifying.text()).toBe(200);
  const finish = await http.post("/identity/accounts/register/finish", {
    data: {
      email,
      emailVerificationToken: await verifying.json(),
      masterPasswordHash: password,
      masterPasswordHint: null,
      userSymmetricKey: encString(`user-key-${email}`),
      userAsymmetricKeys: { publicKey: publicKey(email), encryptedPrivateKey: encString(`private-${email}`) },
      kdf: 0,
      kdfIterations: 600000,
    },
  });
  expect(finish.status(), await finish.text()).toBe(200);
  return { email, password };
}

/** The phone signs in first (an account's first sign-in isn't held) and registers its endpoint. */
async function phoneFor(name: string, endpointPath: string) {
  const who = await register(name);
  const phone: Device = { id: randomUUID(), type: ANDROID };
  const signedIn = await signIn(http, who, phone);
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  const session = { token: signedIn.body.access_token as string };
  const keys = phoneKeys();
  const api = new Api(http);
  const registered = await api.call(session, "PUT", ROUTE, {
    endpoint: service.url(endpointPath),
    publicKey: keys.publicKey.toString("base64url"),
    auth: keys.auth.toString("base64url"),
  });
  expect(registered.status, JSON.stringify(registered.body)).toBe(200);
  expect(registered.body).toEqual(
    expect.objectContaining({ object: "unifiedPush", enabled: true, registered: true }),
  );
  const vapid = registered.body.vapidPublicKey as string;
  expect(b64u(vapid)).toHaveLength(65);
  return { who, phone, session, keys, api, vapid };
}

/** The laptop signs in on a new device: the check holds it, the phone approves with the number. */
async function laptopApprovedBy(
  api: Api,
  who: { email: string; password: string },
  phoneSession: { token: string },
) {
  const laptop: Device = { id: randomUUID(), type: FIREFOX };
  const held = await signIn(http, who, laptop);
  expect(held.status, JSON.stringify(held.body)).toBe(400);
  const check = held.body.KeykeeperNewDeviceCheck as { id: string; token: string; number: string };
  const approved = await api.call(phoneSession, "POST", `/api/keykeeper/new-device-checks/${check.id}/approve`, {
    number: check.number,
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const signedIn = await signIn(http, who, laptop, { newDeviceOtp: check.token });
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  laptop.token = signedIn.body.TwoFactorToken;
  return { laptop, session: { token: signedIn.body.access_token as string } };
}

/** "Sign in with a device" from a device the account knows. */
async function askToSignIn(who: { email: string }, d: Device) {
  const { publicKey: key } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const code = randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 25);
  const started = Date.now();
  const response = await http.post("/api/auth-requests", {
    headers: { "Device-Type": d.type },
    data: {
      email: who.email,
      deviceIdentifier: d.id,
      publicKey: key.export({ type: "spki", format: "der" }).toString("base64"),
      accessCode: code,
      type: 0,
    },
  });
  return { status: response.status(), took: Date.now() - started, body: await response.json().catch(() => null) };
}

/** Waits for exactly `count` messages to a path, then a moment more to see no others come. */
async function exactly(p: string, count: number) {
  await expect.poll(() => service.to(p).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(count);
  await new Promise((r) => setTimeout(r, 500));
  expect(service.to(p)).toHaveLength(count);
  return service.to(p);
}

test("the test's own decryption opens RFC 8291's example", () => {
  const phone = { privateKey: b64u(vector.ua_private), publicKey: b64u(vector.ua_public), auth: b64u(vector.auth_secret) };
  expect(openPush(b64u(vector.message), phone).toString("base64url")).toBe(vector.plaintext);
  expect(() => openPush(b64u(vector.message), { ...phone, auth: randomBytes(16) })).toThrow();
});

test("a phone hears of a sign-in on a new device and of a sign-in request, each once, as the kind alone", async () => {
  const { who, session: phoneSession, keys, api, vapid } = await phoneFor("ana", "/ana-phone");

  // A sign-in on a new device: the check holds it, and the phone hears.
  const { laptop, session: laptopSession } = await laptopApprovedBy(api, who, phoneSession);
  const [first] = await exactly("/ana-phone", 1);
  expect(first.headers["content-encoding"]).toBe("aes128gcm");
  expect(first.headers["content-type"]).toBe("application/octet-stream");
  expect(first.headers.ttl).toBe("900");
  expect(first.headers.urgency).toBe("high");
  expect(first.headers.topic).toBe("sign-in");
  checkVapid(String(first.headers.authorization), vapid, service.origin);
  // It opens with the phone's keys to the kind and nothing else: no email,
  // device, address, or id.
  const opened = openPush(first.body, keys);
  expect(JSON.parse(opened.toString())).toEqual({ kind: "sign-in" });
  expect(opened.toString()).toBe('{"kind":"sign-in"}');
  // And with any other phone's keys, it doesn't.
  expect(() => openPush(first.body, phoneKeys())).toThrow();
  expect(() => openPush(first.body, { ...keys, auth: randomBytes(16) })).toThrow();

  // The laptop registers an endpoint of its own; then it asks to sign in
  // with a device. The phone hears once more; the laptop, which asked, not.
  const laptopKeys = phoneKeys();
  const laptopRegistered = await api.call(laptopSession, "PUT", ROUTE, {
    endpoint: service.url("/ana-laptop"),
    publicKey: laptopKeys.publicKey.toString("base64url"),
    auth: laptopKeys.auth.toString("base64url"),
  });
  expect(laptopRegistered.status, JSON.stringify(laptopRegistered.body)).toBe(200);
  const asked = await askToSignIn(who, laptop);
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);
  const [, second] = await exactly("/ana-phone", 2);
  expect(JSON.parse(openPush(second.body, keys).toString())).toEqual({ kind: "sign-in" });
  checkVapid(String(second.headers.authorization), vapid, service.origin);
  // A new key and salt for each message.
  expect(second.body.subarray(0, 16).equals(first.body.subarray(0, 16))).toBe(false);
  expect(second.body.subarray(21, 86).equals(first.body.subarray(21, 86))).toBe(false);
  expect(service.to("/ana-laptop")).toHaveLength(0);

  // Each device sees only its own registration.
  expect((await api.call(phoneSession, "GET", ROUTE)).body.registered).toBe(true);
  expect((await api.call(laptopSession, "DELETE", ROUTE)).status).toBe(200);
  expect((await api.call(laptopSession, "GET", ROUTE)).body.registered).toBe(false);
  expect((await api.call(phoneSession, "GET", ROUTE)).body.registered).toBe(true);
});

test("a push service that never answers doesn't slow a sign-in request, and a 410 removes the endpoint", async () => {
  const { who, session: phoneSession, keys, api } = await phoneFor("ben", "/ben-phone");
  const { laptop } = await laptopApprovedBy(api, who, phoneSession);
  await exactly("/ben-phone", 1);

  // A push service that takes the message and never answers: the request
  // is answered at once all the same.
  service.answers.set("/ben-phone", "never");
  const slow = await askToSignIn(who, laptop);
  expect(slow.status, JSON.stringify(slow.body)).toBe(200);
  expect(slow.took).toBeLessThan(3_000);
  await exactly("/ben-phone", 2);
  // A timeout isn't "gone": the endpoint stays.
  expect((await api.call(phoneSession, "GET", ROUTE)).body.registered).toBe(true);

  // A push service that no longer has the endpoint (410): it's removed.
  service.answers.set("/ben-phone", 410);
  const gone = await askToSignIn(who, laptop);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  const [, , third] = await exactly("/ben-phone", 3);
  expect(JSON.parse(openPush(third.body, keys).toString())).toEqual({ kind: "sign-in" });
  await expect
    .poll(async () => (await api.call(phoneSession, "GET", ROUTE)).body.registered, { timeout: 15_000 })
    .toBe(false);

  // And nothing more is sent to it.
  const after = await askToSignIn(who, laptop);
  expect(after.status, JSON.stringify(after.body)).toBe(200);
  await new Promise((r) => setTimeout(r, 1_000));
  expect(service.to("/ben-phone")).toHaveLength(3);
});

test("the server refuses endpoints it can't use, and a device registers and removes only its own", async ({
  request,
}) => {
  // The main test server keeps the defaults: no private or loopback address.
  const api = new Api(request);
  const [ana, ben] = await Promise.all([api.account("ana"), api.account("ben")]);
  const keys = phoneKeys();
  const good = {
    endpoint: "https://push.example.net/up/AbCdEf123?up=1",
    publicKey: keys.publicKey.toString("base64url"),
    auth: keys.auth.toString("base64url"),
  };

  const before = await api.call(ana, "GET", ROUTE);
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body).toEqual(expect.objectContaining({ object: "unifiedPush", enabled: true, registered: false }));
  expect(b64u(before.body.vapidPublicKey)).toHaveLength(65);

  for (const endpoint of [
    "http://push.example.net/up/1",
    "https://127.0.0.1/up/1",
    `https://127.0.0.1:${service.origin.split(":").pop()}/up/1`,
    "https://[::1]/up/1",
    "https://10.0.0.8/up/1",
    "https://192.168.1.20/up/1",
    "https://169.254.169.254/latest/meta-data/",
    "https://[fe80::1]/up/1",
    "https://[::ffff:10.0.0.8]/up/1",
    "https://user:secret@push.example.net/up/1",
    "https://push.example.net/up/1#fragment",
    `https://push.example.net/${"a".repeat(2100)}`,
    "not a url",
  ]) {
    const refused = await api.call(ana, "PUT", ROUTE, { ...good, endpoint });
    expect(refused.status, `${endpoint}: ${JSON.stringify(refused.body)}`).toBe(400);
  }
  const notAKey = await api.call(ana, "PUT", ROUTE, { ...good, publicKey: randomBytes(65).toString("base64url") });
  expect(notAKey.status, JSON.stringify(notAKey.body)).toBe(400);
  const shortAuth = await api.call(ana, "PUT", ROUTE, { ...good, auth: randomBytes(15).toString("base64url") });
  expect(shortAuth.status, JSON.stringify(shortAuth.body)).toBe(400);
  expect((await api.call(ana, "GET", ROUTE)).body.registered).toBe(false);

  // No session: nothing.
  const nobody = await request.put(ROUTE, { data: good });
  expect(nobody.status()).toBe(401);

  // Ana's device registers; Ben's sees nothing of it, and removing his own
  // leaves hers.
  const registered = await api.call(ana, "PUT", ROUTE, good);
  expect(registered.status, JSON.stringify(registered.body)).toBe(200);
  expect(registered.body.registered).toBe(true);
  expect((await api.call(ben, "GET", ROUTE)).body.registered).toBe(false);
  expect((await api.call(ben, "DELETE", ROUTE)).status).toBe(200);
  expect((await api.call(ana, "GET", ROUTE)).body.registered).toBe(true);
  // Padding on the keys is fine, as some libraries send it.
  const padded = await api.call(ana, "PUT", ROUTE, { ...good, auth: `${keys.auth.toString("base64url")}==` });
  expect(padded.status, JSON.stringify(padded.body)).toBe(200);
  expect((await api.call(ana, "DELETE", ROUTE)).status).toBe(200);
  expect((await api.call(ana, "GET", ROUTE)).body.registered).toBe(false);
});

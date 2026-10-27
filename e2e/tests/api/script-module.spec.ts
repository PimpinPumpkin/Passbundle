// The PowerShell module for script access (docs/script-access.md), run under
// PowerShell 7 against the test server: it fetches a token's copies and
// decrypts them on the machine, returns credentials, fields, and one-time
// codes, and refuses copies made for another item or with another key, and a
// revoked token. Copies here are made with plain Node, as the vectors are.
// Tier 1's Linux runners have PowerShell; a machine without it skips this.
import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { port } from "../../paths.mjs";

import { Api, withMasterPassword, encString, type Account } from "./support";

// The master password these changes need is checked the way a sign-in is
// (600,000 rounds of PBKDF2 on the server, slow in its debug build), so tests
// that make several get more time.
test.describe.configure({ timeout: 120_000 });

const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "1"]).status === 0;
test.skip(!hasPwsh && !process.env.CI, "PowerShell 7 isn't installed here; tier 1 runs this");

const hkdf = (seed: Buffer, info: string, length: number) =>
  Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(0), info, length));

/** Upstream's type 2 encrypted string. */
function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32)).update(Buffer.concat([iv, ct])).digest();
  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
}

/** RFC 6238 with SHA-1, 30 seconds, 6 digits, at a given time. */
function totp(base32: string, at: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...base32].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash[hash.length - 1] & 0xf;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

type Made = { id: string; tokenString: string };

async function makeToken(
  api: Api,
  owner: Account,
  orgId: string,
  itemId: string,
  copyFor: (id: string, key: Buffer) => string,
): Promise<Made> {
  const id = randomUUID();
  const seed = randomBytes(32);
  const authSecret = hkdf(seed, "passbundle script auth v1", 32);
  const tokenKey = hkdf(seed, "passbundle script key v1", 64);
  const revision = (await api.call(owner, "GET", `/api/ciphers/${itemId}`)).body.revisionDate;
  const created = await api.call(
    owner,
    "POST",
    `/api/keykeeper/organizations/${orgId}/script-tokens`,
    withMasterPassword(owner, {
      id,
      name: "Join domain",
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      authHash: createHash("sha256").update(authSecret).digest("base64"),
      sealedKey: encString("sealed"),
      grants: [{ itemId, copy: copyFor(id, tokenKey), revision, sealedSpec: encString("spec") }],
    }),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { id, tokenString: `pbs1_${id.replace(/-/g, "")}_${seed.toString("base64url")}` };
}

/** The test server's certificate, so PowerShell can trust it (SSL_CERT_FILE). */
async function serverCertificate(): Promise<string> {
  const der = await new Promise<Buffer>((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: Number(port), rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate(true).raw);
      socket.end();
    });
    socket.on("error", reject);
  });
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-module-")), "server.pem");
  fs.writeFileSync(file, pem);
  return file;
}

// PowerShell on Linux trusts what SSL_CERT_FILE names, so tier 1 checks the
// module against the server's real certificate. On a Mac it asks the
// Keychain instead, so a local run there skips the check, in the module's
// own scope (the caller's defaults don't reach into a module).
const trust =
  process.platform === "linux"
    ? ""
    : "& $m { $script:PSDefaultParameterValues = @{ 'Invoke-RestMethod:SkipCertificateCheck' = $true } }; ";

function pwsh(modulePath: string, cert: string, token: string, command: string) {
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", `$m = Import-Module '${modulePath}' -PassThru; ${trust}${command}`],
    { env: { ...process.env, PASSBUNDLE_TOKEN: token, SSL_CERT_FILE: cert, NO_COLOR: "1" }, encoding: "utf8" },
  );
  // Errors as one line of plain text, however PowerShell wraps and colors them.
  const err = result.stderr.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
  return { status: result.status, out: result.stdout.trim().split(/\r?\n/), err };
}

/** The module as the server serves it, saved where PowerShell can load it. */
async function servedModule(request: APIRequestContext): Promise<string> {
  const served = await request.get("/api/keykeeper/script/PassBundle.psm1");
  expect(served.status()).toBe(200);
  const module = await served.text();
  expect(module).toContain(`$script:DefaultServer = 'https://127.0.0.1:${port}'`);
  const modulePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-module-")), "PassBundle.psm1");
  fs.writeFileSync(modulePath, module);
  return modulePath;
}

const vectors = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/vectors");

test("the PowerShell module the server serves passes the vectors' checks", async ({ request }) => {
  // The same checks tier 1 runs on Windows, under Windows PowerShell 5.1 too.
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(vectors, "check-script-module.ps1"),
      "-Module",
      await servedModule(request),
      "-Vectors",
      path.join(vectors, "script-access-v1.json"),
    ],
    { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain(": all passed");
  expect(result.stdout).not.toContain("FAIL");
});

test("the PowerShell module reads a token's credential, fields, and one-time code, and refuses what isn't the token's", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("module-owner");
  const orgId = await api.organization(owner, "Contoso");
  const item = await api.orgItem(owner, orgId, await api.collection(owner, orgId));

  const good = await makeToken(api, owner, orgId, item, (id, key) =>
    encrypt(
      key,
      JSON.stringify({
        v: 1,
        token: id,
        item,
        revision: "2026-10-20T18:00:00.000Z",
        name: "Domain admin",
        username: "admin@contoso.example",
        password: "not-a-real-password-1",
        totp: TOTP_SECRET,
        fields: { "API key": "k-123" },
      }),
    ),
  );

  const modulePath = await servedModule(request);
  const cert = await serverCertificate();

  const before = Date.now();
  const read = pwsh(
    modulePath,
    cert,
    good.tokenString,
    [
      `$c = Get-PassBundleCredential -Item 'Domain admin'`,
      "$c.UserName",
      "$c.GetNetworkCredential().Password",
      `Get-PassBundleSecret -Item 'Domain admin' -Field 'API key'`,
      `Get-PassBundleSecret -Item '${item}' -Field totp`,
    ].join("; "),
  );
  expect(read.status, read.err).toBe(0);
  expect(read.out.slice(0, 3)).toEqual(["admin@contoso.example", "not-a-real-password-1", "k-123"]);
  expect([totp(TOTP_SECRET, before), totp(TOTP_SECRET, Date.now())]).toContain(read.out[3]);

  // Not granted: a field the copy doesn't have, or an item by another name.
  const missing = pwsh(modulePath, cert, good.tokenString, `Get-PassBundleSecret -Item 'Domain admin' -Field 'PIN'`);
  expect(missing.status).not.toBe(0);
  expect(missing.err).toContain("wasn't granted 'PIN'");
  const other = pwsh(modulePath, cert, good.tokenString, `Get-PassBundleSecret -Item 'Wi-Fi' -Field password`);
  expect(other.err).toContain("can't read an item named 'Wi-Fi'");

  // A copy made for another item, and one not made with the token's key.
  const swapped = await makeToken(api, owner, orgId, item, (id, key) =>
    encrypt(key, JSON.stringify({ v: 1, token: id, item: randomUUID(), name: "Domain admin", fields: {} })),
  );
  const swappedRead = pwsh(modulePath, cert, swapped.tokenString, `Get-PassBundleSecret -Item '${item}' -Field password`);
  expect(swappedRead.err).toContain("made for another token or item");
  const forged = await makeToken(api, owner, orgId, item, () =>
    encrypt(randomBytes(64), JSON.stringify({ v: 1, name: "Domain admin", fields: {} })),
  );
  const forgedRead = pwsh(modulePath, cert, forged.tokenString, `Get-PassBundleSecret -Item '${item}' -Field password`);
  expect(forgedRead.err).toContain("integrity check");

  // Revoked: refused.
  await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/script-tokens/${good.id}`);
  const revoked = pwsh(modulePath, cert, good.tokenString, `Get-PassBundleSecret -Item '${item}' -Field password`);
  expect(revoked.status).not.toBe(0);
  expect(revoked.err).toContain("refused the token");
});

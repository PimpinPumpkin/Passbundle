// The client's address (DESIGN.md, "The client's address"): the server takes
// it from IP_HEADER only when the request comes from a proxy it trusts, so a
// header a client sends itself changes nothing: not a script token's
// networks, not limits, not logs. On a public DOMAIN the server doesn't start
// until IP_HEADER is chosen. The limits test server trusts no proxy at all
// (e2e/server.mjs), so here a forged header comes from an untrusted address.
// deploy/smoke.sh checks the hosted setup itself, behind a stand-in tunnel.
import { spawn } from "node:child_process";
import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { limitsServerPort, paths } from "../../paths.mjs";

import { Api, withMasterPassword, encString } from "./support";

// The master password these changes need is checked the way a sign-in is
// (600,000 rounds of PBKDF2 on the server, slow in its debug build), so tests
// that make several get more time.
test.describe.configure({ timeout: 120_000 });

test.use({ baseURL: `https://127.0.0.1:${limitsServerPort}` });

test("a forged address header doesn't get a script token past its networks", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("forged-ip-owner");
  const orgId = await api.organization(owner, "Forged Address");
  const item = await api.orgItem(owner, orgId, await api.collection(owner, orgId));
  const id = randomUUID();
  const authSecret = Buffer.from(hkdfSync("sha256", randomBytes(32), Buffer.alloc(0), "passbundle script auth v1", 32));
  const revision = (await api.call(owner, "GET", `/api/ciphers/${item}`)).body.revisionDate;
  const made = await api.call(
    owner,
    "POST",
    `/api/keykeeper/organizations/${orgId}/script-tokens`,
    withMasterPassword(owner, {
      id,
      name: "Office only",
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      networks: ["198.51.100.0/24"],
      authHash: createHash("sha256").update(authSecret).digest("base64"),
      sealedKey: encString("sealed"),
      grants: [{ itemId: item, copy: encString("copy"), revision, sealedSpec: encString("spec") }],
    }),
  );
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const authorization = `PassBundleScript ${id}.${authSecret.toString("base64url")}`;

  // The reviewer's request: an address inside the token's network, in every
  // header a proxy might use. None of them is believed from here.
  for (const header of ["X-Real-IP", "CF-Connecting-IP", "X-Forwarded-For"]) {
    const read = await request.get(`/api/keykeeper/script/items/${item}`, {
      headers: { Authorization: authorization, [header]: "198.51.100.7" },
    });
    expect(read.status(), header).toBe(401);
  }
  const reads = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/script-tokens/${id}/reads`);
  expect(reads.body.data.length).toBe(3);
  for (const r of reads.body.data) {
    expect(r).toMatchObject({ ip: "127.0.0.1", allowed: false, reason: "outside its networks" });
  }
});

/** A free TCP port on this machine. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Starts the server with these settings and a fresh data folder: its output, and whether it came up. */
async function start(env: Record<string, string>): Promise<{ up: boolean; output: string; code: number | null }> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-address-"));
  const port = await freePort();
  const child = spawn(paths.serverBin, [], {
    env: {
      PATH: process.env.PATH,
      DATA_FOLDER: data,
      ROCKET_ADDRESS: "127.0.0.1",
      ROCKET_PORT: String(port),
      WEB_VAULT_ENABLED: "false",
      DISABLE_ICON_DOWNLOAD: "true",
      LOG_LEVEL: "warn",
      ...env,
    },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  let up = false;
  for (let i = 0; i < 60 && child.exitCode === null; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${port}/alive`)).ok;
    } catch {
      // Not listening yet.
    }
    if (up) {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGTERM");
  const code = await exited;
  fs.rmSync(data, { recursive: true, force: true });
  return { up, output, code };
}

test("on a public address, the server doesn't start until the address header is chosen", async () => {
  test.setTimeout(120_000);
  const hosted = { DOMAIN: "https://vault.example.com" };
  const refused = await start(hosted);
  expect(refused.up, refused.output).toBe(false);
  expect(refused.code, refused.output).not.toBe(0);
  expect(refused.output).toMatch(/set IP_HEADER/);
  expect(refused.output).toMatch(/CF-Connecting-IP/);

  // Chosen: it starts, behind Cloudflare or with nothing in front.
  for (const header of ["CF-Connecting-IP", "none"]) {
    const started = await start({ ...hosted, IP_HEADER: header, IP_HEADER_TRUSTED_PROXIES: "172.30.53.2" });
    expect(started.up, `${header}: ${started.output}`).toBe(true);
  }
  // On this machine or a private network, the default still starts.
  const local = await start({ DOMAIN: "http://localhost:8000" });
  expect(local.up, local.output).toBe(true);
});

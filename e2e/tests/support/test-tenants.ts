// For the test tenants tool's tests (tools/test-tenants): a server of their
// own, set up as the hosted test server is while the tool seeds it
// (server.mjs, KK_LIKE_TEST_SERVER), running the tool as a person would, and
// reading what it writes and what the server keeps.
import { type ChildProcess, spawn } from "node:child_process";
import {
  constants,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  privateDecrypt,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, request as apiRequest } from "@playwright/test";

import { testTenantsServerPort } from "../../paths.mjs";
import type { State } from "../../../tools/test-tenants/seed.ts";
import { DOMAINS } from "../../../tools/test-tenants/tenants.ts";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoDir = path.resolve(e2eDir, "..");
const tool = path.join(repoDir, "tools", "test-tenants", "test-tenants.ts");

export const tenantsServer = `https://127.0.0.1:${testTenantsServerPort}`;

export type TenantsServer = { process: ChildProcess; dataDir: string; outDir: string };

/** Starts the server, with an empty data folder, and a folder for the tool's files. */
export async function startTenantsServer(): Promise<TenantsServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-test-tenants-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-test-tenants-out-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: testTenantsServerPort,
      KK_DATA_DIR: dataDir,
      KK_LIKE_TEST_SERVER: "1",
      KK_SIGNUPS_DOMAINS: DOMAINS.join(","),
    },
    stdio: "ignore",
  });
  const http = await apiRequest.newContext({ baseURL: tenantsServer, ignoreHTTPSErrors: true });
  try {
    await expect
      .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
      .toBe(200);
  } finally {
    await http.dispose();
  }
  return { process: child, dataDir, outDir };
}

export async function stopTenantsServer(server: TenantsServer | undefined) {
  if (!server) {
    return;
  }
  const exited = new Promise((resolve) => server.process.once("exit", resolve));
  server.process.kill("SIGTERM");
  await exited;
  fs.rmSync(server.dataDir, { recursive: true, force: true });
  fs.rmSync(server.outDir, { recursive: true, force: true });
}

export type Run = { code: number | null; stdout: string; stderr: string };

/** Runs the tool from the repository's root, as its README says, against this server unless told otherwise. */
export async function runTool(server: TenantsServer, ...args: string[]): Promise<Run> {
  const withServer = args.some((a) => a.startsWith("--server")) ? args : [...args, "--server", tenantsServer];
  const withOut = withServer.includes("--out") ? withServer : [...withServer, "--out", server.outDir];
  const child = spawn(process.execPath, [tool, ...withOut], { cwd: repoDir, env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

export const statePath = (server: TenantsServer) => path.join(server.outDir, "state.json");
export const credentialsPath = (server: TenantsServer) => path.join(server.outDir, "credentials.md");

export function readState(server: TenantsServer): State {
  return JSON.parse(fs.readFileSync(statePath(server), "utf8"));
}

/** Keeps what signing in changed (a device's token, a two-step code's step), as the tool would. */
export function writeState(server: TenantsServer, state: State) {
  fs.writeFileSync(statePath(server), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Everything the server's SQLite database holds, its write-ahead log included. */
export function databaseBytes(server: TenantsServer): Buffer {
  return Buffer.concat(
    ["db.sqlite3", "db.sqlite3-wal"]
      .map((f) => path.join(server.dataDir, f))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f)),
  );
}

/** Opens a type 2 value (AES-256-CBC with HMAC-SHA256), checking its MAC, as the apps do. */
export function open(key: Buffer, value: string): Buffer {
  const parts = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(value);
  expect(parts, "a type 2 encrypted value").toBeTruthy();
  const [iv, ct, mac] = parts!.slice(1).map((p) => Buffer.from(p, "base64"));
  const want = createHmac("sha256", key.subarray(32)).update(Buffer.concat([iv, ct])).digest();
  expect(want.length === mac.length && timingSafeEqual(want, mac), "its MAC checks out").toBe(true);
  const decipher = createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export const openText = (key: Buffer, value: string | null | undefined) =>
  value == null ? null : open(key, value).toString("utf8");

/** Opens a type 4 value (RSA-OAEP with SHA-1) with a PKCS #8 private key. */
export function unseal(privateKey: Buffer, value: string): Buffer {
  const parts = /^4\.(.+)$/.exec(value);
  expect(parts, "a type 4 encrypted value").toBeTruthy();
  return privateDecrypt(
    {
      key: createPrivateKey({ key: privateKey, format: "der", type: "pkcs8" }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from(parts![1], "base64"),
  );
}

// The command-line tool on a computer new to the account (DESIGN.md,
// "New-device check"): `login` with the master password prints the number to
// type on a device already signed in, waits, and logs in once it's typed
// there. On a test server of its own with the check on. The tool never
// approves anything itself.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { expect, request as apiRequest, test } from "@playwright/test";

import { brand, newDeviceServerPort } from "../../paths.mjs";
import { realAccount } from "../support/vault-crypto";

const cliBin = process.env.KK_CLI;
test.skip(!cliBin && !process.env.CI, "KK_CLI isn't set: build the command-line tool first (docs/cli.md)");

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = `https://127.0.0.1:${newDeviceServerPort}`;
const prefix: string = brand.cli.envPrefix;

let child: ChildProcess;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-new-device-cli-"));
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: { ...process.env, KK_PORT: newDeviceServerPort, KK_DATA_DIR: dataDir, KK_NEW_DEVICE: "1" },
    stdio: "ignore",
  });
  const http = await apiRequest.newContext({ baseURL: server, ignoreHTTPSErrors: true });
  await expect
    .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
    .toBe(200);
  await http.dispose();
});

test.afterAll(async () => {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** The test server's certificate, trusted as a self-hosted server's private CA would be. */
async function certificate(dir: string): Promise<string> {
  const der = await new Promise<Buffer>((resolve, reject) => {
    const socket = tls.connect(
      { host: "127.0.0.1", port: Number(newDeviceServerPort), rejectUnauthorized: false },
      () => {
        resolve(socket.getPeerCertificate(true).raw);
        socket.end();
      },
    );
    socket.on("error", reject);
  });
  const file = path.join(dir, "server.pem");
  fs.writeFileSync(
    file,
    `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`,
  );
  return file;
}

test("login on a new computer prints the number, waits, and logs in once it's typed on another device", async () => {
  test.setTimeout(180_000);
  const http = await apiRequest.newContext({ baseURL: server, ignoreHTTPSErrors: true });
  // Signing up signs in the account's first device, which isn't asked.
  const ana = await realAccount(http, "cli-new-device");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-cli-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    [`${prefix}APPDATA_DIR`]: path.join(home, "data"),
    [`${prefix}NOINTERACTION`]: "true",
    NODE_EXTRA_CA_CERTS: await certificate(home),
    ANA_PASSWORD: ana.password,
  };
  const config = spawn(cliBin!, ["config", "server", server], { env });
  expect(await new Promise((resolve) => config.once("exit", resolve))).toBe(0);

  const login = spawn(cliBin!, ["login", ana.email, "--passwordenv", "ANA_PASSWORD"], { env });
  let stdout = "";
  let stderr = "";
  login.stdout.on("data", (d) => (stdout += d));
  login.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => login.once("exit", resolve));

  await expect.poll(() => stderr, { timeout: 60_000 }).toMatch(/type this number: \d{2}/);
  expect(stderr).toContain("This computer is new to your account");
  const number = /type this number: (\d{2})/.exec(stderr)![1];

  // The account's other device lists it as the CLI, and approves it with the number.
  const auth = { Authorization: `Bearer ${ana.token}` };
  const listed = await (await http.get("/api/keykeeper/new-device-checks", { headers: auth })).json();
  expect(listed.data).toHaveLength(1);
  expect(listed.data[0].device).toMatch(/^CLI on /);
  const approved = await http.post(`/api/keykeeper/new-device-checks/${listed.data[0].id}/approve`, {
    headers: auth,
    data: { number },
  });
  expect(approved.status(), await approved.text()).toBe(200);

  expect(await exited, stdout + stderr).toBe(0);
  expect(stdout).toContain("You are logged in!");
  await http.dispose();
  fs.rmSync(home, { recursive: true, force: true });
});

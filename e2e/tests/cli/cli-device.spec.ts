// The command-line tool signing in with another device's approval, master
// password re-prompt in a script, and `update` before the CLI release key is
// made (DESIGN.md, "Command-line tool": "Signing in with a device's
// approval", "Master password re-prompt", and "Updating itself"). The tool is
// KK_CLI, as tier 1 packs it; the approving device is the web vault, signed
// in with the master password, in Playwright's browser.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, type Page, test } from "@playwright/test";

import { brand, port } from "../../paths.mjs";
import { serverCertificate } from "../support/core";
import { fingerprintPhraseSource } from "../support/fingerprint";
import { apiKey, realAccount, type RealAccount, realPersonalLogin } from "../support/vault-crypto";

const cliBin = process.env.KK_CLI;
test.skip(!cliBin && !process.env.CI, "KK_CLI isn't set: build the command-line tool first (docs/cli.md)");

const server = `https://127.0.0.1:${port}`;
const prefix: string = brand.cli.envPrefix;
const metaRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Work to do when the current test ends, passed or failed. */
const cleanups: (() => void)[] = [];
test.afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
});

type Run = { status: number | null; stdout: string; stderr: string };

/** The tool with a data folder of its own, trusting the test server's certificate, as a script runs it. */
async function toolFor(name: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `pb-${name}-`));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    [`${prefix}APPDATA_DIR`]: path.join(home, "data"),
    [`${prefix}NOINTERACTION`]: "true",
    NODE_EXTRA_CA_CERTS: await serverCertificate(home),
  };
  const run = (args: string[], more: Record<string, string> = {}): Run => {
    const result = spawnSync(cliBin!, args, {
      env: { ...env, ...more },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const start = (args: string[]) => {
    const child: ChildProcess = spawn(cliBin!, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => child.kill());
    const out = { stdout: "", stderr: "" };
    child.stdout!.on("data", (d) => (out.stdout += d));
    child.stderr!.on("data", (d) => (out.stderr += d));
    const ended = new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { child, out, ended };
  };
  return { run, start };
}

/** Signs in to the web vault with the master password, as the person does. */
async function logIn(page: Page, account: RealAccount) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(account.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/#\/vault/, { timeout: 60_000 });
}

test("the web vault approves the tool's sign-in, and the tool signs in and lists items", async ({ page, request }) => {
  test.setTimeout(300_000);
  const ana = await realAccount(request, "cli-device");
  const router = await realPersonalLogin(request, ana, {
    name: "Office router",
    username: "admin",
    password: "router-password-1",
    uri: "https://192.168.1.1",
  });
  const { run, start } = await toolFor("cli-device");
  expect(run(["config", "server", server]).status).toBe(0);

  // A computer the tool never signed in from can't ask: the server takes a
  // request only from a device that signed in to the account before.
  const unknown = run(["login", ana.email, "--device"]);
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain("works only on a computer where the tool has signed in to your account before");

  // So she signs in here once with her master password, and signs out.
  const first = run(["login", ana.email, "--passwordenv", "PB_PASSWORD", "--raw"], { PB_PASSWORD: ana.password });
  expect(first.status, first.stderr).toBe(0);
  expect(run(["logout"]).status).toBe(0);

  // Then asks with --device: the phrase comes first, on stderr.
  const asking = start(["login", ana.email, "--device", "--raw"]);
  await expect.poll(() => asking.out.stderr, { timeout: 60_000 }).toMatch(new RegExp(`^Fingerprint phrase: ${fingerprintPhraseSource}\n`));
  const phrase = /^Fingerprint phrase: (\S+)/.exec(asking.out.stderr)![1];
  expect(asking.out.stderr).toContain("approve this sign-in only if that device shows this same phrase");
  expect(asking.out.stdout).toBe("");

  // The web vault, signed in with her master password, shows the tool's
  // request on Settings, Security, Devices, with the same phrase, and approves
  // it once she types her master password again.
  await logIn(page, ana);
  await page.goto("/#/settings/security/device-management");
  const pending = page.getByRole("row").filter({ hasText: "Request pending" });
  await expect(pending).toHaveCount(1, { timeout: 30_000 });
  await expect(pending).toContainText("CLI");
  await pending.getByRole("link").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Sign-in request")).toBeVisible();
  await expect(dialog.getByText(phrase, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm access" }).click();
  // The web vault asks for her master password before it sends the key.
  const confirm = page.getByTestId("keykeeper-confirm-approval");
  await confirm.getByRole("textbox", { name: /Master password/ }).fill(ana.password);
  await confirm.getByRole("button", { name: "Approve" }).click();

  // The tool signs in, unlocked with the user key the approval wrapped to its
  // request, and prints its session key.
  expect(await asking.ended, asking.out.stderr).toBe(0);
  const session = asking.out.stdout.trim();
  expect(session).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
  const status = JSON.parse(run(["status"], { [`${prefix}SESSION`]: session }).stdout);
  expect(status.status).toBe("unlocked");
  expect(status.userEmail).toBe(ana.email);
  const listed = run(["list", "items"], { [`${prefix}SESSION`]: session });
  expect(listed.status, listed.stderr).toBe(0);
  const items = JSON.parse(listed.stdout);
  expect(items.map((i: { id: string }) => i.id)).toContain(router);
  expect(items.find((i: { id: string }) => i.id === router).login.password).toBe("router-password-1");

  // Ctrl-C stops the next request's wait, and signs nothing in.
  expect(run(["logout"]).status).toBe(0);
  const again = start(["login", ana.email, "--device"]);
  await expect.poll(() => again.out.stderr, { timeout: 60_000 }).toContain("Fingerprint phrase:");
  again.child.kill("SIGINT");
  expect(await again.ended).toBe(1);
  expect(again.out.stderr).toContain("Stopped. Nothing was signed in.");
  expect(JSON.parse(run(["status"]).stdout).status).toBe("unauthenticated");
});

test("a script's get password is refused for an item that asks for the master password again, and given with --reprompt-ok", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const ana = await realAccount(request, "cli-reprompt");
  const guarded = await realPersonalLogin(
    request,
    ana,
    { name: "Domain admin", username: "administrator", password: "domain-admin-password", uri: "https://dc.example" },
    { reprompt: 1 },
  );
  const open = await realPersonalLogin(request, ana, {
    name: "Printer",
    username: "printer",
    password: "printer-password",
    uri: "https://printer.example",
  });
  const key = await apiKey(request, ana);
  const { run } = await toolFor("cli-reprompt");
  expect(run(["config", "server", server]).status).toBe(0);
  expect(
    run(["login", "--apikey"], { [`${prefix}CLIENTID`]: key.clientId, [`${prefix}CLIENTSECRET`]: key.clientSecret })
      .status,
  ).toBe(0);
  const unlocked = run(["unlock", "--passwordenv", "PB_PASSWORD", "--raw"], { PB_PASSWORD: ana.password });
  expect(unlocked.status, unlocked.stderr).toBe(0);
  const withSession = { [`${prefix}SESSION`]: unlocked.stdout.trim() };

  // Refused: a script can't be asked for the master password.
  const refused = run(["get", "password", guarded], withSession);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain('This item asks for your master password again ("Master password re-prompt")');
  expect(refused.stderr).toContain("--reprompt-ok");
  expect(refused.stderr).not.toContain("domain-admin-password");
  // So is the whole item, while its plain values still list.
  expect(run(["get", "item", guarded], withSession).status).toBe(1);
  const listed = JSON.parse(run(["list", "items"], withSession).stdout);
  const shown = listed.find((i: { id: string }) => i.id === guarded);
  expect(shown.login.username).toBe("administrator");
  expect(shown.login.password).toBeNull();
  expect(shown.reprompt).toBe(1);
  expect(JSON.stringify(listed)).not.toContain("domain-admin-password");
  // An item that doesn't ask is as before.
  expect(run(["get", "password", open], withSession).stdout).toBe("printer-password");

  // A script approved for such items says so.
  const approved = run(["get", "password", guarded, "--reprompt-ok"], withSession);
  expect(approved.status, approved.stderr).toBe(0);
  expect(approved.stdout).toBe("domain-admin-password");
});

test("update says updates aren't available yet before the CLI release key is made, and contacts nothing", async () => {
  // The CLI release key's public half, as the release workflow pins it and as
  // the tool has it compiled in (passbundle-clients' brand.json): the tool
  // must take what the workflow signs with, and expect no signature while
  // the workflow makes none.
  const workflow = fs.readFileSync(path.join(metaRoot, ".github/workflows/cli-release.yml"), "utf8");
  const pinned = /^\s*CLI_RELEASE_PUBLIC_KEY:\s*"([0-9a-f]*)"\s*$/m.exec(workflow);
  expect(pinned, "cli-release.yml pins CLI_RELEASE_PUBLIC_KEY").not.toBeNull();
  const keys: string[] = brand.cli.releaseKeys;
  expect(Array.isArray(keys), "brand.json has cli.releaseKeys").toBe(true);
  for (const key of keys) {
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  }
  if (pinned![1] === "") {
    expect(keys).toEqual([]);
  } else {
    expect(keys).toContain(pinned![1]);
    expect(fs.readFileSync(path.join(metaRoot, "docs/cli.md"), "utf8")).toContain(pinned![1]);
  }
  expect(brand.cli.releaseRepository).toBe("PimpinPumpkin/Passbundle");

  // Tier 1's copy is no release's (its version is 0.0.0-test), and while no
  // key is pinned, it says updates aren't available yet. Either way it
  // refuses before contacting anything: tier 1 has no network.
  const { run } = await toolFor("cli-update");
  for (const args of [["update"], ["update", "--check"]]) {
    const update = run(args);
    expect(update.status).toBe(1);
    expect(update.stdout).toBe("");
    if (keys.length === 0) {
      expect(update.stderr).toContain("Updates aren't available yet: releases of the PassBundle CLI aren't signed yet");
      expect(update.stderr).toContain(brand.cli.releases);
    } else {
      expect(update.stderr).toContain("wasn't built by a release, so it doesn't update itself");
    }
  }
});

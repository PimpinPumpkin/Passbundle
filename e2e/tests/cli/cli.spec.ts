// The command-line tool (docs/cli.md), as a technician's script runs it: the
// built program (KK_CLI, from passbundle-clients apps/cli; tier 1 builds it
// as the release does), against the test server. A member signs in with an
// API key, lists items, gets a password from a shared folder where she may
// see passwords, and is refused one where she may not ("see passwords",
// DESIGN.md, "Folders and permissions"). The accounts, the organization, and
// its items have real keys (tests/support/vault-crypto.ts), since the tool
// decrypts what the server sends.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { brand, port } from "../../paths.mjs";
import { serverCertificate } from "../support/core";
import {
  apiKey,
  editLogin,
  realAccount,
  realCollection,
  realLogin,
  realMember,
  realOrganization,
} from "../support/vault-crypto";

const cliBin = process.env.KK_CLI;
// Tier 1 always builds the tool; only a local run without one skips.
test.skip(
  !cliBin && !process.env.CI,
  "KK_CLI isn't set: build the command-line tool first (docs/cli.md)",
);

const server = `https://127.0.0.1:${port}`;
const command: string = brand.cli.command;
const prefix: string = brand.cli.envPrefix;

type Run = {
  status: number | null;
  stdout: string;
  stderr: string;
  json?: any;
};

/**
 * A run of the tool with its own data folder and this environment only (plus
 * PATH), trusting the test server's certificate as a self-hosted server's
 * private CA would be trusted (NODE_EXTRA_CA_CERTS).
 */
function tool(base: Record<string, string>) {
  return (args: string[], env: Record<string, string> = {}): Run => {
    const result = spawnSync(cliBin!, args, {
      env: { PATH: process.env.PATH ?? "", ...base, ...env },
      encoding: "utf8",
      timeout: 120_000,
    });
    const run: Run = {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    try {
      run.json = JSON.parse(result.stdout);
    } catch {
      // Not JSON.
    }
    return run;
  };
}

test.describe.configure({ mode: "serial" });

test("a technician's script signs in with an API key, lists items, and gets only the passwords the folder lets her see", async ({
  request,
}) => {
  test.setTimeout(300_000);
  expect(cliBin, "tier 1 sets KK_CLI").toBeTruthy();

  // An organization with two shared folders: one where Ana may see
  // passwords ("Can view"), one where she may only use them ("Can view but
  // not see passwords").
  const owner = await realAccount(request, "cli-owner");
  const ana = await realAccount(request, "cli-ana");
  const org = await realOrganization(request, owner, "Contoso");
  const visible = await realCollection(request, owner, org, "Servers");
  const hidden = await realCollection(request, owner, org, "Domain admins");
  await realMember(request, owner, org, ana, [
    { id: visible, readOnly: true, hidePasswords: false, manage: false },
    { id: hidden, readOnly: true, hidePasswords: true, manage: false },
  ]);
  const webServer = await realLogin(request, owner, org, visible, {
    name: "Web server",
    username: "deploy",
    password: "web-server-old-password",
    uri: "https://web.contoso.example",
  });
  await editLogin(request, owner, org, webServer, {
    name: "Web server",
    username: "deploy",
    password: "web-server-password-1",
    uri: "https://web.contoso.example",
  });
  const domainAdmin = await realLogin(request, owner, org, hidden, {
    name: "Domain admin",
    username: "administrator",
    password: "domain-admin-old-password",
    uri: "https://dc.contoso.example",
  });
  await editLogin(request, owner, org, domainAdmin, {
    name: "Domain admin",
    username: "administrator",
    password: "domain-admin-password-1",
    uri: "https://dc.contoso.example",
    totp: "JBSWY3DPEHPK3PXP",
  });
  const key = await apiKey(request, ana);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-cli-"));
  // As a script runs it: never waiting for someone to type.
  const run = tool({
    HOME: home,
    [`${prefix}APPDATA_DIR`]: path.join(home, "data"),
    [`${prefix}NOINTERACTION`]: "true",
    NODE_EXTRA_CA_CERTS: await serverCertificate(home),
  });

  // The product's own version, and where to get the newest; it doesn't update itself.
  expect(run(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  const update = run(["update"]);
  expect(update.status).toBe(0);
  expect(update.stdout).toContain(brand.cli.releases);

  // Self-hosted: her MSP's server.
  expect(run(["config", "server", server]).status).toBe(0);
  expect(run(["config", "server"]).stdout.trim()).toBe(server);

  // Upstream's variables, left in a shell for another product's tool, are
  // never used: not its API key, which would go to this server.
  const theirs = run(["login", "--apikey"], {
    BW_CLIENTID: key.clientId,
    BW_CLIENTSECRET: key.clientSecret,
  });
  expect(theirs.status).toBe(1);
  expect(theirs.stdout + theirs.stderr).toContain("client_id is required");

  // Sign in with the API key, then unlock with the master password from a
  // variable the script names.
  const login = run(["login", "--apikey"], {
    [`${prefix}CLIENTID`]: key.clientId,
    [`${prefix}CLIENTSECRET`]: key.clientSecret,
  });
  expect(login.status, login.stdout + login.stderr).toBe(0);
  expect(login.stdout).toContain("You are logged in!");
  // Its messages name the brand's variable and command.
  expect(login.stdout).toContain(`export ${prefix}SESSION=`);
  expect(login.stdout).toContain(`$ ${command} list items --session`);
  const unlock = run(["unlock", "--passwordenv", "ANA_PASSWORD", "--raw"], {
    ANA_PASSWORD: ana.password,
  });
  expect(unlock.status, unlock.stdout + unlock.stderr).toBe(0);
  const session = unlock.stdout.trim();
  expect(session.length).toBeGreaterThan(40);
  const as = { [`${prefix}SESSION`]: session };

  // Upstream's session variable unlocks nothing.
  const locked = run(["get", "password", webServer], { BW_SESSION: session });
  expect(locked.status).toBe(1);
  expect(locked.stdout + locked.stderr).toContain("Vault is locked.");

  // Both items are listed; the hidden one without its password.
  const listed = run(["list", "items", "--response"], as);
  expect(listed.status, listed.stdout + listed.stderr).toBe(0);
  const items = listed.json.data.data;
  expect(items.map((i: any) => i.name).sort()).toEqual([
    "Domain admin",
    "Web server",
  ]);
  const listedHidden = items.find((i: any) => i.id === domainAdmin);
  expect(listedHidden.login.username).toBe("administrator");
  expect(listedHidden.login.password).toBeNull();
  expect(listed.stdout).not.toContain("domain-admin-password-1");
  expect(listed.stdout).not.toContain("domain-admin-old-password");
  expect(listed.stdout).not.toContain("JBSWY3DPEHPK3PXP");

  // The password she may see.
  const password = run(["get", "password", "web.contoso.example"], as);
  expect(password.status, password.stdout + password.stderr).toBe(0);
  expect(password.stdout).toBe("web-server-password-1");

  // And the one she may not: refused, by id and by search, in every form.
  for (const args of [
    ["get", "password", domainAdmin],
    ["get", "password", "dc.contoso.example"],
    ["get", "totp", domainAdmin],
    ["get", "exposed", domainAdmin],
  ]) {
    const refused = run(args, as);
    expect(refused.status, args.join(" ")).toBe(1);
    expect(refused.stdout + refused.stderr).toContain(
      "You can't see this item's passwords",
    );
    expect(refused.stdout + refused.stderr).not.toContain(
      "domain-admin-password-1",
    );
  }
  const item = run(["get", "item", domainAdmin], as);
  expect(item.status).toBe(0);
  expect(JSON.parse(item.stdout).login.username).toBe("administrator");
  expect(item.stdout).not.toContain("domain-admin-password-1");
  expect(run(["get", "username", domainAdmin], as).stdout).toBe(
    "administrator",
  );

  // Each folder says what she may do there.
  const collections = run(["list", "collections"], as).json;
  const permissions = Object.fromEntries(
    collections.map((c: any) => [c.id, c.permissions]),
  );
  expect(permissions[visible]).toMatchObject({
    seePasswords: true,
    edit: false,
    viewHistory: true,
  });
  expect(permissions[hidden]).toMatchObject({
    seePasswords: false,
    edit: false,
    viewHistory: true,
  });

  // Item history: the old password where she may see passwords, and only
  // when and by whom where she may not.
  const history = run(["get", "history", webServer], as);
  expect(history.status, history.stdout + history.stderr).toBe(0);
  const versions = JSON.parse(history.stdout);
  expect(versions[0].item.login.password).toBe("web-server-old-password");
  // Who saved it, as the server lets a regular member see them: someone else.
  expect(versions[0].savedBy).toEqual({ id: null, name: null, email: null });
  const hiddenHistory = run(["get", "history", domainAdmin], as);
  expect(
    hiddenHistory.status,
    hiddenHistory.stdout + hiddenHistory.stderr,
  ).toBe(0);
  expect(JSON.parse(hiddenHistory.stdout)[0].item).toBeNull();
  expect(hiddenHistory.stdout).not.toContain("domain-admin-old-password");

  // Item templates: the built-in ones, and a new item from one.
  const templates = run(["list", "templates"], as).json;
  expect(templates.map((t: any) => t.id)).toContain("wifi");
  const wifi = JSON.parse(run(["get", "template", "Wi-Fi network"], as).stdout);
  expect(wifi.fields.map((f: any) => f.name)).toEqual(
    expect.arrayContaining(["Network name", "Password", "Security type"]),
  );

  // Locking ends the session.
  expect(run(["lock"], as).status).toBe(0);
  const afterLock = run(["get", "password", webServer], as);
  expect(afterLock.status).toBe(1);
  expect(run(["logout"], as).status).toBe(0);
});

test("help and messages are PassBundle's: no upstream name, command, or variables", async () => {
  test.setTimeout(180_000);
  expect(cliBin, "tier 1 sets KK_CLI").toBeTruthy();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-cli-help-"));
  const run = tool({
    HOME: home,
    [`${prefix}APPDATA_DIR`]: path.join(home, "data"),
  });

  const top = run(["--help"]);
  expect(top.status).toBe(0);
  expect(top.stdout).toContain(`Usage: ${command} `);
  // Every command's own help, from the list the top help gives.
  const commands = [...top.stdout.matchAll(/^ {2}([a-z][a-z-]*) /gm)].map(
    (m) => m[1],
  );
  expect(commands).toEqual(
    expect.arrayContaining([
      "login",
      "unlock",
      "get",
      "list",
      "serve",
      "update",
    ]),
  );
  const texts = [top.stdout + top.stderr];
  for (const name of commands.filter((c) => c !== "help")) {
    const help = run([name, "--help"]);
    texts.push(`${name}: ${help.stdout}${help.stderr}`);
  }
  for (const help of texts) {
    // Import formats are named after the apps they come from, upstream's too.
    const text = help.replace(
      /\bbitwarden(csv|json|passwordprotected)\b/g,
      "<import format>",
    );
    expect(text).not.toMatch(/Bitwarden/i);
    expect(text).not.toMatch(/\bbw\b/);
    expect(text).not.toMatch(/\bBW_/);
    // Upstream's Secrets Manager isn't advertised, and isn't a command.
    expect(text).not.toMatch(/Secrets Manager/i);
  }
  expect(texts.join("\n")).toContain(`${command} login`);
  // The default server is ours.
  expect(run(["config", "server"]).stdout.trim()).toBe(brand.urls.webVault);
});

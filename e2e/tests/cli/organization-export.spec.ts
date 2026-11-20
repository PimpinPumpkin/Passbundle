// Exporting an organization's items with the command-line tool
// (`export --organizationid`), by role (DESIGN.md, "Folders and
// permissions", B39). Owners, admins, and a custom role with import and
// export and access to all items get the server's export of the whole
// organization, items in no folder included. Everyone else gets the shared
// folders where they can export, from their own synced items, as the web
// vault's Export does: never the server's export, which refuses them (and
// whose 401 used to sign a regular member out of the tool).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { brand, port } from "../../paths.mjs";
import { serverCertificate } from "../support/core";
import { exportedNames, exportScenario } from "../support/organization-export";
import { apiKey, type RealAccount } from "../support/vault-crypto";

const cliBin = process.env.KK_CLI;
// Tier 1 always builds the tool; only a local run without one skips.
test.skip(!cliBin && !process.env.CI, "KK_CLI isn't set: build the command-line tool first (docs/cli.md)");

const server = `https://127.0.0.1:${port}`;
const prefix: string = brand.cli.envPrefix;

/** The tool, signed in with the account's API key and unlocked, in a data folder of its own, as a script runs it. */
async function signedIn(request: Parameters<typeof apiKey>[0], account: RealAccount) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-cli-export-"));
  const base = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    [`${prefix}APPDATA_DIR`]: path.join(home, "data"),
    [`${prefix}NOINTERACTION`]: "true",
    NODE_EXTRA_CA_CERTS: await serverCertificate(home),
  };
  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(cliBin!, args, {
      env: { ...base, ...env },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout };
  };
  expect(run(["config", "server", server]).status).toBe(0);
  const key = await apiKey(request, account);
  const login = run(["login", "--apikey"], {
    [`${prefix}CLIENTID`]: key.clientId,
    [`${prefix}CLIENTSECRET`]: key.clientSecret,
  });
  expect(login.status, login.out).toBe(0);
  const unlock = run(["unlock", "--passwordenv", "PB_PASSWORD", "--raw"], { PB_PASSWORD: account.password });
  expect(unlock.status, unlock.out).toBe(0);
  const session = { [`${prefix}SESSION`]: unlock.stdout.trim() };
  return {
    home,
    run: (args: string[]) => run(args, session),
  };
}

test("each role's export of an organization from the command line holds what that role may export, and never signs anyone out", async ({
  request,
}) => {
  test.setTimeout(300_000);
  expect(cliBin, "tier 1 sets KK_CLI").toBeTruthy();
  const s = await exportScenario(request, "cli-export");

  /** `export --organizationid` as this account: the file's names, or the refusal. */
  async function exportAs(account: RealAccount) {
    const tool = await signedIn(request, account);
    const file = path.join(tool.home, "org.json");
    const exported = tool.run(["export", "--organizationid", s.org.id, "--format", "json", "--output", file]);
    // Still signed in and unlocked, whatever the export said.
    const after = tool.run(["status"]);
    expect(after.status, after.out).toBe(0);
    expect(JSON.parse(after.stdout).status).toBe("unlocked");
    if (exported.status !== 0) {
      expect(fs.existsSync(file)).toBe(false);
      return { refused: exported.out };
    }
    return { ...exportedNames(JSON.parse(fs.readFileSync(file, "utf8"))), file };
  }

  // The owner and a custom role with import and export and access to all
  // items: the whole organization, the item in no folder too.
  for (const account of [s.owner, s.allItems]) {
    const got = await exportAs(account);
    expect(got.refused, account.email).toBeUndefined();
    expect(got.items, account.email).toEqual(s.everything);
    expect(got.folders, account.email).toEqual(expect.arrayContaining(s.folders));
  }

  // A regular member, and a custom role with import and export but not
  // access to all items: Reports, where they can export, and nothing from
  // Payroll (view only), Domain admins (passwords hidden), Archive (not
  // theirs), or the item in no folder. The item in Reports and Payroll goes,
  // with its password. The same for a member who can export every folder
  // she reaches (only Reports), whom the server's export refuses with 401.
  for (const account of [s.everyFolder, s.member, s.customRole]) {
    const got = await exportAs(account);
    expect(got.refused, account.email).toBeUndefined();
    expect(got.items, account.email).toEqual(s.theirs.items);
    expect(got.folders, account.email).toEqual(s.theirs.folders);
    const text = fs.readFileSync(got.file!, "utf8");
    expect(text).toContain("shared-drive-password");
    expect(text).not.toContain("payroll-portal-password");
    expect(text).not.toContain("domain-admin-password");
  }

  // Someone who can export none of the folders she reaches is told so, with
  // no file.
  const none = await exportAs(s.noExport);
  expect(none.refused).toContain("You can't export any of this organization's shared folders.");
});

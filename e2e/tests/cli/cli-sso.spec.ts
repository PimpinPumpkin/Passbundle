// The command-line tool signs in with an organization's single sign-on
// (DESIGN.md, "Sign in with Microsoft Entra ID"), as upstream's tool does:
// it listens on http://localhost (the first free port of 8065 to 8070),
// opens the web vault's sign-in page in a browser, and the server sends the
// answer back to that listener. Here the browser is Playwright's, the tool's
// own attempt to open one goes nowhere (stand-ins for `open` and `xdg-open`),
// and Microsoft is the local stand-in (e2e/entra-standin.mjs).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium, expect, test } from "@playwright/test";

import { brand, port } from "../../paths.mjs";
import { serverCertificate } from "../support/core";
import {
  linkFromSession,
  newIdentifier,
  settings,
  Tenant,
} from "../support/entra";
import {
  realAccount,
  realMember,
  realOrganization,
} from "../support/vault-crypto";

const cliBin = process.env.KK_CLI;
test.skip(
  !cliBin && !process.env.CI,
  "KK_CLI isn't set: build the command-line tool first (docs/cli.md)",
);
// The tool opens a browser with `open` (macOS) or `xdg-open` (Linux).
test.skip(
  process.platform === "win32",
  "the stand-in for opening a browser is a shell script",
);

const server = `https://127.0.0.1:${port}`;
const command: string = brand.cli.command;
const prefix: string = brand.cli.envPrefix;

test("a member signs in from the command-line tool with her organization's single sign-on", async ({
  request,
}) => {
  test.setTimeout(180_000);
  expect(cliBin, "tier 1 sets KK_CLI").toBeTruthy();
  // Real keys, since the tool syncs and reads the organization's key.
  const owner = await realAccount(request, "cli-sso-owner");
  const member = await realAccount(request, "cli-sso-ana");
  const org = await realOrganization(request, owner, "Fabrikam");
  await realMember(request, owner, org, member, []);
  const tenant = await new Tenant().register();
  const identifier = newIdentifier("cli");
  const saved = await request.put(
    `/api/keykeeper/organizations/${org.id}/sso`,
    {
      headers: { Authorization: `Bearer ${owner.token}` },
      data: settings(tenant, identifier),
    },
  );
  expect(saved.status(), await saved.text()).toBe(200);
  // She links her account from her own session first, as in the web vault.
  const ana = await tenant.person(member.email);
  await tenant.next(ana);
  const linked = await linkFromSession(
    request,
    server,
    { token: member.token, password: member.passwordHash },
    identifier,
  );
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-cli-sso-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  for (const opener of ["open", "xdg-open"]) {
    fs.writeFileSync(path.join(bin, opener), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    [`${prefix}APPDATA_DIR`]: path.join(home, "data"),
    NODE_EXTRA_CA_CERTS: await serverCertificate(home),
  };
  type Done = { status: number | null; stdout: string; stderr: string };
  /** Starts the tool: when it ends, and the address it says it opens, if it does. */
  const start = (args: string[]) => {
    const child = spawn(cliBin!, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let opened: (url: string) => void = () => {};
    const url = new Promise<string>((resolve) => (opened = resolve));
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      const at = /go to:\s*(\S+)/.exec(stderr);
      if (at) {
        opened(at[1]);
      }
    });
    const done = new Promise<Done>((resolve) =>
      child.on("close", (status) => resolve({ status, stdout, stderr })),
    );
    return { done, url };
  };
  const run = (args: string[]) => start(args).done;

  const configured = await run(["config", "server", server]);
  expect(configured.status, configured.stderr).toBe(0);

  // The tool prints the address it opens, on stderr, and waits for the answer.
  await tenant.next(ana);
  // Something else already has the first port: the tool takes the next.
  const busy = net.createServer();
  await new Promise<void>((resolve) => busy.listen(8065, "localhost", resolve));
  const signIn = start(["login", "--sso", identifier]);
  const address = await signIn.url;
  expect(address).toContain(
    `${server}/#/sso?clientId=cli&redirectUri=${encodeURIComponent("http://localhost:8066")}&`,
  );
  expect(address).toContain(`&identifier=${identifier}`);

  // Her browser: the web vault's sign-in page, then Microsoft, then back to
  // the tool's listener. Only 127.0.0.1 and localhost resolve.
  const browser = await chromium.launch({
    args: [
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    ],
  });
  try {
    const page = await (
      await browser.newContext({ ignoreHTTPSErrors: true })
    ).newPage();
    await page.goto(address);
    // A link alone never starts the tool's sign-in: the page says what it's
    // for and waits for Continue.
    await expect(page.getByTestId("sso-for-command-line")).toContainText(
      "command-line tool on this computer",
    );
    await expect(page.getByRole("textbox", { name: "SSO identifier" })).toHaveValue(identifier);
    expect(page.url()).toContain("/#/sso?clientId=cli");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/^http:\/\/localhost:8066\//);
    await expect(page.getByRole("heading")).toHaveText(
      `Successfully authenticated with the ${brand.name} CLI`,
    );
  } finally {
    await browser.close();
  }

  const done = await signIn.done;
  busy.close();
  expect(done.status, done.stdout + done.stderr).toBe(0);
  expect(done.stdout).toContain("You are logged in!");
  expect(done.stdout).toContain(`$ ${command} unlock`);
  const status = await run(["status"]);
  expect(JSON.parse(status.stdout)).toMatchObject({
    userEmail: member.email,
    status: "locked",
  });
});

test("with Require single sign-on, the tool says how to sign in, and an API key still signs in", async ({
  request,
}) => {
  test.setTimeout(180_000);
  expect(cliBin, "tier 1 sets KK_CLI").toBeTruthy();
  const owner = await realAccount(request, "cli-req-owner");
  const linkedMember = await realAccount(request, "cli-req-ana");
  const notLinked = await realAccount(request, "cli-req-ben");
  const org = await realOrganization(request, owner, "Northwind");
  await realMember(request, owner, org, linkedMember, []);
  await realMember(request, owner, org, notLinked, []);
  const tenant = await new Tenant().register();
  const identifier = newIdentifier("cli-req");
  const auth = { Authorization: `Bearer ${owner.token}` };
  expect(
    (
      await request.put(`/api/keykeeper/organizations/${org.id}/sso`, {
        headers: auth,
        data: settings(tenant, identifier),
      })
    ).status(),
  ).toBe(200);
  await tenant.next(await tenant.person(linkedMember.email));
  expect(
    (
      await linkFromSession(
        request,
        server,
        { token: linkedMember.token, password: linkedMember.passwordHash },
        identifier,
      )
    ).status,
  ).toBe(200);
  for (const type of [3, 4]) {
    const on = await request.put(
      `/api/organizations/${org.id}/policies/${type}`,
      {
        headers: auth,
        data: { policy: { enabled: true, data: null } },
      },
    );
    expect(on.status(), await on.text()).toBe(200);
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-cli-req-"));
  const tool = (
    dir: string,
    args: string[],
    extra: Record<string, string> = {},
  ) => {
    const result = spawnSync(cliBin!, args, {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        [`${prefix}APPDATA_DIR`]: path.join(home, dir),
        [`${prefix}NOINTERACTION`]: "true",
        NODE_EXTRA_CA_CERTS: certificate,
        ...extra,
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: result.status, out: result.stdout + result.stderr };
  };
  const certificate = await serverCertificate(home);
  for (const dir of ["ana", "ben", "ana-key"]) {
    expect(tool(dir, ["config", "server", server]).status).toBe(0);
  }

  // A script can't open a browser: it's told how to sign in instead.
  const linked = tool(
    "ana",
    ["login", linkedMember.email, "--passwordenv", "PW"],
    { PW: linkedMember.password },
  );
  expect(linked.status).toBe(1);
  expect(linked.out).toContain("requires you to sign in with single sign-on");
  expect(linked.out).toContain(`${command} login --sso ${identifier}`);

  // Someone not linked yet links in the web vault first.
  const unlinked = tool(
    "ben",
    ["login", notLinked.email, "--passwordenv", "PW"],
    { PW: notLinked.password },
  );
  expect(unlinked.status).toBe(1);
  expect(unlinked.out).toContain("isn't linked to it yet");

  // An API key skips the requirement, as upstream's does (the organization's
  // Single sign-on page can replace members' keys).
  const answer = await request.post("/api/accounts/api-key", {
    headers: { Authorization: `Bearer ${linkedMember.token}` },
    data: { masterPasswordHash: linkedMember.passwordHash },
  });
  const secret = (await answer.json()).apiKey as string;
  const withKey = tool("ana-key", ["login", "--apikey"], {
    [`${prefix}CLIENTID`]: `user.${linkedMember.userId}`,
    [`${prefix}CLIENTSECRET`]: secret,
  });
  expect(withKey.status, withKey.out).toBe(0);
  expect(withKey.out).toContain("You are logged in!");
});

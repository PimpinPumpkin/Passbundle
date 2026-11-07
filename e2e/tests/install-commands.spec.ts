// The install command for Windows, Mac, and Linux (DESIGN.md, "Onboarding
// through the RMM"): each carries the same server, enrollment token, join
// secret, and key fingerprint. The Mac's command is run here with the real
// make-profile.sh, and the profile it writes for the MDM holds them; the
// Linux command is run with the real install script, which takes every
// argument and stops only because this isn't root.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { brand } from "../paths.mjs";

import { signUpWithAuthenticator, webUserFor } from "./support/web";

const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../installer");

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A token, join secret, or key fingerprint: 43 base64url characters. */
const PART = "([A-Za-z0-9_-]{43})";
const SERVER = "(https://127\\.0\\.0\\.1:\\d+)";

/**
 * Runs a command the console showed, in a folder with a copy of the script it
 * names, after checking it's the command it should be (so nothing else runs).
 */
function run(command: string, shape: RegExp, script: string, as: string) {
  expect(command).toMatch(shape);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-command-"));
  fs.copyFileSync(script, path.join(dir, as));
  fs.chmodSync(path.join(dir, as), 0o755);
  const result = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
  return { dir, ...result };
}

test("the install command comes for Windows, Mac, and Linux with the same token, join secret, and key fingerprint, and the scripts take it", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const admin = await (await browser.newContext()).newPage();
  await signUpWithAuthenticator(admin, webUserFor("install-os-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Contoso IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Fabrikam Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Fabrikam Dental")).toBeVisible();
  await admin
    .getByTestId("msp-client-Fabrikam Dental")
    .getByRole("button", { name: "Install command" })
    .click();
  const panel = admin.getByTestId("msp-install");
  const command = panel.getByTestId("msp-install-command");
  const choose = (platform: string) =>
    panel.getByTestId("msp-install-platform").getByText(platform, { exact: true }).click();

  // Windows first. The words are honest about the extension, which isn't in
  // the stores yet, and the panel shows the fingerprint phrase people see.
  const windowsShape = new RegExp(
    `^\\.\\\\${escape(brand.installScript)} -ServerUrl '${SERVER}' -EnrollmentToken '${PART}' -JoinSecret '${PART}' -OrgKey '${PART}'$`,
  );
  await expect(command).toHaveText(windowsShape);
  const [, server, token, secret, orgKey] = windowsShape.exec((await command.textContent())!)!;
  await expect(panel).toContainText("installs the extension once it's in the Chrome and Edge stores");
  await expect(panel).not.toContainText("installs the extension in Edge and Chrome");
  await expect(panel.getByTestId("msp-install-phrase")).toHaveText(
    /^\s*People who join see Fabrikam Dental's fingerprint phrase, to check with you: [a-z-]+\s*$/,
  );
  await panel.getByRole("button", { name: "Copy command" }).click();
  await expect(toast(admin, "Copied the install command")).toBeVisible();

  // Linux: the same parts, single-quoted for the shell. The real script
  // checks each one and stops only because this isn't root.
  await choose("Linux");
  await expect(command).toHaveAttribute("data-platform", "linux");
  const linux = (await command.textContent())!;
  expect(linux).toBe(
    `./${brand.installScriptMacLinux} --server-url '${server}' --enrollment-token '${token}' --join-secret '${secret}' --org-key '${orgKey}'`,
  );
  await expect(panel).toContainText("as root, from your RMM");
  if (process.getuid?.() !== 0) {
    const ran = run(
      linux,
      new RegExp(
        `^\\./${escape(brand.installScriptMacLinux)} --server-url '${SERVER}' --enrollment-token '${PART}' --join-secret '${PART}' --org-key '${PART}'$`,
      ),
      path.join(installer, "linux/install-passbundle.sh"),
      brand.installScriptMacLinux,
    );
    expect(ran.status, ran.stderr).toBe(1);
    expect(ran.stderr.trim()).toBe("Run this as root (sudo, or the RMM's script step).");
  }

  // A Mac: the profile for the MDM, with the same parts, then the app, with
  // nothing secret. The real make-profile.sh writes a profile that has them.
  await choose("Mac");
  await expect(command).toHaveAttribute("data-platform", "macos");
  await expect(panel).toContainText("macOS takes managed settings only from a configuration profile that an MDM installs");
  const mac = (await command.textContent())!;
  expect(mac).toBe(
    `./make-profile.sh --server-url '${server}' --enrollment-token '${token}' --join-secret '${secret}' --org-key '${orgKey}' > ${brand.macProfile}`,
  );
  await expect(panel.getByTestId("msp-install-app-command")).toHaveText(`./${brand.installScriptMacLinux}`);
  await panel.getByRole("button", { name: "Copy profile command" }).click();
  await expect(toast(admin, "Copied the profile command")).toBeVisible();
  const made = run(
    mac,
    new RegExp(
      `^\\./make-profile\\.sh --server-url '${SERVER}' --enrollment-token '${PART}' --join-secret '${PART}' --org-key '${PART}' > ${escape(brand.macProfile)}$`,
    ),
    path.join(installer, "macos/make-profile.sh"),
    "make-profile.sh",
  );
  expect(made.status, made.stderr).toBe(0);
  const profile = fs.readFileSync(path.join(made.dir, brand.macProfile), "utf8");
  for (const [key, value] of [
    ["enrollmentToken", token],
    ["joinSecret", secret],
    ["orgKeyFingerprint", orgKey],
  ]) {
    // Once for Chrome's copy of the extension's settings, once for Edge's.
    expect(profile.split(`<key>${key}</key>\n\t\t\t<string>${value}</string>`)).toHaveLength(3);
  }
  expect(profile).toContain(`<string>${server}</string>`);

  // Back to Windows: the same command as before.
  await choose("Windows");
  await expect(command).toHaveText(windowsShape);
  await expect(command).toContainText(`-EnrollmentToken '${token}' -JoinSecret '${secret}' -OrgKey '${orgKey}'`);
});

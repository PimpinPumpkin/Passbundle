// The install command for Windows, Mac, and Linux (DESIGN.md, "Onboarding
// through the RMM"): each carries the same server, enrollment token, join
// secret, and key fingerprint. The Mac's command is run here with the real
// make-profile.sh, and the profile it writes for the MDM holds them; the
// Linux command is run with the real install script, which takes every
// argument and stops only because this isn't root. The scripts also hand the
// settings to a build loaded by hand, under PassBundle's own extension ID
// (brand.json's), which is checked against each script and DESIGN.md here.
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
    // Chrome's and Edge's copies of the extension's settings, each once for
    // the store's extension and once for a build loaded by hand.
    expect(profile.split(`<key>${key}</key>\n\t\t\t<string>${value}</string>`)).toHaveLength(5);
  }
  expect(profile).toContain(`<string>${server}</string>`);
  // The build loaded by hand has the extension ID this build's brand gives.
  for (const browser of ["com.google.Chrome", "com.microsoft.Edge"]) {
    expect(profile).toContain(`<string>${browser}.extensions.${brand.extension.chromiumId}</string>`);
  }
  expect(profile).not.toContain(`${brand.extension.chromiumId};`);

  // Back to Windows: the same command as before.
  await choose("Windows");
  await expect(command).toHaveText(windowsShape);
  await expect(command).toContainText(`-EnrollmentToken '${token}' -JoinSecret '${secret}' -OrgKey '${orgKey}'`);
});

// A Chrome or Edge build loaded by hand has PassBundle's own extension ID
// (brand.json's chromiumId, from the public key in its manifest). Each install
// script has that ID written into it, so it can't read brand.json: this keeps
// the copies and DESIGN.md's the same, and the ID out of every force-install
// list (DESIGN.md, "PassBundle's extension IDs").
test("the install scripts and DESIGN.md name the extension's own ID as brand.json has it, and never force-install it", () => {
  const own: string = brand.extension.chromiumId;
  expect(own).toMatch(/^[a-p]{32}$/);
  const scripts = [
    ["windows/Install-PassBundle.ps1", `$OwnExtension = "${own}"`],
    ["macos/install-passbundle.sh", `OWN_EXTENSION="${own}"`],
    ["macos/make-profile.sh", `OWN_EXTENSION="${own}"`],
    ["linux/install-passbundle.sh", `OWN_EXTENSION="${own}"`],
  ];
  for (const [file, declaration] of scripts) {
    const lines = fs.readFileSync(path.join(installer, file), "utf8").split("\n");
    // Written once, as a fixed value: every use is by its name.
    expect(lines.filter((line) => line.includes(own)), file).toEqual([declaration]);
    // Never on a line with an update URL or a force-install list.
    expect(
      lines.filter((line) => /own_?extension/i.test(line) && /forcelist|update_?url/i.test(line)),
      file,
    ).toEqual([]);
  }
  const design = fs.readFileSync(path.join(installer, "../DESIGN.md"), "utf8");
  expect(design).toContain(`- **Chrome and Edge:** \`${own}\``);
});

test("with the browsers' card and address autofill turned off, every command turns them off too, and the Mac profile does it for Chrome, Edge, and Firefox", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const admin = await (await browser.newContext()).newPage();
  await signUpWithAuthenticator(admin, webUserFor("install-autofill-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Contoso IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Fabrikam Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Fabrikam Dental")).toBeVisible();

  // The client's Settings page: turn them off (DESIGN.md, "Addresses and cards").
  await admin.getByTestId("msp-client-Fabrikam Dental").getByRole("link", { name: "Admin console" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  await admin.goto(admin.url().replace(/\/members.*$/, "/settings/joining"));
  const setting = admin.getByTestId("browser-autofill-setting");
  await expect(setting.getByRole("radio", { name: /Leave as is/ })).toBeChecked({ timeout: 30_000 });
  await expect(setting.getByTestId("browser-autofill-setting-computers")).toContainText(
    "covers every profile in Chrome, Edge, and Firefox",
  );
  await setting.getByRole("radio", { name: /^Turn off\b/ }).first().check();
  await setting.getByRole("button", { name: "Save" }).click();
  await expect(toast(admin, "The browsers' card and address autofill are off")).toBeVisible();

  await admin.goto("/#/msp");
  await admin
    .getByTestId("msp-client-Fabrikam Dental")
    .getByRole("button", { name: "Install command" })
    .click();
  const panel = admin.getByTestId("msp-install");
  const command = panel.getByTestId("msp-install-command");
  await expect(panel.getByTestId("msp-install-autofill-off")).toContainText(
    "turns off the browsers' own card and address autofill",
  );
  await expect(command).toHaveText(
    new RegExp(`-OrgKey '${PART}' -DisableCardAutofill -DisableAddressAutofill$`),
  );
  await panel.getByTestId("msp-install-platform").getByText("Linux", { exact: true }).click();
  await expect(command).toHaveText(
    new RegExp(`--org-key '${PART}' --disable-card-autofill --disable-address-autofill$`),
  );

  // The real make-profile.sh turns them off in each browser's payload.
  await panel.getByTestId("msp-install-platform").getByText("Mac", { exact: true }).click();
  await expect(command).toHaveAttribute("data-platform", "macos");
  const made = run(
    (await command.textContent())!,
    new RegExp(
      `^\\./make-profile\\.sh --server-url '${SERVER}' --enrollment-token '${PART}' --join-secret '${PART}' --org-key '${PART}' --disable-card-autofill --disable-address-autofill > ${escape(brand.macProfile)}$`,
    ),
    path.join(installer, "macos/make-profile.sh"),
    "make-profile.sh",
  );
  expect(made.status, made.stderr).toBe(0);
  const profile = fs.readFileSync(path.join(made.dir, brand.macProfile), "utf8");
  for (const key of ["AutofillCreditCardEnabled", "AutofillAddressEnabled"]) {
    // Chrome's, Edge's, and Firefox's payloads.
    expect(profile.split(`<key>${key}</key>\n\t\t\t<false/>`)).toHaveLength(4);
  }
  expect(profile).toContain("<string>org.mozilla.firefox</string>");
});

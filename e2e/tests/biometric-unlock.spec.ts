// Unlocking the extension with Windows Hello through the desktop agent, end
// to end: the real extension, the agent, and its native-messaging host, which
// Chromium starts from the profile's NativeMessagingHosts folder. The agent is
// a test build whose stand-in for Windows Hello answers from a script and
// writes down each prompt. Turning biometric unlock on hands the agent the
// user key after a prompt; unlocking gets it back only after another; a
// canceled prompt leaves the vault locked. See DESIGN.md, "Biometric unlock".
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, test as base, type BrowserContext, type Page } from "@playwright/test";

import { brand, hostResolverRules, paths } from "../paths.mjs";

import { createAccount, expect, logInPopup, openPopup, userFor } from "./support/extension";

const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const exe = (name: string) => path.join(paths.agent, process.platform === "win32" ? `${name}.exe` : name);

type Agent = {
  /** The scripted answers for the next prompts, "yes" or "no". */
  answer: (...answers: string[]) => void;
  /** Every prompt shown so far. */
  prompts: () => string[];
};

// Tier 1 builds the agent in its clients job. A clients pull request runs
// main's Tier 1 against this repo's tests until the workflow that builds it
// is merged; only then is there no agent to test.
const agentBuilt = fs.existsSync(exe("passbundle-agent")) && fs.existsSync(exe("passbundle-agent-host"));

// A short folder: Unix socket paths are limited to about 100 bytes.
const shortTemp = () => fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pb-"));

const test = base.extend<{ home: string; agent: Agent; context: BrowserContext; extensionId: string }>({
  home: async ({}, use) => {
    const home = shortTemp();
    await use(home);
    fs.rmSync(home, { recursive: true, force: true });
  },
  agent: async ({ home }, use) => {
    const env = {
      ...process.env,
      HOME: home,
      LOCALAPPDATA: home,
      PASSBUNDLE_AGENT_TEST_HOME: home,
      PASSBUNDLE_AGENT_TEST_AUTHENTICATOR: home,
    };
    const child: ChildProcess = spawn(exe("passbundle-agent"), ["--serve"], { env, stdio: "inherit" });
    await use({
      answer: (...answers) => fs.writeFileSync(path.join(home, "answers"), answers.join("\n")),
      prompts: () => {
        const file = path.join(home, "prompts");
        return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
      },
    });
    child.kill();
  },
  context: async ({ home, agent }, use) => {
    void agent;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-ext-"));
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      locale: "en-US",
      timezoneId: "UTC",
      // The host the browser starts finds the test's agent here.
      env: { ...process.env, PASSBUNDLE_AGENT_TEST_HOME: home } as Record<string, string>,
      args: [
        `--disable-extensions-except=${paths.extension}`,
        `--load-extension=${paths.extension}`,
        "--ignore-certificate-errors",
        `--user-agent=${chromeUserAgent}`,
        hostResolverRules,
      ],
    });
    // Chromium reads native-messaging hosts from the profile too.
    (context as BrowserContext & { profile?: string }).profile = profile;
    await use(context);
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use) => {
    await expect.poll(() => context.serviceWorkers().length, { timeout: 15_000 }).toBeGreaterThan(0);
    const id = new URL(context.serviceWorkers()[0].url()).host;
    // Register the agent's host for this extension, as the installer does.
    const profile = (context as BrowserContext & { profile: string }).profile;
    const dir = path.join(profile, "NativeMessagingHosts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${brand.nativeMessagingHost}.json`),
      JSON.stringify({
        name: brand.nativeMessagingHost,
        description: `${brand.name} desktop agent`,
        path: exe("passbundle-agent-host"),
        type: "stdio",
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    await use(id);
  },
});

/**
 * Locks from the account switcher, where "Lock now" lives. Upstream then
 * reloads the whole extension to clear memory, unless a desktop app's
 * fingerprint was validated, and an extension loaded from the command line,
 * as in these tests, doesn't come back from that reload. So the test marks
 * the fingerprint validated first: the reload isn't what's under test.
 */
async function lockNow(context: BrowserContext, popup: Page, extensionId: string) {
  await context.serviceWorkers()[0].evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (self as any).bitwardenMain.biometricStateService.setFingerprintValidated(true);
  });
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/account-switcher`);
  await popup.getByRole("button", { name: "Lock now" }).click();
  await expect(popup.getByRole("heading", { name: "Your vault is locked" })).toBeVisible({
    timeout: 15_000,
  });
  await popup.close();
}

/** Opens the popup on the lock screen (or the vault, if it unlocked by itself). */
async function openLockedPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  let popup: Page | undefined;
  await expect(async () => {
    await popup?.close().catch(() => {});
    popup = await openPopup(context, extensionId);
    await expect(
      popup
        .getByRole("heading", { name: "Your vault is locked" })
        .or(popup.getByRole("heading", { name: /Vault/ }).first()),
    ).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 45_000, intervals: [1_000] });
  return popup!;
}

test.skip(!agentBuilt, `No test build of the desktop agent in ${paths.agent} (KK_AGENT).`);

async function accountSecurity(popup: Page, extensionId: string) {
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/account-security`);
  return popup.getByRole("checkbox", { name: "Unlock with biometrics" });
}

/**
 * Opens the locked popup and asks to unlock with biometrics once: by the
 * extension's own prompt as the lock screen opens, or else by the button,
 * once the lock screen has checked with the agent and enabled it.
 */
async function unlockWithBiometrics(context: BrowserContext, extensionId: string, prompts: () => string[]) {
  const before = prompts().length;
  const popup = await openLockedPopup(context, extensionId);
  const button = popup.getByRole("button", { name: "Unlock with biometrics" });
  await expect(async () => {
    if (prompts().length > before) {
      return;
    }
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  if (prompts().length === before) {
    await button.click();
  }
  await expect.poll(() => prompts().length, { timeout: 20_000 }).toBe(before + 1);
  return popup;
}

test("biometric unlock through the desktop agent: on with a prompt, unlock with a prompt, and a cancel stays locked", async ({
  context,
  extensionId,
  agent,
}, testInfo) => {
  test.setTimeout(120_000);
  const user = userFor("biometric", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.close();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);

  // Turning it on asks for Windows Hello; confirmed, the setting stays on.
  agent.answer("yes");
  const checkbox = await accountSecurity(popup, extensionId);
  await expect(checkbox).toBeEnabled({ timeout: 20_000 });
  await checkbox.check();
  await expect.poll(() => agent.prompts().length, { timeout: 20_000 }).toBe(1);
  expect(agent.prompts()[0]).toMatch(new RegExp(`^Turn on unlock with .+ for ${user.email} in your browser$`));
  await popup.reload();
  await expect(checkbox).toBeChecked();

  // Locked, it unlocks with a prompt.
  await lockNow(context, popup, extensionId);
  agent.answer("yes");
  const unlocked = await unlockWithBiometrics(context, extensionId, agent.prompts);
  await expect(unlocked.getByRole("heading", { name: /Vault/ }).first()).toBeVisible({ timeout: 30_000 });
  expect(agent.prompts()).toHaveLength(2);
  expect(agent.prompts()[1]).toBe(`Unlock ${brand.name} in your browser`);

  // A canceled prompt leaves it locked.
  await lockNow(context, unlocked, extensionId);
  agent.answer("no");
  const stillLocked = await unlockWithBiometrics(context, extensionId, agent.prompts);
  expect(agent.prompts()).toHaveLength(3);
  await expect(stillLocked.getByRole("heading", { name: "Your vault is locked" })).toBeVisible();
  await expect(stillLocked.getByRole("heading", { name: /^Vault/ })).toHaveCount(0);
});

test("turning biometric unlock on stays off when the prompt is canceled", async ({
  context,
  extensionId,
  agent,
}, testInfo) => {
  test.setTimeout(90_000);
  const user = userFor("biometric-cancel", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.close();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);

  agent.answer("no");
  const checkbox = await accountSecurity(popup, extensionId);
  await expect(checkbox).toBeEnabled({ timeout: 20_000 });
  await checkbox.check();
  await expect(
    popup.getByText("Unlock with biometrics is still off. It wasn't confirmed, or the desktop app isn't running."),
  ).toBeVisible({ timeout: 20_000 });
  await expect(checkbox).not.toBeChecked();
  expect(agent.prompts()).toHaveLength(1);
});

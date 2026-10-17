import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, expect, test } from "@playwright/test";

// The Windows Hello test kit, checked on a Windows machine after
// Try-WindowsHello.ps1 has set it up (.github/workflows/test-kit.yml): the
// kit's extension loads with its fixed ID, gets the test server from policy,
// and reaches the desktop agent through the native-messaging host the kit
// registered. CI machines have no Windows Hello, so the agent answers
// "hardware unavailable" (2); without a working path the extension would say
// "desktop disconnected" (6). The prompts themselves need a real PC.
const kit = process.env.KK_TEST_KIT;
test.skip(!kit, "Set KK_TEST_KIT to an unzipped test kit that Try-WindowsHello.ps1 has set up.");

const HARDWARE_UNAVAILABLE = 2;

test("the test kit's extension reaches the agent and the test server", async () => {
  test.setTimeout(120_000);
  const extension = path.join(kit!, "extension");
  const { id } = JSON.parse(fs.readFileSync(path.join(kit!, "extension-key.json"), "utf8"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pb-kit-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await expect.poll(() => context.serviceWorkers().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const worker = context.serviceWorkers()[0];
    expect(new URL(worker.url()).host).toBe(id);

    // The server from policy, applied at install.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup/index.html`);
    await expect(async () => {
      await popup.reload();
      await expect(popup.getByText(/localhost:8817/).first()).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 45_000 });

    // The agent, through Chromium's native messaging and the kit's host.
    await expect
      .poll(
        () =>
          worker.evaluate(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (await (self as any).bitwardenMain.biometricsService.getBiometricsStatus()) as number;
          }),
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(HARDWARE_UNAVAILABLE);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

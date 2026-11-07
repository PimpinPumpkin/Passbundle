// Verifying an email address, on the server that sends email (the others
// count every address as verified). The link in the email can be opened
// anywhere, often on another device than the vault that asked: the server
// moves the account's revision date and tells the person's open apps to
// sync, and the web vault's "verify your email" banner follows the account,
// so it goes away by itself.
import { expect, test } from "@playwright/test";

import { Api } from "../api/support";
import { menu, reloadVault, signUp, webUserFor } from "../support/web";

import { verifyEmail } from "./mailbox";

test("verifying an email moves the account's revision date, so the apps' next sync picks it up", async ({
  request,
}) => {
  const api = new Api(request);
  const who = await api.account("verify-revision");
  const profile = async () => (await api.call(who, "GET", "/api/accounts/profile")).body;
  const revision = async () => {
    const answer = await api.call(who, "GET", "/api/accounts/revision-date");
    expect(answer.status).toBe(200);
    return answer.body as number;
  };
  expect((await profile()).emailVerified).toBe(false);
  const before = await revision();

  await verifyEmail(api, who);

  expect(await revision()).toBeGreaterThan(before);
  expect((await profile()).emailVerified).toBe(true);
});

test("the web vault stops asking to verify the address as soon as it's verified elsewhere, without a reload", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("verify-banner", testInfo.repeatEachIndex);
  // The vault's own session, to ask for the email as the vault's button does.
  let token = "";
  page.on("request", (r) => {
    const header = r.headers()["authorization"];
    if (header?.startsWith("Bearer ") && r.url().includes("/api/")) {
      token = header.slice("Bearer ".length);
    }
  });
  // Signed in, the vault saves its generator settings to the server once
  // (DESIGN.md, "Generator settings"), and the server's notice of that makes
  // it ask whether anything changed. That's over first, so only the
  // verification can make the vault sync.
  const settled = page
    .waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes("/api/keykeeper/settings"),
      { timeout: 30_000 },
    )
    .then(() =>
      page.waitForResponse((r) => r.url().includes("/api/accounts/revision-date"), {
        timeout: 30_000,
      }),
    );
  await signUp(page, user);
  const banner = page.locator("#verify-email-banner");
  await expect(banner).toContainText("Verify your account's email address");
  await expect.poll(() => token).not.toBe("");
  await settled;
  await expect(banner).toBeVisible();

  // The link from the email, followed somewhere else: not in this tab.
  await verifyEmail(new Api(page.context().request), {
    email: user.email,
    password: user.password,
    token,
    userId: "",
  });

  // The open vault hears of it and syncs: the banner goes, the vault stays.
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  await expect(menu(page)).toBeVisible();

  // And it doesn't come back with the next visit.
  await reloadVault(page);
  await expect(page).toHaveTitle(/^Items/);
  await expect(banner).toHaveCount(0);
});

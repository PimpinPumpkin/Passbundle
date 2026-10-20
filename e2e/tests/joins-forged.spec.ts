// Joins a hacked server can't forge, in the web vault: the server's answers
// about who is waiting are altered in flight, the way a hacked server would
// answer, and the console lets nobody in on its own. With the real answers,
// the same person gets in with no click. The unit tests check the seals
// themselves against docs/vectors/joins-v1.json. See DESIGN.md, "Joins a
// hacked server can't forge".
import { generateKeyPairSync } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { Api } from "./api/support";
import { signUp, webUserFor } from "./support/web";

const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

type Pending = { email: string; joining?: { seal: string | null }; inviteSeal?: string | null };

/** Rewrites every list of people waiting the web vault fetches. */
async function alterPending(page: Page, alter: (p: Pending) => Pending) {
  await page.route(/\/api\/keykeeper\/(msp\/[^/]+|organizations)\/pending$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, data: body.data.map(alter) } });
  });
}

test("the console lets nobody in on its own when the server's answers are forged, and lets the invited person in when they're real", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const admin = await (await browser.newContext()).newPage();
  await signUp(admin, webUserFor("forged-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Forged IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Forged Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Forged Dental")).toBeVisible();

  // Someone with a real key, invited from the client's Members page: the
  // invitation carries the admin's seal. This server sends no email, so
  // they're waiting for the org key at once.
  const api = new Api(request);
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const person = await api.account("Invited", undefined, publicKey.toString("base64"));
  await admin.getByTestId("msp-client-Forged Dental").getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgId = /#\/organizations\/([^/]+)\//.exec(admin.url())![1];

  // Forged before the invitation even exists, so no app's answer is real.
  const forgeries: [string, (p: Pending) => Pending][] = [
    // The server says someone nobody invited is waiting, under the seal of someone who was.
    ["a made-up person", (p) => ({ ...p, email: `mallory-${testInfo.repeatEachIndex}@evil.example` })],
    // The server drops the joining seal, as if approval were never on.
    ["an unsealed setting", (p) => ({ ...p, joining: { ...p.joining, seal: null } })],
    // The server drops the invitation's seal.
    ["an unsealed invitation", (p) => ({ ...p, inviteSeal: null })],
  ];
  await alterPending(admin, forgeries[0][1]);
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(person.email);
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();

  for (const [what, forge] of forgeries) {
    await admin.unrouteAll({ behavior: "wait" });
    await alterPending(admin, forge);
    // Opening the console confirms whoever it may.
    await admin.goto("/#/vault");
    await admin.goto("/#/msp");
    await expect(admin.getByTestId("msp-name")).toBeVisible();
    await admin.waitForTimeout(3_000);
    expect(await api.orgsOf(person), what).toEqual([]);
  }

  // The real answers: the invited person gets in with no click.
  await admin.unrouteAll({ behavior: "wait" });
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();
  expect(await api.orgsOf(person)).toEqual([orgId]);
});

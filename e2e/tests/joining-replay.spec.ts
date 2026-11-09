// Version 3 joining seals in the web vault (DESIGN.md, "Joins a hacked server
// can't forge"): an organization that let people in chooses approval, and
// the server, as a hacked one that kept the old seal would, shows the web
// vault the older setting again with its real seal. The owner's web vault
// that saved the change lets nobody in on it, and neither does the owner's
// web vault on another device, signed in after the change, which learned the
// newer setting on its own background run. Letting people in again, sealed
// later, does let the invited person in. The unit tests check the seals and
// what a device remembers against docs/vectors/joining-v3.json.
import { generateKeyPairSync } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { Api } from "./api/support";
import { reloadVault, signUp, webUserFor, type WebUser } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

type Joining = { autoConfirm: boolean; domains: string[]; seal: string | null };
type Listed = Joining & { organizationId: string };
type Pending = { organizationId: string; email: string; autoConfirm: boolean; joining?: Joining };

const PENDING = /\/api\/keykeeper\/(msp\/[^/]+|organizations)\/pending$/;

/**
 * The organization's joining setting in the next list of who's waiting the
 * web vault fetches: its background work fetches it when the vault loads
 * unlocked, so this reloads it.
 */
async function nextJoining(page: Page, orgId: string): Promise<Joining> {
  // Read through a route, as replay() does: a response the page reloads past
  // can't be read from the network afterwards.
  let body: { joining?: Listed[] } | undefined;
  const route = /\/api\/keykeeper\/organizations\/pending$/;
  await page.route(route, async (r) => {
    const response = await r.fetch();
    const json = await response.json();
    if (response.ok()) {
      body ??= json;
    }
    await r.fulfill({ response, json });
  });
  await reloadVault(page);
  await expect.poll(() => body, { timeout: 60_000 }).toBeTruthy();
  await page.unroute(route);
  const listed = (body!.joining ?? []).find((o) => o.organizationId === orgId);
  expect(listed, JSON.stringify(body!.joining)).toBeTruthy();
  const { autoConfirm, domains, seal } = listed!;
  return { autoConfirm, domains, seal };
}

/**
 * Shows the web vault this organization's older joining setting, with its
 * real seal, wherever the server reports it: for each person waiting there
 * (saying they may be let in), and in the list of every organization's
 * setting. Returns how many answers it has changed so far.
 */
async function replay(page: Page, orgId: string, older: Joining): Promise<() => number> {
  let replayed = 0;
  await page.route(PENDING, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    replayed++;
    await route.fulfill({
      response,
      json: {
        ...body,
        data: (body.data as Pending[]).map((p) =>
          p.organizationId === orgId ? { ...p, autoConfirm: true, joining: older } : p,
        ),
        joining: ((body.joining ?? []) as Listed[]).map((o) =>
          o.organizationId === orgId ? { ...o, ...older } : o,
        ),
      },
    });
  });
  return () => replayed;
}

/** Runs the web vault's background work with the answers it gets, and gives it time to confirm anyone. */
async function runBackgroundWork(page: Page, replayed: () => number) {
  const before = replayed();
  await reloadVault(page);
  await expect.poll(replayed, { timeout: 60_000 }).toBeGreaterThan(before);
  await page.waitForTimeout(5_000);
}

/** Every confirm the web vault sends. */
function confirmsSent(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/organizations\/[^/]+\/users\/[^/]+\/confirm$/.test(request.url())) {
      sent.push(request.url());
    }
  });
  return sent;
}

async function logIn(page: Page, user: WebUser) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/#\/vault/, { timeout: 60_000 });
}

/** The organization's joining card, on its Settings page. */
async function joiningCard(page: Page, orgId: string) {
  await page.goto("/#/vault");
  await page.goto(`/#/organizations/${orgId}/settings/joining`);
  const card = page.getByTestId("org-joining");
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

async function letPeopleIn(page: Page, orgId: string, on: boolean) {
  const card = await joiningCard(page, orgId);
  await card.getByRole("checkbox", { name: "Let people in when they accept an invitation" }).setChecked(on);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Saved how people join")).toBeVisible();
}

test("an older joining setting the server shows again, with its real seal, lets nobody in", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const ownerUser = webUserFor("replay-owner", testInfo.repeatEachIndex);
  const owner = await (await browser.newContext()).newPage();
  await signUp(owner, ownerUser);

  // An organization made the upstream way follows the server's default: let
  // people in, sealed by the owner's browser as it made the organization.
  await owner.goto("/#/create-organization");
  const name = `Replay Bakery ${testInfo.repeatEachIndex}`;
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("radio", { name: /A family or a group/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(owner, `Created ${name}`)).toBeVisible();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
  const letIn = await nextJoining(owner, orgId);
  expect(letIn.autoConfirm).toBe(true);
  expect(letIn.seal).toMatch(/^v3\.default\.[1-9][0-9]*\./);

  // Then it asks for approval, sealed later.
  await letPeopleIn(owner, orgId, false);
  const approval = await nextJoining(owner, orgId);
  expect(approval.autoConfirm).toBe(false);
  expect(approval.seal).toMatch(/^v3\.own\./);

  // Someone with a real key is invited (this server sends no email, so
  // they're waiting for the organization's key at once), with the owner's
  // seal on the invitation.
  const api = new Api(request);
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const person = await api.account("replayed", undefined, publicKey.toString("base64"));
  await owner.goto(`/#/organizations/${orgId}/members`);
  await owner.getByRole("button", { name: "Invite member" }).click();
  const invite = owner.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(person.email);
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(invite).toBeHidden();

  // The owner on another device, signed in after the change: its background
  // run sees the newer setting in the list of every organization's setting
  // (the person waiting is for approval, so nothing else checks it).
  const otherDevice = await (await browser.newContext()).newPage();
  // Read through a route, as replay() does: a response the page reloads
  // past can't be read from the network afterwards.
  let seenNewer = false;
  await otherDevice.route(PENDING, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (((body.joining ?? []) as Listed[]).some((o) => o.organizationId === orgId && o.seal === approval.seal)) {
      seenNewer = true;
    }
    await route.fulfill({ response, json: body });
  });
  await logIn(otherDevice, ownerUser);
  await expect.poll(() => seenNewer, { timeout: 60_000 }).toBe(true);
  await otherDevice.unroute(PENDING);
  // Give the run time to check what it got.
  await otherDevice.waitForTimeout(3_000);

  // The server shows both the older setting, "let people in", with its real
  // seal. Neither lets the person in.
  for (const page of [owner, otherDevice]) {
    const sent = confirmsSent(page);
    const replayed = await replay(page, orgId, letIn);
    await runBackgroundWork(page, replayed);
    expect(sent).toEqual([]);
    expect(await api.orgsOf(person)).toEqual([]);
    await page.unrouteAll({ behavior: "wait" });
  }
  await otherDevice.context().close();

  // Letting people in again, sealed later: the owner's web vault lets the
  // invited person in on its own.
  await letPeopleIn(owner, orgId, true);
  await reloadVault(owner);
  await expect(toast(owner, `Let ${person.email} into ${name}`)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => api.orgsOf(person), { timeout: 30_000 }).toEqual([orgId]);
});

// Single sign-on in the browser extension (DESIGN.md, "Sign in with Microsoft
// Entra ID"), which hands off to the web vault, upstream's way: the
// extension's "Use single sign-on" opens the web vault's sign-in page in a
// tab, with the extension's own state and PKCE challenge; the web vault sends
// that tab to Microsoft (the local stand-in, e2e/entra-standin.mjs) for the
// organization's tenant; the server sends it back to the web vault's
// connector page, which hands the code to the extension (its content script,
// then its background); the extension closes that tab and opens a window of
// its own, which redeems the code with its PKCE verifier. A member with a
// master password then unlocks with it and sees their items. Also: an
// identifier no organization has, and the identifier of an organization the
// person isn't a member of, each refused in the words the web vault uses,
// then trying again from the extension's window once he's a member; and with
// "Require single sign-on" on, a member's password sending them to it, and
// one not linked yet told to link in the web vault first. Real keys
// throughout.
import { randomUUID } from "node:crypto";
import fs from "node:fs";

import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import { Api } from "./api/support";
import { linkFromSession, newDomain, newIdentifier, settings, Tenant, verifyDomain } from "./support/entra";
import { expect, extensionIdOf, launchWithExtension, openPopup, serverUrl, test } from "./support/extension";
import {
  type RealAccount,
  realAccount,
  realCollection,
  realLogin,
  realMember,
  realOrganization,
  realPersonalLogin,
} from "./support/vault-crypto";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string | RegExp) => page.getByText(text, { exact: typeof text === "string" });

const connector = `${serverUrl}/sso-connector.html`;

/**
 * An organization with single sign-on on against its own stand-in tenant, an
 * owner, a shared folder with a login in it, and (unless told not to) its
 * email domain verified, all made over the API with real keys, as the
 * command-line tool's tests make theirs.
 */
async function ssoOrganization(request: APIRequestContext, name: string, options: { verify?: boolean } = {}) {
  const domain = newDomain();
  const owner = await realAccount(request, "ext-sso-owner", `owner-${randomUUID().slice(0, 8)}@${domain}`);
  const org = await realOrganization(request, owner, name);
  const collectionId = await realCollection(request, owner, org, "Front desk");
  await realLogin(request, owner, org, collectionId, {
    name: "Front desk Wi-Fi",
    username: "frontdesk",
    password: `wifi-${randomUUID()}`,
    uri: "https://wifi.example.test",
  });
  const tenant = await new Tenant().register();
  const identifier = newIdentifier("ext");
  const saved = await request.put(`/api/keykeeper/organizations/${org.id}/sso`, {
    headers: { Authorization: `Bearer ${owner.token}` },
    // The master password, as the web vault asks for it (DESIGN.md,
    // "Confirming sensitive changes").
    data: { ...settings(tenant, identifier), masterPasswordHash: owner.passwordHash },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  if (options.verify !== false) {
    await verifyDomain(new Api(request), owner, org.id, domain);
  }
  return { owner, org, collectionId, tenant, identifier, domain };
}

type SsoOrganization = Awaited<ReturnType<typeof ssoOrganization>>;

/**
 * A member of the organization with a login of her own and the shared
 * folder's, in its tenant's directory, who (unless told not to) linked her
 * Microsoft account from her own session first, as in the web vault (Link SSO).
 */
async function linkedMember(request: APIRequestContext, sso: SsoOrganization, prefix: string, link = true) {
  const member = await realAccount(request, prefix, `${prefix}-${randomUUID().slice(0, 8)}@${sso.domain}`);
  await realMember(request, sso.owner, sso.org, member, [
    { id: sso.collectionId, readOnly: false, hidePasswords: false, manage: false },
  ]);
  await realPersonalLogin(request, member, {
    name: "Payroll portal",
    username: member.email,
    password: `payroll-${randomUUID()}`,
    uri: "https://payroll.example.test",
  });
  const person = await sso.tenant.person(member.email, undefined, `${prefix} at work`);
  if (link) {
    await sso.tenant.next(person);
    const linked = await linkFromSession(
      request,
      serverUrl,
      { token: member.token, password: member.passwordHash },
      sso.identifier,
    );
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
  }
  return member;
}

/** The popup's sign-in page, up to the email step, on this test server. */
async function popupAtEmail(context: BrowserContext, extensionId: string, email: string) {
  const popup = await openPopup(context, extensionId);
  // The carousel renders its buttons before Angular wires them up, and an
  // early click is dropped. Click until the app actually navigates.
  await expect(async () => {
    await popup.getByRole("button", { name: "Sign in" }).click();
    await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
  }).toPass();
  await popup.getByRole("button", { name: "Self-hosted" }).click();
  await popup.getByRole("textbox", { name: "Server address" }).fill(serverUrl);
  await popup.getByLabel(/Email address/).fill(email);
  return popup;
}

/** The web vault's sign-in page the extension opens in a tab, for the extension. */
async function webVaultTab(context: BrowserContext, start: () => Promise<void>) {
  const opened = context.waitForEvent("page");
  await start();
  const tab = await opened;
  await tab.waitForURL(/\/#\/sso\?/, { timeout: 30_000 });
  const query = new URLSearchParams(tab.url().split("?")[1]);
  // Upstream's handoff: the extension's own client, state, and challenge, and
  // the answer back to the web vault's connector page.
  expect(query.get("clientId")).toBe("browser");
  expect(query.get("redirectUri")).toBe(connector);
  expect(query.get("state")).toMatch(/:clientId=browser$/);
  expect(query.get("codeChallenge")).toBeTruthy();
  return tab;
}

/**
 * Microsoft (the stand-in's account picker) signs someone in, in the web
 * vault's tab; the connector page hands the answer to the extension, which
 * closes the tab, as upstream's does, and opens its own window to finish. A
 * window an earlier try left open is replaced.
 */
async function pickAccountAndHandBack(
  context: BrowserContext,
  extensionId: string,
  tab: Page,
  email: string,
  earlier?: Page,
) {
  await expect(tab.getByRole("heading", { name: /Test sign-in/ })).toBeVisible();
  const closed = tab.waitForEvent("close");
  const replaced = earlier?.waitForEvent("close");
  await tab.getByRole("link", { name: `Sign in as ${email}` }).click();
  await closed;
  await replaced;
  // Upstream's single-action window for the answer.
  const prefix = `chrome-extension://${extensionId}/popup/index.html?uilocation=popout&singleActionPopout=auth_ssoAuthResult#/`;
  let finish: Page | undefined;
  await expect
    .poll(() => {
      const windows = context.pages().filter((p) => p.url().startsWith(prefix));
      finish = windows.length === 1 ? windows[0] : undefined;
      return windows.length;
    })
    .toBe(1);
  return finish!;
}

/** The extension asks for the master password, which unlocks it, and shows these items. */
async function unlockAndSeeItems(finish: Page, account: RealAccount, items: string[]) {
  await finish.waitForURL(/#\/lock/, { timeout: 30_000 });
  await finish.getByRole("textbox", { name: /Master password/ }).fill(account.password);
  await finish.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(finish.getByRole("heading", { name: /Items/ }).first()).toBeVisible({ timeout: 30_000 });
  for (const item of items) {
    await expect(finish.getByText(item, { exact: true })).toBeVisible();
  }
}

test("a member signs in to the extension with single sign-on: the web vault hands back, its tab closes, and her master password unlocks her items", async ({
  context,
  extensionId,
  request,
}) => {
  test.setTimeout(180_000);
  const sso = await ssoOrganization(request, "Fabrikam Dental");
  const ana = await linkedMember(request, sso, "ana");

  // Her email's domain is verified, so the web vault finds the
  // organization's sign-in by itself and goes on to Microsoft.
  const popup = await popupAtEmail(context, extensionId, ana.email);
  const tab = await webVaultTab(context, () => popup.getByRole("button", { name: "Use single sign-on" }).click());
  expect(new URLSearchParams(tab.url().split("?")[1]).get("email")).toBe(ana.email);
  const finish = await pickAccountAndHandBack(context, extensionId, tab, ana.email);
  // Her own login (her account key) and the shared folder's (the
  // organization's key, wrapped to her).
  await unlockAndSeeItems(finish, ana, ["Payroll portal", "Front desk Wi-Fi"]);

  // The organization's event log has her sign-in, from the extension (upstream's
  // device type 2, the Chrome extension).
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const end = new Date(Date.now() + 3_600_000).toISOString();
  const events = await request.get(`/api/organizations/${sso.org.id}/events?start=${start}&end=${end}`, {
    headers: { Authorization: `Bearer ${sso.owner.token}` },
  });
  expect(events.status(), await events.text()).toBe(200);
  const signIns = (await events.json()).data.filter(
    (e: { type: number; actingUserId: string; deviceType: number }) =>
      e.type === 1590 && e.actingUserId === ana.userId && e.deviceType === 2,
  );
  expect(signIns).toHaveLength(1);
});

test("the handoff is refused for an identifier that isn't the organization's, in the words the web vault uses, and works when tried again once he's a member", async ({
  context,
  extensionId,
  request,
}) => {
  test.setTimeout(180_000);
  const sso = await ssoOrganization(request, "Harbor Clinic");
  // Bob is in the clinic's Microsoft 365 directory, at a domain Microsoft
  // confirmed, but his PassBundle account is in another organization. The
  // clinic didn't verify his domain, so the web vault asks for the identifier.
  const bob = await realAccount(request, "bob", `bob-${randomUUID().slice(0, 8)}@${newDomain()}`);
  await realOrganization(request, bob, "Bob's Bikes");
  const bobAtWork = await sso.tenant.person(bob.email, true);

  const popup = await popupAtEmail(context, extensionId, bob.email);
  const tab = await webVaultTab(context, () => popup.getByRole("button", { name: "Use single sign-on" }).click());
  const field = tab.getByRole("textbox", { name: "SSO identifier" });
  await expect(field).toBeVisible();
  await expect(field).toHaveValue("");

  // An identifier no organization has: the web vault says so, and nothing
  // goes back to the extension.
  await field.fill(newIdentifier("nobody"));
  await tab.getByRole("button", { name: "Continue" }).click();
  await expect(toast(tab, "No organization uses that SSO identifier, or its single sign-on is turned off.")).toBeVisible();
  expect(tab.url()).toContain("/#/sso?clientId=browser");

  // The clinic's, whose member he isn't: Microsoft signs him in, the web
  // vault hands back, and the extension says why not, in the words the web
  // vault uses (sso.spec.ts). Nothing is signed in.
  await field.fill(sso.identifier);
  await tab.getByRole("button", { name: "Continue" }).click();
  const refused = await pickAccountAndHandBack(context, extensionId, tab, bob.email);
  await expect(
    toast(
      refused,
      `${bob.email} isn't a member of Harbor Clinic, so its single sign-on can't sign you in. Ask your administrator to invite you.`,
    ),
  ).toBeVisible({ timeout: 30_000 });
  await expect(refused.getByRole("heading", { name: /Items/ })).toHaveCount(0);
  // The window offers the identifier again.
  await expect(refused.getByRole("textbox")).toHaveValue(sso.identifier);

  // The clinic adds him, and he links his account in the web vault.
  await realMember(request, sso.owner, sso.org, bob, [
    { id: sso.collectionId, readOnly: false, hidePasswords: false, manage: false },
  ]);
  await sso.tenant.next(bobAtWork);
  const linked = await linkFromSession(
    request,
    serverUrl,
    { token: bob.token, password: bob.passwordHash },
    sso.identifier,
  );
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);

  // Continue in that window starts again through the web vault, which goes
  // on to Microsoft by itself, and the new answer replaces the window.
  const again = await webVaultTab(context, () => refused.getByRole("button", { name: "Continue" }).click());
  expect(new URLSearchParams(again.url().split("?")[1]).get("identifier")).toBe(sso.identifier);
  const finish = await pickAccountAndHandBack(context, extensionId, again, bob.email, refused);
  await unlockAndSeeItems(finish, bob, ["Front desk Wi-Fi"]);
});

test("with Require single sign-on, a member's password in the extension sends her to it, and one not linked yet is told to link in the web vault", async ({
  context,
  extensionId,
  request,
}) => {
  test.setTimeout(180_000);
  // No verified domain: the identifier comes from the server's answer.
  const sso = await ssoOrganization(request, "Pine Street Law", { verify: false });
  const cy = await linkedMember(request, sso, "cy");
  const dee = await linkedMember(request, sso, "dee", false);
  // Single organization, then Require single sign-on.
  for (const type of [3, 4]) {
    const on = await request.put(`/api/organizations/${sso.org.id}/policies/${type}`, {
      headers: { Authorization: `Bearer ${sso.owner.token}` },
      data: { policy: { enabled: true, data: null } },
    });
    expect(on.status(), await on.text()).toBe(200);
  }

  // Cy's password checks out, and the extension opens the web vault's
  // sign-in for her organization, which goes on to Microsoft by itself.
  const popup = await popupAtEmail(context, extensionId, cy.email);
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup.getByRole("textbox", { name: /Master password/ }).fill(cy.password);
  const tab = await webVaultTab(context, () => popup.getByRole("button", { name: "Sign in", exact: true }).click());
  expect(new URLSearchParams(tab.url().split("?")[1]).get("identifier")).toBe(sso.identifier);
  const finish = await pickAccountAndHandBack(context, extensionId, tab, cy.email);
  await unlockAndSeeItems(finish, cy, ["Payroll portal", "Front desk Wi-Fi"]);

  // Dee isn't linked yet, in a browser of her own: her password gets her
  // nowhere in the extension, which says to link in the web vault first, and
  // opens no tab.
  const own = await launchWithExtension();
  try {
    const deePopup = await popupAtEmail(own.context, await extensionIdOf(own.context), dee.email);
    await deePopup.getByRole("button", { name: "Continue" }).click();
    await deePopup.getByRole("textbox", { name: /Master password/ }).fill(dee.password);
    await deePopup.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      toast(
        deePopup,
        "Your organization requires single sign-on, and your account isn't linked to it yet. Sign in to the web vault with your email and master password to link it, then sign in here with single sign-on.",
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(deePopup.getByRole("heading", { name: /Items/ })).toHaveCount(0);
    expect(own.context.pages().filter((p) => p.url().includes("/#/sso"))).toEqual([]);
  } finally {
    await own.context.close();
    fs.rmSync(own.profile, { recursive: true, force: true });
  }
});

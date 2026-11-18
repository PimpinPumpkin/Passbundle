// Enrolling at unlock, with real keys (DESIGN.md, "Enrolling at unlock"): an
// MSP's client turns on account recovery with automatic enrollment after a
// member joined; the member signs in to the web vault and is enrolled without
// being asked, with their real user key, which the client's private key
// opens. A technician of the MSP in the same client signs in and stays out:
// the web vault sends nothing for their place there, which came from the
// MSP, and where another organization gave them a place of its own, the
// server refuses once and the web vault doesn't try again. The browser
// extension enrolls a member the same way. Runs on the server that sends
// email, which only offers account recovery with email.
import { constants, createPrivateKey, privateDecrypt, randomBytes } from "node:crypto";

import {
  type APIRequestContext,
  expect,
  type Page,
  request as requests,
  test,
} from "@playwright/test";

import { mailServerPort } from "../paths.mjs";

import { type Account, Api } from "./api/support";
import { inviteParams, verifyEmail, waitForMessage } from "./mail/mailbox";
import { test as extensionTest, logInPopup, openPopup } from "./support/extension";
import { answerTwoStep, giveAuthenticator } from "./support/two-step";
import {
  encrypt,
  encryptTo,
  type RealAccount,
  realAccount,
  type RealOrganization,
  rsaKeyPair,
} from "./support/vault-crypto";

const mailServer = `https://127.0.0.1:${mailServerPort}`;

/** A real account as the API tests' helpers take it: its password is the hash the apps send. */
const asAccount = (a: RealAccount): Account => ({
  email: a.email,
  password: a.passwordHash,
  token: a.token,
  userId: a.userId,
});

/** An MSP's new client, with a real organization key and key pair, owned by the MSP admin who adds it. */
async function realClient(api: Api, admin: RealAccount, mspId: string, name: string) {
  const key = randomBytes(64);
  const { publicKey, privateKey } = rsaKeyPair();
  const created = await api.call(asAccount(admin), "POST", `/api/keykeeper/msp/${mspId}/clients`, {
    name,
    collectionName: encrypt(key, "Default collection"),
    key: encryptTo(admin.publicKey, key),
    keys: {
      publicKey: publicKey.toString("base64"),
      encryptedPrivateKey: encrypt(key, privateKey),
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { org: { id: created.body.id as string, key } satisfies RealOrganization, privateKey };
}

/** A company's own organization, with a real organization key and key pair. */
async function realOrg(api: Api, owner: RealAccount, name: string) {
  const key = randomBytes(64);
  const { publicKey, privateKey } = rsaKeyPair();
  const created = await api.call(asAccount(owner), "POST", "/api/organizations", {
    name,
    billingEmail: owner.email,
    collectionName: encrypt(key, "Default collection"),
    key: encryptTo(owner.publicKey, key),
    keys: {
      publicKey: publicKey.toString("base64"),
      encryptedPrivateKey: encrypt(key, privateKey),
    },
    planType: 0,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { org: { id: created.body.id as string, key } satisfies RealOrganization, privateKey };
}

/** The user key in a recovery key, opened with the organization's private key as Recover account does. */
function openRecoveryKey(sealed: string, privateKey: Buffer): Buffer {
  expect(sealed).toMatch(/^4\./);
  return privateDecrypt(
    {
      key: createPrivateKey({ key: privateKey, format: "der", type: "pkcs8" }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from(sealed.slice(2), "base64"),
  );
}

/**
 * Has an account join an organization through its emailed invitation, before
 * the organization uses account recovery (so without enrolling), and
 * confirms them with the organization's key wrapped to their public key.
 */
async function joinByEmail(
  api: Api,
  owner: RealAccount,
  org: RealOrganization,
  orgName: string,
  member: RealAccount,
): Promise<string> {
  const invited = await api.call(asAccount(owner), "POST", `/api/organizations/${org.id}/users/invite`, {
    emails: [member.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const link = inviteParams(await waitForMessage(member.email, new RegExp(`Join ${orgName}`)));
  const memberId = link.get("organizationUserId")!;
  const accepted = await api.call(asAccount(member), "POST", `/api/organizations/${org.id}/users/${memberId}/accept`, {
    token: link.get("token"),
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const confirmed = await api.call(asAccount(owner), "POST", `/api/organizations/${org.id}/users/${memberId}/confirm`, {
    key: encryptTo(member.publicKey, org.key),
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return memberId;
}

/** An owner turns on account recovery with automatic enrollment, after people joined. */
async function turnOnRecovery(api: Api, owner: RealAccount, orgId: string) {
  const policy = await api.call(asAccount(owner), "PUT", `/api/organizations/${orgId}/policies/8`, {
    policy: { enabled: true, data: { autoEnrollEnabled: true } },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
}

/** The recovery key the server holds for a membership, as an owner's Recover account reads it. */
async function recoveryKey(api: Api, owner: RealAccount, orgId: string, memberId: string) {
  const details = await api.call(
    asAccount(owner),
    "GET",
    `/api/organizations/${orgId}/users/${memberId}/reset-password-details`,
  );
  return details.status === 200 ? (details.body.resetPasswordKey as string | null) : null;
}

/** Whether the members list shows someone enrolled in account recovery. */
async function enrolled(api: Api, owner: RealAccount, orgId: string, email: string) {
  const listed = await api.call(asAccount(owner), "GET", `/api/organizations/${orgId}/users`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.data.find((m: { email: string }) => m.email === email).resetPasswordEnrolled as boolean;
}

/** Signs in to the web vault with the master password, and waits for the vault. */
async function signIn(page: Page, account: RealAccount, twoStep = false) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(account.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /^Master password/ }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (twoStep) {
    await answerTwoStep(page, account.email);
  }
  await expect(page.getByRole("heading", { name: "All items" }).first()).toBeVisible({ timeout: 30_000 });
}

/** Every enrollment request a page sends, by organization, with the server's answers. */
function watchEnrollments(page: Page) {
  const sent: { orgId: string; status: number | null }[] = [];
  page.on("request", (r) => {
    const match = /\/api\/organizations\/([^/]+)\/users\/[^/]+\/reset-password-enrollment/.exec(r.url());
    if (match && r.method() === "PUT") {
      const entry = { orgId: match[1], status: null as number | null };
      sent.push(entry);
      void r.response().then((answer) => (entry.status = answer?.status() ?? null));
    }
  });
  return sent;
}

/** Requests to the server that sends email, for the test to dispose of. */
const mailServerRequests = (): Promise<APIRequestContext> =>
  requests.newContext({ baseURL: mailServer, ignoreHTTPSErrors: true });

test("a member is enrolled at their next unlock when their organization turns on account recovery later, and the MSP's technician stays out", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const request = await mailServerRequests();
  const api = new Api(request);

  // An MSP admin adds a client with no policies yet, and a technician who
  // reaches it.
  const admin = await realAccount(request, "rau-admin");
  const mspId = await api.msp(asAccount(admin), "Unlock IT");
  const clientName = `Unlock Dental ${Date.now()}`;
  const { org: client, privateKey } = await realClient(api, admin, mspId, clientName);
  const tech = await realAccount(request, "rau-tech");
  await verifyEmail(api, asAccount(tech));
  // An authenticator app the web vault's sign-in can answer: the MSP requires two-step login of its staff.
  await giveAuthenticator(request, tech);
  await api.addStaff(asAccount(admin), mspId, asAccount(tech), "technician", undefined, { authenticator: false });
  const pending = await api.call(asAccount(admin), "GET", `/api/keykeeper/msp/${mspId}/pending`);
  expect(pending.status, JSON.stringify(pending.body)).toBe(200);
  const techPlace = pending.body.data.find(
    (p: { organizationId: string; email: string }) => p.organizationId === client.id && p.email === tech.email,
  );
  expect(techPlace, JSON.stringify(pending.body)).toBeTruthy();
  const techConfirmed = await api.call(
    asAccount(admin),
    "POST",
    `/api/organizations/${client.id}/users/${techPlace.memberId}/confirm`,
    { key: encryptTo(tech.publicKey, client.key) },
  );
  expect(techConfirmed.status, JSON.stringify(techConfirmed.body)).toBe(200);

  // A member joins the client by email while it doesn't use account recovery.
  const member = await realAccount(request, "rau-member");
  const memberId = await joinByEmail(api, admin, client, clientName, member);

  // Another organization gives the technician a place of its own.
  const otherOwner = await realAccount(request, "rau-other");
  const otherName = `Unlock Elsewhere ${Date.now()}`;
  const { org: other } = await realOrg(api, otherOwner, otherName);
  const techElsewhere = await joinByEmail(api, otherOwner, other, otherName, tech);

  // Both turn on account recovery with automatic enrollment, after the fact.
  await turnOnRecovery(api, admin, client.id);
  await turnOnRecovery(api, otherOwner, other.id);
  expect(await enrolled(api, admin, client.id, member.email)).toBe(false);

  // The member signs in to the web vault, and nothing asks them anything.
  const memberContext = await browser.newContext({ baseURL: mailServer, ignoreHTTPSErrors: true });
  const memberPage = await memberContext.newPage();
  const memberSent = watchEnrollments(memberPage);
  await signIn(memberPage, member);
  await expect
    .poll(() => recoveryKey(api, admin, client.id, memberId), { timeout: 30_000 })
    .toMatch(/^4\./);
  expect(await enrolled(api, admin, client.id, member.email)).toBe(true);

  // It's their real user key, encrypted to the client's public key: the
  // client's private key opens it, as an admin's Recover account will.
  const sealed = (await recoveryKey(api, admin, client.id, memberId))!;
  expect(openRecoveryKey(sealed, privateKey).equals(member.userKey)).toBe(true);
  // Once, and nothing after: another page of the vault doesn't send it again.
  await memberPage.goto("/#/settings/account");
  await memberPage.goto("/#/vault");
  await expect(memberPage.getByRole("heading", { name: "All items" }).first()).toBeVisible();
  expect(memberSent).toEqual([{ orgId: client.id, status: 200 }]);

  // The technician signs in. Their place in the client came from the MSP, so
  // the web vault sends nothing for it. The other organization's place is
  // their own, and the server refuses it: an MSP's staff are never enrolled.
  const techContext = await browser.newContext({ baseURL: mailServer, ignoreHTTPSErrors: true });
  const techPage = await techContext.newPage();
  const techSent = watchEnrollments(techPage);
  const refused = techPage.waitForResponse(
    (r) => r.url().includes(`/api/organizations/${other.id}/users/`) && r.request().method() === "PUT",
    { timeout: 30_000 },
  );
  await signIn(techPage, tech, true);
  expect((await refused).status()).toBe(400);
  expect((await (await refused).json()).message).toContain("MSP staff can't join an organization's account recovery");
  // Nothing tries again in this unlock, whatever else the vault does.
  await techPage.goto("/#/settings/account");
  await techPage.goto("/#/vault");
  await expect(techPage.getByRole("heading", { name: "All items" }).first()).toBeVisible();
  expect(techSent).toEqual([{ orgId: other.id, status: 400 }]);
  expect(await enrolled(api, admin, client.id, tech.email)).toBe(false);
  expect(await enrolled(api, otherOwner, other.id, tech.email)).toBe(false);
  expect(await recoveryKey(api, otherOwner, other.id, techElsewhere)).toBeNull();

  await memberContext.close();
  await techContext.close();
  await request.dispose();
});

extensionTest("the browser extension enrolls a member at unlock too", async ({ context, extensionId }) => {
  extensionTest.setTimeout(180_000);
  const request = await mailServerRequests();
  const api = new Api(request);
  const owner = await realAccount(request, "rau-ext-owner");
  const orgName = `Unlock Extension ${Date.now()}`;
  const { org, privateKey } = await realOrg(api, owner, orgName);
  const member = await realAccount(request, "rau-ext-member");
  const memberId = await joinByEmail(api, owner, org, orgName, member);
  await turnOnRecovery(api, owner, org.id);

  // The member signs in to the extension; its background enrolls them.
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, { email: member.email, password: member.password, name: "rau-ext-member" }, mailServer);
  await expect
    .poll(() => recoveryKey(api, owner, org.id, memberId), { timeout: 30_000 })
    .toMatch(/^4\./);
  const sealed = (await recoveryKey(api, owner, org.id, memberId))!;
  expect(openRecoveryKey(sealed, privateKey).equals(member.userKey)).toBe(true);
  expect(await enrolled(api, owner, org.id, member.email)).toBe(true);

  await request.dispose();
});

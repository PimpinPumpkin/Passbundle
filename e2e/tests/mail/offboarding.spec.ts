// Offboarding that holds (DESIGN.md, "Offboarding"), for what needs a server
// that sends email: install commands limited to email domains (verified
// emails), account recovery, and invitation emails. The rest is in
// tests/api/offboarding.spec.ts.
import { randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { mailServerPort } from "../../paths.mjs";
import { type Account, Api, encString, withMasterPassword } from "../api/support";
import { message, ssoOrg, ssoSignIn } from "../support/entra";

import { joinByEmail, verifyEmail, waitForMessage } from "./mailbox";

// The master password these changes need is checked the way a sign-in is
// (600,000 rounds of PBKDF2 on the server, slow in its debug build), so tests
// that make several get more time.
test.describe.configure({ timeout: 120_000 });

const INVITED = 0;
const ACCEPTED = 1;
const OWNER = 0;
const USER = 2;
const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const origin = `https://127.0.0.1:${mailServerPort}`;

/** Whether the MSP's console, or a client's own apps, would let this person in without an admin. */
async function letInAlone(api: Api, admin: Account, mspId: string, who: Account): Promise<boolean | undefined> {
  const pending = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  expect(pending.status, JSON.stringify(pending.body)).toBe(200);
  return pending.body.data.find((p: { email: string }) => p.email === who.email)?.autoConfirm;
}

async function memberOf(api: Api, admin: Account, orgId: string, who: Account) {
  return (await api.members(admin, orgId)).find((m) => m.email === who.email);
}

async function provision(request: APIRequestContext, token: string, orgId: string, email: string): Promise<string> {
  const response = await request.fetch(`/scim/v2/${orgId}/Users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/scim+json" },
    data: JSON.stringify({
      schemas: [SCIM_USER],
      externalId: randomUUID(),
      userName: `${randomUUID()}@contoso.onmicrosoft.com`,
      active: true,
      emails: [{ primary: true, type: "work", value: email }],
    }),
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).id as string;
}

test("someone removed who rejoins with the install command they kept waits for an admin, until the client invites them again, and so does someone the directory removed", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Maple IT");
  const orgId = await api.client(admin, mspId, "Maple Dental");
  const command = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`);
  const token = command.body.token as string;
  const domains = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment/domains`, {
    domains: ["api.example.test"],
  });
  expect(domains.status, JSON.stringify(domains.body)).toBe(200);
  const join = (who: Account) => api.call(who, "POST", "/api/keykeeper/enrollment/join", { token });
  const confirm = async (who: Account) => {
    const member = (await memberOf(api, admin, orgId, who))!;
    const confirmed = await api.call(admin, "POST", `/api/organizations/${orgId}/users/${member.id}/confirm`, {
      key: encString(`org-key-for-${who.email}`),
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return member.id;
  };

  // A verified account at the client's domain joins and is let in on its own.
  const ana = await api.account("ana");
  await verifyEmail(api, ana);
  expect((await join(ana)).status).toBe(200);
  expect(await letInAlone(api, admin, mspId, ana)).toBe(true);
  const anaId = await confirm(ana);

  // Removed, she joins again with the same command: she waits for an admin.
  expect((await api.call(admin, "DELETE", `/api/organizations/${orgId}/users/${anaId}`)).status).toBe(200);
  const back = await join(ana);
  expect(back.status, JSON.stringify(back.body)).toBe(200);
  expect(back.body.status).toBe(ACCEPTED);
  expect(await letInAlone(api, admin, mspId, ana)).toBe(false);
  expect((await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`)).body.removedSinceToken).toBe(1);

  // An admin's approval settles it.
  const approvedId = await confirm(ana);
  expect((await api.call(admin, "DELETE", `/api/organizations/${orgId}/users/${approvedId}`)).status).toBe(200);

  // A new invitation does too: she's let in on her own again.
  const invited = await api.call(admin, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [ana.email],
    type: USER,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  expect((await join(ana)).status).toBe(200);
  expect(await letInAlone(api, admin, mspId, ana)).toBe(true);

  // Someone the directory removes is remembered the same way.
  const scim = await api.call(
    admin,
    "POST",
    `/api/keykeeper/organizations/${orgId}/provisioning/token`,
    withMasterPassword(admin),
  );
  expect(scim.status, JSON.stringify(scim.body)).toBe(200);
  const ben = await api.account("ben");
  await verifyEmail(api, ben);
  const scimId = await provision(request, scim.body.newToken, orgId, ben.email);
  expect((await join(ben)).status).toBe(200);
  expect(await letInAlone(api, admin, mspId, ben)).toBe(true);
  await confirm(ben);
  const deleted = await request.fetch(`/scim/v2/${orgId}/Users/${scimId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${scim.body.newToken}` },
  });
  expect(deleted.status()).toBe(204);
  expect((await join(ben)).status).toBe(200);
  expect(await letInAlone(api, admin, mspId, ben)).toBe(false);
});

test("an MSP's people can't recover the client's own owners, and making an MSP ends its admin's own recovery enrollments", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Nutmeg IT");
  const orgName = `Nutmeg Law ${randomUUID().slice(0, 6)}`;
  const orgId = await api.client(admin, mspId, orgName);
  const recovery = await api.call(admin, "PUT", `/api/organizations/${orgId}/policies/8`, {
    policy: { enabled: true, data: { autoEnrollEnabled: true } },
  });
  expect(recovery.status, JSON.stringify(recovery.body)).toBe(200);
  const owner = await api.account("client-owner");
  const ownerId = await joinByEmail(api, admin, orgId, orgName, owner, { type: OWNER });
  const member = await api.account("member");
  const memberId = await joinByEmail(api, admin, orgId, orgName, member, { type: USER });

  const details = (who: Account, id: string) =>
    api.call(who, "GET", `/api/organizations/${orgId}/users/${id}/reset-password-details`);
  const refused = await details(admin, ownerId);
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(/Only the organization's own owners can recover one of its owners/);
  const recovered = await api.call(admin, "PUT", `/api/organizations/${orgId}/users/${ownerId}/recover-account`, {
    newMasterPasswordHash: Buffer.from("new-hash").toString("base64"),
    key: encString("new-key"),
    resetMasterPassword: true,
    resetTwoFactor: false,
  });
  expect(recovered.status).toBe(400);
  // A regular member, the MSP's admin can; the client's own owner, anyone.
  expect((await details(admin, memberId)).status).toBe(200);
  expect((await details(owner, memberId)).status).toBe(200);

  // MSP staff are never recoverable: setting up an MSP ends the enrollments
  // its admin has, as joining one's staff does.
  const enrolled = async () =>
    (await api.call(member, "GET", "/api/accounts/profile")).body.organizations.find(
      (o: { id: string }) => o.id === orgId,
    ).resetPasswordEnrolled;
  expect(await enrolled()).toBe(true);
  await api.msp(member, "Member's Own IT");
  expect(await enrolled()).toBe(false);
});

test("someone whose first sign-in is with single sign-on joins an organization that enrolls everyone in account recovery only with their recovery key", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const { owner, orgId, tenant, identifier, domain } = await ssoOrg(api, "first-sso");
  const recovery = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/8`, {
    policy: { enabled: true, data: { autoEnrollEnabled: true } },
  });
  expect(recovery.status, JSON.stringify(recovery.body)).toBe(200);
  const email = `fay-${randomUUID().slice(0, 8)}@${domain}`;
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [email],
    type: USER,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  await waitForMessage(email, /Join /);

  await tenant.next(await tenant.person(email));
  const signedIn = await ssoSignIn(request, origin, identifier);
  expect(signedIn.token?.status, message(signedIn.token?.body)).toBe(200);
  const fay = { token: signedIn.token!.body.access_token as string };
  const passwordHash = Buffer.from(`hash-${email}`).toString("base64");
  const set = await api.call(fay, "POST", "/api/accounts/set-password", {
    masterPasswordHash: passwordHash,
    key: encString(`user-key-${email}`),
    masterPasswordHint: null,
    orgIdentifier: identifier,
    keys: { publicKey: Buffer.from(`public-${email}`).toString("base64"), encryptedPrivateKey: encString(`private-${email}`) },
    kdf: 0,
    kdfIterations: 600000,
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const member = () => api.members(owner, orgId).then((m) => m.find((x) => x.email === email)!);
  // Still invited: nobody can confirm her without her recovery key.
  expect((await member()).status).toBe(INVITED);
  const pending = await api.call(owner, "GET", "/api/keykeeper/organizations/pending");
  expect(pending.body.data.map((p: { email: string }) => p.email)).not.toContain(email);

  // The app enrolls her right after, as upstream's does, and that joins her.
  const userId = (await api.call(fay, "GET", "/api/accounts/profile")).body.id as string;
  const enrolled = await api.call(fay, "PUT", `/api/organizations/${orgId}/users/${userId}/reset-password-enrollment`, {
    resetPasswordKey: encString(`recovery-key-${email}`),
    masterPasswordHash: passwordHash,
  });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
  const joined = await member();
  expect(joined.status).toBe(ACCEPTED);
  const details = await api.call(owner, "GET", `/api/organizations/${orgId}/users/${joined.id}/reset-password-details`);
  expect(details.body.resetPasswordKey).toBe(encString(`recovery-key-${email}`));
});

test("an MSP's invitation emails to one address are limited, even if each is cancelled", async ({ request }) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Oak IT");
  const email = `invitee-${randomUUID().slice(0, 8)}@api.example.test`;
  const invite = () => api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/staff`, { email, role: "technician" });
  for (let i = 0; i < 3; i++) {
    const sent = await invite();
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.emailed).toBe(true);
    expect((await api.call(admin, "DELETE", `/api/keykeeper/msp/${mspId}/invites/${sent.body.inviteId}`)).status).toBe(200);
  }
  const fourth = await invite();
  expect(fourth.status).toBe(400);
  expect(fourth.body.message).toMatch(/has had 3 invitations from your MSP today/);
});

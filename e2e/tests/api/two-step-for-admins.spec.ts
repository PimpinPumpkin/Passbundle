// Two-step login for admins (DESIGN.md, "Two-step login for admins"): an
// organization that requires it (the Business preset and an MSP's clients, by
// default) requires its owners, admins, custom roles that manage members,
// policies, or account recovery, and everyone its MSP brings in to have an
// authenticator app, a security key or passkey, or Duo with the server's own
// Duo account; an MSP requires it of its whole staff. Someone it covers who
// signs in without one gets a setup session, which can only set one up,
// instead of a login, and someone a change brings under it without one is
// signed out everywhere at once.
import { constants, generateKeyPairSync, publicEncrypt, randomBytes, randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { port } from "../../paths.mjs";
import { linkFromSession, settings, ssoOrg, ssoSignIn } from "../support/entra";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Cert, httpsReceiver, throwawayCert, waitFor } from "./siem";
import { type Account, Api, type Result, encString, nextTotp, publicKey, totp } from "./support";

const origin = `https://127.0.0.1:${port}`;
const ADMIN_TWO_STEP = 1000;

const orgSetting = (orgId: string) => `/api/keykeeper/organizations/${orgId}/admin-two-step`;
const mspSetting = (mspId: string) => `/api/keykeeper/msp/${mspId}/two-step`;

async function requireIt(api: Api, as: { token: string }, orgId: string, required: boolean) {
  const saved = await api.call(as, "PUT", orgSetting(orgId), { required });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.required).toBe(required);
  return saved.body;
}

/** A sign-in the rule held up: a setup session, and nothing that signs in. */
function expectSetup(result: Result, requiredBy?: string[]) {
  expect(result.status, JSON.stringify(result.body)).toBe(400);
  expect(result.body.KeykeeperTwoStepSetup, JSON.stringify(result.body)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.body.error).toBe("invalid_grant");
  expect(result.body.ErrorModel.Message).toMatch(/require[s]? two-step login for your role/);
  expect(result.body.ErrorModel.Message).toContain("an authenticator app, a security key or passkey, or Duo");
  expect(result.body).not.toHaveProperty("access_token");
  expect(result.body).not.toHaveProperty("refresh_token");
  expect(result.body).not.toHaveProperty("Key");
  if (requiredBy) {
    expect(result.body.KeykeeperTwoStepRequiredBy).toEqual(requiredBy);
  }
  return result.body.KeykeeperTwoStepSetup as string;
}

function expectSignedIn(result: Result) {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.access_token).toBeTruthy();
  expect(result.body).not.toHaveProperty("KeykeeperTwoStepSetup");
}

/** Whether a session's access token still works. */
async function works(api: Api, token: string) {
  return (await api.call({ token }, "GET", "/api/sync")).status === 200;
}

/** What a session's access token says. */
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

/** A password sign-in with the next code from the account's authenticator (Api.giveAuthenticator). */
async function signInWithCode(api: Api, who: Account, extra: Record<string, string> = {}) {
  return api.signIn(who.email, who.password, {
    twoFactorProvider: "0",
    twoFactorToken: await nextTotp(who.email),
    ...extra,
  });
}

async function businessOrg(api: Api, owner: Account, name: string) {
  const created = await api.call(owner, "POST", "/api/keykeeper/organizations", {
    name,
    collectionName: encString(`everyone-${name}`),
    adminsCollectionName: encString(`admins-${name}`),
    preset: "business",
    key: encString(`org-key-for-${owner.email}`),
    keys: { publicKey: publicKey(`org-${name}`), encryptedPrivateKey: encString(`org-private-${name}`) },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}

/**
 * Puts someone on an MSP's staff without an authenticator (Api.addStaff
 * gives one): they accept the invitation, and joining signs them out.
 */
async function inviteStaff(api: Api, admin: Account, mspId: string, member: Account, role: string, access?: unknown) {
  const invited = await api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/staff`, {
    email: member.email,
    role,
    access,
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const token = new URL(invited.body.inviteUrl).hash.split("invite=")[1];
  const accepted = await api.call(member, "POST", "/api/keykeeper/msp/invites/accept", { token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
}

async function refresh(request: APIRequestContext, refreshToken: string) {
  const response = await request.post("/identity/connect/token", {
    form: { grant_type: "refresh_token", client_id: "web", refresh_token: refreshToken },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

test("an organization's owners, admins, and custom roles that manage members, policies, or account recovery need it; nobody else does", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  // The owner who changes things has an authenticator; a second owner doesn't.
  const owner = await api.account("rule-owner");
  await api.giveAuthenticator(owner);
  const orgName = `Acme Dental ${randomUUID().slice(0, 6)}`;
  const orgId = await api.organization(owner, orgName);
  const coOwner = await api.account("rule-co-owner");
  await api.addMember(owner, orgId, coOwner, "owner");

  const admin = await api.account("rule-admin");
  await api.addMember(owner, orgId, admin, "admin");
  const revoked = await api.account("rule-revoked");
  const revokedId = await api.addMember(owner, orgId, revoked, "admin");
  const revoke = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${revokedId}/revoke`);
  expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
  // One member whose role changes, to try each of the others.
  const member = await api.account("rule-member");
  const memberId = await api.addCustomMember(owner, orgId, member, { manageUsers: true });
  const giveRole = async (type: number, permissions: Record<string, boolean> = {}) => {
    const given = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
      type,
      permissions,
      collections: [],
      groups: [],
      accessAll: false,
    });
    expect(given.status, JSON.stringify(given.body)).toBe(200);
  };

  // An organization made the upstream way (a family, a group) doesn't
  // require it, so its owners and admins still sign in with a password alone.
  expect((await api.call(owner, "GET", orgSetting(orgId))).body.required).toBe(false);
  for (const person of [coOwner, admin]) {
    expectSignedIn(await api.signIn(person.email, person.password));
  }

  // Before it's on, the setting lists who it would hold up.
  const before = (await api.call(owner, "GET", orgSetting(orgId))).body;
  const listed = (before.notSetUp as { email: string; role: string }[]).map((p) => `${p.email}:${p.role}`).sort();
  expect(listed).toEqual([`${coOwner.email}:owner`, `${admin.email}:admin`, `${member.email}:custom`].sort());

  await requireIt(api, owner, orgId, true);
  for (const person of [coOwner, admin]) {
    expectSetup(await api.signIn(person.email, person.password), [orgName]);
  }
  // A revoked admin reaches nothing, so isn't covered.
  expectSignedIn(await api.signIn(revoked.email, revoked.password));
  // Custom roles that manage members, policies, or account recovery are
  // covered; members, managers, and custom roles that only see the event log
  // or import and export aren't.
  const CUSTOM = 4;
  for (const [type, permissions, covered] of [
    [CUSTOM, { manageUsers: true }, true],
    [CUSTOM, { managePolicies: true }, true],
    [CUSTOM, { manageResetPassword: true }, true],
    [CUSTOM, { accessEventLogs: true }, false],
    [CUSTOM, { accessImportExport: true }, false],
    [3, {}, false],
    [2, {}, false],
  ] as const) {
    await giveRole(type, permissions);
    const signIn = await api.signIn(member.email, member.password);
    if (covered) {
      expectSetup(signIn, [orgName]);
    } else {
      expectSignedIn(signIn);
    }
  }
  // A wrong password says nothing about it.
  const wrong = await api.signIn(admin.email, Buffer.from("wrong").toString("base64"));
  expect(wrong.status).toBe(400);
  expect(wrong.body).not.toHaveProperty("KeykeeperTwoStepSetup");
  expect(JSON.stringify(wrong.body)).not.toMatch(/two-step/i);
});

test("the Business preset and an MSP's clients have it on, an MSP needs it of its staff, and either can turn it off", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);

  // A company's own organization with the Business preset. Its owner has no
  // method, so making it signs them out at once.
  const bizOwner = await api.account("biz-owner");
  const bizName = `Fabrikam ${randomUUID().slice(0, 6)}`;
  await businessOrg(api, bizOwner, bizName);
  expect(await works(api, bizOwner.token)).toBe(false);
  expectSetup(await api.signIn(bizOwner.email, bizOwner.password), [bizName]);

  // An MSP: its staff, and its clients' admins, by default. Its admin has an
  // authenticator (Api.msp).
  const mspAdmin = await api.account("msp-admin");
  const mspName = `Contoso IT ${randomUUID().slice(0, 6)}`;
  const mspId = await api.msp(mspAdmin, mspName);
  const defaults = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`);
  expect(defaults.body.types).toContain(ADMIN_TWO_STEP);
  expect(defaults.body.defaults).toContainEqual({ type: ADMIN_TWO_STEP, enabled: true, data: null });
  const clientName = `Northwind ${randomUUID().slice(0, 6)}`;
  const clientId = await api.client(mspAdmin, mspId, clientName, "business");
  expect((await api.call(mspAdmin, "GET", orgSetting(clientId))).body).toMatchObject({
    required: true,
    msp: { id: mspId, name: mspName },
  });
  // A technician with an authenticator, and one without, whom joining signs out.
  const technician = await api.account("msp-technician");
  await api.addStaff(mspAdmin, mspId, technician, "technician");
  const newcomer = await api.account("msp-newcomer");
  await inviteStaff(api, mspAdmin, mspId, newcomer, "technician");
  expect(await works(api, newcomer.token)).toBe(false);
  await api.confirmPending(mspAdmin, mspId);
  // The client's owner has an authenticator; its admin doesn't.
  const clientOwner = await api.account("client-owner");
  await api.giveAuthenticator(clientOwner);
  await api.addMember(mspAdmin, clientId, clientOwner, "owner");
  const clientAdmin = await api.account("client-admin");
  await api.addMember(mspAdmin, clientId, clientAdmin, "admin", { authenticator: false });
  expect(await works(api, clientAdmin.token)).toBe(false);

  const view = (await api.call(mspAdmin, "GET", mspSetting(mspId))).body;
  expect(view.staffRequired).toBe(true);
  expect(view.staffNotSetUp.map((s: { email: string }) => s.email)).toEqual([newcomer.email]);
  const client = view.clients.find((c: { id: string }) => c.id === clientId);
  expect(client.required).toBe(true);
  // The client's own people; the MSP's staff are listed as staff.
  expect(client.notSetUp.map((p: { email: string }) => p.email)).toEqual([clientAdmin.email]);

  // A technician is an admin in every client, so both name them.
  expectSetup(await api.signIn(newcomer.email, newcomer.password), [mspName, clientName]);
  expectSetup(await api.signIn(clientAdmin.email, clientAdmin.password), [clientName]);

  // Turning off the staff rule leaves the client's own rule, which covers
  // everyone the MSP brings in.
  const technicianRefused = await api.call(technician, "PUT", mspSetting(mspId), { staffRequired: false });
  expect(technicianRefused.status).toBe(403);
  const off = await api.call(mspAdmin, "PUT", mspSetting(mspId), { staffRequired: false });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.staffRequired).toBe(false);
  expectSetup(await api.signIn(newcomer.email, newcomer.password), [clientName]);
  // And the client's owner turns the client's off: its own setting.
  await requireIt(api, clientOwner, clientId, false);
  expectSignedIn(await api.signIn(newcomer.email, newcomer.password));
  expectSignedIn(await api.signIn(clientAdmin.email, clientAdmin.password));
  const own = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`);
  const ownClient = own.body.clients.find((c: { id: string }) => c.id === clientId);
  expect(ownClient.own).toContainEqual({ type: ADMIN_TWO_STEP, enabled: false, data: null });

  // Both changes are in the MSP's activity log.
  const events = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  const recorded = (events.body.data as { event: string; detail: string | null; orgId?: string }[]).map(
    (e) => `${e.event}:${e.detail}`,
  );
  expect(recorded).toContain("staff_two_step_set:off");
  expect(recorded).toContain("client_admin_two_step_set:off");

  // Use default puts the client back on the MSP's default, and its admins
  // need it again.
  const back = await api.call(mspAdmin, "POST", `/api/keykeeper/msp/${mspId}/policies/${ADMIN_TWO_STEP}/apply`, {
    clients: [clientId],
  });
  expect(back.status, JSON.stringify(back.body)).toBe(200);
  expect(back.body.changed.map((c: { id: string }) => c.id)).toEqual([clientId]);
  expectSetup(await api.signIn(clientAdmin.email, clientAdmin.password), [clientName]);

  // A default the MSP turns off reaches the clients that follow it.
  const changed = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${ADMIN_TWO_STEP}`, {
    enabled: false,
    data: null,
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body.changed.map((c: { id: string }) => c.id)).toEqual([clientId]);
  expect((await api.call(clientOwner, "GET", orgSetting(clientId))).body.required).toBe(false);
  expectSignedIn(await api.signIn(clientAdmin.email, clientAdmin.password));
});

test("everyone an MSP brings into a client is covered by the client's setting, whatever their role there", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const mspAdmin = await api.account("reach-msp-admin");
  const mspId = await api.msp(mspAdmin, `Reach IT ${randomUUID().slice(0, 6)}`);
  const clientName = `Reach Client ${randomUUID().slice(0, 6)}`;
  const clientId = await api.client(mspAdmin, mspId, clientName, "business");
  // Only the client's rule, not the MSP's.
  const off = await api.call(mspAdmin, "PUT", mspSetting(mspId), { staffRequired: false });
  expect(off.status, JSON.stringify(off.body)).toBe(200);

  // A technician whose custom role reaches every vault item and exports
  // them, but manages no members, policies, or account recovery.
  const reader = { permissions: { accessImportExport: true }, vaultItems: true };
  const technician = await api.account("reach-technician");
  await inviteStaff(api, mspAdmin, mspId, technician, "technician", {
    allClients: true,
    clients: [],
    custom: reader,
    installCommands: false,
  });
  await api.confirmPending(mspAdmin, mspId);
  expectSetup(await api.signIn(technician.email, technician.password), [clientName]);

  // The client's own member with that role isn't covered.
  const member = await api.account("reach-member");
  await api.addCustomMember(mspAdmin, clientId, member, { accessImportExport: true });
  expectSignedIn(await api.signIn(member.email, member.password));
});

test("a setup session can only set up two-step login, setting it up ends the session with a new recovery code, and then the person signs in as usual", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("setup-owner");
  // A recovery code from earlier two-step login, turned off again.
  await api.turnOnAuthenticator(owner, owner.password);
  const earlier = (await api.call(owner, "POST", "/api/two-factor/get-recover", { masterPasswordHash: owner.password }))
    .body.code as string;
  expect(earlier).toMatch(/^[A-Z2-7]{32}$/);
  const turnedOff = await api.call(owner, "PUT", "/api/two-factor/disable", {
    masterPasswordHash: owner.password,
    type: 0,
  });
  expect(turnedOff.status, JSON.stringify(turnedOff.body)).toBe(200);
  const orgName = `Tailspin ${randomUUID().slice(0, 6)}`;
  const orgId = await businessOrg(api, owner, orgName);

  // One at a time: a second sign-in's session replaces the first's.
  const first = expectSetup(await api.signIn(owner.email, owner.password));
  const token = expectSetup(await api.signIn(owner.email, owner.password));
  expect((await api.call({ token: first }, "GET", "/api/keykeeper/two-step-setup")).status).toBe(401);

  const setup = { token };
  const info = await api.call(setup, "GET", "/api/keykeeper/two-step-setup");
  expect(info.status, JSON.stringify(info.body)).toBe(200);
  expect(info.body).toMatchObject({
    email: owner.email,
    requiredBy: [orgName],
    qualifying: false,
    hasMasterPassword: true,
    // Duo counts only with the server's own Duo account, which this test
    // server doesn't have.
    methods: { authenticator: true, duo: false },
  });

  // Nothing else takes it: not the vault, the account, the organization,
  // other two-step settings, single sign-on's linking, or an API key.
  for (const [method, path, data] of [
    ["GET", "/api/sync", undefined],
    ["GET", "/api/accounts/profile", undefined],
    ["GET", "/api/two-factor", undefined],
    ["POST", "/api/two-factor/get-recover", { masterPasswordHash: owner.password }],
    ["PUT", "/api/two-factor/disable", { masterPasswordHash: owner.password, type: 0 }],
    ["DELETE", "/api/two-factor/webauthn", { masterPasswordHash: owner.password, id: 1 }],
    ["POST", "/api/two-factor/get-email", { masterPasswordHash: owner.password }],
    ["POST", "/api/accounts/api-key", { masterPasswordHash: owner.password }],
    ["POST", "/api/accounts/sso/user-identifier", { masterPasswordHash: owner.password }],
    ["GET", `/api/organizations/${orgId}/users`, undefined],
    ["GET", orgSetting(orgId), undefined],
    ["PUT", orgSetting(orgId), { required: false }],
    ["GET", "/api/ciphers", undefined],
  ] as const) {
    const refused = await api.call(setup, method, path, data);
    expect(refused.status, `${method} ${path}: ${JSON.stringify(refused.body)}`).toBe(401);
  }
  // It isn't a refresh token either.
  expect((await refresh(request, token)).status).toBe(400);

  // The other methods' setup endpoints take it too: Duo's, and the security
  // key's (which this test server, at an IP address, can't offer).
  const duo = await api.call(setup, "POST", "/api/two-factor/get-duo", { masterPasswordHash: owner.password });
  expect(duo.status, JSON.stringify(duo.body)).toBe(200);
  const webAuthn = await api.call(setup, "POST", "/api/two-factor/get-webauthn", {
    masterPasswordHash: owner.password,
  });
  expect(webAuthn.status, JSON.stringify(webAuthn.body)).toBe(400);
  expect(webAuthn.body.message).toMatch(/not compatible with Webauthn/);
  // But it sets up no Duo that doesn't count: someone's own Duo application,
  // or the server's, which this one doesn't have.
  for (const [keys, refusal] of [
    [{ clientId: "DIXXXXXXXXXXXXXXXXXX", clientSecret: "secret", host: "api-1.duosecurity.com" }, /only with this server's own Duo account/],
    [{ clientId: "", clientSecret: "", host: "" }, /no Duo account of its own/],
  ] as const) {
    const ownDuo = await api.call(setup, "PUT", "/api/two-factor/duo", { ...keys, masterPasswordHash: owner.password });
    expect(ownDuo.status, JSON.stringify(ownDuo.body)).toBe(400);
    expect(ownDuo.body.message).toMatch(refusal);
  }

  // Upstream's setup endpoints still want the master password.
  const wrong = await api.call(setup, "POST", "/api/two-factor/get-authenticator", {
    masterPasswordHash: Buffer.from("wrong").toString("base64"),
  });
  expect(wrong.status).toBe(400);
  const started = await api.call(setup, "POST", "/api/two-factor/get-authenticator", {
    masterPasswordHash: owner.password,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const key = started.body.key as string;
  const on = await api.call(setup, "POST", "/api/two-factor/authenticator", {
    key,
    token: totp(key),
    masterPasswordHash: owner.password,
  });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  expect(on.body.enabled).toBe(true);
  // A new recovery code comes with it, since the session ends here: the
  // earlier one stops working.
  const recoveryCode = on.body.keykeeperRecoveryCode as string;
  expect(recoveryCode).toMatch(/^[A-Z2-7]{32}$/);
  expect(recoveryCode).not.toBe(earlier);

  // Set up: the session is gone.
  expect((await api.call(setup, "GET", "/api/keykeeper/two-step-setup")).status).toBe(401);
  expect((await api.call(setup, "POST", "/api/two-factor/get-authenticator", { masterPasswordHash: owner.password })).status).toBe(401);

  // And the person signs in as usual, with their authenticator.
  const asked = await api.signIn(owner.email, owner.password);
  expect(asked.status).toBe(400);
  expect(asked.body.TwoFactorProviders).toEqual(["0"]);
  const earlierRefused = await api.signIn(owner.email, owner.password, { twoFactorProvider: "8", twoFactorToken: earlier });
  expect(earlierRefused.status).toBe(400);
  expect(earlierRefused.body).not.toHaveProperty("access_token");
  const signedIn = await api.signIn(owner.email, owner.password, {
    twoFactorProvider: "0",
    twoFactorToken: totp(key, Date.now() + 30_000),
  });
  expectSignedIn(signedIn);
  const session = { token: signedIn.body.access_token as string };
  // The recovery code the setup answer carried is the account's.
  const recover = await api.call(session, "POST", "/api/two-factor/get-recover", { masterPasswordHash: owner.password });
  expect(recover.body.code).toBe(recoveryCode);
  // A signed-in session asks whether its methods count, as the web vault
  // does before someone takes on a role that needs them.
  const counted = await api.call(session, "GET", "/api/keykeeper/two-step-setup");
  expect(counted.status, JSON.stringify(counted.body)).toBe(200);
  expect(counted.body).toMatchObject({ qualifying: true, requiredBy: [] });
  expect((await api.call(session, "GET", orgSetting(orgId))).body.required).toBe(true);
});

test("the two-step recovery code still works, ends the person's other sessions, and leads straight to setting up a new method", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("recovery-owner");
  const orgId = await api.organization(owner, `Recovery Co ${randomUUID().slice(0, 6)}`);
  await api.turnOnAuthenticator(owner, owner.password);
  await requireIt(api, owner, orgId, true);
  const code = (await api.call(owner, "POST", "/api/two-factor/get-recover", { masterPasswordHash: owner.password }))
    .body.code as string;
  expect(await works(api, owner.token)).toBe(true);

  // The code turns two-step login off, as upstream; the sign-in then needs a
  // method that counts, so it's a setup session, and every other session
  // ends.
  const token = expectSetup(
    await api.signIn(owner.email, owner.password, { twoFactorProvider: "8", twoFactorToken: code }),
  );
  expect(await works(api, owner.token)).toBe(false);
  const on = await api.turnOnAuthenticator({ token }, owner.password);
  expect(on).toMatch(/^[A-Z2-7]+$/);
});

test("single sign-on meets the rule for its own organization's admins, never for its owners or another organization", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const { owner, orgId, tenant, identifier } = await ssoOrg(api, "admin2fa");
  await api.giveAuthenticator(owner);
  const xName = (await api.call(owner, "GET", `/api/organizations/${orgId}`)).body.name as string;

  // An admin and a second owner, linked to its single sign-on before the
  // organization requires two-step login, which then signs them out.
  const admin = await api.account("sso-admin");
  await api.addMember(owner, orgId, admin, "admin");
  const person = await tenant.person(admin.email, true, "SSO Admin");
  await tenant.next(person);
  const linked = await linkFromSession(request, origin, admin, identifier);
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);
  const coOwner = await api.account("sso-co-owner");
  await api.addMember(owner, orgId, coOwner, "owner");
  const ownerPerson = await tenant.person(coOwner.email, true, "SSO Owner");
  await tenant.next(ownerPerson);
  const ownerLinked = await linkFromSession(request, origin, coOwner, identifier);
  expect(ownerLinked.status, JSON.stringify(ownerLinked.body)).toBe(200);
  await requireIt(api, owner, orgId, true);
  expect(await works(api, admin.token)).toBe(false);

  // Its single sign-on meets the rule for the admin; their password doesn't.
  await tenant.next(person);
  const viaSso = await ssoSignIn(request, origin, identifier);
  expectSignedIn(viaSso.token!);
  // The session says which organization's single sign-on counted.
  expect(claims(viaSso.token!.body.access_token).kk_sso_org).toBe(orgId);
  expectSetup(await api.signIn(admin.email, admin.password), [xName]);
  // Their single sign-on session refreshes while it's all they need, and
  // keeps saying so.
  const refreshed = await refresh(request, viaSso.token!.body.refresh_token);
  expect(refreshed.status).toBe(200);
  expect(claims(refreshed.body.access_token).kk_sso_org).toBe(orgId);

  // Not when the ID token says the sign-in had no MFA; when it says it had,
  // it does.
  await tenant.next(person, { claims: { amr: ["pwd"] } });
  expectSetup((await ssoSignIn(request, origin, identifier)).token!, [xName]);
  await tenant.next(person, { claims: { amr: ["pwd", "mfa"] } });
  expectSignedIn((await ssoSignIn(request, origin, identifier)).token!);

  // Owners can always sign in with a password, so single sign-on doesn't
  // stand in for two-step login for them.
  await tenant.next(ownerPerson);
  expectSetup((await ssoSignIn(request, origin, identifier)).token!, [xName]);

  // An admin of another organization that requires it, too: this
  // organization's single sign-on doesn't meet that one. Joining it signs
  // them out everywhere at once.
  const otherOwner = await api.account("other-owner");
  await api.giveAuthenticator(otherOwner);
  const yName = `Other Org ${randomUUID().slice(0, 6)}`;
  const otherId = await api.organization(otherOwner, yName);
  await requireIt(api, otherOwner, otherId, true);
  await tenant.next(person);
  const beforeJoining = await ssoSignIn(request, origin, identifier);
  expectSignedIn(beforeJoining.token!);
  const otherMemberId = await api.addMember(otherOwner, otherId, admin, "admin", { authenticator: false });
  expect(await works(api, beforeJoining.token!.body.access_token)).toBe(false);
  expect((await refresh(request, beforeJoining.token!.body.refresh_token)).status).toBe(400);
  await tenant.next(person);
  expectSetup((await ssoSignIn(request, origin, identifier)).token!, [yName]);
  const removed = await api.call(otherOwner, "DELETE", `/api/organizations/${otherId}/users/${otherMemberId}`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);

  // Only someone who meets the rule turns it off: once the organization's
  // single sign-on is off, the session it started no longer meets it; with
  // it on again, it does.
  await tenant.next(person);
  const signedIn = await ssoSignIn(request, origin, identifier);
  expectSignedIn(signedIn.token!);
  const session = { token: signedIn.token!.body.access_token as string };
  const ssoPath = `/api/keykeeper/organizations/${orgId}/sso`;
  const ssoOff = await api.call(owner, "PUT", ssoPath, settings(tenant, identifier, false, false));
  expect(ssoOff.status, JSON.stringify(ssoOff.body)).toBe(200);
  const refused = await api.call(session, "PUT", orgSetting(orgId), { required: false });
  expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  expect(refused.body.message).toMatch(/Set up two-step login for your own account before you turn this off/);
  expect((await api.call(owner, "GET", orgSetting(orgId))).body.required).toBe(true);
  const ssoOn = await api.call(owner, "PUT", ssoPath, settings(tenant, identifier, true, false));
  expect(ssoOn.status, JSON.stringify(ssoOn.body)).toBe(200);
  await requireIt(api, session, orgId, false);
});

test("a session ends at once when its person no longer meets the rule, and goes on when they still do", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("ends-owner");
  await api.giveAuthenticator(owner);
  const orgId = await api.organization(owner, `Ends Co ${randomUUID().slice(0, 6)}`);
  await requireIt(api, owner, orgId, true);

  // An admin who turns two-step login off.
  const admin = await api.account("ends-admin");
  await api.giveAuthenticator(admin);
  const adminId = await api.addMember(owner, orgId, admin, "admin");
  const session = await signInWithCode(api, admin);
  expectSignedIn(session);
  expect((await refresh(request, session.body.refresh_token)).status).toBe(200);
  // Promoted again, with a method that counts: nothing ends.
  const toOwner = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${adminId}`, {
    type: 0,
    collections: [],
    groups: [],
    accessAll: true,
    permissions: {},
  });
  expect(toOwner.status, JSON.stringify(toOwner.body)).toBe(200);
  expect(await works(api, session.body.access_token)).toBe(true);
  const off = await api.call({ token: session.body.access_token }, "PUT", "/api/two-factor/disable", {
    masterPasswordHash: admin.password,
    type: 0,
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(await works(api, session.body.access_token)).toBe(false);
  const ended = await refresh(request, session.body.refresh_token);
  expect(ended.status).toBe(400);
  expect(ended.body.error).toBe("invalid_grant");

  // A member who's made an admin.
  const member = await api.account("ends-member");
  const memberId = await api.addMember(owner, orgId, member, "user");
  const memberSession = await api.signIn(member.email, member.password);
  expectSignedIn(memberSession);
  const promoted = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
    type: 1,
    collections: [],
    groups: [],
    accessAll: false,
    permissions: {},
  });
  expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
  expect(await works(api, memberSession.body.access_token)).toBe(false);
  expect((await refresh(request, memberSession.body.refresh_token)).status).toBe(400);
  expectSetup(await api.signIn(member.email, member.password));

  // An admin whose organization turns it on.
  const later = await api.account("ends-later");
  const otherOwner = await api.account("ends-other-owner");
  await api.giveAuthenticator(otherOwner);
  const otherId = await api.organization(otherOwner, `Later Co ${randomUUID().slice(0, 6)}`);
  await api.addMember(otherOwner, otherId, later, "admin");
  const laterSession = await api.signIn(later.email, later.password);
  expectSignedIn(laterSession);
  await requireIt(api, otherOwner, otherId, true);
  expect(await works(api, laterSession.body.access_token)).toBe(false);
  expect((await refresh(request, laterSession.body.refresh_token)).status).toBe(400);
  // The owner who turned it on has a method that counts, and goes on.
  expect(await works(api, otherOwner.token)).toBe(true);

  // Someone the MSP makes staff, which requires it.
  const mspAdmin = await api.account("ends-msp-admin");
  const mspId = await api.msp(mspAdmin, `Ends IT ${randomUUID().slice(0, 6)}`);
  const joiner = await api.account("ends-joiner");
  const joinerSession = await api.signIn(joiner.email, joiner.password);
  expectSignedIn(joinerSession);
  await inviteStaff(api, mspAdmin, mspId, joiner, "admin");
  expect(await works(api, joinerSession.body.access_token)).toBe(false);
  expect((await refresh(request, joinerSession.body.refresh_token)).status).toBe(400);
});

test("devices remembered for two-step login are forgotten when someone comes under the rule", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("remember-owner");
  await api.giveAuthenticator(owner);
  const orgId = await api.organization(owner, `Remember Co ${randomUUID().slice(0, 6)}`);
  await requireIt(api, owner, orgId, true);
  const member = await api.account("remember-member");
  await api.giveAuthenticator(member);
  const memberId = await api.addMember(owner, orgId, member, "user");

  // A member whose device remembers their two-step login.
  const deviceIdentifier = randomUUID();
  const first = await signInWithCode(api, member, { twoFactorRemember: "1", deviceIdentifier });
  expectSignedIn(first);
  const remembered = await api.signIn(member.email, member.password, {
    twoFactorProvider: "5",
    twoFactorToken: first.body.TwoFactorToken,
    twoFactorRemember: "1",
    deviceIdentifier,
  });
  expectSignedIn(remembered);
  expect(remembered.body.TwoFactorToken).toBeTruthy();

  // Made an admin: their method counts, so their sessions go on, but the
  // device asks for it again, since it may have been remembered with a code
  // that doesn't count.
  const promoted = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
    type: 1,
    collections: [],
    groups: [],
    accessAll: false,
    permissions: {},
  });
  expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
  expect(await works(api, remembered.body.access_token)).toBe(true);
  const forgotten = await api.signIn(member.email, member.password, {
    twoFactorProvider: "5",
    twoFactorToken: remembered.body.TwoFactorToken,
    deviceIdentifier,
  });
  expect(forgotten.status, JSON.stringify(forgotten.body)).toBe(400);
  expect(forgotten.body.TwoFactorProviders).toEqual(["0"]);
});

test("turning it on or off is in the organization's event log, and high for its security tools", async ({
  request,
}) => {
  test.setTimeout(60_000);
  const api = new Api(request);
  const cert: Cert = throwawayCert();
  const receiver = await httpsReceiver(cert);
  try {
    const owner = await api.account("logged-owner");
    await api.giveAuthenticator(owner);
    const orgId = await api.organization(owner, `Logged Co ${randomUUID().slice(0, 6)}`);
    const destination = await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/event-streaming`, {
      name: "SIEM",
      kind: "webhook",
      webhook: { url: receiver.url("/events"), caCertificate: cert.cert },
    });
    expect(destination.status, JSON.stringify(destination.body)).toBe(200);
    await requireIt(api, owner, orgId, true);
    await requireIt(api, owner, orgId, false);
    // Saving what's already there isn't a change, and isn't logged.
    await requireIt(api, owner, orgId, false);

    const start = new Date(Date.now() - 3_600_000).toISOString();
    const end = new Date(Date.now() + 3_600_000).toISOString();
    const log = await api.call(owner, "GET", `/api/organizations/${orgId}/events?start=${start}&end=${end}`);
    const ours = (log.body.data as { type: number; actingUserId: string }[]).filter((e) =>
      [1695, 1696].includes(e.type),
    );
    expect(ours.map((e) => e.type).sort()).toEqual([1695, 1696]);
    for (const e of ours) {
      expect(e.actingUserId).toBe(owner.userId);
    }

    const sent = await waitFor(
      receiver.received,
      (all) => {
        const events = all.flatMap((r) => {
          const body = JSON.parse(r.body);
          return Array.isArray(body) ? body : [body];
        });
        const found = events.filter((e: { type: number }) => [1695, 1696].includes(e.type));
        return found.length >= 2 ? found : undefined;
      },
      "both changes, at the security tool",
    );
    expect(sent.find((e: { type: number }) => e.type === 1696)).toMatchObject({
      name: "Turned off two-step login for admins",
      severity: "high",
      category: "organization",
      actor: { email: owner.email },
    });
    expect(sent.find((e: { type: number }) => e.type === 1695)).toMatchObject({ severity: "high" });
  } finally {
    await receiver.close();
  }
});

test("an API key doesn't sign in someone the rule covers until they set it up, and then reads their vault but does no admin work", async ({
  request,
}) => {
  test.setTimeout(60_000);
  const api = new Api(request);
  const owner = await api.account("key-owner");
  await api.giveAuthenticator(owner);
  const orgId = await api.organization(owner, `Key Co ${randomUUID().slice(0, 6)}`);
  const admin = await api.account("key-admin");
  await api.addMember(owner, orgId, admin, "admin");
  const apiKey = await api.call(admin, "POST", "/api/accounts/api-key", { masterPasswordHash: admin.password });
  expect(apiKey.status, JSON.stringify(apiKey.body)).toBe(200);
  const keyLogin = async () => {
    const response = await request.post("/identity/connect/token", {
      form: {
        grant_type: "client_credentials",
        client_id: `user.${admin.userId}`,
        client_secret: apiKey.body.apiKey,
        scope: "api",
        deviceType: "8",
        deviceIdentifier: randomUUID(),
        deviceName: "admin-cli",
      },
    });
    return { status: response.status(), body: await response.json() };
  };
  // Before the rule covers them, an API key does what their role does.
  const before = await keyLogin();
  expect(before.status).toBe(200);
  const usersPath = `/api/organizations/${orgId}/users`;
  expect((await api.call({ token: before.body.access_token }, "GET", usersPath)).status).toBe(200);

  await requireIt(api, owner, orgId, true);
  const refused = await keyLogin();
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(/requires two-step login for your role\. An API key can't sign in until you set it up/);
  expect(refused.body).not.toHaveProperty("access_token");
  const setup = expectSetup(await api.signIn(admin.email, admin.password));
  await api.turnOnAuthenticator({ token: setup }, admin.password);

  // Set up, the API key signs in again: it reads and changes their own
  // vault, as the CLI and scripts do, but it skips two-step login, so it
  // does no admin work.
  const after = await keyLogin();
  expect(after.status, JSON.stringify(after.body)).toBe(200);
  const key = { token: after.body.access_token as string };
  expect((await api.call(key, "GET", "/api/sync")).status).toBe(200);
  const folder = await api.call(key, "POST", "/api/folders", { name: encString("scripts") });
  expect(folder.status, JSON.stringify(folder.body)).toBe(200);
  for (const [method, path, data] of [
    ["GET", usersPath, undefined],
    ["GET", `/api/organizations/${orgId}/policies`, undefined],
    ["GET", orgSetting(orgId), undefined],
    ["PUT", orgSetting(orgId), { required: false }],
  ] as const) {
    const blocked = await api.call(key, method, path, data);
    expect(blocked.status, `${method} ${path}: ${JSON.stringify(blocked.body)}`).toBe(401);
  }
  expect((await api.call(owner, "GET", orgSetting(orgId))).body.required).toBe(true);
});

// Signing in with another device's approval (DESIGN.md, "Approving a sign-in
// from another device"), as its own tests do it: the web vault in Chrome, a
// real public key, and the user key wrapped to it as type 4.
const WEB = "9";

async function signInOn(api: Api, who: Account, deviceIdentifier: string, authRequest?: { id: string; code: string }) {
  return api.signIn(who.email, authRequest ? authRequest.code : who.password, {
    deviceType: WEB,
    deviceIdentifier,
    ...(authRequest ? { authRequest: authRequest.id } : {}),
  });
}

/** A known device asks to sign in, and a session that signed in with the master password approves it. */
async function approvedRequest(api: Api, request: APIRequestContext, who: Account, approver: string, device: string) {
  const { publicKey: key } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = key.export({ type: "spki", format: "der" });
  const code = randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 25);
  const asked = await request.post("/api/auth-requests", {
    headers: { "Device-Type": WEB },
    data: { email: who.email, deviceIdentifier: device, publicKey: der.toString("base64"), accessCode: code, type: 0 },
  });
  expect(asked.status(), await asked.text()).toBe(200);
  const id = (await asked.json()).id as string;
  const wrapped = publicEncrypt(
    { key: der, format: "der", type: "spki", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    randomBytes(64),
  ).toString("base64");
  const approved = await api.call({ token: approver }, "PUT", `/api/auth-requests/${id}`, {
    deviceIdentifier: claims(approver).device,
    key: `4.${wrapped}`,
    masterPasswordHash: null,
    requestApproved: true,
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return { id, code };
}

test("a sign-in another device approved doesn't start setup, and a session one began ends when its person comes under the rule", async ({
  request,
}) => {
  test.setTimeout(60_000);
  const api = new Api(request);
  const owner = await api.account("approved-owner");
  await api.giveAuthenticator(owner);
  const orgId = await api.organization(owner, `Approved Co ${randomUUID().slice(0, 6)}`);

  // An admin approves a sign-in before the rule is on, and the device that
  // asked (one that's signed in before) signs in with it after.
  const admin = await api.account("approved-admin");
  await api.addMember(owner, orgId, admin, "admin");
  const approver = await signInOn(api, admin, randomUUID());
  expectSignedIn(approver);
  const asking = randomUUID();
  expectSignedIn(await signInOn(api, admin, asking));
  const approval = await approvedRequest(api, request, admin, approver.body.access_token, asking);
  await requireIt(api, owner, orgId, true);
  const viaApproval = await signInOn(api, admin, asking, approval);
  expect(viaApproval.status, JSON.stringify(viaApproval.body)).toBe(400);
  expect(viaApproval.body).not.toHaveProperty("KeykeeperTwoStepSetup");
  expect(viaApproval.body).not.toHaveProperty("access_token");
  expect(viaApproval.body.message).toMatch(/requires two-step login for your role\. Sign in with your master password in the web vault/);

  // A member signs in with an approval, and that session refreshes, until
  // they're made an admin.
  const member = await api.account("approved-member");
  const memberId = await api.addMember(owner, orgId, member, "user");
  const memberApprover = await signInOn(api, member, randomUUID());
  expectSignedIn(memberApprover);
  const memberDevice = randomUUID();
  expectSignedIn(await signInOn(api, member, memberDevice));
  const memberApproval = await approvedRequest(api, request, member, memberApprover.body.access_token, memberDevice);
  const approvedSession = await signInOn(api, member, memberDevice, memberApproval);
  expectSignedIn(approvedSession);
  expect(claims(approvedSession.body.access_token).keykeeper_signin).toBe("authrequest");
  const refreshed = await refresh(request, approvedSession.body.refresh_token);
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  const promoted = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
    type: 1,
    collections: [],
    groups: [],
    accessAll: false,
    permissions: {},
  });
  expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
  expect(await works(api, refreshed.body.access_token)).toBe(false);
  const stopped = await refresh(request, refreshed.body.refresh_token);
  expect(stopped.status).toBe(400);
  expect(stopped.body.error).toBe("invalid_grant");
});

// Who reads and changes the settings. Anyone else gets "not found" (never 403
// for an organization's, which upstream's web vault signs out on).
type Actor =
  | "owner"
  | "admin"
  | "manageUsers"
  | "member"
  | "mspAdmin"
  | "technician"
  | "otherOrgOwner"
  | "otherMspAdmin"
  | "anonymous";
const ACTORS: readonly Actor[] = [
  "owner",
  "admin",
  "manageUsers",
  "member",
  "mspAdmin",
  "technician",
  "otherOrgOwner",
  "otherMspAdmin",
  "anonymous",
];
type Ctx = { api: Api; orgId: string; mspId: string; mspAdmin: Account };

const rows: MatrixRow<Actor, Ctx>[] = [
  {
    name: "read a client's setting and who hasn't set it up",
    allowed: ["owner", "admin", "mspAdmin"],
    request: async ({ orgId }) => ({ method: "GET", path: orgSetting(orgId) }),
  },
  {
    name: "change a client's setting",
    allowed: ["owner", "admin", "mspAdmin"],
    request: async (ctx) => {
      await ctx.api.call(ctx.mspAdmin, "PUT", orgSetting(ctx.orgId), { required: true });
      return {
        method: "PUT",
        path: orgSetting(ctx.orgId),
        data: { required: false },
        check: async (allowed) => {
          const now = await ctx.api.call(ctx.mspAdmin, "GET", orgSetting(ctx.orgId));
          expect(now.body.required).toBe(!allowed);
        },
      };
    },
  },
  {
    name: "read the MSP's setting for its staff",
    allowed: ["mspAdmin", "technician"],
    request: async ({ mspId }) => ({ method: "GET", path: mspSetting(mspId) }),
  },
  {
    name: "change the MSP's setting for its staff",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      await ctx.api.call(ctx.mspAdmin, "PUT", mspSetting(ctx.mspId), { staffRequired: true });
      return {
        method: "PUT",
        path: mspSetting(ctx.mspId),
        data: { staffRequired: false },
        check: async (allowed) => {
          const now = await ctx.api.call(ctx.mspAdmin, "GET", mspSetting(ctx.mspId));
          expect(now.body.staffRequired).toBe(!allowed);
        },
      };
    },
  },
];

test.describe("Two-step login for admins: who reads and changes the settings", () => {
  permissionMatrix(
    ACTORS,
    async (api) => {
      // Everyone the rule may cover here has an authenticator (the MSP's
      // staff from Api.msp and Api.addStaff), so turning it on in a row
      // doesn't end their sessions.
      const mspAdmin = await api.account("matrix-msp-admin");
      const mspId = await api.msp(mspAdmin, "Matrix MSP");
      const orgId = await api.client(mspAdmin, mspId, "Matrix Client");
      const technician = await api.account("matrix-technician");
      await api.addStaff(mspAdmin, mspId, technician, "technician");
      await api.confirmPending(mspAdmin, mspId);
      const owner = await api.account("matrix-owner");
      await api.giveAuthenticator(owner);
      await api.addMember(mspAdmin, orgId, owner, "owner");
      const admin = await api.account("matrix-admin");
      await api.giveAuthenticator(admin);
      await api.addMember(mspAdmin, orgId, admin, "admin");
      const manageUsers = await api.account("matrix-manage-users");
      await api.giveAuthenticator(manageUsers);
      await api.addCustomMember(mspAdmin, orgId, manageUsers, { manageUsers: true });
      const member = await api.account("matrix-member");
      await api.addMember(mspAdmin, orgId, member, "user");
      const otherOrgOwner = await api.account("matrix-other-owner");
      await api.organization(otherOrgOwner, "Matrix Other");
      const otherMspAdmin = await api.account("matrix-other-msp");
      await api.msp(otherMspAdmin, "Other Matrix MSP");
      return {
        ctx: { api, orgId, mspId, mspAdmin },
        callers: {
          owner,
          admin,
          manageUsers,
          member,
          mspAdmin,
          technician,
          otherOrgOwner,
          otherMspAdmin,
          anonymous: null,
        },
      };
    },
    rows,
  );
});

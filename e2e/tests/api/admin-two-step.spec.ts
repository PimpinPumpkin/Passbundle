// Two-step login for admins (DESIGN.md, "Two-step login for admins"): an
// organization that requires it (the Business preset and an MSP's clients, by
// default) requires its owners, admins, and custom roles that manage members,
// policies, or account recovery to have an authenticator app, a security key
// or passkey, or Duo; an MSP requires it of its whole staff. Someone it covers
// who signs in without one gets a setup session, which can only set one up,
// instead of a login.
import { randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { port } from "../../paths.mjs";
import { Tenant, linkFromSession, ssoOrg, ssoSignIn } from "../support/entra";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Cert, httpsReceiver, throwawayCert, waitFor } from "./siem";
import { type Account, Api, type Result, encString, publicKey, totp } from "./support";

const origin = `https://127.0.0.1:${port}`;
const ADMIN_TWO_STEP = 1000;

const orgSetting = (orgId: string) => `/api/keykeeper/organizations/${orgId}/admin-two-step`;
const mspSetting = (mspId: string) => `/api/keykeeper/msp/${mspId}/two-step`;

async function requireIt(api: Api, owner: Account, orgId: string, required: boolean) {
  const saved = await api.call(owner, "PUT", orgSetting(orgId), { required });
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
  const owner = await api.account("rule-owner");
  const orgName = `Acme Dental ${randomUUID().slice(0, 6)}`;
  const orgId = await api.organization(owner, orgName);

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
  // require it, so its owner and admin still sign in with a password alone.
  expect((await api.call(owner, "GET", orgSetting(orgId))).body.required).toBe(false);
  for (const person of [owner, admin]) {
    expectSignedIn(await api.signIn(person.email, person.password));
  }

  // Before it's on, the setting lists who it would hold up.
  const before = (await api.call(owner, "GET", orgSetting(orgId))).body;
  const listed = (before.notSetUp as { email: string; role: string }[]).map((p) => `${p.email}:${p.role}`).sort();
  expect(listed).toEqual([`${owner.email}:owner`, `${admin.email}:admin`, `${member.email}:custom`].sort());

  await requireIt(api, owner, orgId, true);
  for (const person of [owner, admin]) {
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
  test.setTimeout(120_000);
  const api = new Api(request);

  // A company's own organization with the Business preset.
  const bizOwner = await api.account("biz-owner");
  const bizName = `Fabrikam ${randomUUID().slice(0, 6)}`;
  const bizId = await businessOrg(api, bizOwner, bizName);
  expect((await api.call(bizOwner, "GET", orgSetting(bizId))).body.required).toBe(true);
  expectSetup(await api.signIn(bizOwner.email, bizOwner.password), [bizName]);

  // An MSP: its staff, and its clients' admins, by default.
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
  const technician = await api.account("msp-technician");
  await api.addStaff(mspAdmin, mspId, technician, "technician");
  await api.confirmPending(mspAdmin, mspId);
  const clientOwner = await api.account("client-owner");
  await api.addMember(mspAdmin, clientId, clientOwner, "owner");

  const view = (await api.call(mspAdmin, "GET", mspSetting(mspId))).body;
  expect(view.staffRequired).toBe(true);
  expect(view.staffNotSetUp.map((s: { email: string }) => s.email).sort()).toEqual(
    [mspAdmin.email, technician.email].sort(),
  );
  const client = view.clients.find((c: { id: string }) => c.id === clientId);
  expect(client.required).toBe(true);
  // The client's own people; the MSP's staff are listed as staff.
  expect(client.notSetUp.map((p: { email: string }) => p.email)).toEqual([clientOwner.email]);

  // MSP admins are owners in every client, so both name them.
  expectSetup(await api.signIn(mspAdmin.email, mspAdmin.password), [mspName, clientName]);
  expectSetup(await api.signIn(technician.email, technician.password), [mspName, clientName]);
  expectSetup(await api.signIn(clientOwner.email, clientOwner.password), [clientName]);

  // Turning off the staff rule leaves the client's own rule for its admins,
  // which covers a technician, an admin there.
  const technicianRefused = await api.call(technician, "PUT", mspSetting(mspId), { staffRequired: false });
  expect(technicianRefused.status).toBe(403);
  const off = await api.call(mspAdmin, "PUT", mspSetting(mspId), { staffRequired: false });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.staffRequired).toBe(false);
  expectSetup(await api.signIn(technician.email, technician.password), [clientName]);
  // And the client's owner turns the client's off: its own setting.
  await requireIt(api, clientOwner, clientId, false);
  expectSignedIn(await api.signIn(technician.email, technician.password));
  expectSignedIn(await api.signIn(clientOwner.email, clientOwner.password));
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
  expectSetup(await api.signIn(clientOwner.email, clientOwner.password), [clientName]);

  // A default the MSP turns off reaches the clients that follow it.
  const changed = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${ADMIN_TWO_STEP}`, {
    enabled: false,
    data: null,
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body.changed.map((c: { id: string }) => c.id)).toEqual([clientId]);
  expect((await api.call(clientOwner, "GET", orgSetting(clientId))).body.required).toBe(false);
  expectSignedIn(await api.signIn(clientOwner.email, clientOwner.password));
});

test("a setup session can only set up two-step login, setting it up ends the session, and then the person signs in as usual", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("setup-owner");
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
    hasMasterPassword: true,
    methods: { authenticator: true, duo: true },
  });
  // Only a setup session reads that.
  expect((await api.call(owner, "GET", "/api/keykeeper/two-step-setup")).status).toBe(404);

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
  expect((await api.call(owner, "GET", orgSetting(orgId))).body.required).toBe(true);

  // The other methods' setup endpoints take it too: Duo's, and the security
  // key's (which this test server, at an IP address, can't offer).
  const duo = await api.call(setup, "POST", "/api/two-factor/get-duo", { masterPasswordHash: owner.password });
  expect(duo.status, JSON.stringify(duo.body)).toBe(200);
  const webAuthn = await api.call(setup, "POST", "/api/two-factor/get-webauthn", {
    masterPasswordHash: owner.password,
  });
  expect(webAuthn.status, JSON.stringify(webAuthn.body)).toBe(400);
  expect(webAuthn.body.message).toMatch(/not compatible with Webauthn/);

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
  // The recovery code comes with it, since the session ends here.
  expect(on.body.keykeeperRecoveryCode).toMatch(/^[A-Z2-7]{32}$/);

  // Set up: the session is gone.
  expect((await api.call(setup, "GET", "/api/keykeeper/two-step-setup")).status).toBe(401);
  expect((await api.call(setup, "POST", "/api/two-factor/get-authenticator", { masterPasswordHash: owner.password })).status).toBe(401);

  // And the person signs in as usual, with their authenticator.
  const asked = await api.signIn(owner.email, owner.password);
  expect(asked.status).toBe(400);
  expect(asked.body.TwoFactorProviders).toEqual(["0"]);
  expectSignedIn(
    await api.signIn(owner.email, owner.password, {
      twoFactorProvider: "0",
      twoFactorToken: totp(key, Date.now() + 30_000),
    }),
  );
  // The recovery code the setup answer carried is the account's.
  const recover = await api.call(owner, "POST", "/api/two-factor/get-recover", { masterPasswordHash: owner.password });
  expect(recover.body.code).toBe(on.body.keykeeperRecoveryCode);
});

test("the two-step recovery code still works, and leads straight to setting up a new method", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("recovery-owner");
  const orgId = await api.organization(owner, `Recovery Co ${randomUUID().slice(0, 6)}`);
  await api.turnOnAuthenticator(owner, owner.password);
  await requireIt(api, owner, orgId, true);
  const code = (await api.call(owner, "POST", "/api/two-factor/get-recover", { masterPasswordHash: owner.password }))
    .body.code as string;

  // The code turns two-step login off, as upstream; the sign-in then needs a
  // method that counts, so it's a setup session.
  const token = expectSetup(
    await api.signIn(owner.email, owner.password, { twoFactorProvider: "8", twoFactorToken: code }),
  );
  const on = await api.turnOnAuthenticator({ token }, owner.password);
  expect(on).toMatch(/^[A-Z2-7]+$/);
});

test("single sign-on meets the rule for its own organization's admins, never for its owners or another organization", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const { owner, orgId, tenant, identifier } = await ssoOrg(api, "admin2fa");
  const xName = (await api.call(owner, "GET", `/api/organizations/${orgId}`)).body.name as string;
  await requireIt(api, owner, orgId, true);

  // An admin linked to the organization's single sign-on.
  const admin = await api.account("sso-admin");
  await api.addMember(owner, orgId, admin, "admin");
  const person = await tenant.person(admin.email, true, "SSO Admin");
  await tenant.next(person);
  const linked = await linkFromSession(request, origin, admin, identifier);
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);

  // Its single sign-on meets the rule for them; their password doesn't.
  await tenant.next(person);
  const viaSso = await ssoSignIn(request, origin, identifier);
  expectSignedIn(viaSso.token!);
  expectSetup(await api.signIn(admin.email, admin.password), [xName]);
  // Their single sign-on session refreshes while it's all they need.
  expect((await refresh(request, viaSso.token!.body.refresh_token)).status).toBe(200);

  // An admin of another organization that requires it, too: this
  // organization's single sign-on doesn't meet that one.
  const otherOwner = await api.account("other-owner");
  const yName = `Other Org ${randomUUID().slice(0, 6)}`;
  const otherId = await api.organization(otherOwner, yName);
  await requireIt(api, otherOwner, otherId, true);
  await api.addMember(otherOwner, otherId, admin, "admin");
  await tenant.next(person);
  const elsewhere = await ssoSignIn(request, origin, identifier);
  expectSetup(elsewhere.token!, [yName]);
  // And the session single sign-on started stops refreshing.
  expect((await refresh(request, viaSso.token!.body.refresh_token)).status).toBe(400);

  // Owners can always sign in with a password, so single sign-on doesn't
  // stand in for two-step login for them.
  const ownerPerson = await tenant.person(owner.email, true, "SSO Owner");
  await tenant.next(ownerPerson);
  const ownerLinked = await linkFromSession(request, origin, owner, identifier);
  expect(ownerLinked.status, JSON.stringify(ownerLinked.body)).toBe(200);
  await tenant.next(ownerPerson);
  const ownerSso = await ssoSignIn(request, origin, identifier);
  expectSetup(ownerSso.token!, [xName]);
});

test("a session ends at its next refresh once its person no longer meets the rule", async ({ request }) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("refresh-owner");
  const orgId = await api.organization(owner, `Refresh Co ${randomUUID().slice(0, 6)}`);
  await requireIt(api, owner, orgId, true);

  // An admin who turns two-step login off.
  const admin = await api.account("refresh-admin");
  await api.addMember(owner, orgId, admin, "admin");
  const key = await api.turnOnAuthenticator(admin, admin.password);
  const session = await api.signIn(admin.email, admin.password, {
    twoFactorProvider: "0",
    twoFactorToken: totp(key, Date.now() + 30_000),
  });
  expectSignedIn(session);
  expect((await refresh(request, session.body.refresh_token)).status).toBe(200);
  const off = await api.call({ token: session.body.access_token }, "PUT", "/api/two-factor/disable", {
    masterPasswordHash: admin.password,
    type: 0,
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  const ended = await refresh(request, session.body.refresh_token);
  expect(ended.status).toBe(400);
  expect(ended.body.error).toBe("invalid_grant");

  // A member who's made an admin.
  const member = await api.account("refresh-member");
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
  expect((await refresh(request, memberSession.body.refresh_token)).status).toBe(400);
  expectSetup(await api.signIn(member.email, member.password));

  // An admin whose organization turns it on.
  const later = await api.account("refresh-later");
  const otherOwner = await api.account("refresh-other-owner");
  const otherId = await api.organization(otherOwner, `Later Co ${randomUUID().slice(0, 6)}`);
  await api.addMember(otherOwner, otherId, later, "admin");
  const laterSession = await api.signIn(later.email, later.password);
  expectSignedIn(laterSession);
  await requireIt(api, otherOwner, otherId, true);
  expect((await refresh(request, laterSession.body.refresh_token)).status).toBe(400);
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

test("an API key doesn't sign in someone the rule covers until they set it up", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("key-owner");
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
  expect((await keyLogin()).status).toBe(200);
  await requireIt(api, owner, orgId, true);
  const refused = await keyLogin();
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(/requires two-step login for your role\. An API key can't sign in until you set it up/);
  expect(refused.body).not.toHaveProperty("access_token");
  await api.turnOnAuthenticator(admin, admin.password);
  expect((await keyLogin()).status).toBe(200);
});

test("a sign-in another device approved doesn't start setup: the person signs in with their master password", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("approved-owner");
  const orgId = await api.organization(owner, `Approved Co ${randomUUID().slice(0, 6)}`);
  const admin = await api.account("approved-admin");
  await api.addMember(owner, orgId, admin, "admin");
  // A device that's signed in approves, before the rule is on.
  const approver = await api.signIn(admin.email, admin.password);
  expectSignedIn(approver);
  const approverDevice = JSON.parse(
    Buffer.from(approver.body.access_token.split(".")[1], "base64url").toString("utf8"),
  ).device as string;
  // The device that asks has signed in to the account before, as upstream
  // requires of a device asking for approval.
  const deviceIdentifier = randomUUID();
  expectSignedIn(await api.signIn(admin.email, admin.password, { deviceIdentifier }));
  await requireIt(api, owner, orgId, true);

  const accessCode = randomUUID().replace(/-/g, "").slice(0, 25);
  const asked = await request.post("/api/auth-requests", {
    headers: { "Device-Type": "10" },
    data: { email: admin.email, publicKey: publicKey("new-device"), deviceIdentifier, accessCode, type: 0 },
  });
  expect(asked.status(), await asked.text()).toBe(200);
  const requestId = (await asked.json()).id as string;
  const approved = await api.call({ token: approver.body.access_token }, "PUT", `/api/auth-requests/${requestId}`, {
    deviceIdentifier: approverDevice,
    key: encString("user-key-for-new-device"),
    requestApproved: true,
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);

  const viaApproval = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: admin.email,
      password: accessCode,
      authRequest: requestId,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier,
      deviceName: "new-device",
    },
  });
  const body = await viaApproval.json();
  expect(viaApproval.status(), JSON.stringify(body)).toBe(400);
  expect(body).not.toHaveProperty("KeykeeperTwoStepSetup");
  expect(body).not.toHaveProperty("access_token");
  expect(body.message).toMatch(/Sign in with your master password in the web vault/);
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
      // Everyone here signed in before the rule applied to them; their
      // sessions are still good for these requests.
      const mspAdmin = await api.account("matrix-msp-admin");
      const mspId = await api.msp(mspAdmin, "Matrix MSP");
      const orgId = await api.client(mspAdmin, mspId, "Matrix Client");
      const technician = await api.account("matrix-technician");
      await api.addStaff(mspAdmin, mspId, technician, "technician");
      await api.confirmPending(mspAdmin, mspId);
      const owner = await api.account("matrix-owner");
      await api.addMember(mspAdmin, orgId, owner, "owner");
      const admin = await api.account("matrix-admin");
      await api.addMember(mspAdmin, orgId, admin, "admin");
      const manageUsers = await api.account("matrix-manage-users");
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

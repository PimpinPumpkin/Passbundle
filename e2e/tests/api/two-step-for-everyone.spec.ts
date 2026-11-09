// Two-step login for everyone (DESIGN.md, "Two-step login for everyone"): an
// organization can require two-step login for admins' rule of everyone in it,
// with the same counting (an authenticator app, a security key or passkey, or
// Duo with the server's own Duo account; not email codes) and the same
// machinery: a setup session at sign-in, sessions ending at once, roles not
// yet accepted, and the MSP's default policies. And for everyone no rule
// covers who has no two-step login at all, a nudge to set it up, which Not
// now hides for 90 days on every device.
import { randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { port } from "../../paths.mjs";
import { linkFromSession, settings, ssoOrg, ssoSignIn } from "../support/entra";

import { type Cert, httpsReceiver, throwawayCert, waitFor } from "./siem";
import { type Account, Api, type Result, encString, nextTotp, withMasterPassword } from "./support";

// The master password these changes need is checked the way a sign-in is
// (600,000 rounds of PBKDF2 on the server, slow in its debug build), so tests
// that make several get more time.
test.describe.configure({ timeout: 180_000 });

const origin = `https://127.0.0.1:${port}`;
const ADMIN_TWO_STEP = 1000;
const REVOKED = -1;
const CONFIRMED = 2;

const orgSetting = (orgId: string) => `/api/keykeeper/organizations/${orgId}/admin-two-step`;
const mspSetting = (mspId: string) => `/api/keykeeper/msp/${mspId}/two-step`;

/** Sets whom the organization requires it of: its admins, and everyone else too. */
async function requireOf(
  api: Api,
  as: { token: string; password?: string },
  orgId: string,
  level: "nobody" | "admins" | "everyone",
) {
  const data = { required: level !== "nobody", everyone: level === "everyone" };
  const saved = await api.call(as, "PUT", orgSetting(orgId), withMasterPassword(as, data));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect({ required: saved.body.required, everyone: saved.body.everyone }).toEqual(data);
  return saved.body;
}

/** A sign-in the rule held up: a setup session, and nothing that signs in. */
function expectSetup(result: Result, requiredBy?: string[]) {
  expect(result.status, JSON.stringify(result.body)).toBe(400);
  expect(result.body.KeykeeperTwoStepSetup, JSON.stringify(result.body)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.body.ErrorModel.Message).toContain("an authenticator app, a security key or passkey, or Duo");
  expect(result.body).not.toHaveProperty("access_token");
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

async function refresh(request: APIRequestContext, refreshToken: string) {
  const response = await request.post("/identity/connect/token", {
    form: { grant_type: "refresh_token", client_id: "web", refresh_token: refreshToken },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

/** A password sign-in with the next code from the account's authenticator (Api.giveAuthenticator). */
async function signInWithCode(api: Api, who: Account) {
  return api.signIn(who.email, who.password, { twoFactorProvider: "0", twoFactorToken: await nextTotp(who.email) });
}

/** Whether the vault page shows the nudge to set up two-step login, for this session. */
async function nudged(api: Api, as: { token: string }) {
  const answer = await api.call(as, "GET", "/api/keykeeper/two-step-nudge");
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.show as boolean;
}

const emails = (people: { email: string }[]) => people.map((p) => p.email).sort();

test("an organization that requires it of everyone covers every member who has joined, and going back to admins lets them sign in with a password again", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("all-owner");
  await api.giveAuthenticator(owner);
  const orgName = `All Dental ${randomUUID().slice(0, 6)}`;
  const orgId = await api.organization(owner, orgName);
  // A regular member, a manager, and a custom role that only reads the event
  // log: none of them is one the admin rule covers. And a member who has an
  // authenticator app.
  const member = await api.account("all-member");
  await api.addMember(owner, orgId, member, "user");
  const manager = await api.account("all-manager");
  await api.addMember(owner, orgId, manager, "manager");
  const reader = await api.account("all-reader");
  await api.addCustomMember(owner, orgId, reader, { accessEventLogs: true });
  const keeper = await api.account("all-keeper");
  await api.giveAuthenticator(keeper);
  await api.addMember(owner, orgId, keeper, "user");

  // Before it's on for everyone, the setting lists the members it would hold
  // up, apart from the admins, and nobody is held up yet.
  await requireOf(api, owner, orgId, "admins");
  const before = (await api.call(owner, "GET", orgSetting(orgId))).body;
  expect(before.everyone).toBe(false);
  expect(before.notSetUp).toEqual([]);
  expect(emails(before.membersNotSetUp)).toEqual(emails([member, manager, reader]));
  expect(new Set(before.membersNotSetUp.map((p: { role: string }) => p.role))).toEqual(new Set(["member"]));
  const sessions = await Promise.all([member, manager, reader].map((p) => api.signIn(p.email, p.password)));
  sessions.forEach(expectSignedIn);

  // Everyone needs the admins too.
  const alone = await api.call(owner, "PUT", orgSetting(orgId), withMasterPassword(owner, { required: false, everyone: true }));
  expect(alone.status).toBe(400);
  expect(alone.body.message).toMatch(/includes the admins/);

  // On for everyone: each member without a method that counts is signed out
  // at once, and sets one up at their next sign-in; the one with an
  // authenticator app goes on.
  const keeperSession = await signInWithCode(api, keeper);
  expectSignedIn(keeperSession);
  const on = await requireOf(api, owner, orgId, "everyone");
  expect(emails(on.membersNotSetUp)).toEqual(emails([member, manager, reader]));
  for (const session of sessions) {
    expect(await works(api, session.body.access_token)).toBe(false);
    expect((await refresh(request, session.body.refresh_token)).status).toBe(400);
  }
  for (const person of [member, manager, reader]) {
    expectSetup(await api.signIn(person.email, person.password), [orgName]);
  }
  expect(await works(api, keeperSession.body.access_token)).toBe(true);
  expect(await works(api, owner.token)).toBe(true);
  // Leaving the setting out of a save keeps it as it is.
  const kept = await api.call(owner, "PUT", orgSetting(orgId), withMasterPassword(owner, { required: true }));
  expect(kept.body.everyone, JSON.stringify(kept.body)).toBe(true);

  // A member sets up an authenticator app with the setup session, and signs
  // in with it; they're off the list.
  const setup = expectSetup(await api.signIn(member.email, member.password));
  await api.turnOnAuthenticator({ token: setup }, member.password);
  const listed = (await api.call(owner, "GET", orgSetting(orgId))).body.membersNotSetUp;
  expect(emails(listed)).toEqual(emails([manager, reader]));

  // Back to admins only, members sign in with a password again; off turns
  // both off.
  await requireOf(api, owner, orgId, "admins");
  expectSignedIn(await api.signIn(manager.email, manager.password));
  await requireOf(api, owner, orgId, "everyone");
  expectSetup(await api.signIn(manager.email, manager.password));
  const off = await api.call(owner, "PUT", orgSetting(orgId), withMasterPassword(owner, { required: false }));
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body).toMatchObject({ required: false, everyone: false });
  expectSignedIn(await api.signIn(manager.email, manager.password));
  expectSignedIn(await api.signIn(reader.email, reader.password));
});

test("requiring it of everyone is in the organization's event log, and high for its security tools", async ({
  request,
}) => {
  const api = new Api(request);
  const cert: Cert = throwawayCert();
  const receiver = await httpsReceiver(cert);
  try {
    const owner = await api.account("all-logged-owner");
    await api.giveAuthenticator(owner);
    const orgId = await api.organization(owner, `All Logged ${randomUUID().slice(0, 6)}`);
    const destination = await api.call(
      owner,
      "POST",
      `/api/keykeeper/organizations/${orgId}/event-streaming`,
      withMasterPassword(owner, {
        name: "SIEM",
        kind: "webhook",
        webhook: { url: receiver.url("/events"), caCertificate: cert.cert },
      }),
    );
    expect(destination.status, JSON.stringify(destination.body)).toBe(200);
    // Off to everyone: the admins, then everyone. Back to admins, then off.
    await requireOf(api, owner, orgId, "everyone");
    await requireOf(api, owner, orgId, "admins");
    await requireOf(api, owner, orgId, "nobody");

    const start = new Date(Date.now() - 3_600_000).toISOString();
    const end = new Date(Date.now() + 3_600_000).toISOString();
    const log = await api.call(owner, "GET", `/api/organizations/${orgId}/events?start=${start}&end=${end}`);
    const ours = (log.body.data as { type: number; actingUserId: string }[]).filter((e) =>
      [1695, 1696, 1697, 1698].includes(e.type),
    );
    expect(ours.map((e) => e.type).sort()).toEqual([1695, 1696, 1697, 1698]);
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
        const found = events.filter((e: { type: number }) => [1697, 1698].includes(e.type));
        return found.length >= 2 ? found : undefined;
      },
      "both changes, at the security tool",
    );
    expect(sent.find((e: { type: number }) => e.type === 1697)).toMatchObject({
      name: "Required two-step login of everyone",
      severity: "high",
      category: "organization",
      actor: { email: owner.email },
    });
    expect(sent.find((e: { type: number }) => e.type === 1698)).toMatchObject({ severity: "high" });
  } finally {
    await receiver.close();
  }
});

test("an MSP's default can require it of everyone in its clients: following, own settings, Use default, and required for every client", async ({
  request,
}) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const mspAdmin = await api.account("all-msp-admin");
  const mspId = await api.msp(mspAdmin, `All IT ${randomUUID().slice(0, 6)}`);
  const followerName = `All Follower ${randomUUID().slice(0, 6)}`;
  const followerId = await api.client(mspAdmin, mspId, followerName, "business");
  const ownName = `All Own ${randomUUID().slice(0, 6)}`;
  const ownId = await api.client(mspAdmin, mspId, ownName, "business");
  const followerMember = await api.account("all-follower-member");
  await api.addMember(mspAdmin, followerId, followerMember, "user");
  const ownMember = await api.account("all-own-member");
  await api.addMember(mspAdmin, ownId, ownMember, "user");
  // The second client's owner turns its setting off: its own setting.
  const ownOwner = await api.account("all-own-owner");
  await api.giveAuthenticator(ownOwner);
  await api.addMember(mspAdmin, ownId, ownOwner, "owner");
  await requireOf(api, ownOwner, ownId, "nobody");

  // The default is for admins, as always: no option, and its data stays null.
  const policiesPath = `/api/keykeeper/msp/${mspId}/policies`;
  expect((await api.call(mspAdmin, "GET", policiesPath)).body.defaults).toContainEqual(
    expect.objectContaining({ type: ADMIN_TWO_STEP, enabled: true, data: null }),
  );
  const memberSession = await api.signIn(followerMember.email, followerMember.password);
  expectSignedIn(memberSession);

  // Everyone else too: it reaches the client that follows, at once, and not
  // the one with its own setting.
  const changed = await api.call(mspAdmin, "PUT", `${policiesPath}/${ADMIN_TWO_STEP}`, {
    enabled: true,
    data: { everyone: true },
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body.changed.map((c: { id: string }) => c.id)).toEqual([followerId]);
  expect(changed.body.kept.map((c: { id: string }) => c.id)).toEqual([ownId]);
  expect(await works(api, memberSession.body.access_token)).toBe(false);
  expectSetup(await api.signIn(followerMember.email, followerMember.password), [followerName]);
  expectSignedIn(await api.signIn(ownMember.email, ownMember.password));
  const policies = (await api.call(mspAdmin, "GET", policiesPath)).body;
  expect(policies.defaults).toContainEqual(
    expect.objectContaining({ type: ADMIN_TWO_STEP, enabled: true, data: { everyone: true } }),
  );
  expect(policies.clients.find((c: { id: string }) => c.id === ownId).own).toContainEqual({
    type: ADMIN_TWO_STEP,
    enabled: false,
    data: null,
  });
  expect((await api.call(mspAdmin, "GET", orgSetting(followerId))).body).toMatchObject({
    required: true,
    everyone: true,
  });
  // The console's two-step section names who isn't set up in each client.
  const view = (await api.call(mspAdmin, "GET", mspSetting(mspId))).body;
  const follower = view.clients.find((c: { id: string }) => c.id === followerId);
  expect(follower).toMatchObject({ required: true, everyone: true });
  expect(emails(follower.membersNotSetUp)).toEqual([followerMember.email]);
  expect(view.clients.find((c: { id: string }) => c.id === ownId).membersNotSetUp).toEqual([]);
  // In the activity log, high: a security setting.
  const events = (await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/events`)).body.data as {
    event: string;
    detail: string | null;
  }[];
  expect(events.find((e) => e.event === "admin_two_step_default_set")?.detail).toMatch(
    /^Two-step login for admins to on for everyone: 1 client changed, 1 client kept its own setting/,
  );

  // Use default puts the other client on it too.
  const back = await api.call(mspAdmin, "POST", `${policiesPath}/${ADMIN_TWO_STEP}/apply`, { clients: [ownId] });
  expect(back.status, JSON.stringify(back.body)).toBe(200);
  expect(back.body.changed.map((c: { id: string }) => c.id)).toEqual([ownId]);
  expectSetup(await api.signIn(ownMember.email, ownMember.password), [ownName]);
  // A client the MSP adds now gets it too.
  const laterId = await api.client(mspAdmin, mspId, `All Later ${randomUUID().slice(0, 6)}`, "business");
  expect((await api.call(mspAdmin, "GET", orgSetting(laterId))).body).toMatchObject({ everyone: true });

  // Required for every client: nobody changes either part in a client.
  const required = await api.call(mspAdmin, "PUT", `${policiesPath}/${ADMIN_TWO_STEP}`, {
    enabled: true,
    data: { everyone: true },
    required: true,
  });
  expect(required.status, JSON.stringify(required.body)).toBe(200);
  const locked = await api.call(
    ownOwner,
    "PUT",
    orgSetting(ownId),
    withMasterPassword(ownOwner, { required: true, everyone: false }),
  );
  expect(locked.status, JSON.stringify(locked.body)).toBe(400);
  expect(locked.body.message).toMatch(/requires this policy for every client/);
  expect((await api.call(ownOwner, "GET", orgSetting(ownId))).body).toMatchObject({
    everyone: true,
    requiredByMsp: true,
  });

  // Back to admins only, as a default: it reaches every client that
  // follows, and members sign in with a password again.
  const lowered = await api.call(mspAdmin, "PUT", `${policiesPath}/${ADMIN_TWO_STEP}`, {
    enabled: true,
    data: null,
    required: false,
  });
  expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
  expect(lowered.body.changed.map((c: { id: string }) => c.id).sort()).toEqual([followerId, ownId, laterId].sort());
  expectSignedIn(await api.signIn(followerMember.email, followerMember.password));
  expect((await api.call(mspAdmin, "GET", orgSetting(followerId))).body).toMatchObject({
    required: true,
    everyone: false,
  });
});

test("upstream's Require two-step login and requiring it of everyone each do only what they say", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("both-owner");
  await api.giveAuthenticator(owner);
  const orgName = `Both Dental ${randomUUID().slice(0, 6)}`;
  const orgId = await api.organization(owner, orgName);
  const upstreamPolicy = (enabled: boolean) =>
    api.call(owner, "PUT", `/api/organizations/${orgId}/policies/0`, { policy: { enabled, data: null } });
  const upstreamOn = async () =>
    (await api.call(owner, "GET", `/api/organizations/${orgId}/policies/0`)).body?.enabled === true;
  expect((await upstreamPolicy(true)).status).toBe(200);
  await requireOf(api, owner, orgId, "everyone");

  // Both on: someone with an authenticator app meets both, and is let in.
  const keeper = await api.account("both-keeper");
  await api.addMember(owner, orgId, keeper, "user");
  expectSignedIn(await signInWithCode(api, keeper));

  // Someone without two-step login: accepting signs them out (ours), and
  // nobody can let them in until they have it (upstream's).
  const newcomer = await api.account("both-newcomer");
  const newcomerId = await api.addMember(owner, orgId, newcomer, "user", { authenticator: false, confirm: false });
  expect(await works(api, newcomer.token)).toBe(false);
  const confirm = (id: string, who: Account) =>
    api.call(owner, "POST", `/api/organizations/${orgId}/users/${id}/confirm`, {
      key: encString(`org-key-for-${who.email}`),
    });
  expect((await confirm(newcomerId, newcomer)).status).toBe(400);
  const setup = expectSetup(await api.signIn(newcomer.email, newcomer.password), [orgName]);
  await api.turnOnAuthenticator({ token: setup }, newcomer.password);
  expect((await confirm(newcomerId, newcomer)).status).toBe(200);

  // Ours off: upstream's is still on, and does what it did: someone without
  // two-step login signs in with a password, and can't be let in.
  await requireOf(api, owner, orgId, "nobody");
  expect(await upstreamOn()).toBe(true);
  const later = await api.account("both-later");
  const laterId = await api.addMember(owner, orgId, later, "user", { confirm: false });
  expect(await works(api, later.token)).toBe(true);
  expectSignedIn(await api.signIn(later.email, later.password));
  expect((await confirm(laterId, later)).status).toBe(400);

  // Upstream's off: ours, on again, is as it was, and upstream's stays off.
  await requireOf(api, owner, orgId, "everyone");
  expect((await upstreamPolicy(false)).status).toBe(200);
  expect((await api.call(owner, "GET", orgSetting(orgId))).body).toMatchObject({ required: true, everyone: true });
  expect(await upstreamOn()).toBe(false);
  expectSetup(await api.signIn(later.email, later.password), [orgName]);
  // Now nothing holds up letting them in: ours never does.
  expect((await confirm(laterId, later)).status).toBe(200);
});

test("on a server without email, requiring it of everyone counts a member's place once they accept it, and holds one confirmed before it until they do", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("all-unasked-owner");
  await api.giveAuthenticator(owner);
  const orgName = `All Unasked ${randomUUID().slice(0, 6)}`;
  const orgId = await api.organization(owner, orgName);
  // Confirmed while it wasn't required, in a place the server accepted for
  // them (this test server sends no email), and they never did.
  const held = await api.account("all-held-member");
  const heldId = await api.addMember(owner, orgId, held, "user", { accept: false });
  const statusOf = async (id: string) => (await api.members(owner, orgId)).find((m) => m.id === id)!.status;
  expect(await statusOf(heldId)).toBe(CONFIRMED);

  await requireOf(api, owner, orgId, "everyone");
  // Revoked until they accept it, without being signed out.
  expect(await statusOf(heldId)).toBe(REVOKED);
  expect(await works(api, held.token)).toBe(true);
  expect((await api.call(held, "GET", "/api/keykeeper/organizations/unaccepted")).body.data).toEqual([
    { organizationId: orgId, name: orgName, role: "member", revoked: true },
  ]);

  // An invitation now signs nobody out, and nobody lets them in until they
  // accept their place.
  const invited = await api.account("all-invited-member");
  const invitedId = await api.addMember(owner, orgId, invited, "user", {
    authenticator: false,
    accept: false,
    confirm: false,
  });
  expect(await works(api, invited.token)).toBe(true);
  expectSignedIn(await api.signIn(invited.email, invited.password));
  const early = await api.call(owner, "POST", `/api/organizations/${orgId}/users/${invitedId}/confirm`, {
    key: encString(`org-key-for-${invited.email}`),
  });
  expect(early.status).toBe(400);
  expect(early.body.message).toMatch(/hasn't accepted their role yet/);
  expect((await api.call(invited, "GET", "/api/keykeeper/organizations/unaccepted")).body.data).toEqual([
    { organizationId: orgId, name: orgName, role: "member", revoked: false },
  ]);

  // Accepting takes it on, and the rule with it: signed out, to set it up as
  // they sign in again. The one on hold comes back as they were.
  await api.acceptRole(invited, orgId);
  expect(await works(api, invited.token)).toBe(false);
  expectSetup(await api.signIn(invited.email, invited.password), [orgName]);
  await api.acceptRole(held, orgId);
  expect(await statusOf(heldId)).toBe(CONFIRMED);
  expect(await works(api, held.token)).toBe(false);
  expectSetup(await api.signIn(held.email, held.password), [orgName]);
});

test("single sign-on meets it for its own organization's members, and lowering it takes someone who meets it", async ({
  request,
}) => {
  const api = new Api(request);
  const { owner, orgId, tenant, identifier } = await ssoOrg(api, "all2fa");
  await api.giveAuthenticator(owner);
  const orgName = (await api.call(owner, "GET", `/api/organizations/${orgId}`)).body.name as string;
  // A member and an admin, linked to its single sign-on, without two-step login.
  const member = await api.account("all-sso-member");
  await api.addMember(owner, orgId, member, "user");
  const memberPerson = await tenant.person(member.email, true, "SSO Member");
  await tenant.next(memberPerson);
  expect((await linkFromSession(request, origin, member, identifier)).status).toBe(200);
  const admin = await api.account("all-sso-admin");
  await api.addMember(owner, orgId, admin, "admin", { authenticator: false });
  const adminPerson = await tenant.person(admin.email, true, "SSO Admin");
  await tenant.next(adminPerson);
  expect((await linkFromSession(request, origin, admin, identifier)).status).toBe(200);
  // Before the rule covers them, the vault nudges the member to set it up.
  expect(await nudged(api, member)).toBe(true);

  await requireOf(api, owner, orgId, "everyone");
  expect(await works(api, member.token)).toBe(false);
  // Its single sign-on meets it for the member; their password doesn't.
  await tenant.next(memberPerson);
  const viaSso = (await ssoSignIn(request, origin, identifier)).token!;
  expectSignedIn(viaSso);
  expectSetup(await api.signIn(member.email, member.password), [orgName]);
  // Covered now, so no nudge: the rule asks for it at a password sign-in.
  expect(await nudged(api, { token: viaSso.body.access_token })).toBe(false);

  // Once the organization's single sign-on is off, the admin's session it
  // started no longer meets the rule, and can't lower it.
  await tenant.next(adminPerson);
  const adminSso = (await ssoSignIn(request, origin, identifier)).token!;
  expectSignedIn(adminSso);
  const ssoPath = `/api/keykeeper/organizations/${orgId}/sso`;
  const ssoOff = await api.call(owner, "PUT", ssoPath, withMasterPassword(owner, settings(tenant, identifier, false, false)));
  expect(ssoOff.status, JSON.stringify(ssoOff.body)).toBe(200);
  const refused = await api.call({ token: adminSso.body.access_token }, "PUT", orgSetting(orgId), {
    required: true,
    everyone: false,
  });
  expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  expect(refused.body.message).toMatch(/Set up two-step login for your own account before you turn this off/);
  expect((await api.call(owner, "GET", orgSetting(orgId))).body.everyone).toBe(true);
});

test("the nudge is for someone with no two-step login whom no rule covers, and Not now hides it on every device", async ({
  request,
}) => {
  const api = new Api(request);
  // No two-step login, no organization: nudged.
  const solo = await api.account("nudge-solo");
  expect(await nudged(api, solo)).toBe(true);
  // Not now hides it, and the server keeps that for the account: a new
  // sign-in, as on another device, doesn't show it either.
  const dismissed = await api.call(solo, "POST", "/api/keykeeper/two-step-nudge/dismiss");
  expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
  expect(dismissed.body).toEqual({ show: false });
  expect(await nudged(api, solo)).toBe(false);
  expect(await nudged(api, { token: await api.logIn(solo.email, solo.password) })).toBe(false);

  // Someone with an authenticator app isn't nudged.
  const keeper = await api.account("nudge-keeper");
  expect(await nudged(api, keeper)).toBe(true);
  await api.giveAuthenticator(keeper);
  expect(await nudged(api, { token: await api.logIn(keeper.email, keeper.password) })).toBe(false);

  // A member of an organization that doesn't require it is nudged, an
  // organization's owner too. (Another account's Not now is its own.)
  const owner = await api.account("nudge-owner");
  const orgId = await api.organization(owner, `Nudge Co ${randomUUID().slice(0, 6)}`);
  expect(await nudged(api, owner)).toBe(true);
  const member = await api.account("nudge-member");
  await api.addMember(owner, orgId, member, "user");
  expect(await nudged(api, member)).toBe(true);

  // Someone an organization's upstream Require two-step login is waiting on
  // has that notice instead ("Joining").
  const strictOwner = await api.account("nudge-strict-owner");
  const strictId = await api.organization(strictOwner, `Nudge Strict ${randomUUID().slice(0, 6)}`);
  const policy = await api.call(strictOwner, "PUT", `/api/organizations/${strictId}/policies/0`, {
    policy: { enabled: true, data: null },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  const waiting = await api.account("nudge-waiting");
  await api.addMember(strictOwner, strictId, waiting, "user", { confirm: false });
  expect((await api.call(waiting, "GET", "/api/keykeeper/organizations/two-step-needed")).body.data).toHaveLength(1);
  expect(await nudged(api, waiting)).toBe(false);

  // Nobody else's session reads or changes it.
  expect((await api.call(null, "GET", "/api/keykeeper/two-step-nudge")).status).toBe(401);
  expect((await api.call(null, "POST", "/api/keykeeper/two-step-nudge/dismiss")).status).toBe(401);
});

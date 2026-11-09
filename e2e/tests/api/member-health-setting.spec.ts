// Members' own passwords is an organization's setting (DESIGN.md, "Members'
// own passwords"): on for a business and in every new MSP's default
// policies, off for an organization made the upstream way. Its owners and
// admins, and its MSP's admins, change it; nobody else sees it. While no
// organization a member has joined has it on, the server tells their apps
// so, ignores their reports, and keeps nothing; when the last one that does
// turns it off, or the member leaves it, is removed, or is revoked there,
// the numbers are deleted.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type Account, Api, encString, publicKey, serverDatabase } from "./support";

const MEMBER_HEALTH = 1002;

const setting = (orgId: string) => `/api/keykeeper/organizations/${orgId}/member-health-setting`;
const report = (api: Api, who: Account, numbers: unknown = { logins: 4, weak: 1, reused: 2 }) =>
  api.call(who, "PUT", "/api/keykeeper/own-health", numbers);
const view = (api: Api, who: Account, orgId: string) =>
  api.call(who, "GET", `/api/keykeeper/organizations/${orgId}/member-health`);
const seenBy = async (api: Api, who: Account) => {
  const seen = await api.call(who, "GET", "/api/keykeeper/own-health/seen-by");
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  return (seen.body.data as { id: string; name: string }[]).map((o) => o.name);
};

async function turn(api: Api, who: Account, orgId: string, enabled: boolean) {
  const saved = await api.call(who, "PUT", setting(orgId), { enabled });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.enabled).toBe(enabled);
  return saved.body;
}

/** A company's own organization with the Business preset; its owner gets an authenticator first. */
async function businessOrg(api: Api, owner: Account, name: string) {
  await api.giveAuthenticator(owner);
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

/** How many rows of numbers the server keeps for someone, where the test can read its database. */
async function keptRows(who: Account): Promise<number | null> {
  const db = await serverDatabase();
  return db ? db("SELECT COUNT(*) FROM keykeeper_member_health WHERE user_uuid = ?", who.userId) : null;
}

async function expectKept(who: Account, kept: boolean) {
  const rows = await keptRows(who);
  if (rows != null) {
    expect(rows, who.email).toBe(kept ? 1 : 0);
  }
}

test("a business has it on and a family or a group has it off; its owners and admins change it, and nobody else sees it", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const [owner, admin, member, poc, outsider, bizOwner] = await Promise.all([
    api.account("Owner"),
    api.account("Admin"),
    api.account("Member"),
    api.account("Poc"),
    api.account("Outsider"),
    api.account("BizOwner"),
  ]);

  const family = await api.organization(owner, "Family");
  expect((await api.call(owner, "GET", setting(family))).body).toEqual({
    enabled: false,
    msp: null,
    requiredByMsp: false,
  });
  const business = await businessOrg(api, bizOwner, `Harbor Dental ${randomUUID().slice(0, 6)}`);
  expect((await api.call(bizOwner, "GET", setting(business))).body.enabled).toBe(true);

  await api.addMember(owner, family, admin, "admin");
  await api.addMember(owner, family, member, "user");
  await api.addCustomMember(owner, family, poc, { manageUsers: true, managePolicies: true });

  // The owner turns it on, an admin off; saving what's there changes nothing.
  await turn(api, owner, family, true);
  await turn(api, admin, family, false);
  await turn(api, admin, family, false);
  await turn(api, owner, family, true);

  // A member, a custom role, and someone outside get "not found", never 403.
  for (const who of [member, poc, outsider, bizOwner]) {
    expect((await api.call(who, "GET", setting(family))).status, who.email).toBe(404);
    expect((await api.call(who, "PUT", setting(family), { enabled: false })).status, who.email).toBe(404);
  }
  expect((await api.call(owner, "GET", setting(family))).body.enabled).toBe(true);

  // Each change is in the organization's event log, by who made it.
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const end = new Date(Date.now() + 3_600_000).toISOString();
  const log = await api.call(owner, "GET", `/api/organizations/${family}/events?start=${start}&end=${end}`);
  const changes = (log.body.data as { type: number; actingUserId: string }[])
    .filter((e) => [1688, 1689].includes(e.type))
    .map((e) => `${e.type}:${e.actingUserId}`)
    .sort();
  expect(changes).toEqual(
    [`1688:${owner.userId}`, `1688:${owner.userId}`, `1689:${admin.userId}`].sort(),
  );
  // The Business preset's own is logged too, when the organization was made.
  const bizLog = await api.call(bizOwner, "GET", `/api/organizations/${business}/events?start=${start}&end=${end}`);
  expect((bizLog.body.data as { type: number }[]).filter((e) => e.type === 1688)).toHaveLength(1);
});

test("while no organization a member joined has it on, their apps are told so, a report is ignored, and the admin report lists nobody", async ({
  request,
}) => {
  const api = new Api(request);
  const [owner, ana] = await Promise.all([api.account("Owner"), api.account("Ana")]);
  const name = `Contoso ${randomUUID().slice(0, 6)}`;
  const orgId = await api.organization(owner, name);
  const anaId = await api.addMember(owner, orgId, ana, "user");

  expect(await seenBy(api, ana)).toEqual([]);
  const ignored = await report(api, ana);
  expect(ignored.status, JSON.stringify(ignored.body)).toBe(200);
  expect(ignored.body).toEqual({ object: "keykeeperOwnHealth", kept: false, seenBy: [] });
  await expectKept(ana, false);
  // Bad numbers are still refused, on or off.
  expect((await report(api, ana, { logins: 2, weak: 3, reused: 0 })).status).toBe(400);
  // The owner's report says it's off, and lists nobody.
  const off = await view(api, owner, orgId);
  expect(off.status).toBe(200);
  expect(off.body).toMatchObject({ on: false, data: [] });

  // On: Ana's apps are told who sees the numbers, by name, and her report is kept.
  await turn(api, owner, orgId, true);
  expect(await seenBy(api, ana)).toEqual([name]);
  const kept = await report(api, ana);
  expect(kept.body).toMatchObject({ kept: true, seenBy: [{ id: orgId, name }], logins: 4 });
  await expectKept(ana, true);
  const on = await view(api, owner, orgId);
  expect(on.body.on).toBe(true);
  expect(on.body.data.find((r: { memberId: string }) => r.memberId === anaId)).toMatchObject({
    logins: 4,
    weak: 1,
    reused: 2,
  });
});

test("the numbers are deleted when the last organization that sees them turns it off", async ({ request }) => {
  const api = new Api(request);
  const [contosoOwner, fabrikamOwner, ana] = await Promise.all([
    api.account("ContosoOwner"),
    api.account("FabrikamOwner"),
    api.account("Ana"),
  ]);
  const contoso = await api.organization(contosoOwner, "Contoso");
  const fabrikam = await api.organization(fabrikamOwner, "Fabrikam");
  const inContoso = await api.addMember(contosoOwner, contoso, ana, "user");
  const inFabrikam = await api.addMember(fabrikamOwner, fabrikam, ana, "user");
  await turn(api, contosoOwner, contoso, true);
  await turn(api, fabrikamOwner, fabrikam, true);
  expect(await seenBy(api, ana)).toEqual(["Contoso", "Fabrikam"]);
  expect((await report(api, ana)).body.kept).toBe(true);

  const anaIn = async (owner: Account, orgId: string, memberId: string) =>
    (await view(api, owner, orgId)).body.data.find((r: { memberId: string }) => r.memberId === memberId);

  // Contoso turns it off: Fabrikam still sees them, Contoso doesn't.
  await turn(api, contosoOwner, contoso, false);
  expect(await seenBy(api, ana)).toEqual(["Fabrikam"]);
  await expectKept(ana, true);
  expect(await anaIn(fabrikamOwner, fabrikam, inFabrikam)).toMatchObject({ logins: 4 });
  expect((await view(api, contosoOwner, contoso)).body).toMatchObject({ on: false, data: [] });

  // Fabrikam too: they're gone, and turning it on again shows nothing until her apps report.
  await turn(api, fabrikamOwner, fabrikam, false);
  expect(await seenBy(api, ana)).toEqual([]);
  await expectKept(ana, false);
  await turn(api, contosoOwner, contoso, true);
  expect(await anaIn(contosoOwner, contoso, inContoso)).toMatchObject({ logins: null, reportedAt: null });
});

test("the numbers are deleted when the member leaves, is removed, or is revoked from the last organization that sees them", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const owner = await api.account("Owner");
  const [leaver, removed, revoked] = await Promise.all([
    api.account("Leaver"),
    api.account("Removed"),
    api.account("Revoked"),
  ]);
  const contoso = await api.organization(owner, "Contoso");
  const fabrikam = await api.organization(owner, "Fabrikam");
  await turn(api, owner, contoso, true);
  await turn(api, owner, fabrikam, true);
  const ids = new Map<string, { contoso: string; fabrikam: string }>();
  for (const who of [leaver, removed, revoked]) {
    ids.set(who.email, {
      contoso: await api.addMember(owner, contoso, who, "user"),
      fabrikam: await api.addMember(owner, fabrikam, who, "user"),
    });
    expect((await report(api, who)).body.kept).toBe(true);
  }

  // Out of Contoso: Fabrikam still sees them.
  expect((await api.call(leaver, "POST", `/api/organizations/${contoso}/leave`)).status).toBe(200);
  expect(
    (await api.call(owner, "DELETE", `/api/organizations/${contoso}/users/${ids.get(removed.email)!.contoso}`))
      .status,
  ).toBe(200);
  expect(
    (await api.call(owner, "PUT", `/api/organizations/${contoso}/users/${ids.get(revoked.email)!.contoso}/revoke`))
      .status,
  ).toBe(200);
  for (const who of [leaver, removed, revoked]) {
    expect(await seenBy(api, who), who.email).toEqual(["Fabrikam"]);
    await expectKept(who, true);
  }

  // Out of Fabrikam, the last one: gone.
  expect((await api.call(leaver, "POST", `/api/organizations/${fabrikam}/leave`)).status).toBe(200);
  expect(
    (await api.call(owner, "DELETE", `/api/organizations/${fabrikam}/users/${ids.get(removed.email)!.fabrikam}`))
      .status,
  ).toBe(200);
  expect(
    (await api.call(owner, "PUT", `/api/organizations/${fabrikam}/users/${ids.get(revoked.email)!.fabrikam}/revoke`))
      .status,
  ).toBe(200);
  for (const who of [leaver, removed, revoked]) {
    expect(await seenBy(api, who), who.email).toEqual([]);
    await expectKept(who, false);
    expect((await report(api, who)).body.kept, who.email).toBe(false);
  }
});

test("an MSP's default reaches its clients, a client's own change is in the MSP's activity, and a required one can't be changed in the client", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const [mspAdmin, technician, clientOwner, member] = await Promise.all([
    api.account("MspAdmin"),
    api.account("Technician"),
    api.account("ClientOwner"),
    api.account("Member"),
  ]);
  const mspName = `Northwind IT ${randomUUID().slice(0, 6)}`;
  const mspId = await api.msp(mspAdmin, mspName);
  const defaults = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`);
  expect(defaults.body.types).toContain(MEMBER_HEALTH);
  expect(defaults.body.defaults).toContainEqual(
    expect.objectContaining({ type: MEMBER_HEALTH, enabled: true, data: null, required: false }),
  );

  // Add client with the defaults: on, following the MSP.
  const dental = await api.client(mspAdmin, mspId, "Acme Dental", "business");
  expect((await api.call(mspAdmin, "GET", setting(dental))).body).toEqual({
    enabled: true,
    msp: { id: mspId, name: mspName },
    requiredByMsp: false,
  });
  const clientOf = async (orgId: string) =>
    ((await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`)).body.clients as {
      id: string;
      own: { type: number; enabled: boolean }[];
    }[]).find((c) => c.id === orgId)!;
  expect((await clientOf(dental)).own.map((p) => p.type)).not.toContain(MEMBER_HEALTH);

  // A technician (an admin in the client) neither sees nor changes it.
  await api.addStaff(mspAdmin, mspId, technician, "technician");
  await api.confirmPending(mspAdmin, mspId);
  expect((await api.call(technician, "GET", setting(dental))).status).toBe(404);
  expect((await api.call(technician, "PUT", setting(dental), { enabled: false })).status).toBe(404);

  // The client's own owner turns it off: its own setting, in the MSP's activity.
  await api.giveAuthenticator(clientOwner);
  await api.addMember(mspAdmin, dental, clientOwner, "owner");
  await api.addMember(mspAdmin, dental, member, "user");
  expect((await report(api, member)).body.kept).toBe(true);
  await turn(api, clientOwner, dental, false);
  await expectKept(member, false);
  expect((await clientOf(dental)).own).toContainEqual({ type: MEMBER_HEALTH, enabled: false, data: null });
  const events = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  const recorded = (events.body.data as { event: string; detail: string | null; orgId?: string }[]).map(
    (e) => `${e.event}:${e.detail}`,
  );
  expect(recorded).toContain("client_member_health_set:off");

  // Use default puts it back on.
  const back = await api.call(mspAdmin, "POST", `/api/keykeeper/msp/${mspId}/policies/${MEMBER_HEALTH}/apply`, {
    clients: [dental],
  });
  expect(back.status, JSON.stringify(back.body)).toBe(200);
  expect(back.body.changed.map((c: { id: string }) => c.id)).toEqual([dental]);
  expect((await api.call(clientOwner, "GET", setting(dental))).body.enabled).toBe(true);

  // A default the MSP turns off reaches the clients that follow it; options are ignored.
  const off = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${MEMBER_HEALTH}`, {
    enabled: false,
    data: { anything: true },
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.changed.map((c: { id: string }) => c.id)).toEqual([dental]);
  expect((await api.call(clientOwner, "GET", setting(dental))).body.enabled).toBe(false);

  // Required for every client: on everywhere, and the client can't change it (400, never 403).
  const required = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${MEMBER_HEALTH}`, {
    enabled: true,
    data: null,
    required: true,
  });
  expect(required.status, JSON.stringify(required.body)).toBe(200);
  expect((await api.call(clientOwner, "GET", setting(dental))).body).toMatchObject({
    enabled: true,
    requiredByMsp: true,
  });
  const refused = await api.call(clientOwner, "PUT", setting(dental), { enabled: false });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain(`${mspName} requires this policy for every client`);
  // A client added later, without the defaults, still gets what's required.
  const bare = await api.client(mspAdmin, mspId, "Bare Co");
  expect((await api.call(mspAdmin, "GET", setting(bare))).body.enabled).toBe(true);
});

test("a new client added without the default policies has it off, and the install command's question says when it's on", async ({
  request,
}) => {
  const api = new Api(request);
  const mspAdmin = await api.account("MspAdmin");
  const person = await api.account("Person");
  const mspId = await api.msp(mspAdmin, "Prompt IT");
  const orgId = await api.client(mspAdmin, mspId, "Prompt Dental");
  expect((await api.call(mspAdmin, "GET", setting(orgId))).body.enabled).toBe(false);

  const enrollment = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`);
  expect(enrollment.status, JSON.stringify(enrollment.body)).toBe(200);
  const info = () =>
    api.call(person, "POST", "/api/keykeeper/enrollment/info", { token: enrollment.body.token });
  expect((await info()).body).toMatchObject({ organizationName: "Prompt Dental", memberHealth: false });
  await turn(api, mspAdmin, orgId, true);
  expect((await info()).body.memberHealth).toBe(true);
});

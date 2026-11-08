// Members' own passwords, in numbers (DESIGN.md, "Members' own passwords"): a
// member's apps report how many of their own logins there are and how many
// are weak, reused, and exposed; an organization's owners and admins see the
// numbers for each confirmed member, by membership id; nobody else sees
// anything, and a refusal is 404, never one that signs anyone out. Bad
// numbers get a plain 400.
import { expect, test } from "@playwright/test";

import { type Account, Api, serverDatabase } from "./support";

const report = (api: Api, who: Account | null, numbers: unknown) =>
  api.call(who, "PUT", "/api/keykeeper/own-health", numbers);
const view = (api: Api, who: Account | null, orgId: string) =>
  api.call(who, "GET", `/api/keykeeper/organizations/${orgId}/member-health`);

test("a member's numbers reach the organization's owners and admins, by membership, and nobody else", async ({
  request,
}) => {
  const api = new Api(request);
  const [owner, admin, ana, ben, poc, outsider, otherOwner] = await Promise.all([
    api.account("Owner"),
    api.account("Admin"),
    api.account("Ana"),
    api.account("Ben"),
    api.account("Poc"),
    api.account("Outsider"),
    api.account("OtherOwner"),
  ]);
  const orgId = await api.organization(owner, "Contoso");
  const adminId = await api.addMember(owner, orgId, admin, "admin");
  const anaId = await api.addMember(owner, orgId, ana, "user");
  await api.addMember(owner, orgId, ben, "user");
  await api.addCustomMember(owner, orgId, poc, { manageUsers: true });
  const otherOrg = await api.organization(otherOwner, "Fabrikam");

  const sent = await report(api, ana, { logins: 12, weak: 2, reused: 3, exposed: 1 });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body).toMatchObject({
    object: "keykeeperOwnHealth",
    logins: 12,
    weak: 2,
    reused: 3,
    exposed: 1,
  });
  expect(sent.body.reportedAt).toEqual(expect.any(String));
  expect(sent.body.exposedCheckedAt).toEqual(expect.any(String));
  // The apps don't check breaches: no exposed at all is a report too.
  expect((await report(api, admin, { logins: 3, weak: 0, reused: 0 })).status).toBe(200);

  for (const reader of [owner, admin]) {
    const seen = await view(api, reader, orgId);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    const byMember = new Map(seen.body.data.map((row: { memberId: string }) => [row.memberId, row]));
    // Every confirmed member, the owner, Ben, and the custom role among them.
    expect(byMember.size).toBe(5);
    expect(byMember.get(anaId)).toMatchObject({ logins: 12, weak: 2, reused: 3, exposed: 1 });
    expect(byMember.get(adminId)).toMatchObject({ logins: 3, weak: 0, reused: 0, exposed: null });
    const notYet = seen.body.data.filter((row: { reportedAt: string | null }) => row.reportedAt == null);
    expect(notYet).toHaveLength(3);
    // Numbers and ids: no names, emails, or anything about items.
    for (const row of seen.body.data) {
      expect(Object.keys(row).sort()).toEqual([
        "exposed",
        "exposedCheckedAt",
        "logins",
        "memberId",
        "reportedAt",
        "reused",
        "weak",
      ]);
    }
    expect(JSON.stringify(seen.body)).not.toContain(ana.email);
  }

  // A member, a custom role (one that manages members), someone outside,
  // another organization's owner: "not found", never 403.
  for (const reader of [ben, poc, outsider, otherOwner]) {
    expect((await view(api, reader, orgId)).status, reader.email).toBe(404);
  }
  expect((await view(api, owner, otherOrg)).status).toBe(404);
  expect((await view(api, owner, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  expect((await view(api, null, orgId)).status).toBe(401);
  expect((await report(api, null, { logins: 1, weak: 0, reused: 0 })).status).toBe(401);
});

test("people who aren't confirmed members, revoked members, and an MSP's people are left out", async ({
  request,
}) => {
  const api = new Api(request);
  const [owner, invited, revoked, tech, own] = await Promise.all([
    api.account("Owner"),
    api.account("Invited"),
    api.account("Revoked"),
    api.account("Tech"),
    api.account("Own"),
  ]);
  const orgId = await api.organization(owner, "Contoso");
  await api.addMember(owner, orgId, invited, "user", { confirm: false });
  const revokedId = await api.addMember(owner, orgId, revoked, "user");
  for (const who of [owner, invited, revoked]) {
    expect((await report(api, who, { logins: 5, weak: 1, reused: 0 })).status).toBe(200);
  }
  expect(
    (await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${revokedId}/revoke`)).status,
  ).toBe(200);

  const ids = async (who: Account, org: string) =>
    (await view(api, who, org)).body.data.map((row: { memberId: string }) => row.memberId);
  const members = await api.members(owner, orgId);
  const idOf = (email: string) => members.find((m) => m.email === email)!.id;
  expect(await ids(owner, orgId)).toEqual([idOf(owner.email)]);

  // An MSP's client: the MSP's own people there are the MSP's business, not
  // the client's; the client's own people are listed.
  const mspId = await api.msp(tech, "Northwind IT");
  const clientId = await api.client(tech, mspId, "Lakeside Clinic");
  await api.addMember(tech, clientId, own, "user");
  for (const who of [tech, own]) {
    expect((await report(api, who, { logins: 2, weak: 0, reused: 1 })).status).toBe(200);
  }
  const clientMembers = await api.members(tech, clientId);
  const listed = await ids(tech, clientId);
  expect(listed).toEqual([clientMembers.find((m) => m.email === own.email)!.id]);
});

test("numbers that aren't whole, or more than the logins, are refused in plain words", async ({
  request,
}) => {
  const api = new Api(request);
  const ana = await api.account("Ana");
  for (const bad of [
    {},
    { logins: 2, weak: 0 },
    { logins: "2", weak: 0, reused: 0 },
    { logins: 2.5, weak: 0, reused: 0 },
    { logins: -1, weak: 0, reused: 0 },
    { logins: 100_001, weak: 0, reused: 0 },
    { logins: 2, weak: 3, reused: 0 },
    { logins: 2, weak: 0, reused: 3 },
    { logins: 2, weak: 0, reused: 0, exposed: 3 },
    { logins: 2, weak: 0, reused: 0, exposed: "1" },
    [2, 0, 0],
  ]) {
    const refused = await report(api, ana, bad);
    expect(refused.status, JSON.stringify(bad)).toBe(400);
    expect(JSON.stringify(refused.body), JSON.stringify(bad)).toMatch(/whole numbers|number of logins/);
  }
});

test("a report without exposed keeps the last breach check, and deleting the account deletes the numbers", async ({
  request,
}) => {
  const api = new Api(request);
  const [owner, ana] = await Promise.all([api.account("Owner"), api.account("Ana")]);
  const orgId = await api.organization(owner, "Contoso");
  const anaId = await api.addMember(owner, orgId, ana, "user");
  const row = async () =>
    (await view(api, owner, orgId)).body.data.find((r: { memberId: string }) => r.memberId === anaId);

  expect((await report(api, ana, { logins: 10, weak: 1, reused: 2, exposed: 2 })).status).toBe(200);
  const checked = await row();
  expect((await report(api, ana, { logins: 11, weak: 0, reused: 2 })).status).toBe(200);
  const later = await row();
  expect(later).toMatchObject({ logins: 11, weak: 0, reused: 2, exposed: 2 });
  expect(later.exposedCheckedAt).toBe(checked.exposedCheckedAt);

  const db = await serverDatabase();
  const rows = () => db!("SELECT COUNT(*) FROM keykeeper_member_health WHERE user_uuid = ?", ana.userId);
  if (db) {
    expect(rows()).toBe(1);
  }
  const gone = await api.call(ana, "DELETE", "/api/accounts", { masterPasswordHash: ana.password });
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  if (db) {
    expect(rows()).toBe(0);
  }
});

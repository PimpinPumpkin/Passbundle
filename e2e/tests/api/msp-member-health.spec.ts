// Members' own passwords in the MSP console (DESIGN.md, "Members' own
// passwords"): the MSP's staff who manage a client (it's one they reach, and
// they're a confirmed owner or admin there) see its members' numbers as the
// client's own owners and admins do, by membership id, never which items and
// never the MSP's own people's numbers; a client with it off says so and
// lists nobody. Staff of another MSP, the client's own admin, someone signed
// out, and an MSP that doesn't exist get nothing from the MSP's route, and a
// technician sees only the clients assigned to them.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type Account, Api } from "./support";

type Row = {
  memberId: string;
  logins: number | null;
  weak: number | null;
  reused: number | null;
  exposed: number | null;
  exposedCheckedAt: string | null;
  reportedAt: string | null;
};
type Client = { organizationId: string; on: boolean; members: Row[] };

const route = (mspId: string) => `/api/keykeeper/msp/${mspId}/member-health`;
const setting = (orgId: string) => `/api/keykeeper/organizations/${orgId}/member-health-setting`;
const report = (api: Api, who: Account, numbers: Record<string, number>) =>
  api.call(who, "PUT", "/api/keykeeper/own-health", numbers);

async function inConsole(api: Api, who: Account, mspId: string): Promise<Client[]> {
  const seen = await api.call(who, "GET", route(mspId));
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  return seen.body.data;
}

const byMember = (rows: Row[]) => new Map(rows.map((r) => [r.memberId, r]));

test("an MSP's staff who manage a client see its own members' numbers, as its owners and admins do, and nobody else gets them", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const [mspAdmin, technician, clientAdmin, ana, ben, otherMspAdmin] = await Promise.all([
    api.account("MspAdmin"),
    api.account("Technician"),
    api.account("ClientAdmin"),
    api.account("Ana"),
    api.account("Ben"),
    api.account("OtherMspAdmin"),
  ]);

  // The technician's own numbers are kept for an organization of their own
  // that sees them: a client never sees them, nor counts them as its own.
  const home = await api.organization(technician, "Technician's own");
  expect((await api.call(technician, "PUT", setting(home), { enabled: true })).status).toBe(200);
  expect((await report(api, technician, { logins: 9, weak: 9, reused: 9, exposed: 9 })).body.kept).toBe(true);

  const mspId = await api.msp(mspAdmin, `Northwind IT ${randomUUID().slice(0, 6)}`);
  // With the default policies, Members' own passwords is on; without, off.
  const dental = await api.client(mspAdmin, mspId, "Acme Dental", "business");
  const law = await api.client(mspAdmin, mspId, "Acme Law");
  await api.addStaff(mspAdmin, mspId, technician, "technician");
  await api.confirmPending(mspAdmin, mspId);
  const adminId = await api.addMember(mspAdmin, dental, clientAdmin, "admin");
  const anaId = await api.addMember(mspAdmin, dental, ana, "user");
  const benId = await api.addMember(mspAdmin, dental, ben, "user");
  const kept = await report(api, ana, { logins: 4, weak: 1, reused: 2, exposed: 1 });
  expect(kept.body.kept, JSON.stringify(kept.body)).toBe(true);

  // The MSP admin sees both clients: Dental's own members, Law off.
  const seen = await inConsole(api, mspAdmin, mspId);
  expect(seen.map((c) => c.organizationId).sort()).toEqual([dental, law].sort());
  const dentalSeen = seen.find((c) => c.organizationId === dental)!;
  expect(dentalSeen.on).toBe(true);
  const rows = byMember(dentalSeen.members);
  expect([...rows.keys()].sort()).toEqual([adminId, anaId, benId].sort());
  expect(rows.get(anaId)).toMatchObject({ logins: 4, weak: 1, reused: 2, exposed: 1 });
  expect(rows.get(anaId)!.reportedAt).toEqual(expect.any(String));
  expect(rows.get(benId)).toMatchObject({ logins: null, weak: null, reused: null, exposed: null, reportedAt: null });
  // Numbers by membership id: nothing that names a person or an item, and
  // never the MSP's own people's numbers.
  for (const row of dentalSeen.members) {
    expect(Object.keys(row).sort()).toEqual(
      ["exposed", "exposedCheckedAt", "logins", "memberId", "reportedAt", "reused", "weak"],
    );
    expect(row.logins).not.toBe(9);
  }
  const text = JSON.stringify(seen);
  for (const who of [mspAdmin, technician, clientAdmin, ana, ben]) {
    expect(text).not.toContain(who.email);
  }
  expect(seen.find((c) => c.organizationId === law)).toEqual({ organizationId: law, on: false, members: [] });

  // The same rows the client's own admin sees in its Reports.
  const own = await api.call(clientAdmin, "GET", `/api/keykeeper/organizations/${dental}/member-health`);
  expect(own.status).toBe(200);
  expect(byMember(own.body.data)).toEqual(rows);

  // A technician who reaches every client, as an admin, sees both.
  expect((await inConsole(api, technician, mspId)).map((c) => c.organizationId).sort()).toEqual(
    [dental, law].sort(),
  );
  // Assigned to Law only: Dental isn't theirs any more.
  const access = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/staff/${technician.userId}/access`, {
    allClients: false,
    clients: [law],
    custom: null,
    installCommands: true,
  });
  expect(access.status, JSON.stringify(access.body)).toBe(200);
  expect((await inConsole(api, technician, mspId)).map((c) => c.organizationId)).toEqual([law]);

  // Staff of another MSP, the client's own admin, a member, someone signed
  // out, and an MSP that doesn't exist: "not found", or signed out.
  const otherMsp = await api.msp(otherMspAdmin, `Litware IT ${randomUUID().slice(0, 6)}`);
  expect(await inConsole(api, otherMspAdmin, otherMsp)).toEqual([]);
  for (const who of [otherMspAdmin, clientAdmin, ana]) {
    const refused = await api.call(who, "GET", route(mspId));
    expect(refused.status, who.email).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain(anaId);
  }
  expect((await api.call(null, "GET", route(mspId))).status).toBe(401);
  expect((await api.call(mspAdmin, "GET", route(randomUUID()))).status).toBe(404);

  // Turned off for Dental: it says so, and lists nobody.
  expect((await api.call(mspAdmin, "PUT", setting(dental), { enabled: false })).status).toBe(200);
  expect((await inConsole(api, mspAdmin, mspId)).find((c) => c.organizationId === dental)).toEqual({
    organizationId: dental,
    on: false,
    members: [],
  });
});

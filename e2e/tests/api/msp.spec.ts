// MSPs: staff become members of every client, waiting for the org key until
// the console confirms them; roles and removals apply to every client at once;
// clients stay in control; and upstream deletes are never blocked by MSP data.
import { expect, test } from "@playwright/test";

import { Api } from "./support";

const OWNER = 0;
const ADMIN = 1;
const USER = 2;
const ACCEPTED = 1;
const CONFIRMED = 2;

test("staff join every client, existing and new, and the console confirms them", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental");

  await api.addStaff(admin, mspId, tech, "technician");
  const techIn = async (orgId: string) =>
    (await api.members(admin, orgId)).find((m) => m.email === tech.email);
  expect(await techIn(dental)).toMatchObject({ status: ACCEPTED, type: ADMIN });
  // Waiting for the org key, so the technician can't see the client yet.
  expect(await api.orgsOf(tech)).toEqual([]);

  // A new client includes every staff member from the start.
  const law = await api.client(admin, mspId, "Baker Law");
  expect(await techIn(law)).toMatchObject({ status: ACCEPTED, type: ADMIN });

  // The technician can't give out keys they don't have; the admin's console can.
  expect(await api.confirmPending(tech, mspId)).toEqual([]);
  expect((await api.confirmPending(admin, mspId)).sort()).toEqual([
    tech.email,
    tech.email,
  ]);
  expect(await techIn(dental)).toMatchObject({ status: CONFIRMED });
  expect(await api.orgsOf(tech)).toEqual([dental, law].sort());

  // The overview counts each client's own people, not the MSP's staff.
  const client = await api.account("client-user");
  await api.addMember(admin, dental, client, "user");
  const overview = await api.call(tech, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(overview.body.role).toBe("technician");
  expect(
    overview.body.staff.map((s: { email: string; role: string }) => [
      s.email,
      s.role,
    ]),
  ).toEqual([
    [admin.email, "admin"],
    [tech.email, "technician"],
  ]);
  expect(
    overview.body.clients.map((c: { name: string; members: unknown }) => [
      c.name,
      c.members,
    ]),
  ).toEqual([
    ["Acme Dental", { confirmed: 1, accepted: 0, invited: 0, revoked: 0 }],
    ["Baker Law", { confirmed: 0, accepted: 0, invited: 0, revoked: 0 }],
  ]);
});

test("a role change and a removal apply to every client at once", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const mspId = await api.msp(admin, "Contoso Managed");
  const one = await api.client(admin, mspId, "Client One");
  const two = await api.client(admin, mspId, "Client Two");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);
  const types = async () =>
    Promise.all(
      [one, two].map(
        async (o) =>
          (await api.members(admin, o)).find((m) => m.email === tech.email)
            ?.type,
      ),
    );

  const promoted = await api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/staff/${tech.userId}`,
    { role: "admin" },
  );
  expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
  expect(await types()).toEqual([OWNER, OWNER]);
  await api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/staff/${tech.userId}`,
    { role: "technician" },
  );
  expect(await types()).toEqual([ADMIN, ADMIN]);

  // The last admin can't step down or be removed.
  const demoteLast = await api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/staff/${admin.userId}`,
    {
      role: "technician",
    },
  );
  expect(demoteLast.status).toBe(400);
  expect(demoteLast.body.message).toContain("at least one admin");

  const removed = await api.call(
    admin,
    "DELETE",
    `/api/keykeeper/msp/${mspId}/staff/${tech.userId}`,
  );
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect(await types()).toEqual([undefined, undefined]);
  expect(await api.orgsOf(tech)).toEqual([]);
  expect(
    (await api.call(tech, "GET", `/api/keykeeper/msp/${mspId}`)).status,
  ).toBe(404);
});

test("staff can't be removed in a way that leaves a client without a confirmed owner", async ({
  request,
}) => {
  const api = new Api(request);
  const first = await api.account("first-admin");
  const second = await api.account("second-admin");
  const mspId = await api.msp(first, "Fabrikam Support");
  const orgId = await api.client(first, mspId, "Only Client");
  await api.addStaff(first, mspId, second, "admin");

  // The second admin is an owner there, but not confirmed yet.
  const blocked = await api.call(
    second,
    "DELETE",
    `/api/keykeeper/msp/${mspId}/staff/${first.userId}`,
  );
  expect(blocked.status).toBe(400);
  expect(blocked.body.message).toContain("Only Client would have no owner");

  await api.confirmPending(first, mspId);
  const allowed = await api.call(
    second,
    "DELETE",
    `/api/keykeeper/msp/${mspId}/staff/${first.userId}`,
  );
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  expect((await api.members(second, orgId)).map((m) => m.email)).toEqual([
    second.email,
  ]);
});

test("a client's own owner sees the MSP and can remove it in one step; the MSP can't", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const owner = await api.account("client-owner");
  const staffer = await api.account("client-admin");
  const mspId = await api.msp(admin, "Litware MSP");
  const orgId = await api.client(admin, mspId, "Client Co");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);
  await api.addMember(admin, orgId, owner, "owner");
  await api.addMember(admin, orgId, staffer, "admin");

  const seen = await api.call(
    owner,
    "GET",
    `/api/keykeeper/organizations/${orgId}/msp`,
  );
  expect(seen.body.msp.name).toBe("Litware MSP");
  expect(seen.body.staff.map((s: { email: string }) => s.email).sort()).toEqual(
    [admin.email, tech.email].sort(),
  );

  // Not the MSP's own owner, and not the client's admins: only the client's owners.
  expect(
    (
      await api.call(
        admin,
        "DELETE",
        `/api/keykeeper/organizations/${orgId}/msp`,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await api.call(
        staffer,
        "DELETE",
        `/api/keykeeper/organizations/${orgId}/msp`,
      )
    ).status,
  ).toBe(403);

  const removed = await api.call(
    owner,
    "DELETE",
    `/api/keykeeper/organizations/${orgId}/msp`,
  );
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect((await api.members(owner, orgId)).map((m) => m.email).sort()).toEqual(
    [owner.email, staffer.email].sort(),
  );
  expect(await api.orgsOf(tech)).toEqual([]);
  expect(
    (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`)).body.clients,
  ).toEqual([]);
  expect(
    (await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/msp`))
      .body.msp,
  ).toBeNull();
});

test("upstream deletes of members, organizations, and accounts work with MSP data in place", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const leaver = await api.account("leaver");
  const mspId = await api.msp(admin, "Tailspin IT");
  const keep = await api.client(admin, mspId, "Keep Co");
  const gone = await api.client(admin, mspId, "Gone Co");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.addStaff(admin, mspId, leaver, "technician");
  await api.confirmPending(admin, mspId);

  // A client admin removes one technician with the ordinary endpoint.
  const techMember = (await api.members(admin, keep)).find(
    (m) => m.email === tech.email,
  )!;
  const removed = await api.call(
    admin,
    "DELETE",
    `/api/organizations/${keep}/users/${techMember.id}`,
  );
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);

  // An organization is deleted with the ordinary endpoint.
  const deleted = await api.call(
    admin,
    "DELETE",
    `/api/organizations/${gone}`,
    {
      masterPasswordHash: admin.password,
    },
  );
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);

  // A staff member deletes their own account.
  const closed = await api.call(leaver, "DELETE", "/api/accounts", {
    masterPasswordHash: leaver.password,
  });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);

  const overview = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(overview.body.clients.map((c: { name: string }) => c.name)).toEqual([
    "Keep Co",
  ]);
  expect(overview.body.staff.map((s: { email: string }) => s.email)).toEqual([
    admin.email,
    tech.email,
  ]);
  // Removing the technician from the MSP still works after the client removed them.
  expect(
    (
      await api.call(
        admin,
        "DELETE",
        `/api/keykeeper/msp/${mspId}/staff/${tech.userId}`,
      )
    ).status,
  ).toBe(200);
});

test("MSP names are checked", async ({ request }) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  for (const name of ["", "   ", "x".repeat(101)]) {
    const result = await api.call(admin, "POST", "/api/keykeeper/msp", {
      name,
    });
    expect(result.status, name).toBe(400);
  }
  expect(
    (await api.call(admin, "GET", "/api/keykeeper/msp")).body.data,
  ).toEqual([]);
});

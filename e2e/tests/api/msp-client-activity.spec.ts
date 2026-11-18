// A client's own view of what its MSP did there (DESIGN.md, "The client sees
// its MSP's actions"): GET /api/keykeeper/organizations/<id>/msp/activity.
// Only the client's own confirmed owners and admins read it, never the MSP's
// people there, and it holds only entries about that organization: never
// another client's, never an MSP-wide entry, never the MSP's list of clients,
// and never where an action came from.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api, encString } from "./support";

const DISABLE_SEND = 6;

type Entry = {
  id: string;
  date: string;
  event: string;
  actorEmail: string | null;
  targetEmail: string | null;
  detail: string | null;
};

const ACTORS = [
  "clientOwner",
  "clientAdmin",
  "clientContact",
  "clientUser",
  "mspAdmin",
  "technician",
  "otherMspAdmin",
  "otherClientOwner",
  "stranger",
  "anonymous",
] as const;
type Actor = (typeof ACTORS)[number];
type Context = { api: Api; orgId: string; ownOrgId: string };
type Row = MatrixRow<Actor, Context>;

const activity = (orgId: string, query = "") =>
  `/api/keykeeper/organizations/${orgId}/msp/activity${query}`;

const rows: Row[] = [
  {
    name: "read what the MSP did in the client",
    allowed: ["clientOwner", "clientAdmin"],
    request: async ({ orgId }) => ({ method: "GET", path: activity(orgId) }),
  },
  {
    // An organization no MSP manages: its owner gets an empty list, not an
    // error; everyone else, as before, nothing.
    name: "read it in an organization with no MSP",
    allowed: ["clientOwner"],
    request: async ({ ownOrgId }) => ({ method: "GET", path: activity(ownOrgId) }),
  },
];

test.describe("Who reads a client's view of its MSP's actions", () => {
  permissionMatrix(
    ACTORS,
    async (api) => {
      const admin = await api.account("activity-msp-admin");
      const tech = await api.account("activity-tech");
      const other = await api.account("activity-other-msp");
      const owner = await api.account("activity-owner");
      const clientAdmin = await api.account("activity-client-admin");
      const contact = await api.account("activity-contact");
      const user = await api.account("activity-user");
      const otherOwner = await api.account("activity-other-owner");
      const mspId = await api.msp(admin, "Matrix IT");
      const otherMsp = await api.msp(other, "Other IT");
      await api.client(other, otherMsp, "Other MSP's Client");
      const orgId = await api.client(admin, mspId, "Matrix Dental");
      const otherClient = await api.client(admin, mspId, "Matrix Law");
      await api.addStaff(admin, mspId, tech, "technician");
      await api.confirmPending(admin, mspId);
      // The client's own people: an owner the MSP adds, and the rest that
      // owner adds (only a client's own owners add owners once it has one).
      await api.addMember(admin, orgId, owner, "owner");
      await api.addMember(owner, orgId, clientAdmin, "admin");
      await api.addMember(owner, orgId, user, "user");
      await api.addCustomMember(owner, orgId, contact, { manageUsers: true, accessEventLogs: true });
      // An owner of another of the same MSP's clients.
      await api.addMember(admin, otherClient, otherOwner, "owner");
      // The client's owner also owns an organization of their own, no MSP's.
      const ownOrgId = await api.organization(owner, "Owner's Own Company");
      const callers: Record<Actor, Account | null> = {
        clientOwner: owner,
        clientAdmin,
        clientContact: contact,
        clientUser: user,
        mspAdmin: admin,
        technician: tech,
        otherMspAdmin: other,
        otherClientOwner: otherOwner,
        stranger: await api.account("activity-stranger"),
        anonymous: null,
      };
      return { ctx: { api, orgId, ownOrgId }, callers };
    },
    rows,
  );
});

test("an organization no MSP manages has nothing to show its owner, and its members still get nothing", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("own-owner");
  const user = await api.account("own-user");
  const orgId = await api.organization(owner, "Contoso Own");
  await api.addMember(owner, orgId, user, "user");
  const seen = await api.call(owner, "GET", activity(orgId));
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  expect(seen.body).toEqual({ msp: null, data: [] });
  expect((await api.call(user, "GET", activity(orgId))).status).toBe(404);
});

test("a client's own owner sees what the MSP did in their organization, newest first, and nothing about any other client", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("seen-msp-admin");
  const tech = await api.account("seen-tech");
  const dentalOwner = await api.account("seen-dental-owner");
  const lawOwner = await api.account("seen-law-owner");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental");
  const law = await api.client(admin, mspId, "Baker Law");
  await api.addMember(admin, dental, dentalOwner, "owner");
  await api.addMember(admin, law, lawOwner, "owner");

  // The MSP adds a technician, who joins both clients. The console confirms
  // them in Acme Dental on its own (it says so); an admin confirms them in
  // Baker Law by hand.
  await api.addStaff(admin, mspId, tech, "technician");
  const pending = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  for (const p of pending.body.data) {
    const confirmed = await api.call(
      admin,
      "POST",
      `/api/organizations/${p.organizationId}/users/${p.memberId}/confirm`,
      {
        key: encString(`org-key-for-${p.email}`),
        ...(p.organizationId === dental ? { keykeeperAutomatic: true } : {}),
      },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  }

  // Acme Dental's install command is replaced, and the MSP's default Remove
  // Send reaches it (Baker Law keeps what it has this time).
  const replaced = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/clients/${dental}/enrollment`,
  );
  expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
  const pushed = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${DISABLE_SEND}`, {
    enabled: true,
    data: null,
    keep: [law],
  });
  expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
  expect(pushed.body.changed.map((c: { id: string }) => c.id)).toEqual([dental]);

  // The technician is limited to Baker Law, with a custom role there: Acme
  // Dental loses them, and Baker Law's role for them changes.
  const limited = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/staff/${tech.userId}/access`, {
    allClients: false,
    clients: [law],
    custom: { permissions: { manageUsers: true }, vaultItems: false },
    installCommands: false,
    clientRoles: [],
  });
  expect(limited.status, JSON.stringify(limited.body)).toBe(200);

  const read = async (who: Account, orgId: string, query = "") => {
    const result = await api.call(who, "GET", activity(orgId, query));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body as { msp: { id: string; name: string }; data: Entry[] };
  };
  const summary = (entries: Entry[]) =>
    entries.map((e) => [e.event, e.actorEmail, e.targetEmail, e.detail]);

  const dentalView = await read(dentalOwner, dental);
  expect(dentalView.msp).toEqual({ id: mspId, name: "Northwind IT" });
  expect(summary(dentalView.data)).toEqual(
    [
      ["client_created", admin.email, null, "No defaults"],
      // addMember confirms the client's owner with upstream's confirm.
      ["member_confirmed", admin.email, dentalOwner.email, null],
      ["client_staff_added", admin.email, tech.email, "admin"],
      ["member_confirmed", admin.email, tech.email, "automatic"],
      ["install_token_replaced", admin.email, null, null],
      ["client_policy_pushed", admin.email, null, "Remove Send to on"],
      ["client_staff_removed", admin.email, tech.email, null],
    ].reverse(),
  );
  // Only what, when, by whom, and to whom: never where it came from, nor
  // which organization (it's theirs).
  for (const entry of dentalView.data) {
    expect(Object.keys(entry).sort()).toEqual(
      ["actorEmail", "date", "detail", "event", "id", "targetEmail"],
    );
  }
  const text = JSON.stringify(dentalView);
  expect(text).not.toContain(law);
  expect(text).not.toContain("Baker Law");
  expect(text).not.toContain(lawOwner.email);

  const lawView = await read(lawOwner, law);
  expect(summary(lawView.data)).toEqual(
    [
      ["client_created", admin.email, null, "No defaults"],
      ["member_confirmed", admin.email, lawOwner.email, null],
      ["client_staff_added", admin.email, tech.email, "admin"],
      ["member_confirmed", admin.email, tech.email, null],
      ["client_staff_role_changed", admin.email, tech.email, "custom"],
    ].reverse(),
  );
  expect(JSON.stringify(lawView)).not.toContain("Acme Dental");

  // Pages, newest first, by the date of the oldest entry already shown.
  const first = await read(dentalOwner, dental, "?limit=3");
  expect(first.data.map((e) => e.id)).toEqual(dentalView.data.slice(0, 3).map((e) => e.id));
  const older = await read(dentalOwner, dental, `?limit=3&before=${encodeURIComponent(first.data[2].date)}`);
  expect(older.data.map((e) => e.id)).toEqual(dentalView.data.slice(3, 6).map((e) => e.id));
  expect((await api.call(dentalOwner, "GET", activity(dental, "?before=yesterday"))).status).toBe(400);

  // The MSP's own Activity keeps its one entry per change: none of each
  // client's shares, and the automatic confirm says so there too.
  const msp = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  const mspEvents: (Entry & { organizationName: string | null })[] = msp.body.data;
  expect(mspEvents.some((e) => e.event.startsWith("client_staff_") || e.event.startsWith("client_policy_pushed"))).toBe(
    false,
  );
  expect(
    mspEvents
      .filter((e) => e.event === "member_confirmed" && e.targetEmail === tech.email)
      .map((e) => [e.organizationName, e.detail])
      .sort(),
  ).toEqual([
    ["Acme Dental", "automatic"],
    ["Baker Law", null],
  ]);

  // Once Acme Dental removes its MSP, it has none: nothing to show.
  const removed = await api.call(dentalOwner, "DELETE", `/api/keykeeper/organizations/${dental}/msp`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect(await read(dentalOwner, dental)).toEqual({ msp: null, data: [] });
});

test("templates the MSP sends and its Templates folder show in each client they reach", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("tpl-msp-admin");
  const owner = await api.account("tpl-owner");
  const otherOwner = await api.account("tpl-other-owner");
  const mspId = await api.msp(admin, "Template IT");
  const dental = await api.client(admin, mspId, "Template Dental");
  const law = await api.client(admin, mspId, "Template Law");
  await api.addMember(admin, dental, owner, "owner");
  await api.addMember(admin, law, otherOwner, "owner");
  const templateId = randomUUID();
  const source = await api.personalItem(admin);
  const added = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/templates/${templateId}`, {
    sourceCipherId: source,
    allClients: true,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  // The console writes a copy into each client's Templates folder and records them at once.
  const copies = [];
  for (const orgId of [dental, law]) {
    const collection = await api.templatesCollection(admin, mspId, orgId);
    copies.push({
      organizationId: orgId,
      cipherId: await api.orgItem(admin, orgId, collection),
      sourceRevision: "2026-11-17T09:30:00.000000Z",
    });
  }
  const recorded = await api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/templates/${templateId}/copies`, {
    copies,
  });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);

  for (const [who, orgId] of [
    [owner, dental],
    [otherOwner, law],
  ] as const) {
    const seen = await api.call(who, "GET", activity(orgId));
    const kinds = (seen.body.data as Entry[]).map((e) => [e.event, e.detail]);
    expect(kinds).toContainEqual(["client_template_sent", templateId]);
    expect(kinds.map(([event]) => event)).toContain("templates_collection_set");
    expect(kinds.filter(([event]) => event === "client_template_sent")).toHaveLength(1);
  }
});

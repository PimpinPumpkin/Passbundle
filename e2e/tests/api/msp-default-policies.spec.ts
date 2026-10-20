// An MSP's default policies: every client follows them, a client whose policy
// differs has its own setting, and changing a default changes only the
// clients that follow it. Defaults reach clients through upstream's own policy
// code, side effects included. See DESIGN.md, "Default policies".
import { expect, test } from "@playwright/test";

import { type Account, Api } from "./support";

const TWO_STEP = 0;
const MASTER_PASSWORD = 1;
const SINGLE_ORG = 3;
const REQUIRE_SSO = 4;
const DISABLE_SEND = 6;
const RESET_PASSWORD = 8;
const CONFIRMED = 2;
const REVOKED = -1;

const STRONG = {
  minComplexity: 3,
  minLength: 12,
  requireUpper: false,
  requireLower: false,
  requireNumbers: false,
  requireSpecial: false,
  enforceOnLogin: false,
};

type Policy = { type: number; enabled: boolean; data: any };
type Overview = {
  types: number[];
  defaults: Policy[];
  clients: { id: string; name: string; own: Policy[] }[];
};
type Named = { id: string; name: string };

async function overview(api: Api, who: Account, mspId: string) {
  const result = await api.call(
    who,
    "GET",
    `/api/keykeeper/msp/${mspId}/policies`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as Overview;
}

/** The policy types where a client has its own setting. */
async function ownSettings(
  api: Api,
  who: Account,
  mspId: string,
  orgId: string,
) {
  const client = (await overview(api, who, mspId)).clients.find(
    (c) => c.id === orgId,
  );
  expect(client, `client ${orgId}`).toBeTruthy();
  return client!.own.map((p) => p.type).sort();
}

/** A client's policy, as its admin console reads it. */
async function clientPolicy(
  api: Api,
  admin: Account,
  orgId: string,
  type: number,
) {
  const result = await api.call(
    admin,
    "GET",
    `/api/organizations/${orgId}/policies/${type}`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as { enabled: boolean; data: any };
}

/** Saves a client's policy in its admin console. */
async function setClientPolicy(
  api: Api,
  who: Account,
  orgId: string,
  type: number,
  enabled: boolean,
  data: unknown,
) {
  const result = await api.call(
    who,
    "PUT",
    `/api/organizations/${orgId}/policies/${type}`,
    { policy: { enabled, data } },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

async function setDefault(
  api: Api,
  admin: Account,
  mspId: string,
  type: number,
  enabled: boolean,
  data: unknown,
) {
  const result = await api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/policies/${type}`,
    { enabled, data },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as { changed: Named[]; kept: Named[]; refused: Named[] };
}

const names = (clients: Named[]) => clients.map((c) => c.name).sort();

test("a new MSP's defaults are the Business policies, and a new client starts with them", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");

  const start = await overview(api, admin, mspId);
  // Account recovery is a default too, but only offered when the server
  // sends email, which this one doesn't.
  expect(start.types).toContain(TWO_STEP);
  expect(start.types).not.toContain(RESET_PASSWORD);
  expect(start.types).not.toContain(REQUIRE_SSO);
  expect(
    start.defaults
      .filter((p) => p.enabled)
      .map((p) => p.type)
      .sort(),
  ).toEqual([MASTER_PASSWORD, SINGLE_ORG]);
  expect(
    start.defaults.find((p) => p.type === MASTER_PASSWORD)!.data,
  ).toMatchObject({ minLength: 12, minComplexity: 3 });

  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  expect((await clientPolicy(api, admin, dental, SINGLE_ORG)).enabled).toBe(
    true,
  );
  expect(
    (await clientPolicy(api, admin, dental, MASTER_PASSWORD)).data,
  ).toMatchObject({ minLength: 12, minComplexity: 3 });
  expect((await clientPolicy(api, admin, dental, RESET_PASSWORD)).enabled).toBe(
    true,
  );
  expect(await ownSettings(api, admin, mspId, dental)).toEqual([]);

  // A client added without the defaults has its own settings: all off.
  const bare = await api.client(admin, mspId, "Bare Co");
  expect(await ownSettings(api, admin, mspId, bare)).toEqual([
    MASTER_PASSWORD,
    SINGLE_ORG,
  ]);
});

test("changing a default changes every client that follows it and leaves clients with their own setting alone, until they use the default again", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const law = await api.client(admin, mspId, "Baker Law", "business");
  const bakery = await api.client(admin, mspId, "Corner Bakery", "business");

  // Baker Law asks for longer master passwords in its own admin console,
  // which makes that policy its own setting.
  await setClientPolicy(api, admin, law, MASTER_PASSWORD, true, {
    ...STRONG,
    minLength: 14,
  });
  expect(await ownSettings(api, admin, mspId, law)).toEqual([MASTER_PASSWORD]);

  // The MSP raises the default. Everyone else follows; Baker Law keeps 14.
  const raised = await setDefault(api, admin, mspId, MASTER_PASSWORD, true, {
    ...STRONG,
    minLength: 16,
  });
  expect(names(raised.changed)).toEqual(["Acme Dental", "Corner Bakery"]);
  expect(names(raised.kept)).toEqual(["Baker Law"]);
  expect(raised.refused).toEqual([]);
  for (const org of [dental, bakery]) {
    expect(
      (await clientPolicy(api, admin, org, MASTER_PASSWORD)).data.minLength,
    ).toBe(16);
  }
  expect(
    (await clientPolicy(api, admin, law, MASTER_PASSWORD)).data.minLength,
  ).toBe(14);

  // Turning a policy on reaches every client that had it off like the default.
  const twoStep = await setDefault(api, admin, mspId, TWO_STEP, true, null);
  expect(names(twoStep.changed)).toEqual([
    "Acme Dental",
    "Baker Law",
    "Corner Bakery",
  ]);
  expect(twoStep.kept).toEqual([]);

  // Baker Law goes back to the default, and then follows it again.
  const used = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/policies/${MASTER_PASSWORD}/apply`,
    { clients: [law] },
  );
  expect(used.status, JSON.stringify(used.body)).toBe(200);
  expect(names(used.body.changed)).toEqual(["Baker Law"]);
  expect(
    (await clientPolicy(api, admin, law, MASTER_PASSWORD)).data.minLength,
  ).toBe(16);
  expect(await ownSettings(api, admin, mspId, law)).toEqual([]);
  const lowered = await setDefault(
    api,
    admin,
    mspId,
    MASTER_PASSWORD,
    true,
    STRONG,
  );
  expect(names(lowered.changed)).toEqual([
    "Acme Dental",
    "Baker Law",
    "Corner Bakery",
  ]);

  // Using the default where a client already follows it changes nothing.
  const again = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/policies/${MASTER_PASSWORD}/apply`,
    { clients: [law, dental] },
  );
  expect(again.status).toBe(200);
  expect(again.body.changed).toEqual([]);

  // The audit log, newest first.
  const events = (
    await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`)
  ).body.data as { event: string; organizationName: string; detail: string }[];
  const policyEvents = events.filter((e) =>
    ["default_policy_changed", "client_policy_default"].includes(e.event),
  );
  expect(policyEvents.map((e) => e.detail)).toEqual([
    "Master password requirements to on: 3 clients changed",
    "Master password requirements",
    "Require two-step login to on: 3 clients changed",
    "Master password requirements to on: 2 clients changed, 1 client kept its own setting",
  ]);
  expect(policyEvents[1]).toMatchObject({
    event: "client_policy_default",
    organizationName: "Baker Law",
  });
});

test("a default reaches a client through its admin console's policy code: two-step login revokes members and technicians without it, not the MSP's owners", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const member = await api.account("dental-member");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);
  await api.addMember(admin, dental, member, "user");

  const result = await setDefault(api, admin, mspId, TWO_STEP, true, null);
  expect(names(result.changed)).toEqual(["Acme Dental"]);
  const members = await api.members(admin, dental);
  expect(members.find((m) => m.email === member.email)).toMatchObject({
    status: REVOKED,
  });
  // Technicians follow a client's two-step policy like its own members. The
  // MSP's admins own the client, so they stay, as upstream keeps owners.
  expect(members.find((m) => m.email === tech.email)).toMatchObject({
    status: REVOKED,
  });
  expect(members.find((m) => m.email === admin.email)).toMatchObject({
    status: CONFIRMED,
  });
});

test("a technician sees the defaults and their own clients' settings, but only MSP admins change them", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  await api.client(admin, mspId, "Baker Law", "business");
  await api.addStaff(admin, mspId, tech, "technician", {
        allClients: false,
        clients: [dental],
        custom: null,
        installCommands: true,
      });

  const seen = await overview(api, tech, mspId);
  expect(seen.clients.map((c) => c.name)).toEqual(["Acme Dental"]);
  expect(seen.defaults.length).toBe(seen.types.length);

  const changed = await api.call(
    tech,
    "PUT",
    `/api/keykeeper/msp/${mspId}/policies/${TWO_STEP}`,
    { enabled: true, data: null },
  );
  expect(changed.status).toBe(403);
  const used = await api.call(
    tech,
    "POST",
    `/api/keykeeper/msp/${mspId}/policies/${TWO_STEP}/apply`,
    { clients: [dental] },
  );
  expect(used.status).toBe(403);
  expect(
    (await overview(api, admin, mspId)).defaults.find(
      (p) => p.type === TWO_STEP,
    )!.enabled,
  ).toBe(false);
});

test("defaults must be supported policies with options, and only the MSP's own clients can use them", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const other = await api.account("other-msp-admin");
  const otherMsp = await api.msp(other, "Other IT");
  const theirs = await api.client(other, otherMsp, "Not Yours Inc", "business");
  await setClientPolicy(api, other, theirs, DISABLE_SEND, true, null);

  const refused = async (
    method: string,
    path: string,
    data: unknown,
    message: RegExp,
  ) => {
    const result = await api.call(admin, method, path, data);
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect(result.body.message).toMatch(message);
  };
  const base = `/api/keykeeper/msp/${mspId}/policies`;
  await refused(
    "PUT",
    `${base}/${REQUIRE_SSO}`,
    { enabled: true, data: null },
    /unsupported policy type/,
  );
  await refused(
    "PUT",
    `${base}/${MASTER_PASSWORD}`,
    { enabled: true, data: "long" },
    /must be an object/,
  );
  await refused(
    "POST",
    `${base}/${DISABLE_SEND}/apply`,
    { clients: [dental, theirs] },
    /Client not found/,
  );
  await refused(
    "POST",
    `${base}/${DISABLE_SEND}/apply`,
    { clients: [] },
    /at least one client/,
  );

  // Nothing changed in either MSP's clients.
  expect((await clientPolicy(api, other, theirs, DISABLE_SEND)).enabled).toBe(
    true,
  );
  expect(
    (await clientPolicy(api, admin, dental, MASTER_PASSWORD)).data.minLength,
  ).toBe(12);
});

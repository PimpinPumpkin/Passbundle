// A company with its own IT: an organization made with the Business preset in
// one step, and its own install command, managed by its owners and admins in
// the admin console. An MSP's client's command stays in the MSP's console.
// See DESIGN.md, "A company's own IT".
import { expect, test } from "@playwright/test";

import { Api, type Account, encString, publicKey } from "./support";

const ACCEPTED = 1;
const MASTER_PASSWORD = 1;
const SINGLE_ORG = 3;
const RESET_PASSWORD = 8;
const VAULT_LOCK = 9;

/** A new organization, made the way the web vault's New organization page does. */
async function create(api: Api, owner: Account, name: string, preset?: "business" | "none") {
  return api.call(owner, "POST", "/api/keykeeper/organizations", {
    name,
    collectionName: encString(`everyone-${name}`),
    adminsCollectionName: preset === "business" ? encString(`admins-${name}`) : undefined,
    preset,
    key: encString(`org-key-for-${owner.email}`),
    keys: {
      publicKey: publicKey(`org-${name}`),
      encryptedPrivateKey: encString(`org-private-${name}`),
    },
  });
}

async function makeOrg(api: Api, owner: Account, name: string, preset?: "business" | "none") {
  const created = await create(api, owner, name, preset);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}

const install = (api: Api, as: Account, orgId: string, method: "GET" | "POST" = "GET") =>
  api.call(as, method, `/api/keykeeper/organizations/${orgId}/enrollment`);

async function enabledPolicies(api: Api, owner: Account, orgId: string) {
  const policies = await api.call(owner, "GET", `/api/organizations/${orgId}/policies`);
  expect(policies.status, JSON.stringify(policies.body)).toBe(200);
  return policies.body.data
    .filter((p: { enabled: boolean }) => p.enabled)
    .map((p: { type: number; data: unknown }) => ({ type: p.type, data: p.data }))
    .sort((a: { type: number }, b: { type: number }) => a.type - b.type);
}

/** Confirms everyone who accepted, as an owner's app does in the background. */
async function confirmAccepted(api: Api, owner: Account, orgId: string) {
  for (const member of await api.members(owner, orgId)) {
    if (member.status !== ACCEPTED) continue;
    const confirmed = await api.call(owner, "POST", `/api/organizations/${orgId}/users/${member.id}/confirm`, {
      key: encString(`org-key-for-${member.email}`),
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  }
}

test("a company's organization starts with the Business preset and an install command, in one step", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await makeOrg(api, owner, "Northpoint Logistics", "business");

  // The Business preset: single organization, master password requirements,
  // account recovery with automatic enrollment, and vaults that lock when the
  // computer locks.
  expect(await enabledPolicies(api, owner, orgId)).toEqual([
    { type: MASTER_PASSWORD, data: expect.objectContaining({ minLength: 12, minComplexity: 3 }) },
    { type: SINGLE_ORG, data: null },
    { type: RESET_PASSWORD, data: expect.objectContaining({ autoEnrollEnabled: true }) },
    { type: VAULT_LOCK, data: { type: "onSystemLock", minutes: null, action: "lock" } },
  ]);
  // Everyone and Admins.
  const collections = await api.call(owner, "GET", `/api/organizations/${orgId}/collections`);
  expect(collections.body.data).toHaveLength(2);

  const command = await install(api, owner, orgId);
  expect(command.status, JSON.stringify(command.body)).toBe(200);
  expect(command.body).toMatchObject({ joins: 0, domains: [] });
  expect(command.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("someone joins a company's organization with its install command, gets Everyone, and waits for the org key", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await makeOrg(api, owner, "Harbor Freight Co", "business");
  const { token } = (await install(api, owner, orgId)).body;

  const person = await api.account("person");
  const info = await api.call(person, "POST", "/api/keykeeper/enrollment/info", { token });
  expect(info.status, JSON.stringify(info.body)).toBe(200);
  expect(info.body).toMatchObject({ organizationId: orgId, organizationName: "Harbor Freight Co" });

  const joined = await api.call(person, "POST", "/api/keykeeper/enrollment/join", { token });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  expect(joined.body).toMatchObject({ organizationId: orgId, status: ACCEPTED });
  expect(await api.orgsOf(person)).toEqual([]);

  await confirmAccepted(api, owner, orgId);
  expect(await api.orgsOf(person)).toEqual([orgId]);
  const collections = await api.call(person, "GET", "/api/collections");
  expect(collections.body.data).toHaveLength(1);
  expect((await install(api, owner, orgId)).body.joins).toBe(1);
});

test("without a preset it's upstream's organization: no policies, and no install command until an owner makes one", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await makeOrg(api, owner, "Rivera Family", "none");
  expect(await enabledPolicies(api, owner, orgId)).toEqual([]);
  expect((await api.call(owner, "GET", `/api/organizations/${orgId}/collections`)).body.data).toHaveLength(1);

  expect((await install(api, owner, orgId)).body.token).toBeNull();
  const made = await install(api, owner, orgId, "POST");
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // Replacing it stops the old one.
  const replaced = await install(api, owner, orgId, "POST");
  expect(replaced.body.token).not.toBe(made.body.token);
  const person = await api.account("person");
  const old = await api.call(person, "POST", "/api/keykeeper/enrollment/info", { token: made.body.token });
  expect(old.status).toBe(404);
  expect(old.body.message).toContain("isn't valid anymore");
});

test("only the organization's owners and admins manage its install command", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await makeOrg(api, owner, "Linden Supply", "business");
  const admin = await api.account("admin");
  const user = await api.account("user");
  const manager = await api.account("manager");
  const outsider = await api.account("outsider");
  for (const [member, type] of [
    [admin, "admin"],
    [user, "user"],
    [manager, "manager"],
  ] as const) {
    await api.addMember(owner, orgId, member, type);
  }

  for (const caller of [owner, admin]) {
    expect((await install(api, caller, orgId)).status).toBe(200);
  }
  expect((await install(api, admin, orgId, "POST")).status).toBe(200);
  // The web vault signs out on 403, and every member's Settings page reads
  // this, so reading it says "not found" to anyone else.
  for (const caller of [user, manager]) {
    expect((await install(api, caller, orgId)).status, caller.email).toBe(404);
    expect((await install(api, caller, orgId, "POST")).status, caller.email).toBe(403);
    const domains = await api.call(caller, "PUT", `/api/keykeeper/organizations/${orgId}/enrollment/domains`, {
      domains: [],
    });
    expect(domains.status).toBe(403);
  }
  for (const method of ["GET", "POST"] as const) {
    expect((await install(api, outsider, orgId, method)).status).toBe(404);
  }
  expect((await api.call(null, "GET", `/api/keykeeper/organizations/${orgId}/enrollment`)).status).toBe(401);
});

test("an MSP's client's install command stays in the MSP's console, out of reach of its admin console", async ({
  request,
}) => {
  const api = new Api(request);
  const mspAdmin = await api.account("msp-admin");
  const mspId = await api.msp(mspAdmin, "Harbor IT");
  const orgId = await api.client(mspAdmin, mspId, "Acme Dental", "business");
  // A technician without install commands is still an admin in the client.
  const tech = await api.account("tech");
  await api.addStaff(mspAdmin, mspId, tech, "technician", { allClients: true, clients: [], custom: null, installCommands: false });
  await api.confirmPending(mspAdmin, mspId);
  expect(await api.orgsOf(tech)).toContain(orgId);

  // Its Settings page says who manages it, with no token, and changing it is refused.
  for (const caller of [mspAdmin, tech]) {
    const read = await install(api, caller, orgId);
    expect(read.status, caller.email).toBe(200);
    // With how many people it removed since the token was made, so its
    // Members page can say when to ask the provider for a new one.
    expect(read.body).toEqual({ provider: "Harbor IT", removedSinceToken: 0 });
    const refused = await install(api, caller, orgId, "POST");
    expect(refused.status, caller.email).toBe(403);
    expect(refused.body.message).toContain("MSP console");
    const domains = await api.call(caller, "PUT", `/api/keykeeper/organizations/${orgId}/enrollment/domains`, {
      domains: [],
    });
    expect(domains.status, caller.email).toBe(403);
  }
});

test("a client that removes its MSP keeps Everyone for people who join, and makes its own install command", async ({
  request,
}) => {
  const api = new Api(request);
  const mspAdmin = await api.account("msp-admin");
  const mspId = await api.msp(mspAdmin, "Harbor IT");
  const orgId = await api.client(mspAdmin, mspId, "Baker Law", "business");
  const mspToken = (await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`)).body
    .token;
  const clientOwner = await api.account("client-owner");
  await api.addMember(mspAdmin, orgId, clientOwner, "owner");

  const removed = await api.call(clientOwner, "DELETE", `/api/keykeeper/organizations/${orgId}/msp`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);

  // The MSP's command is gone with the MSP; the owners make their own.
  const person = await api.account("person");
  expect((await api.call(person, "POST", "/api/keykeeper/enrollment/info", { token: mspToken })).status).toBe(404);
  expect((await install(api, clientOwner, orgId)).body.token).toBeNull();
  const { token } = (await install(api, clientOwner, orgId, "POST")).body;
  const joined = await api.call(person, "POST", "/api/keykeeper/enrollment/join", { token });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  await confirmAccepted(api, clientOwner, orgId);
  const collections = await api.call(person, "GET", "/api/collections");
  expect(collections.body.data).toHaveLength(1);
});

test("making an organization follows upstream's rules", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await makeOrg(api, owner, "Cedar Builders", "business");

  // A member of an organization with single organization on can't make another.
  const member = await api.account("member");
  await api.addMember(owner, orgId, member, "user");
  const refused = await create(api, member, "Side Project", "business");
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(/may not create an organization/);

  for (const [name, preset, message] of [
    ["", "business", /1 to 100 characters/],
    ["Odd Co", "enterprise", /Preset must be business or none/],
  ] as const) {
    const bad = await create(api, owner, name, preset as "business");
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(message);
  }
  const noAdmins = await api.call(owner, "POST", "/api/keykeeper/organizations", {
    name: "No Admins Co",
    collectionName: encString("everyone"),
    preset: "business",
    key: encString("key"),
    keys: { publicKey: publicKey("no-admins"), encryptedPrivateKey: encString("private") },
  });
  expect(noAdmins.status).toBe(400);
  expect(noAdmins.body.message).toMatch(/Admins collection/);
});

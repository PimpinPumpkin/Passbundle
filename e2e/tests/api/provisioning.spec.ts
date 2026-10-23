// Provisioning from Microsoft Entra ID (DESIGN.md, "Provisioning from Entra
// ID"): the token an organization's owners and admins make, and the SCIM
// requests Entra's provisioning service sends with it, replayed in the shapes
// Microsoft documents for SCIM endpoints ("Develop and plan provisioning for
// a SCIM endpoint in Microsoft Entra ID", and its compliance notes for the
// aadOptscim062020 flag). This server sends no email, so people it invites
// join when they sign up, as upstream's invitations do without email.
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { Api, type Account, type Result } from "./support";

const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";

const REVOKED = -1;
const INVITED = 0;
const ACCEPTED = 1;
const CONFIRMED = 2;

type Scim = Result & { headers: Record<string, string> };

/** Calls the SCIM endpoint the way Entra does: a bearer token and SCIM JSON. */
async function scim(
  request: APIRequestContext,
  token: string | null,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Scim> {
  const headers: Record<string, string> = { Accept: "application/scim+json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/scim+json";
  }
  const response = await request.fetch(path, {
    method,
    headers,
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; keep the text.
  }
  return { status: response.status(), body: parsed, headers: response.headers() };
}

/** A SCIM error as RFC 7644 describes it, with the status as a string. */
function expectError(result: Scim, status: number, scimType?: string) {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(result.headers["content-type"]).toContain("application/scim+json");
  expect(result.body.schemas).toEqual([ERROR]);
  expect(result.body.status).toBe(String(status));
  expect(typeof result.body.detail).toBe("string");
  if (scimType) {
    expect(result.body.scimType).toBe(scimType);
  }
}

async function makeToken(api: Api, who: Account, orgId: string): Promise<string> {
  const made = await api.call(who, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.newToken).toMatch(/^pbscim1_[A-Za-z0-9_-]{43}$/);
  return made.body.newToken;
}

/** The org's SCIM base path, as the Provisioning page shows it. */
const base = (orgId: string) => `/scim/v2/${orgId}`;

/** Microsoft's "Create User" request, for one address. */
function createUserBody(userName: string, email: string, externalId = randomUUID()) {
  return {
    schemas: [USER, ENTERPRISE],
    externalId,
    userName,
    active: true,
    emails: [{ primary: true, type: "work", value: email }],
    meta: { resourceType: "User" },
    name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
    roles: [],
  };
}

const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}@api.example.test`;

async function memberOf(api: Api, owner: Account, orgId: string, email: string) {
  return (await api.members(owner, orgId)).find((m) => m.email === email);
}

async function events(api: Api, owner: Account, orgId: string) {
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const end = new Date(Date.now() + 3_600_000).toISOString();
  const listed = await api.call(owner, "GET", `/api/organizations/${orgId}/events?start=${start}&end=${end}`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.data as { type: number; organizationUserId: string | null; groupId: string | null; systemUser: number | null; actingUserId: string | null }[];
}

test("owners and admins make, replace, and revoke the token, shown once and kept only as a hash", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("ProvOwner");
  const admin = await api.account("ProvAdmin");
  const member = await api.account("ProvMember");
  const stranger = await api.account("ProvStranger");
  const orgId = await api.organization(owner, `Provisioning ${randomUUID().slice(0, 6)}`);
  await api.addMember(owner, orgId, admin, "admin");
  await api.addMember(owner, orgId, member, "user");
  const page = `/api/keykeeper/organizations/${orgId}/provisioning`;

  const empty = await api.call(owner, "GET", page);
  expect(empty.status).toBe(200);
  expect(empty.body.token).toBeNull();
  expect(empty.body.scimUrl).toMatch(new RegExp(`/scim/v2/${orgId}$`));
  // Never 403: the web vault signs out on it.
  for (const who of [member, stranger]) {
    expect((await api.call(who, "GET", page)).status).toBe(404);
    expect((await api.call(who, "POST", `${page}/token`)).status).toBe(404);
    expect((await api.call(who, "DELETE", `${page}/token`)).status).toBe(404);
  }
  expect((await api.call(null, "GET", page)).status).toBe(401);

  const first = await makeToken(api, owner, orgId);
  const shown = await api.call(owner, "GET", page);
  expect(shown.body.token.createdBy).toBe(owner.email);
  expect(shown.body.token.lastUsedAt).toBeNull();
  expect(JSON.stringify(shown.body)).not.toContain(first);
  expect(shown.body.newToken).toBeUndefined();

  // Entra's Test Connection: a user that doesn't exist, by a random GUID.
  const test = await scim(request, first, "GET", `${base(orgId)}/Users?filter=userName eq "${randomUUID()}"`);
  expect(test.status, JSON.stringify(test.body)).toBe(200);
  expect(test.headers["content-type"]).toContain("application/scim+json");
  expect(test.body).toEqual({ schemas: [LIST], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
  const used = await api.call(owner, "GET", page);
  expect(used.body.token.lastUsedAt).not.toBeNull();
  expect(used.body.token.lastUsedIp).toBe("127.0.0.1");

  // Every way a token can be wrong is the same 401.
  for (const [token, header] of [
    [null, undefined],
    ["pbscim1_" + "A".repeat(43), undefined],
    ["not-a-token", undefined],
    [first.slice(0, -1) + (first.endsWith("A") ? "B" : "A"), undefined],
  ] as const) {
    const refused = await scim(request, token, "GET", `${base(orgId)}/Users`);
    expectError(refused, 401);
    expect(refused.headers["www-authenticate"]).toBe("Bearer");
    void header;
  }
  const basic = await request.fetch(`${base(orgId)}/Users`, { headers: { Authorization: `Basic ${first}` } });
  expect(basic.status()).toBe(401);

  // An admin replaces it: the first stops at once.
  const second = await makeToken(api, admin, orgId);
  expect(second).not.toBe(first);
  expectError(await scim(request, first, "GET", `${base(orgId)}/Users`), 401);
  expect((await scim(request, second, "GET", `${base(orgId)}/Users`)).status).toBe(200);

  const revoked = await api.call(owner, "DELETE", `${page}/token`);
  expect(revoked.status).toBe(200);
  expect(revoked.body.token).toBeNull();
  expectError(await scim(request, second, "GET", `${base(orgId)}/Users`), 401);
});

test("a token works only for its own organization's URL", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("ScopeOwner");
  const other = await api.account("ScopeOther");
  const orgA = await api.organization(owner, `Scope A ${randomUUID().slice(0, 6)}`);
  const orgB = await api.organization(other, `Scope B ${randomUUID().slice(0, 6)}`);
  const tokenA = await makeToken(api, owner, orgA);
  const tokenB = await makeToken(api, other, orgB);
  const inB = await scim(request, tokenB, "POST", `${base(orgB)}/Users`, createUserBody(unique("b"), unique("b")));
  expect(inB.status, JSON.stringify(inB.body)).toBe(201);
  const groupB = await scim(request, tokenB, "POST", `${base(orgB)}/Groups`, { displayName: "Only B" });
  expect(groupB.status, JSON.stringify(groupB.body)).toBe(201);

  // A's token at B's URL is refused like any wrong token.
  expectError(await scim(request, tokenA, "GET", `${base(orgB)}/Users`), 401);
  expectError(await scim(request, tokenA, "DELETE", `${base(orgB)}/Users/${inB.body.id}`), 401);
  // B's people and groups don't exist at A's URL.
  for (const path of [`/Users/${inB.body.id}`, `/Groups/${groupB.body.id}`]) {
    expectError(await scim(request, tokenA, "GET", `${base(orgA)}${path}`), 404);
    expectError(await scim(request, tokenA, "DELETE", `${base(orgA)}${path}`), 404);
  }
  expectError(
    await scim(request, tokenA, "PATCH", `${base(orgA)}/Users/${inB.body.id}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "active", value: false }],
    }),
    404,
  );
  const listed = await scim(request, tokenA, "GET", `${base(orgA)}/Users`);
  expect(listed.body.Resources.map((u: { id: string }) => u.id)).not.toContain(inB.body.id);
  // And B's person is untouched.
  expect((await scim(request, tokenB, "GET", `${base(orgB)}/Users/${inB.body.id}`)).body.active).toBe(true);
  // A made-up organization is a 401 too, so the answer says nothing.
  expectError(await scim(request, tokenA, "GET", `${base(randomUUID())}/Users`), 401);
});

test("Entra's requests for a person: create, match, update, turn off and on, remove", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("EntraOwner");
  const orgId = await api.organization(owner, `Entra ${randomUUID().slice(0, 6)}`);
  const token = await makeToken(api, owner, orgId);

  // Someone with no account yet: Entra's userName is their user principal
  // name, and their mailbox is the work email.
  const email = unique("newhire");
  const upn = `Test_User_${randomUUID()}`;
  const externalId = randomUUID();
  const created = await scim(request, token, "POST", `${base(orgId)}/Users?aadOptscim062020`, createUserBody(upn, email, externalId));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id;
  expect(created.headers["location"]).toMatch(new RegExp(`/scim/v2/${orgId}/Users/${id}$`));
  expect(created.body).toMatchObject({
    schemas: expect.arrayContaining([USER]),
    id,
    externalId,
    userName: upn,
    active: true,
    emails: [{ primary: true, type: "work", value: email }],
    name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
    meta: { resourceType: "User" },
  });
  expect(created.body.roles).toBeUndefined();
  // An invitation, as a regular member, with no seal to vouch for it.
  const invited = await memberOf(api, owner, orgId, email);
  expect(invited).toMatchObject({ id, status: INVITED, type: 2 });

  // Entra creates twice only by mistake: the second is a conflict.
  expectError(await scim(request, token, "POST", `${base(orgId)}/Users`, createUserBody(upn, email)), 409, "uniqueness");

  // Matching, by userName (any case), externalId, and work email.
  for (const filter of [
    `userName eq "${upn}"`,
    `userName eq "${upn.toUpperCase()}"`,
    `externalId eq "${externalId}"`,
    `emails[type eq "work"].value eq "${email}"`,
  ]) {
    const found = await scim(request, token, "GET", `${base(orgId)}/Users?filter=${encodeURIComponent(filter)}`);
    expect(found.status, filter).toBe(200);
    expect(found.body.totalResults, filter).toBe(1);
    expect(found.body.Resources[0].id, filter).toBe(id);
  }
  expectError(await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName zz "x"`), 400, "invalidFilter");
  const one = await scim(request, token, "GET", `${base(orgId)}/Users/${id}`);
  expect(one.status).toBe(200);
  expect(one.body.userName).toBe(upn);
  expectError(await scim(request, token, "GET", `${base(orgId)}/Users/${randomUUID()}`), 404);

  // They sign up (this server sends no email, so the invitation lets the
  // address register) and are in, waiting for the organization's key.
  await api.account("NewHire", email);
  expect((await memberOf(api, owner, orgId, email))?.status).toBe(ACCEPTED);

  // Update, multi-valued and single-valued, as Microsoft documents.
  const updated = await scim(request, token, "PATCH", `${base(orgId)}/Users/${id}`, {
    schemas: [PATCH_OP],
    Operations: [
      { op: "Replace", path: 'emails[type eq "work"].value', value: "updatedEmail@microsoft.com" },
      { op: "Replace", path: "name.familyName", value: "updatedFamilyName" },
    ],
  });
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  expect(updated.body.emails).toEqual([{ primary: true, type: "work", value: "updatedEmail@microsoft.com" }]);
  expect(updated.body.name.familyName).toBe("updatedFamilyName");
  // The account's email stays: that's the person's to change.
  expect((await memberOf(api, owner, orgId, email))?.id).toBe(id);
  const renamedUpn = `${randomUUID()}@testuser.com`;
  const renamed = await scim(request, token, "PATCH", `${base(orgId)}/Users/${id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "Replace", path: "userName", value: renamedUpn }],
  });
  expect(renamed.body.userName).toBe(renamedUpn);
  const byNew = await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName eq "${renamedUpn}"`);
  expect(byNew.body.Resources[0].id).toBe(id);
  expect((await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName eq "${upn}"`)).body.totalResults).toBe(0);

  // With the flag: replace without a path, paths as the value's keys.
  const flagged = await scim(request, token, "PATCH", `${base(orgId)}/Users/${id}`, {
    schemas: [PATCH_OP],
    Operations: [
      {
        op: "replace",
        value: { displayName: "Bjfe", "name.givenName": "Kkom", [`${ENTERPRISE}:employeeNumber`]: "Aklq" },
      },
    ],
  });
  expect(flagged.body).toMatchObject({ displayName: "Bjfe", name: { givenName: "Kkom" }, [ENTERPRISE]: { employeeNumber: "Aklq" } });

  // Turning off: "False" as a string (Entra without its flag) revokes them.
  const off = await scim(request, token, "PATCH", `${base(orgId)}/Users/${id}`, {
    Operations: [{ op: "Replace", path: "active", value: "False" }],
    schemas: [PATCH_OP],
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.active).toBe(false);
  expect((await memberOf(api, owner, orgId, email))?.status).toBeLessThan(INVITED);
  // Still listed, inactive, as Microsoft asks.
  const listedOff = await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName eq "${renamedUpn}"`);
  expect(listedOff.body.Resources[0].active).toBe(false);

  // On again: false as a boolean was off; true restores them.
  const on = await scim(request, token, "PATCH", `${base(orgId)}/Users/${id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", path: "active", value: true }],
  });
  expect(on.body.active).toBe(true);
  expect((await memberOf(api, owner, orgId, email))?.status).toBe(ACCEPTED);

  // Someone an admin turned off in PassBundle stays off until an admin
  // turns them on there.
  const revoke = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${id}/revoke`);
  expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
  expectError(
    await scim(request, token, "PATCH", `${base(orgId)}/Users/${id}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "active", value: true }],
    }),
    403,
  );
  expect((await memberOf(api, owner, orgId, email))?.status).toBeLessThan(INVITED);
  expect((await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${id}/restore`)).status).toBe(200);

  // PUT replaces what's kept.
  const put = await scim(request, token, "PUT", `${base(orgId)}/Users/${id}`, {
    schemas: [USER],
    userName: renamedUpn,
    externalId,
    displayName: "Joy Young",
    emails: [{ type: "work", value: email, primary: true }],
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  expect(put.body.displayName).toBe("Joy Young");
  expect(put.body.name).toBeUndefined();
  expect(put.body.active).toBe(true);

  // Every change is in the organization's event log, by SCIM, with no person.
  const log = await events(api, owner, orgId);
  const mine = log.filter((e) => e.organizationUserId === id && e.systemUser === 1);
  expect(mine.map((e) => e.type)).toEqual(expect.arrayContaining([1500, 1511, 1512]));
  expect(mine.every((e) => e.actingUserId === null)).toBe(true);

  // Removing: the membership goes; their account stays theirs.
  const removed = await scim(request, token, "DELETE", `${base(orgId)}/Users/${id}`);
  expect(removed.status).toBe(204);
  expect(await memberOf(api, owner, orgId, email)).toBeUndefined();
  expectError(await scim(request, token, "GET", `${base(orgId)}/Users/${id}`), 404);
  expect((await events(api, owner, orgId)).some((e) => e.type === 1503 && e.organizationUserId === id && e.systemUser === 1)).toBe(true);
  await api.logIn(email, Buffer.from(`hash-${email}`).toString("base64"));
});

test("someone already in the organization is matched, not invited again", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("MatchOwner");
  const alice = await api.account("Alice");
  const orgId = await api.organization(owner, `Match ${randomUUID().slice(0, 6)}`);
  const aliceId = await api.addMember(owner, orgId, alice, "user");
  const token = await makeToken(api, owner, orgId);

  // Entra matches by userName; Alice's account email is what she's known by.
  const found = await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName eq "${alice.email}"`);
  expect(found.body.totalResults).toBe(1);
  expect(found.body.Resources[0]).toMatchObject({ id: aliceId, userName: alice.email, active: true });
  // With a userName that isn't her email, Entra creates her: she's matched by
  // her work email, and her membership is as it was.
  const upn = `alice-${randomUUID()}@contoso.onmicrosoft.com`;
  const linked = await scim(request, token, "POST", `${base(orgId)}/Users`, createUserBody(upn, alice.email));
  expect(linked.status, JSON.stringify(linked.body)).toBe(201);
  expect(linked.body.id).toBe(aliceId);
  expect((await memberOf(api, owner, orgId, alice.email))?.status).toBe(CONFIRMED);
  const byUpn = await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName eq "${upn}"`);
  expect(byUpn.body.Resources[0].id).toBe(aliceId);
  // And from now on she's the directory's: turning her off revokes her.
  const off = await scim(request, token, "PATCH", `${base(orgId)}/Users/${aliceId}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  expect(off.status).toBe(200);
  expect((await memberOf(api, owner, orgId, alice.email))?.status).toBe(REVOKED);
  // Revoking keeps her membership and its key: on again, she's confirmed.
  await scim(request, token, "PATCH", `${base(orgId)}/Users/${aliceId}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", path: "active", value: true }],
  });
  expect((await memberOf(api, owner, orgId, alice.email))?.status).toBe(CONFIRMED);
});

test("owners, admins, custom roles, and an MSP's staff are matched but never changed", async ({ request }) => {
  const api = new Api(request);
  const mspAdmin = await api.account("ProvMspAdmin");
  const tech = await api.account("ProvTech");
  const clientAdmin = await api.account("ProvClientAdmin");
  const poc = await api.account("ProvPoc");
  const regular = await api.account("ProvRegular");
  const mspId = await api.msp(mspAdmin, `Prov MSP ${randomUUID().slice(0, 6)}`);
  const orgId = await api.client(mspAdmin, mspId, `Prov Client ${randomUUID().slice(0, 6)}`, "business");
  await api.addStaff(mspAdmin, mspId, tech, "technician");
  await api.confirmPending(mspAdmin, mspId);
  await api.addMember(mspAdmin, orgId, clientAdmin, "admin");
  await api.addCustomMember(mspAdmin, orgId, poc, { manageUsers: true });
  const regularId = await api.addMember(mspAdmin, orgId, regular, "user");

  // A technician can't make the client's token: an MSP's admins can.
  expect((await api.call(tech, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`)).status).toBe(404);
  const token = await makeToken(api, mspAdmin, orgId);

  const protectedPeople = [mspAdmin, tech, clientAdmin, poc];
  for (const who of protectedPeople) {
    const found = await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName eq "${who.email}"`);
    expect(found.body.totalResults, who.email).toBe(1);
    const id = found.body.Resources[0].id;
    const before = await memberOf(api, mspAdmin, orgId, who.email);
    const off = await scim(request, token, "PATCH", `${base(orgId)}/Users/${id}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expectError(off, 403);
    expect(off.body.detail).toContain("doesn't change owners, admins");
    expectError(await scim(request, token, "DELETE", `${base(orgId)}/Users/${id}`), 403);
    // Read-only: nothing the directory sends about them is kept.
    expectError(
      await scim(request, token, "PATCH", `${base(orgId)}/Users/${id}`, {
        schemas: [PATCH_OP],
        Operations: [
          { op: "replace", path: "displayName", value: "Renamed by the directory" },
          { op: "replace", path: "userName", value: `taken-${randomUUID()}@contoso.onmicrosoft.com` },
        ],
      }),
      403,
    );
    expectError(
      await scim(request, token, "PUT", `${base(orgId)}/Users/${id}`, { schemas: [USER], userName: who.email, displayName: "x" }),
      403,
    );
    const unchanged = await scim(request, token, "GET", `${base(orgId)}/Users/${id}`);
    expect(unchanged.body.userName, who.email).toBe(who.email);
    expect(unchanged.body.displayName, who.email).toBeUndefined();
    // Never linked under a userName the directory chose.
    const upn = `${randomUUID()}@contoso.onmicrosoft.com`;
    expectError(await scim(request, token, "POST", `${base(orgId)}/Users`, createUserBody(upn, who.email)), 409, "uniqueness");
    expect((await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName eq "${upn}"`)).body.totalResults).toBe(0);
    // Nor can anyone else take their email as a userName.
    expectError(
      await scim(request, token, "POST", `${base(orgId)}/Users`, createUserBody(who.email, unique("squatter"))),
      409,
      "uniqueness",
    );
    expect(await memberOf(api, mspAdmin, orgId, who.email), who.email).toEqual(before);
  }
  // The Provisioning page lists whom Entra turned off, for a person to remove.
  const page = await api.call(mspAdmin, "GET", `/api/keykeeper/organizations/${orgId}/provisioning`);
  expect(page.body.turnedOff.map((p: { email: string }) => p.email).sort()).toEqual(
    protectedPeople.map((p) => p.email).sort(),
  );
  expect(page.body.turnedOff.find((p: { email: string }) => p.email === tech.email).role).toBe("IT provider's staff");
  expect(page.body.turnedOff.find((p: { email: string }) => p.email === poc.email).role).toBe("Custom role");

  // A group's changes leave them out, and still apply to everyone else.
  const group = await scim(request, token, "POST", `${base(orgId)}/Groups`, { schemas: [GROUP], displayName: "Everyone at the client" });
  expect(group.status, JSON.stringify(group.body)).toBe(201);
  const ids = [];
  for (const who of [...protectedPeople, regular]) {
    ids.push((await memberOf(api, mspAdmin, orgId, who.email))!.id);
  }
  const added = await scim(request, token, "PATCH", `${base(orgId)}/Groups/${group.body.id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "Add", path: "members", value: ids.map((value) => ({ $ref: null, value })) }],
  });
  expect(added.status, JSON.stringify(added.body)).toBe(204);
  const inGroup = await api.call(mspAdmin, "GET", `/api/organizations/${orgId}/groups/${group.body.id}/users`);
  expect(inGroup.body).toEqual([regularId]);
  // And someone who's a regular member is the directory's to turn off.
  const off = await scim(request, token, "PATCH", `${base(orgId)}/Users/${regularId}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  expect(off.status).toBe(200);
  // A regular member can't take a protected person's email as a userName.
  expectError(
    await scim(request, token, "PATCH", `${base(orgId)}/Users/${regularId}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "userName", value: mspAdmin.email }],
    }),
    409,
    "uniqueness",
  );
  // Entra turning a protected person back on clears them from the list,
  // and still changes nothing about them.
  const admin = await scim(request, token, "GET", `${base(orgId)}/Users?filter=userName eq "${clientAdmin.email}"`);
  const back = await scim(request, token, "PATCH", `${base(orgId)}/Users/${admin.body.Resources[0].id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", path: "active", value: true }],
  });
  expectError(back, 403);
  const after = await api.call(mspAdmin, "GET", `/api/keykeeper/organizations/${orgId}/provisioning`);
  expect(after.body.turnedOff.map((p: { email: string }) => p.email)).not.toContain(clientAdmin.email);
  // The MSP's activity log has the token, never the token itself.
  const activity = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  expect(activity.status, JSON.stringify(activity.body)).toBe(200);
  expect(JSON.stringify(activity.body)).toContain("provisioning_token_created");
  expect(JSON.stringify(activity.body)).not.toContain(token);
});

test("groups: create, find by name, rename, add and remove members both ways, delete", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("GroupsOwner");
  const orgId = await api.organization(owner, `Groups ${randomUUID().slice(0, 6)}`);
  const token = await makeToken(api, owner, orgId);
  const people = [];
  for (const n of [1, 2]) {
    const email = unique(`grp${n}`);
    const made = await scim(request, token, "POST", `${base(orgId)}/Users`, createUserBody(email, email));
    expect(made.status).toBe(201);
    people.push(made.body.id as string);
  }

  // Microsoft's "Create Group", with its extra schema URN.
  const externalId = randomUUID();
  const created = await scim(request, token, "POST", `${base(orgId)}/Groups`, {
    schemas: [GROUP, "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group"],
    externalId,
    displayName: "displayName",
    meta: { resourceType: "Group" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id;
  expect(created.body).toMatchObject({ schemas: [GROUP], id, externalId, displayName: "displayName", members: [], meta: { resourceType: "Group" } });
  expectError(
    await scim(request, token, "POST", `${base(orgId)}/Groups`, { schemas: [GROUP], displayName: "DISPLAYNAME" }),
    409,
    "uniqueness",
  );
  // It's an ordinary group in PassBundle, with no shared folders.
  const groups = await api.call(owner, "GET", `/api/organizations/${orgId}/groups`);
  expect(groups.body.data.find((g: { id: string }) => g.id === id)).toMatchObject({ name: "displayName", externalId });

  const got = await scim(request, token, "GET", `${base(orgId)}/Groups/${id}?excludedAttributes=members`);
  expect(got.status).toBe(200);
  expect(got.body.members).toBeUndefined();
  const byName = await scim(
    request,
    token,
    "GET",
    `${base(orgId)}/Groups?excludedAttributes=members&filter=${encodeURIComponent('displayName eq "displayName"')}`,
  );
  expect(byName.body.totalResults).toBe(1);
  expect(byName.body.Resources[0].id).toBe(id);
  expect(byName.body.Resources[0].members).toBeUndefined();

  const newName = `${randomUUID()}updatedDisplayName`;
  const rename = await scim(request, token, "PATCH", `${base(orgId)}/Groups/${id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "Replace", path: "displayName", value: newName }],
  });
  expect(rename.status).toBe(204);
  expect((await scim(request, token, "GET", `${base(orgId)}/Groups/${id}`)).body.displayName).toBe(newName);

  const members = async () =>
    ((await api.call(owner, "GET", `/api/organizations/${orgId}/groups/${id}/users`)).body as string[]).sort();
  const add = await scim(request, token, "PATCH", `${base(orgId)}/Groups/${id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "Add", path: "members", value: people.map((value) => ({ $ref: null, value })) }],
  });
  expect(add.status, JSON.stringify(add.body)).toBe(204);
  expect(await members()).toEqual([...people].sort());
  const filtered = await scim(
    request,
    token,
    "GET",
    `${base(orgId)}/Groups?filter=${encodeURIComponent(`id eq "${id}" and members[value eq "${people[0]}"]`)}&excludedAttributes=members`,
  );
  expect(filtered.body.totalResults).toBe(1);
  // Without the flag: path "members" and the values to remove.
  const removeOld = await scim(request, token, "PATCH", `${base(orgId)}/Groups/${id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "Remove", path: "members", value: [{ $ref: null, value: people[0] }] }],
  });
  expect(removeOld.status).toBe(204);
  expect(await members()).toEqual([people[1]]);
  // With it: a filter in the path.
  const removeNew = await scim(request, token, "PATCH", `${base(orgId)}/Groups/${id}`, {
    schemas: [PATCH_OP],
    Operations: [{ op: "remove", path: `members[value eq "${people[1]}"]` }],
  });
  expect(removeNew.status).toBe(204);
  expect(await members()).toEqual([]);
  expectError(
    await scim(request, token, "PATCH", `${base(orgId)}/Groups/${id}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Add", path: "members", value: [{ value: randomUUID() }] }],
    }),
    400,
    "invalidValue",
  );
  const log = await events(api, owner, orgId);
  expect(log.some((e) => e.type === 1400 && e.groupId === id && e.systemUser === 1)).toBe(true);
  expect(log.some((e) => e.type === 1504 && e.organizationUserId === people[0] && e.systemUser === 1)).toBe(true);

  // Groups made in PassBundle aren't the directory's.
  const own = await api.call(owner, "POST", `/api/organizations/${orgId}/groups`, {
    name: "Made in PassBundle",
    accessAll: false,
    collections: [],
    users: [],
  });
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  expectError(await scim(request, token, "GET", `${base(orgId)}/Groups/${own.body.id}`), 404);
  expectError(await scim(request, token, "DELETE", `${base(orgId)}/Groups/${own.body.id}`), 404);
  const listed = await scim(request, token, "GET", `${base(orgId)}/Groups`);
  expect(listed.body.Resources.map((g: { id: string }) => g.id)).toEqual([id]);
  expectError(
    await scim(request, token, "POST", `${base(orgId)}/Groups`, { schemas: [GROUP], displayName: "made in passbundle" }),
    409,
    "uniqueness",
  );

  expect((await scim(request, token, "DELETE", `${base(orgId)}/Groups/${id}`)).status).toBe(204);
  const left = await api.call(owner, "GET", `/api/organizations/${orgId}/groups`);
  expect(left.body.data.map((g: { id: string }) => g.id)).toEqual([own.body.id]);
});

test("discovery, paging, and the paths and flags Entra uses", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("DiscoOwner");
  const orgId = await api.organization(owner, `Discovery ${randomUUID().slice(0, 6)}`);
  const token = await makeToken(api, owner, orgId);

  const config = await scim(request, token, "GET", `${base(orgId)}/ServiceProviderConfig`);
  expect(config.status).toBe(200);
  expect(config.body).toMatchObject({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false },
    filter: { supported: true, maxResults: 200 },
    sort: { supported: false },
    etag: { supported: false },
    changePassword: { supported: false },
    authenticationSchemes: [expect.objectContaining({ type: "oauthbearertoken" })],
  });
  const types = await scim(request, token, "GET", `${base(orgId)}/ResourceTypes`);
  expect(types.body.schemas).toEqual([LIST]);
  expect(types.body.Resources.map((t: { id: string }) => t.id)).toEqual(["User", "Group"]);
  expect((await scim(request, token, "GET", `${base(orgId)}/ResourceTypes/User`)).body.endpoint).toBe("/Users");
  const schemas = await scim(request, token, "GET", `${base(orgId)}/Schemas`);
  expect(schemas.body.Resources.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([USER, GROUP, ENTERPRISE]));
  const userSchema = await scim(request, token, "GET", `${base(orgId)}/Schemas/${USER}`);
  expect(userSchema.body.attributes.find((a: { name: string }) => a.name === "userName")).toMatchObject({
    required: true,
    caseExact: false,
    uniqueness: "server",
  });
  expectError(await scim(request, token, "GET", `${base(orgId)}/Schemas/urn:nope`), 404);
  // Discovery needs the token too.
  expectError(await scim(request, null, "GET", `${base(orgId)}/ServiceProviderConfig`), 401);

  for (let i = 0; i < 3; i++) {
    const email = unique(`page${i}`);
    expect((await scim(request, token, "POST", `${base(orgId)}/Users`, createUserBody(email, email))).status).toBe(201);
  }
  // Paths in any case, and Entra's flag in the URL.
  const all = await scim(request, token, "GET", `${base(orgId)}/users?aadOptscim062020&startIndex=1&count=200`);
  expect(all.status).toBe(200);
  expect(all.body.totalResults).toBe(4);
  const page = await scim(request, token, "GET", `${base(orgId)}/Users?startIndex=2&count=2`);
  expect(page.body).toMatchObject({ totalResults: 4, startIndex: 2, itemsPerPage: 2 });
  expect(page.body.Resources.map((u: { id: string }) => u.id)).toEqual(
    all.body.Resources.slice(1, 3).map((u: { id: string }) => u.id),
  );
  const ids = await scim(request, token, "GET", `${base(orgId)}/Users?attributes=userName&count=1`);
  expect(Object.keys(ids.body.Resources[0]).sort()).toEqual(["id", "schemas", "userName"]);
  expectError(await scim(request, token, "GET", `${base(orgId)}/Users?count=many`), 400);
  expectError(await scim(request, token, "GET", `${base(orgId)}/Nothing`), 404);
  expectError(
    await scim(request, token, "PATCH", `${base(orgId)}/Users/${all.body.Resources[1].id}`, { Operations: [{ op: "move" }] }),
    400,
    "invalidSyntax",
  );
  const notJson = await request.fetch(`${base(orgId)}/Users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/scim+json" },
    data: "{not json",
  });
  expect(notJson.status()).toBe(400);
  expect((await notJson.json()).scimType).toBe("invalidSyntax");
  // A user without an email address to invite is refused, saying why.
  const noEmail = await scim(request, token, "POST", `${base(orgId)}/Users`, { schemas: [USER], userName: `Test_User_${randomUUID()}` });
  expectError(noEmail, 400, "invalidValue");
});

test("an invitation from the directory waits until an owner or admin lets it in", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("LetInOwner");
  const orgId = await api.organization(owner, `Let in ${randomUUID().slice(0, 6)}`);
  const token = await makeToken(api, owner, orgId);
  const email = unique("waiting");
  const made = await scim(request, token, "POST", `${base(orgId)}/Users`, createUserBody(email, email));
  expect(made.status).toBe(201);
  const person = await api.account("Waiting", email);
  const pending = async () =>
    (await api.call(owner, "GET", "/api/keykeeper/organizations/pending")).body.data.find(
      (p: { email: string }) => p.email === email,
    );
  // Waiting for the organization's key, with nothing that vouches for them:
  // apps that let people in on their own won't (join-checks.ts).
  expect(await pending()).toMatchObject({
    memberId: made.body.id,
    userId: person.userId,
    autoConfirm: false,
    inviteSeal: null,
    joinProof: null,
  });
  const page = `/api/keykeeper/organizations/${orgId}/provisioning`;
  expect((await api.call(owner, "GET", page)).body.waiting).toEqual([
    { memberId: made.body.id, email, userName: email, joined: true },
  ]);

  // Only people the directory invited, and only seals that look like seals.
  const seal = Buffer.alloc(32, 7).toString("base64");
  const stranger = await api.call(owner, "PUT", `${page}/seals`, { seals: [{ email: owner.email, seal }] });
  expect(stranger.status).toBe(400);
  const notSeal = await api.call(owner, "PUT", `${page}/seals`, { seals: [{ email, seal: "nope" }] });
  expect(notSeal.status).toBe(400);
  const member = await api.account("LetInMember");
  await api.addMember(owner, orgId, member, "user");
  expect((await api.call(member, "PUT", `${page}/seals`, { seals: [{ email, seal }] })).status).toBe(404);

  const letIn = await api.call(owner, "PUT", `${page}/seals`, { seals: [{ email, seal }] });
  expect(letIn.status, JSON.stringify(letIn.body)).toBe(200);
  expect(letIn.body.waiting).toEqual([]);
  expect(await pending()).toMatchObject({ autoConfirm: true, inviteSeal: seal });
  // Entra creating them again would be a new invitation, with no seal.
  await scim(request, token, "DELETE", `${base(orgId)}/Users/${made.body.id}`);
  const again = await scim(request, token, "POST", `${base(orgId)}/Users`, createUserBody(email, email));
  expect(again.status).toBe(201);
  expect(await pending()).toMatchObject({ autoConfirm: false, inviteSeal: null });
});

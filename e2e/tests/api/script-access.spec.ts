// Script access on the server (docs/script-access.md): tokens an
// organization's owners and admins (and its MSP's admins) make, which read
// only their own grants with nothing but the token's auth secret; refusals
// logged; networks; refreshing copies; and who may do what. The copies here
// are stand-ins: the server only stores them, and the vectors and the
// module's tests cover what's inside.
import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { Api, encString, type Account } from "./support";

const USER = 2;

/** A new token's secrets, as an admin's browser makes them. */
function newToken() {
  const id = randomUUID();
  const seed = randomBytes(32);
  const authSecret = Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(0), "passbundle script auth v1", 32));
  return {
    id,
    authHash: createHash("sha256").update(authSecret).digest("base64"),
    authorization: `PassBundleScript ${id}.${authSecret.toString("base64url")}`,
  };
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function revisionOf(api: Api, who: Account, itemId: string): Promise<string> {
  const item = await api.call(who, "GET", `/api/ciphers/${itemId}`);
  expect(item.status, JSON.stringify(item.body)).toBe(200);
  return item.body.revisionDate;
}

/** Changes an item, as an app saving it would, so its revision moves on. */
async function editItem(api: Api, who: Account, itemId: string) {
  const seen = await api.call(who, "GET", `/api/ciphers/${itemId}`);
  const edited = await api.call(who, "PUT", `/api/ciphers/${itemId}`, {
    ...seen.body,
    encryptedFor: who.userId,
    notes: encString(`edited-${randomUUID()}`),
  });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
}

async function grantFor(api: Api, who: Account, itemId: string) {
  return {
    itemId,
    copy: encString(`copy-${itemId}`),
    revision: await revisionOf(api, who, itemId),
    sealedSpec: encString(`spec-${itemId}`),
  };
}

async function createToken(
  api: Api,
  who: Account,
  orgId: string,
  items: string[],
  more: Record<string, unknown> = {},
) {
  const token = newToken();
  const grants = [];
  for (const item of items) {
    grants.push(await grantFor(api, who, item));
  }
  const created = await api.call(who, "POST", `/api/keykeeper/organizations/${orgId}/script-tokens`, {
    id: token.id,
    name: "Join domain",
    expiresAt: inDays(90),
    networks: [],
    authHash: token.authHash,
    sealedKey: encString(`sealed-key-${token.id}`),
    grants,
    ...more,
  });
  return { ...token, created };
}

test("a token reads only its grants, with nothing but its auth secret, and every read and refusal is logged", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("script-owner");
  const orgId = await api.organization(owner, "Contoso");
  const collection = await api.collection(owner, orgId);
  const granted = await api.orgItem(owner, orgId, collection);
  const other = await api.orgItem(owner, orgId, collection);

  const token = await createToken(api, owner, orgId, [granted]);
  expect(token.created.status, JSON.stringify(token.created.body)).toBe(200);
  expect(token.created.body).toMatchObject({ id: token.id, name: "Join domain", createdBy: owner.email });
  expect(token.created.body.grants).toEqual([
    expect.objectContaining({ itemId: granted, upToDate: true, itemDeleted: false }),
  ]);

  const script = (path: string, authorization = token.authorization) =>
    request.get(`/api/keykeeper/script/${path}`, { headers: { Authorization: authorization } });

  const one = await script(`items/${granted}`);
  expect(one.status()).toBe(200);
  expect(await one.json()).toEqual({ itemId: granted, copy: encString(`copy-${granted}`), upToDate: true });
  const all = await script("items");
  expect((await all.json()).data.map((d: { itemId: string }) => d.itemId)).toEqual([granted]);

  // Another item, a wrong secret, an ordinary login, or nothing: refused.
  expect((await script(`items/${other}`)).status()).toBe(404);
  expect((await script("items", newToken().authorization.replace(/^PassBundleScript [^.]+/, `PassBundleScript ${token.id}`))).status()).toBe(401);
  expect((await request.get("/api/keykeeper/script/items", { headers: { Authorization: `Bearer ${owner.token}` } })).status()).toBe(401);
  expect((await request.get("/api/keykeeper/script/items")).status()).toBe(401);
  // And a token can't use anything else.
  expect((await request.get("/api/sync", { headers: { Authorization: token.authorization } })).status()).toBe(401);

  const reads = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/script-tokens/${token.id}/reads`);
  const summary = reads.body.data.map((r: { itemId: string | null; allowed: boolean; reason: string }) => [
    r.itemId,
    r.allowed,
    r.reason,
  ]);
  expect(summary).toEqual(
    expect.arrayContaining([
      [granted, true, "read"],
      [other, false, "not granted"],
      [null, false, "wrong secret"],
    ]),
  );
  const listed = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/script-tokens`);
  expect(listed.body.data[0].lastUsedAt).toBeTruthy();

  // Revoked: it stops working at once, and its copies are gone.
  const revoked = await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/script-tokens/${token.id}`);
  expect(revoked.status).toBe(200);
  expect(revoked.body.revokedAt).toBeTruthy();
  expect(revoked.body.grants).toEqual([]);
  expect((await script(`items/${granted}`)).status()).toBe(401);
});

test("a token works only from its networks", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("script-net-owner");
  const orgId = await api.organization(owner, "Fabrikam");
  const item = await api.orgItem(owner, orgId, await api.collection(owner, orgId));

  const elsewhere = await createToken(api, owner, orgId, [item], { networks: ["203.0.113.0/24"] });
  expect(elsewhere.created.status, JSON.stringify(elsewhere.created.body)).toBe(200);
  expect(elsewhere.created.body.networks).toEqual(["203.0.113.0/24"]);
  const here = await createToken(api, owner, orgId, [item], { networks: ["127.0.0.1"] });
  expect(here.created.body.networks).toEqual(["127.0.0.1/32"]);

  const read = (authorization: string) =>
    request.get(`/api/keykeeper/script/items/${item}`, { headers: { Authorization: authorization } });
  expect((await read(elsewhere.authorization)).status()).toBe(401);
  expect((await read(here.authorization)).status()).toBe(200);
  const reads = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/script-tokens/${elsewhere.id}/reads`);
  expect(reads.body.data[0]).toMatchObject({ allowed: false, reason: "outside its networks" });
});

test("a token's settings and grants are checked", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("script-check-owner");
  const orgId = await api.organization(owner, "Litware");
  const item = await api.orgItem(owner, orgId, await api.collection(owner, orgId));
  const otherOrg = await api.organization(owner, "Elsewhere");
  const foreign = await api.orgItem(owner, otherOrg, await api.collection(owner, otherOrg));
  const personal = await api.personalItem(owner);

  for (const [why, more, items] of [
    ["lasts over a year", { expiresAt: inDays(400) }, [item]],
    ["already expired", { expiresAt: inDays(-1) }, [item]],
    ["a network that isn't one", { networks: ["the office"] }, [item]],
    ["no grants", {}, []],
    ["another organization's item", {}, [foreign]],
    ["a personal item", {}, [personal]],
    ["a plain-text copy", {}, null],
  ] as const) {
    const grants = items ?? [item];
    const made = items
      ? await createToken(api, owner, orgId, [...grants], more)
      : await createToken(api, owner, orgId, [], {
          grants: [{ ...(await grantFor(api, owner, item)), copy: "the password in plain text" }],
        });
    expect(made.created.status, why).toBe(400);
  }

  // A copy made from an older revision of the item is refused.
  const stale = await grantFor(api, owner, item);
  await editItem(api, owner, item);
  const old = await createToken(api, owner, orgId, [], { grants: [stale] });
  expect(old.created.status).toBe(400);
  expect(old.created.body.message).toMatch(/changed/);
});

test("anyone who can edit a granted item refreshes its copy for the item's current revision; nobody else changes grants", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("script-refresh-owner");
  const orgId = await api.organization(owner, "Northwind");
  const collection = await api.collection(owner, orgId);
  const item = await api.orgItem(owner, orgId, collection);
  const token = await createToken(api, owner, orgId, [item]);
  expect(token.created.status).toBe(200);

  // A member who can edit the item (an owner here edits it) changes it: the
  // grant is out of date and on the list of copies to refresh.
  const member = await api.account("script-refresh-member");
  await api.addMember(owner, orgId, member, "user");
  await editItem(api, owner, item);
  const stale = await api.call(owner, "GET", "/api/keykeeper/script-grants/stale");
  expect(stale.body.data).toEqual([
    expect.objectContaining({
      organizationId: orgId,
      tokenId: token.id,
      itemId: item,
      revision: await revisionOf(api, owner, item),
      sealedKey: encString(`sealed-key-${token.id}`),
      sealedSpec: encString(`spec-${item}`),
    }),
  ]);
  // The member has no access to the item's collection: nothing for them to refresh, and they can't.
  expect((await api.call(member, "GET", "/api/keykeeper/script-grants/stale")).body.data).toEqual([]);
  const path = `/api/keykeeper/organizations/${orgId}/script-tokens/${token.id}/grants/${item}`;
  const fresh = {
    copy: encString("refreshed"),
    revision: await revisionOf(api, owner, item),
    sealedSpec: encString(`spec-${item}`),
  };
  expect((await api.call(member, "PUT", path, fresh)).status).toBe(404);

  // The owner refreshes it; an old revision is refused.
  expect((await api.call(owner, "PUT", path, { ...fresh, revision: "2020-01-01T00:00:00.000000Z" })).status).toBe(400);
  const refreshed = await api.call(owner, "PUT", path, fresh);
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  expect(refreshed.body.grants[0]).toMatchObject({ itemId: item, upToDate: true });
  expect((await api.call(owner, "GET", "/api/keykeeper/script-grants/stale")).body.data).toEqual([]);
  const read = await request.get(`/api/keykeeper/script/items/${item}`, { headers: { Authorization: token.authorization } });
  expect(await read.json()).toMatchObject({ copy: encString("refreshed"), upToDate: true });

  // Regular members can't list, make, or revoke tokens.
  expect((await api.call(member, "GET", `/api/keykeeper/organizations/${orgId}/script-tokens`)).status).toBe(404);
  const asMember = newToken();
  const memberMade = await api.call(member, "POST", `/api/keykeeper/organizations/${orgId}/script-tokens`, {
    id: asMember.id,
    name: "Not theirs",
    expiresAt: inDays(30),
    authHash: asMember.authHash,
    sealedKey: encString("sealed"),
    grants: [await grantFor(api, owner, item)],
  });
  expect(memberMade.status).toBe(404);
  expect((await api.call(member, "DELETE", `/api/keykeeper/organizations/${orgId}/script-tokens/${token.id}`)).status).toBe(404);

  // A trashed item's copy isn't served.
  expect((await api.call(owner, "PUT", `/api/ciphers/${item}/delete`)).status).toBe(200);
  expect((await request.get(`/api/keykeeper/script/items/${item}`, { headers: { Authorization: token.authorization } })).status()).toBe(404);
});

test("an MSP's admins make tokens for its clients; its technicians don't, even as the client's admins", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("script-msp-admin");
  const mspId = await api.msp(admin, "Adatum IT");
  const clientId = await api.client(admin, mspId, "Acme Dental");
  const item = await api.orgItem(admin, clientId, await api.collection(admin, clientId));
  const tech = await api.account("script-tech");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);

  const made = await createToken(api, admin, clientId, [item]);
  expect(made.created.status, JSON.stringify(made.created.body)).toBe(200);
  expect((await api.call(tech, "GET", `/api/keykeeper/organizations/${clientId}/script-tokens`)).status).toBe(404);
  expect((await createToken(api, tech, clientId, [item])).created.status).toBe(404);

  // The MSP's activity log has it, and a token's first use from an address.
  await request.get(`/api/keykeeper/script/items/${item}`, { headers: { Authorization: made.authorization } });
  const events = (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`)).body.data.map(
    (e: { event: string }) => e.event,
  );
  expect(events).toContain("script_token_created");
  expect(events).toContain("script_token_new_address");
});

test("a token reads at most 60 times a minute", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("script-limit-owner");
  const orgId = await api.organization(owner, "Tailspin");
  const item = await api.orgItem(owner, orgId, await api.collection(owner, orgId));
  const token = await createToken(api, owner, orgId, [item]);
  const statuses = [];
  for (let i = 0; i < 61; i++) {
    statuses.push(
      (await request.get(`/api/keykeeper/script/items/${item}`, { headers: { Authorization: token.authorization } })).status(),
    );
  }
  expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
  expect(statuses[60]).toBe(429);
});

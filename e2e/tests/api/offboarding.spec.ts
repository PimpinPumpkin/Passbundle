// Offboarding that holds (DESIGN.md, "Offboarding"): removing someone, or a
// client removing its MSP, cuts what they could still use, and stays done.
// These began as a pre-launch security review's scripts: an MSP's script and
// provisioning tokens working after the client removed it, a technician the
// client removed coming back with the next staff change, an MSP admin the
// client revoked still running it from the console, and a removed member
// rejoining with the install command they kept (tests/mail/offboarding.spec.ts).
import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { type Cert, httpsReceiver, throwawayCert } from "./siem";
import { type Account, Api, encString, serverDatabase } from "./support";

const REVOKED = -1;
const CONFIRMED = 2;
const OWNER = 0;
const ADMIN = 1;
const USER = 2;

const cert: Cert = throwawayCert();

/** A script token's secrets, as an admin's browser makes them. */
function newScriptToken() {
  const id = randomUUID();
  const seed = randomBytes(32);
  const authSecret = Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(0), "passbundle script auth v1", 32));
  return {
    id,
    authHash: createHash("sha256").update(authSecret).digest("base64"),
    authorization: `PassBundleScript ${id}.${authSecret.toString("base64url")}`,
  };
}

async function revisionOf(api: Api, who: Account, itemId: string): Promise<string> {
  const item = await api.call(who, "GET", `/api/ciphers/${itemId}`);
  expect(item.status, JSON.stringify(item.body)).toBe(200);
  return item.body.revisionDate;
}

/** A script token for one item, made by `who`. */
async function scriptToken(api: Api, who: Account, orgId: string, itemId: string, name: string) {
  const token = newScriptToken();
  const created = await api.call(who, "POST", `/api/keykeeper/organizations/${orgId}/script-tokens`, {
    id: token.id,
    name,
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    networks: [],
    authHash: token.authHash,
    sealedKey: encString(`sealed-key-${token.id}`),
    grants: [
      {
        itemId,
        copy: encString(`copy-${itemId}`),
        revision: await revisionOf(api, who, itemId),
        sealedSpec: encString(`spec-${itemId}`),
      },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return token;
}

/** A script's read with a token, as the PowerShell module makes it. */
async function scriptRead(request: APIRequestContext, authorization: string): Promise<number> {
  return (await request.get("/api/keykeeper/script/items", { headers: { Authorization: authorization } })).status();
}

/** A provisioning token, made by `who`. */
async function provisioningToken(api: Api, who: Account, orgId: string): Promise<string> {
  const made = await api.call(who, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.body.newToken;
}

/** A directory's read of the organization's people, as Entra makes it. */
async function scimRead(request: APIRequestContext, orgId: string, token: string): Promise<number> {
  return (
    await request.get(`/scim/v2/${orgId}/Users?count=5`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/scim+json" },
    })
  ).status();
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

/** The script grants whose copies `who`'s apps are asked to refresh. */
async function staleTokens(api: Api, who: Account): Promise<string[]> {
  const stale = await api.call(who, "GET", "/api/keykeeper/script-grants/stale");
  expect(stale.status, JSON.stringify(stale.body)).toBe(200);
  return stale.body.data.map((g: { tokenId: string }) => g.tokenId);
}

async function memberId(api: Api, owner: Account, orgId: string, who: Account): Promise<string | undefined> {
  return (await api.members(owner, orgId)).find((m) => m.email === who.email)?.id;
}

async function membership(api: Api, owner: Account, orgId: string, who: Account) {
  return (await api.members(owner, orgId)).find((m) => m.email === who.email);
}

/** An MSP seal stand-in: 32 bytes, base64, as an admin's browser sends one. */
const seal = () => randomBytes(32).toString("base64");

async function overview(api: Api, who: Account, mspId: string) {
  const seen = await api.call(who, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  return seen.body;
}

/** An MSP with a Business client whose own owner the MSP's admin added. */
async function mspWithClient(api: Api, name: string) {
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, `${name} IT`);
  const orgId = await api.client(admin, mspId, name, "business");
  const owner = await api.account("client-owner");
  await api.addMember(admin, orgId, owner, "owner");
  return { admin, mspId, orgId, owner };
}

test("removing an MSP revokes the script and provisioning tokens and event destinations its people made there, and says what went", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const receiver = await httpsReceiver(cert);
  try {
    const { admin, mspId, orgId, owner } = await mspWithClient(api, "Acme Dental");
    const tech = await api.account("tech");
    await api.addStaff(admin, mspId, tech, "technician");
    await api.confirmPending(admin, mspId);
    const sealed = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/seals`, {
      staff: [{ organizationId: orgId, email: tech.email, seal: seal() }],
    });
    expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);

    const collection = await api.collection(admin, orgId);
    const item = await api.orgItem(admin, orgId, collection);
    const mspToken = await scriptToken(api, admin, orgId, item, "RMM deploy");
    const ownToken = await scriptToken(api, owner, orgId, item, "Backups");
    expect(await scriptRead(request, mspToken.authorization)).toBe(200);
    const scimToken = await provisioningToken(api, admin, orgId);
    expect(await scimRead(request, orgId, scimToken)).toBe(200);
    const destination = (who: Account, name: string) =>
      api.call(who, "POST", `/api/keykeeper/organizations/${orgId}/event-streaming`, {
        name,
        kind: "webhook",
        webhook: { url: receiver.url(`/${name}`), caCertificate: cert.cert },
      });
    expect((await destination(admin, "MSP SIEM")).status).toBe(200);
    expect((await destination(owner, "Own SIEM")).status).toBe(200);

    // The client's own owner removes the MSP, and hears what went with it.
    const removed = await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/msp`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({
      msp: { id: mspId, name: "Acme Dental IT" },
      peopleRemoved: 2,
      scriptTokensRevoked: [{ id: mspToken.id, name: "RMM deploy", createdBy: admin.email }],
      provisioningTokenRevoked: { createdBy: admin.email },
      eventDestinationsDeleted: [{ name: "MSP SIEM" }],
      installCommandRemoved: true,
      singleSignOn: null,
    });
    expect(removed.body.staffSealsDeleted).toBeGreaterThanOrEqual(1);

    // What the MSP's people made stops; the client's own keeps working.
    expect(await scriptRead(request, mspToken.authorization)).toBe(401);
    expect(await scriptRead(request, ownToken.authorization)).toBe(200);
    expect(await scimRead(request, orgId, scimToken)).toBe(401);
    expect((await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/provisioning`)).body.token).toBeNull();
    const destinations = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/event-streaming`);
    expect(destinations.body.data.map((d: { name: string }) => d.name)).toEqual(["Own SIEM"]);
    const db = await serverDatabase();
    if (db) {
      expect(db("SELECT COUNT(*) FROM join_seals WHERE org_uuid = ? AND kind = 'staff'", orgId)).toBe(0);
    }

    // The owner changes the password: their apps are asked to refresh only
    // their own token's copy, never the MSP's, and can't refresh the MSP's.
    await editItem(api, owner, item);
    const stale = await staleTokens(api, owner);
    expect(stale).toContain(ownToken.id);
    expect(stale).not.toContain(mspToken.id);
    const refreshed = await api.call(
      owner,
      "PUT",
      `/api/keykeeper/organizations/${orgId}/script-tokens/${mspToken.id}/grants/${item}`,
      { copy: encString("rotated"), revision: await revisionOf(api, owner, item), sealedSpec: encString("spec") },
    );
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(400);
    expect(await scriptRead(request, mspToken.authorization)).toBe(401);
  } finally {
    await receiver.close();
  }
});

test("removing an MSP names the single sign-on settings for the owner to review, and who last changed them", async ({
  request,
}) => {
  const api = new Api(request);
  const { admin, orgId, owner } = await mspWithClient(api, "Bayside Law");
  const identifier = `offboard-${randomBytes(3).toString("hex")}`;
  const saved = await api.call(admin, "PUT", `/api/keykeeper/organizations/${orgId}/sso`, {
    enabled: false,
    identifier,
    tenantId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: null,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const removed = await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/msp`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect(removed.body.singleSignOn).toMatchObject({
    enabled: false,
    updatedBy: admin.email,
    updatedByProvider: true,
  });
});

test("a script or provisioning token works only while whoever made it manages the organization, checked on every use", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const owner = await api.account("owner");
  const maker = await api.account("maker");
  const orgId = await api.organization(owner, "Contoso");
  const makerId = await api.addMember(owner, orgId, maker, "admin");
  const collection = await api.collection(owner, orgId);
  const item = await api.orgItem(owner, orgId, collection);
  const token = await scriptToken(api, maker, orgId, item, "Join domain");
  const scimToken = await provisioningToken(api, maker, orgId);
  expect(await scriptRead(request, token.authorization)).toBe(200);
  expect(await scimRead(request, orgId, scimToken)).toBe(200);

  const setRole = async (type: number) => {
    const edited = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${makerId}`, {
      type,
      collections: [],
      groups: [],
      permissions: {},
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  };
  const shownStopped = async () => {
    const tokens = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/script-tokens`);
    const provisioning = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/provisioning`);
    return [
      tokens.body.data.find((t: { id: string }) => t.id === token.id).creatorLostAccess,
      provisioning.body.token.creatorLostAccess,
    ];
  };
  expect(await shownStopped()).toEqual([false, false]);

  // Made a regular member, their tokens stop, the owner's pages say so, and
  // the owner's apps aren't asked to refresh the copy.
  await setRole(USER);
  expect(await scriptRead(request, token.authorization)).toBe(401);
  expect(await scimRead(request, orgId, scimToken)).toBe(401);
  expect(await shownStopped()).toEqual([true, true]);
  await editItem(api, owner, item);
  expect(await staleTokens(api, owner)).not.toContain(token.id);
  const reads = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/script-tokens/${token.id}/reads`);
  expect(reads.body.data[0]).toMatchObject({ allowed: false, reason: "its maker no longer manages the organization" });

  // An admin again, they work again: it's checked on every use, not once.
  await setRole(ADMIN);
  expect(await scimRead(request, orgId, scimToken)).toBe(200);
  expect(await staleTokens(api, owner)).toContain(token.id);

  // Removed, revoked, or disabled, they stop.
  const revoked = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${makerId}/revoke`);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  expect(await scimRead(request, orgId, scimToken)).toBe(401);
  expect((await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${makerId}/restore`)).status).toBe(200);
  expect(await scimRead(request, orgId, scimToken)).toBe(200);
  expect((await api.call(owner, "DELETE", `/api/organizations/${orgId}/users/${makerId}`)).status).toBe(200);
  expect(await scriptRead(request, token.authorization)).toBe(401);
  expect(await scimRead(request, orgId, scimToken)).toBe(401);
});

test("someone the client removes from its MSP's people stays out: staff changes don't add them back, their seal is gone, and only the client invites them again", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const { admin, mspId, orgId, owner } = await mspWithClient(api, "Cedar Clinic");
  const tess = await api.account("tess");
  await api.addStaff(admin, mspId, tess, "technician");
  await api.confirmPending(admin, mspId);
  const sealed = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/seals`, {
    staff: [{ organizationId: orgId, email: tess.email, seal: seal() }],
  });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);

  const tessId = (await memberId(api, owner, orgId, tess))!;
  const removed = await api.call(owner, "DELETE", `/api/organizations/${orgId}/users/${tessId}`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect(await membership(api, owner, orgId, tess)).toBeUndefined();
  const db = await serverDatabase();
  if (db) {
    expect(db("SELECT COUNT(*) FROM join_seals WHERE org_uuid = ? AND kind = 'staff'", orgId)).toBe(0);
  }

  // The MSP's console says so, and its changes don't bring them back.
  let seen = await overview(api, admin, mspId);
  expect(seen.clients[0].removedByClient).toEqual([
    expect.objectContaining({ userId: tess.userId, email: tess.email, revoked: false }),
  ]);
  expect(seen.staff.find((s: { email: string }) => s.email === tess.email).removedByClient).toEqual([
    expect.objectContaining({ organizationId: orgId, revoked: false }),
  ]);
  const access = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/staff/${tess.userId}/access`, {
    allClients: true,
    clients: [],
    custom: null,
    installCommands: true,
  });
  expect(access.status, JSON.stringify(access.body)).toBe(200);
  for (const role of ["admin", "technician"]) {
    const changed = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/staff/${tess.userId}`, { role });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  }
  expect(await membership(api, owner, orgId, tess)).toBeUndefined();
  const activity = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  expect(activity.body.data).toContainEqual(
    expect.objectContaining({ event: "client_removed_staff", targetEmail: tess.email, actorEmail: owner.email }),
  );

  // Nor does the MSP's admin inviting them from the client's Members page;
  // the client's own owner can.
  const invite = (who: Account) =>
    api.call(who, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [tess.email],
      type: USER,
      collections: [],
      groups: [],
      permissions: {},
    });
  const byMsp = await invite(admin);
  expect(byMsp.status).toBe(400);
  expect(byMsp.body.message).toMatch(/organization's own people removed .*, so only they can invite them again/);
  expect(await membership(api, owner, orgId, tess)).toBeUndefined();
  expect((await invite(owner)).status).toBe(200);
  expect(await membership(api, owner, orgId, tess)).toBeTruthy();
  seen = await overview(api, admin, mspId);
  expect(seen.clients[0].removedByClient).toEqual([]);
  // Theirs now, not the MSP's.
  const clientView = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/msp`);
  expect(clientView.body.staff.map((s: { email: string }) => s.email)).not.toContain(tess.email);
});

test("someone the client revokes from its MSP's people stays revoked until the client restores them, and the client can't change their role instead", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const { admin, mspId, orgId, owner } = await mspWithClient(api, "Delta Dental");
  const second = await api.account("second-admin");
  await api.addStaff(admin, mspId, second, "admin");
  const tom = await api.account("tom");
  await api.addStaff(admin, mspId, tom, "technician");
  await api.confirmPending(admin, mspId);
  const tomId = (await memberId(api, owner, orgId, tom))!;

  // The client changes the role of one of the MSP's people: refused, since
  // the MSP's console would set it back.
  const demoted = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${tomId}`, {
    type: USER,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(demoted.status).toBe(400);
  expect(demoted.body.message).toMatch(/Remove MSP/);
  expect((await membership(api, owner, orgId, tom))!.type).toBe(ADMIN);

  const revoked = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${tomId}/revoke`);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

  // The MSP's changes leave them as they are, and its admins can't restore them.
  const access = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/staff/${tom.userId}/access`, {
    allClients: true,
    clients: [],
    custom: { permissions: { manageUsers: true }, vaultItems: false },
    installCommands: true,
  });
  expect(access.status, JSON.stringify(access.body)).toBe(200);
  expect(await membership(api, owner, orgId, tom)).toMatchObject({ status: REVOKED, type: ADMIN });
  for (const msp of [admin, second]) {
    const restored = await api.call(msp, "PUT", `/api/organizations/${orgId}/users/${tomId}/restore`);
    expect(restored.status).toBe(400);
    expect(restored.body.message).toMatch(/only they can restore them/);
  }
  const seen = await overview(api, admin, mspId);
  expect(seen.clients[0].removedByClient).toEqual([expect.objectContaining({ email: tom.email, revoked: true })]);
  const activity = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  expect(activity.body.data).toContainEqual(
    expect.objectContaining({ event: "client_revoked_staff", targetEmail: tom.email }),
  );

  // The client restores them: they're back, and the MSP's console manages them again.
  const restored = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${tomId}/restore`);
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  expect((await overview(api, admin, mspId)).clients[0].removedByClient).toEqual([]);
  const again = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/staff/${tom.userId}/access`, {
    allClients: true,
    clients: [],
    custom: null,
    installCommands: true,
  });
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(await membership(api, owner, orgId, tom)).toMatchObject({ status: CONFIRMED, type: ADMIN });
});

test("an MSP admin the client revoked can't act on it from the MSP console, while the MSP's other admins still can", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const { admin: mia, mspId, orgId, owner } = await mspWithClient(api, "Elm Street Vets");
  const bob = await api.account("bob");
  await api.addStaff(mia, mspId, bob, "admin");
  const tess = await api.account("tess");
  await api.addStaff(mia, mspId, tess, "technician");
  await api.confirmPending(mia, mspId);
  const miaId = (await memberId(api, owner, orgId, mia))!;
  const enrollment = `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`;
  const tokenBefore = (await api.call(bob, "GET", enrollment)).body.token;

  const revoked = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${miaId}/revoke`);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

  const refusedForMia = async (method: "GET" | "POST" | "PUT", path: string, data?: unknown) => {
    const result = await api.call(mia, method, path, data);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(400);
    expect(result.body.message).toMatch(/You don't have access to Elm Street Vets yourself/);
  };
  await refusedForMia("GET", enrollment);
  await refusedForMia("POST", enrollment);
  await refusedForMia("PUT", `${enrollment}/domains`, { domains: ["elm.example.test"] });
  await refusedForMia("PUT", `/api/keykeeper/msp/${mspId}/seals`, {
    staff: [{ organizationId: orgId, email: bob.email, seal: seal() }],
  });
  await refusedForMia("PUT", `/api/keykeeper/msp/${mspId}/seals`, {
    joining: [{ organizationId: orgId, seal: seal() }],
  });
  await refusedForMia("PUT", `/api/keykeeper/msp/${mspId}/clients/${orgId}/templates-collection`, {
    name: encString("Templates"),
  });
  expect((await api.call(bob, "GET", enrollment)).body.token).toBe(tokenBefore);
  const templates = await api.call(bob, "GET", `/api/keykeeper/msp/${mspId}/templates`);
  expect(templates.body.collections[orgId]).toBeNull();

  // Default policies skip the client and say so; its policy stays as it was.
  const generator = `/api/organizations/${orgId}/policies/2`;
  const before = (await api.call(owner, "GET", generator)).body.enabled;
  const changed = await api.call(mia, "PUT", `/api/keykeeper/msp/${mspId}/policies/2`, {
    enabled: !before,
    data: null,
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body.refused).toEqual([
    expect.objectContaining({ id: orgId, error: expect.stringMatching(/don't have access/) }),
  ]);
  expect((await api.call(owner, "GET", generator)).body.enabled).toBe(before);
  const sendOff = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/6`, {
    policy: { enabled: true, data: null },
  });
  expect(sendOff.status).toBe(200);
  const applied = await api.call(mia, "POST", `/api/keykeeper/msp/${mspId}/policies/6/apply`, { clients: [orgId] });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(applied.body.refused).toEqual([expect.objectContaining({ id: orgId })]);
  expect((await api.call(owner, "GET", `/api/organizations/${orgId}/policies/6`)).body.enabled).toBe(true);

  // Changing the MSP's joining default leaves the client's as it was, as its own.
  const joiningBefore = (await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/joining`)).body;
  const joining = await api.call(mia, "PUT", `/api/keykeeper/msp/${mspId}/joining`, {
    autoConfirm: !joiningBefore.autoConfirm,
    inviteHours: 48,
    seals: {},
  });
  expect(joining.status, JSON.stringify(joining.body)).toBe(200);
  const joiningAfter = (await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/joining`)).body;
  expect(joiningAfter).toMatchObject({
    source: "own",
    autoConfirm: joiningBefore.autoConfirm,
    inviteHours: joiningBefore.inviteHours,
    seal: joiningBefore.seal,
  });

  // Staff changes don't reach the client either: a technician made an MSP
  // admin isn't made an owner there, and a new MSP admin isn't added.
  expect((await api.call(mia, "PUT", `/api/keykeeper/msp/${mspId}/staff/${tess.userId}`, { role: "admin" })).status).toBe(
    200,
  );
  expect(await membership(api, owner, orgId, tess)).toMatchObject({ type: ADMIN, status: CONFIRMED });
  const eve = await api.account("eve");
  await api.addStaff(mia, mspId, eve, "admin");
  expect(await membership(api, owner, orgId, eve)).toBeUndefined();
  const pending = await api.call(mia, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  expect(pending.body.data).toEqual([]);
  // Nor can they make a provisioning token there.
  expect((await api.call(mia, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`)).status).toBe(404);

  // The MSP's other admin, whom the client didn't revoke, still can.
  expect((await api.call(bob, "GET", enrollment)).status).toBe(200);
  const replaced = await api.call(bob, "POST", enrollment);
  expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
  expect(replaced.body.token).not.toBe(tokenBefore);
  expect(await api.templatesCollection(bob, mspId, orgId)).toBeTruthy();
});

test("the MSP's people can't remove, revoke, demote, or delete the client's own owners or the client, and a client run only by its MSP stays theirs to run", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const { admin, mspId, orgId, owner } = await mspWithClient(api, "Fir Grove Law");
  const ownerId = (await memberId(api, owner, orgId, owner))!;
  const refused = async (method: "PUT" | "DELETE", path: string, data?: unknown) => {
    const result = await api.call(admin, method, path, data);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(400);
    expect(result.body.message).toMatch(/Only the organization's own owners can/);
  };
  await refused("DELETE", `/api/organizations/${orgId}/users/${ownerId}`);
  await refused("PUT", `/api/organizations/${orgId}/users/${ownerId}/revoke`);
  await refused("PUT", `/api/organizations/${orgId}/users/${ownerId}`, {
    type: ADMIN,
    collections: [],
    groups: [],
    permissions: {},
  });
  await refused("DELETE", `/api/organizations/${orgId}`, { masterPasswordHash: admin.password });
  const bulk = await api.call(admin, "DELETE", `/api/organizations/${orgId}/users`, { ids: [ownerId] });
  expect(bulk.body.data[0].error).not.toBe("");
  expect(await membership(api, owner, orgId, owner)).toMatchObject({ type: OWNER, status: CONFIRMED });

  // The client's own owner can still do all of it, starting with the MSP's admin.
  const adminId = (await memberId(api, owner, orgId, admin))!;
  expect((await api.call(owner, "DELETE", `/api/organizations/${orgId}/users/${adminId}`)).status).toBe(200);

  // A client with no owners of its own is the MSP's to run, deleting included.
  const solo = await api.client(admin, mspId, "Gale Accounting");
  const invited = await api.account("future-owner");
  const invite = await api.call(admin, "POST", `/api/organizations/${solo}/users/invite`, {
    emails: [invited.email],
    type: OWNER,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(200);
  const deleted = await api.call(admin, "DELETE", `/api/organizations/${solo}`, { masterPasswordHash: admin.password });
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
});

test("a client's Templates collection is one the server makes, new and empty, logged in the client's event log, and made again after the client deletes it", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const { admin, mspId, orgId, owner } = await mspWithClient(api, "Harbor Dental");
  const member = await api.account("member");
  const memberIdInOrg = await api.addMember(admin, orgId, member, "user");
  const path = `/api/keykeeper/msp/${mspId}/clients/${orgId}/templates-collection`;
  const recorded = async () =>
    (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/templates`)).body.collections[orgId];

  // An existing collection can't be pointed at; a name must be encrypted.
  const existing = await api.collection(admin, orgId);
  expect((await api.call(admin, "PUT", path, { collectionId: existing })).status).not.toBe(200);
  const plain = await api.call(admin, "PUT", path, { name: "Templates" });
  expect(plain.status).toBe(400);
  expect(plain.body.message).toMatch(/encrypted/);
  expect(await recorded()).toBeNull();

  const made = await api.call(admin, "PUT", path, { name: encString("Templates") });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const collection = made.body.collectionId as string;
  expect(collection).not.toBe(existing);
  expect(await recorded()).toBe(collection);
  const details = await api.call(admin, "GET", `/api/organizations/${orgId}/collections/${collection}/details`);
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  expect(details.body.groups).toEqual([]);
  const users = await api.call(admin, "GET", `/api/organizations/${orgId}/collections/${collection}/users`);
  expect(users.body).toEqual([expect.objectContaining({ id: memberIdInOrg, readOnly: true })]);
  const items = await api.call(admin, "GET", `/api/ciphers/organization-details?organizationId=${orgId}`);
  expect(
    items.body.data.filter((c: { collectionIds: string[] }) => c.collectionIds.includes(collection)),
  ).toEqual([]);
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const end = new Date(Date.now() + 3_600_000).toISOString();
  const events = await api.call(owner, "GET", `/api/organizations/${orgId}/events?start=${start}&end=${end}`);
  expect(events.body.data).toContainEqual(
    expect.objectContaining({ type: 1300, collectionId: collection, actingUserId: admin.userId }),
  );
  const again = await api.call(admin, "PUT", path, { name: encString("Templates") });
  expect(again.status).toBe(400);
  expect(again.body.message).toMatch(/already has its Templates collection/);

  // The client deletes it: confirming people still works, the MSP hears of it,
  // and the next template sent there gets a new one.
  const deleted = await api.call(owner, "DELETE", `/api/organizations/${orgId}/collections/${collection}`);
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  const later = await api.account("later");
  await api.addMember(owner, orgId, later, "user");
  expect(await recorded()).toBeNull();
  const activity = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  expect(activity.body.data).toContainEqual(expect.objectContaining({ event: "templates_collection_gone" }));
  const remade = await api.call(admin, "PUT", path, { name: encString("Templates") });
  expect(remade.status, JSON.stringify(remade.body)).toBe(200);
  expect(remade.body.collectionId).not.toBe(collection);
});

test("only a secure note in the client's Templates collection, and not another template's copy, is recorded as a template's copy", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const { admin, mspId, orgId } = await mspWithClient(api, "Iris Insurance");
  const templatesFolder = await api.templatesCollection(admin, mspId, orgId);
  const other = await api.collection(admin, orgId);
  const newTemplate = async () => {
    const id = randomUUID();
    const added = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/templates/${id}`, {
      sourceCipherId: await api.personalItem(admin),
      allClients: true,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    return id;
  };
  const record = (templateId: string, cipherId: string) =>
    api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/templates/${templateId}/copies`, {
      copies: [{ organizationId: orgId, cipherId, sourceRevision: "r1" }],
    });
  const first = await newTemplate();
  const second = await newTemplate();

  const elsewhere = await api.orgItem(admin, orgId, other);
  const notInTemplates = await record(first, elsewhere);
  expect(notInTemplates.status).toBe(400);
  expect(notInTemplates.body.message).toMatch(/isn't a template copy/);

  const login = await api.call(admin, "POST", "/api/ciphers/create", {
    cipher: {
      type: 1,
      name: encString("A login"),
      notes: null,
      login: { username: null, password: null, uris: [] },
      organizationId: orgId,
      encryptedFor: admin.userId,
      favorite: false,
      reprompt: 0,
      fields: [],
    },
    collectionIds: [templatesFolder],
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  expect((await record(first, login.body.id)).status).toBe(400);

  const copy = await api.orgItem(admin, orgId, templatesFolder);
  expect((await record(first, copy)).status).toBe(200);
  const taken = await record(second, copy);
  expect(taken.status).toBe(400);
  expect(taken.body.message).toMatch(/another template's copy/);
});

test("after someone is removed, the install command offers to be replaced, until it is", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Juniper Bakery");
  const command = `/api/keykeeper/organizations/${orgId}/enrollment`;
  expect((await api.call(owner, "POST", command)).status).toBe(200);
  expect((await api.call(owner, "GET", command)).body.removedSinceToken).toBe(0);
  const member = await api.account("member");
  const memberIdInOrg = await api.addMember(owner, orgId, member, "user");
  expect((await api.call(owner, "DELETE", `/api/organizations/${orgId}/users/${memberIdInOrg}`)).status).toBe(200);
  expect((await api.call(owner, "GET", command)).body.removedSinceToken).toBe(1);
  expect((await api.call(owner, "POST", command)).body.removedSinceToken).toBe(0);

  // An MSP's client: the MSP's console offers it, and the client's owners
  // see whom to ask.
  const { admin, mspId, orgId: client, owner: clientOwner } = await mspWithClient(api, "Kestrel Dental");
  const leaver = await api.account("leaver");
  const leaverId = await api.addMember(admin, client, leaver, "user");
  expect((await api.call(clientOwner, "DELETE", `/api/organizations/${client}/users/${leaverId}`)).status).toBe(200);
  expect((await overview(api, admin, mspId)).clients[0].removedSinceToken).toBe(1);
  const mspCommand = `/api/keykeeper/msp/${mspId}/clients/${client}/enrollment`;
  expect((await api.call(admin, "GET", mspCommand)).body.removedSinceToken).toBe(1);
  expect((await api.call(clientOwner, "GET", `/api/keykeeper/organizations/${client}/enrollment`)).body).toEqual({
    provider: "Kestrel Dental IT",
    removedSinceToken: 1,
  });
  expect((await api.call(admin, "POST", mspCommand)).body.removedSinceToken).toBe(0);
});

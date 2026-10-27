// The server's side of "Joins a hacked server can't forge" (DESIGN.md): it
// keeps the seals, proofs, and encrypted join secrets apps make, lets only the
// right people leave them, checks only that each looks like one, and hands
// them to the apps that confirm, with each person waiting. The apps' checks
// are unit-tested against docs/vectors/joins-v1.json and joins-v2.json.
// Invitation and staff seals are version 2, which end and carry a nonce; the
// server takes only those for them, and deletes them once the person they
// vouch for is confirmed.
import { expect, test } from "@playwright/test";

import { type Account, Api, encString, expiringSeal } from "./support";

/** A version 1 seal-shaped value (joining seals, client seals, proofs): the server can't tell a real one from this. */
const seal = (n: number) => Buffer.alloc(32, n).toString("base64");
const secret = encString("join-secret");

async function setUp(api: Api) {
  const admin = await api.account("seal-admin");
  const mspId = await api.msp(admin, "Seal IT");
  const orgId = await api.client(admin, mspId, "Seal Dental");
  return { admin, mspId, orgId };
}

const pendingFor = async (api: Api, admin: Account, mspId: string, email: string) => {
  const pending = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  expect(pending.status, JSON.stringify(pending.body)).toBe(200);
  return pending.body.data.find((p: { email: string }) => p.email === email);
};

test("only an MSP's admins leave seals for its clients, and only for its staff", async ({
  request,
}) => {
  const api = new Api(request);
  const { admin, mspId, orgId } = await setUp(api);
  const tech = await api.account("seal-tech");
  await api.addStaff(admin, mspId, tech, "technician");
  const url = `/api/keykeeper/msp/${mspId}/seals`;
  const staff = { staff: [{ organizationId: orgId, email: tech.email, seal: expiringSeal(1) }] };

  expect((await api.call(admin, "PUT", url, staff)).status).toBe(200);
  // Staff who aren't admins, people outside the MSP, and no one at all can't.
  const stranger = await api.account("seal-stranger");
  for (const caller of [tech, stranger, null]) {
    expect((await api.call(caller, "PUT", url, staff)).status).not.toBe(200);
  }
  // Not another MSP's client, not someone who isn't staff, nothing malformed.
  const other = await api.account("seal-other-admin");
  const otherMsp = await api.msp(other, "Other IT");
  const otherClient = await api.client(other, otherMsp, "Other Dental");
  for (const body of [
    { staff: [{ organizationId: otherClient, email: tech.email, seal: expiringSeal(1) }] },
    { staff: [{ organizationId: orgId, email: stranger.email, seal: expiringSeal(1) }] },
    { staff: [{ organizationId: orgId, email: tech.email, seal: "not a seal" }] },
    // A version 1 staff seal never ends; one that has ended is no use.
    { staff: [{ organizationId: orgId, email: tech.email, seal: seal(1) }] },
    { staff: [{ organizationId: orgId, email: tech.email, seal: expiringSeal(1, -60) }] },
    { joining: [{ organizationId: orgId, seal: seal(2).slice(0, 43) }] },
    { secrets: [{ organizationId: orgId, secret: "plaintext" }] },
    { clients: [{ organizationId: otherClient, seal: seal(3) }] },
    { clients: [{ organizationId: orgId, seal: expiringSeal(3) }] },
  ]) {
    const refused = await api.call(admin, "PUT", url, body);
    expect(refused.status, JSON.stringify(body)).not.toBe(200);
  }
});

test("an MSP admin's browser leaves a client seal for its own clients, and every staff member's apps get it", async ({
  request,
}) => {
  const api = new Api(request);
  const { admin, mspId, orgId } = await setUp(api);
  const tech = await api.account("client-seal-tech");
  await api.addStaff(admin, mspId, tech, "technician");
  const clientSeal = (caller: Account) =>
    api
      .call(caller, "GET", `/api/keykeeper/msp/${mspId}`)
      .then((r) => r.body.clients.find((c: { id: string }) => c.id === orgId).seal);
  expect(await clientSeal(admin)).toBeNull();

  const url = `/api/keykeeper/msp/${mspId}/seals`;
  const body = { clients: [{ organizationId: orgId, seal: seal(15) }] };
  expect((await api.call(tech, "PUT", url, body)).status).not.toBe(200);
  expect((await api.call(admin, "PUT", url, body)).status).toBe(200);
  expect(await clientSeal(admin)).toBe(seal(15));
  expect(await clientSeal(tech)).toBe(seal(15));
});

test("each person waiting comes with what vouches for them, for the apps to check", async ({
  request,
}) => {
  const api = new Api(request);
  const { admin, mspId, orgId } = await setUp(api);

  // A sealed joining setting and an install command with a join secret.
  const sealed = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/seals`, {
    joining: [{ organizationId: orgId, seal: seal(3) }],
    secrets: [{ organizationId: orgId, secret }],
  });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  const enrollment = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
  );
  expect(enrollment.body.secret).toBe(secret);

  // A technician with a staff seal.
  const tech = await api.account("vouch-tech");
  await api.addStaff(admin, mspId, tech, "technician");
  const staffSeal = expiringSeal(4);
  await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/seals`, {
    staff: [{ organizationId: orgId, email: tech.email, seal: staffSeal }],
  });
  // Someone invited with a seal (this server sends no email, so they're in at once).
  const invited = await api.account("vouch-invited");
  const inviteSeal = expiringSeal(5);
  const invite = await api.call(admin, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [invited.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
    keykeeperSeals: { [invited.email.toUpperCase()]: inviteSeal },
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(200);
  // A version 1 invitation seal, which never ends, isn't taken.
  const v1 = await api.account("vouch-v1");
  const refusedV1 = await api.call(admin, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [v1.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
    keykeeperSeals: { [v1.email]: seal(5) },
  });
  expect(refusedV1.status).toBe(400);
  // Someone who joins with the install command, with a proof.
  const joiner = await api.account("vouch-joiner");
  const joined = await api.call(joiner, "POST", "/api/keykeeper/enrollment/join", {
    token: enrollment.body.token,
    proof: seal(6),
  });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  // A malformed proof is refused.
  const late = await api.account("vouch-late");
  expect(
    (
      await api.call(late, "POST", "/api/keykeeper/enrollment/join", {
        token: enrollment.body.token,
        proof: "not a proof",
      })
    ).status,
  ).toBe(400);

  const joining = { autoConfirm: true, domains: [], seal: seal(3) };
  expect(await pendingFor(api, admin, mspId, tech.email)).toMatchObject({
    userId: tech.userId,
    fromMsp: true,
    joining,
    staffSeal,
    inviteSeal: null,
    joinProof: null,
    enrollmentSecret: null,
  });
  expect(await pendingFor(api, admin, mspId, invited.email)).toMatchObject({
    fromMsp: false,
    joining,
    inviteSeal,
    staffSeal: null,
  });
  expect(await pendingFor(api, admin, mspId, joiner.email)).toMatchObject({
    joining,
    inviteSeal: null,
    joinProof: seal(6),
    enrollmentSecret: secret,
  });
  // The organizations list says the same.
  const everywhere = await api.call(admin, "GET", "/api/keykeeper/organizations/pending");
  expect(
    everywhere.body.data.find((p: { email: string }) => p.email === joiner.email),
  ).toMatchObject({ joinProof: seal(6), enrollmentSecret: secret, joining });
});

test("a change made without a seal never keeps an old one's word", async ({ request }) => {
  const api = new Api(request);
  const { admin, mspId, orgId } = await setUp(api);
  const joiningUrl = `/api/keykeeper/organizations/${orgId}/joining`;
  const current = async () => (await api.call(admin, "GET", joiningUrl)).body;

  // The client's own setting, sealed, then changed without a seal.
  await api.call(admin, "PUT", joiningUrl, { autoConfirm: true, inviteHours: 24, seal: seal(7) });
  expect((await current()).seal).toBe(seal(7));
  await api.call(admin, "PUT", joiningUrl, { autoConfirm: true, inviteHours: 24 });
  expect((await current()).seal).toBeNull();

  // Back on the MSP's default, sealed; then the default changes with a seal for it.
  await api.call(admin, "DELETE", joiningUrl, { seal: seal(8) });
  expect((await current()).seal).toBe(seal(8));
  const following = (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/joining`)).body
    .following;
  expect(following).toEqual([{ organizationId: orgId, domains: [], seal: seal(8) }]);
  await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/joining`, {
    autoConfirm: false,
    inviteHours: 24,
    seals: { [orgId]: seal(9) },
  });
  expect((await current()).seal).toBe(seal(9));
  // Changed again without one: the client has none.
  await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/joining`, {
    autoConfirm: true,
    inviteHours: 24,
  });
  expect((await current()).seal).toBeNull();

  // An invitation sent again without a seal drops the earlier one.
  const person = await api.account("reinvited");
  const invite = (seals?: Record<string, string>) =>
    api.call(admin, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [person.email],
      type: 2,
      collections: [],
      groups: [],
      permissions: {},
      keykeeperSeals: seals,
    });
  const personSeal = expiringSeal(10);
  expect((await invite({ [person.email]: personSeal })).status).toBe(200);
  expect((await pendingFor(api, admin, mspId, person.email)).inviteSeal).toBe(personSeal);
  const member = (await api.members(admin, orgId)).find((m) => m.email === person.email)!;
  expect(
    (await api.call(admin, "DELETE", `/api/organizations/${orgId}/users/${member.id}`)).status,
  ).toBe(200);
  expect((await invite()).status).toBe(200);
  expect((await pendingFor(api, admin, mspId, person.email)).inviteSeal).toBeNull();

  // A staff member who leaves takes their seals with them.
  const tech = await api.account("leaving-tech");
  await api.addStaff(admin, mspId, tech, "technician");
  const techSeal = expiringSeal(11);
  await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/seals`, {
    staff: [{ organizationId: orgId, email: tech.email, seal: techSeal }],
  });
  expect((await pendingFor(api, admin, mspId, tech.email)).staffSeal).toBe(techSeal);
  expect(
    (await api.call(admin, "DELETE", `/api/keykeeper/msp/${mspId}/staff/${tech.userId}`)).status,
  ).toBe(200);
  await api.addStaff(admin, mspId, tech, "technician");
  expect((await pendingFor(api, admin, mspId, tech.email)).staffSeal).toBeNull();
});

test("the seals that vouched for someone are used up once they're confirmed", async ({ request }) => {
  const api = new Api(request);
  const { admin, mspId, orgId } = await setUp(api);
  const person = await api.account("used-up");
  const personSeal = expiringSeal(20);
  const invited = await api.call(admin, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [person.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
    keykeeperSeals: { [person.email]: personSeal },
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  expect((await pendingFor(api, admin, mspId, person.email)).inviteSeal).toBe(personSeal);

  // Confirmed, then removed.
  const member = (await api.members(admin, orgId)).find((m) => m.email === person.email)!;
  const confirmed = await api.call(
    admin,
    "POST",
    `/api/organizations/${orgId}/users/${member.id}/confirm`,
    { key: encString("org-key-for-used-up") },
  );
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  expect(
    (await api.call(admin, "DELETE", `/api/organizations/${orgId}/users/${member.id}`)).status,
  ).toBe(200);

  // Back through the install command, which leaves seals as they are: the
  // invitation's seal was used, so nothing vouches for them now.
  const enrollment = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
  );
  const joined = await api.call(person, "POST", "/api/keykeeper/enrollment/join", {
    token: enrollment.body.token,
  });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  expect(await pendingFor(api, admin, mspId, person.email)).toMatchObject({ inviteSeal: null });
});

test("a company's own owners and admins seal their organization; an MSP's client is its MSP's to seal", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("own-sealer");
  const created = await api.call(owner, "POST", "/api/keykeeper/organizations", {
    name: "Sealed Co",
    preset: "business",
    billingEmail: owner.email,
    collectionName: encString("Everyone"),
    adminsCollectionName: encString("Admins"),
    key: encString("org-key"),
    keys: { publicKey: Buffer.alloc(32, 1).toString("base64"), encryptedPrivateKey: encString("private") },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const orgId = created.body.id;
  const url = `/api/keykeeper/organizations/${orgId}/seals`;
  expect((await api.call(owner, "PUT", url, { joining: seal(12), secret })).status).toBe(200);
  expect(
    (await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/enrollment`)).body.secret,
  ).toBe(secret);
  expect((await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/joining`)).body.seal).toBe(
    seal(12),
  );

  // The browser derives the fingerprint from the organization's private key,
  // encrypted with the organization key owners and admins already hold.
  const privateKey = `/api/keykeeper/organizations/${orgId}/private-key`;
  expect((await api.call(owner, "GET", privateKey)).body.encryptedPrivateKey).toBe(
    encString("private"),
  );

  const member = await api.account("own-member");
  await api.addMember(owner, orgId, member, "user");
  expect((await api.call(member, "PUT", url, { joining: seal(13) })).status).not.toBe(200);
  // Anyone else: "not found", never 403, which signs the web vault out.
  expect((await api.call(member, "GET", privateKey)).status).toBe(404);
  expect((await api.call(null, "PUT", url, { joining: seal(13) })).status).not.toBe(200);

  const { admin, orgId: client } = await setUp(api);
  const refused = await api.call(admin, "PUT", `/api/keykeeper/organizations/${client}/seals`, {
    joining: seal(14),
  });
  expect(refused.status).toBe(403);
});

// Everyone who joins a Business organization as a member gets its Everyone
// collection (DESIGN.md, "Defaults (Business preset)"): someone invited by
// email gets it when an owner's or admin's app confirms them, the moment they
// get the organization's key, as people who join with the install command get
// it when they join. Can edit, beside whatever their invitation named. Never
// an MSP's staff, nor anyone in an organization without Everyone, or that
// deleted it. And the members list says whom provisioning manages
// (`keykeeperProvisioned`), for the admin console's "From Microsoft Entra ID"
// (DESIGN.md, "Provisioning from Entra ID").
//
// This server sends no email: an invited address joins when it signs up, and
// an invited account at once, as upstream's invitations do without email. The
// mail tests accept invitations with the emailed link.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { Api, type Account, encString, publicKey, withMasterPassword } from "./support";

// Several accounts and organizations each, with two-step login for owners,
// and a provisioning token checks the master password the way a sign-in does
// (slow in the server's debug build).
test.describe.configure({ timeout: 120_000 });

const INVITED = 0;
const ACCEPTED = 1;
const CONFIRMED = 2;
const USER = 2;

const unique = (name: string) => `${name} ${randomUUID().slice(0, 6)}`;
const address = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}@api.example.test`;

/**
 * A company's own organization with the Business preset, made the way the web
 * vault's New organization page does: its Everyone collection is the one
 * named here. `preset: "none"` is a family's or a group's, without Everyone.
 */
async function company(api: Api, owner: Account, name: string, preset: "business" | "none" = "business") {
  if (preset === "business") {
    // The preset requires two-step login of its owners.
    await api.giveAuthenticator(owner);
  }
  const created = await api.call(owner, "POST", "/api/keykeeper/organizations", {
    name,
    collectionName: encString(`everyone-${name}`),
    adminsCollectionName: preset === "business" ? encString(`admins-${name}`) : undefined,
    preset,
    key: encString(`org-key-for-${owner.email}`),
    keys: { publicKey: publicKey(`org-${name}`), encryptedPrivateKey: encString(`org-private-${name}`) },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}

/** A collection's id by the name it was made with. */
async function collectionNamed(api: Api, owner: Account, orgId: string, name: string) {
  const listed = await api.call(owner, "GET", `/api/organizations/${orgId}/collections`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const found = listed.body.data.find((c: { name: string }) => c.name === encString(name));
  expect(found, `the collection ${name}`).toBeTruthy();
  return found.id as string;
}

type Grant = { id: string; readOnly: boolean; hidePasswords: boolean; manage: boolean };

/** Who has a grant in a collection, by membership, as its access list shows. */
async function grants(api: Api, owner: Account, orgId: string, collectionId: string): Promise<Grant[]> {
  const listed = await api.call(owner, "GET", `/api/organizations/${orgId}/collections/${collectionId}/users`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body;
}

/** A member's own grants, as the member dialog reads them. */
async function memberGrants(api: Api, owner: Account, orgId: string, memberId: string): Promise<Grant[]> {
  const read = await api.call(owner, "GET", `/api/organizations/${orgId}/users/${memberId}?includeCollections=true`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.collections;
}

/** Invites addresses by email from the Members page, naming these grants. */
async function invite(api: Api, owner: Account, orgId: string, emails: string[], collections: Grant[] = []) {
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails,
    type: USER,
    collections,
    groups: [],
    accessSecretsManager: false,
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
}

async function membership(api: Api, owner: Account, orgId: string, email: string) {
  const found = (await api.members(owner, orgId)).find((m) => m.email === email);
  expect(found, `membership for ${email}`).toBeTruthy();
  return found!;
}

/** An owner's or admin's app confirms them: they get the organization's key. */
async function confirm(api: Api, owner: Account, orgId: string, memberId: string, email: string) {
  const confirmed = await api.call(owner, "POST", `/api/organizations/${orgId}/users/${memberId}/confirm`, {
    key: encString(`org-key-for-${email}`),
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
}

const canEdit = { readOnly: false, hidePasswords: false, manage: false };
const canView = { readOnly: true, hidePasswords: false, manage: false };

test("someone invited by email gets Everyone when they're confirmed, beside the folders their invitation named", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const name = unique("Harbor Dental");
  const orgId = await company(api, owner, name);
  const everyone = await collectionNamed(api, owner, orgId, `everyone-${name}`);
  const admins = await collectionNamed(api, owner, orgId, `admins-${name}`);
  const frontDesk = await api.collection(owner, orgId);

  // Invited by email, naming Front desk (Can view); they sign up from it.
  const email = address("hire");
  await invite(api, owner, orgId, [email], [{ id: frontDesk, ...canView }]);
  expect((await membership(api, owner, orgId, email)).status).toBe(INVITED);
  const hire = await api.account("hire", email);
  const member = await membership(api, owner, orgId, email);
  expect(member.status).toBe(ACCEPTED);

  // Nothing in Everyone until the organization's key reaches them.
  expect((await grants(api, owner, orgId, everyone)).map((g) => g.id)).not.toContain(member.id);
  expect(await api.orgsOf(hire)).toEqual([]);

  await confirm(api, owner, orgId, member.id, email);
  expect((await membership(api, owner, orgId, email)).status).toBe(CONFIRMED);
  // Can edit in Everyone, as joining with the install command gives; Front
  // desk as the invitation named it; never Admins.
  const theirs = await memberGrants(api, owner, orgId, member.id);
  expect(theirs).toHaveLength(2);
  expect(theirs.find((g) => g.id === everyone)).toMatchObject(canEdit);
  expect(theirs.find((g) => g.id === frontDesk)).toMatchObject(canView);
  expect((await grants(api, owner, orgId, admins)).map((g) => g.id)).not.toContain(member.id);
  // In their own vault: both, in this organization.
  expect(await api.orgsOf(hire)).toEqual([orgId]);
  const seen = await api.call(hire, "GET", "/api/collections");
  expect(seen.body.data.map((c: { id: string }) => c.id).sort()).toEqual([everyone, frontDesk].sort());
});

test("an invitation that gave Everyone keeps its grant, with no second one, and an account invited by email gets it too", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const name = unique("Lakeside Clinic");
  const orgId = await company(api, owner, name);
  const everyone = await collectionNamed(api, owner, orgId, `everyone-${name}`);

  // One account invited with Everyone, Can view; another with nothing named.
  // Both have accounts already, so they join at once on this server.
  const viewer = await api.account("viewer");
  const editor = await api.account("editor");
  await invite(api, owner, orgId, [viewer.email], [{ id: everyone, ...canView }]);
  await invite(api, owner, orgId, [editor.email]);
  for (const who of [viewer, editor]) {
    const member = await membership(api, owner, orgId, who.email);
    expect(member.status).toBe(ACCEPTED);
    await confirm(api, owner, orgId, member.id, who.email);
  }

  const viewerId = (await membership(api, owner, orgId, viewer.email)).id;
  const editorId = (await membership(api, owner, orgId, editor.email)).id;
  const inEveryone = await grants(api, owner, orgId, everyone);
  // One grant each: the viewer's as the admin set it, the editor's Can edit.
  expect(inEveryone.filter((g) => g.id === viewerId)).toEqual([expect.objectContaining(canView)]);
  expect(inEveryone.filter((g) => g.id === editorId)).toEqual([expect.objectContaining(canEdit)]);
  // The owner reaches it already, and isn't added.
  const ownerId = (await membership(api, owner, orgId, owner.email)).id;
  expect(inEveryone.map((g) => g.id)).not.toContain(ownerId);
});

test("an MSP's staff never get a client's Everyone; the client's people invited by email do, when the console confirms them", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const mspId = await api.msp(admin, unique("Northwind IT"));
  const name = unique("Acme Dental");
  const orgId = await api.client(admin, mspId, name, "business");
  const everyone = await collectionNamed(api, admin, orgId, `collection-${name}`);
  await api.addStaff(admin, mspId, tech, "technician");

  // One of the client's own people, invited by email from its Members page.
  const person = await api.account("person");
  await invite(api, admin, orgId, [person.email]);

  // The console confirms everyone waiting: the technician and the person.
  const confirmed = await api.confirmPending(admin, mspId);
  expect(confirmed.sort()).toEqual([person.email, tech.email].sort());

  const inEveryone = (await grants(api, admin, orgId, everyone)).map((g) => g.id);
  expect(inEveryone).toContain((await membership(api, admin, orgId, person.email)).id);
  expect(inEveryone).not.toContain((await membership(api, admin, orgId, tech.email)).id);
  expect(inEveryone).not.toContain((await membership(api, admin, orgId, admin.email)).id);
  expect(inEveryone).toHaveLength(1);
});

test("an organization without Everyone, or that deleted it, gives nothing, and confirming and the install command still work", async ({
  request,
}) => {
  const api = new Api(request);

  // A family: upstream's organization, one collection, which isn't Everyone.
  const parent = await api.account("parent");
  const familyName = unique("Rivera Family");
  const family = await company(api, parent, familyName, "none");
  const shared = await collectionNamed(api, parent, family, `everyone-${familyName}`);
  const kid = await api.account("kid");
  await invite(api, parent, family, [kid.email]);
  const kidId = (await membership(api, parent, family, kid.email)).id;
  await confirm(api, parent, family, kidId, kid.email);
  expect(await memberGrants(api, parent, family, kidId)).toEqual([]);
  expect((await grants(api, parent, family, shared)).map((g) => g.id)).not.toContain(kidId);

  // A business that deleted its Everyone.
  const owner = await api.account("owner");
  const name = unique("Harbor Freight Co");
  const orgId = await company(api, owner, name);
  const everyone = await collectionNamed(api, owner, orgId, `everyone-${name}`);
  const deleted = await api.call(owner, "DELETE", `/api/organizations/${orgId}/collections/${everyone}`);
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);

  const invited = await api.account("invited");
  await invite(api, owner, orgId, [invited.email]);
  const invitedId = (await membership(api, owner, orgId, invited.email)).id;
  await confirm(api, owner, orgId, invitedId, invited.email);
  expect(await memberGrants(api, owner, orgId, invitedId)).toEqual([]);

  // Joining with the install command doesn't fail on the deleted collection.
  const command = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/enrollment`);
  expect(command.status, JSON.stringify(command.body)).toBe(200);
  const joiner = await api.account("joiner");
  const joined = await api.call(joiner, "POST", "/api/keykeeper/enrollment/join", { token: command.body.token });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  expect(joined.body).toMatchObject({ organizationId: orgId, status: ACCEPTED });
  const joinerId = (await membership(api, owner, orgId, joiner.email)).id;
  await confirm(api, owner, orgId, joinerId, joiner.email);
  expect(await memberGrants(api, owner, orgId, joinerId)).toEqual([]);
});

test("the members list says whom provisioning manages: regular members it invited or matched, while there's a token", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const name = unique("Contoso");
  const orgId = await company(api, owner, name);
  const everyone = await collectionNamed(api, owner, orgId, `everyone-${name}`);
  const adminAccount = await api.account("admin");
  await api.addMember(owner, orgId, adminAccount, "admin");
  const matchedAccount = await api.account("matched");
  await api.addMember(owner, orgId, matchedAccount, "user");
  const ownAccount = await api.account("own");
  await api.addMember(owner, orgId, ownAccount, "user");

  const made = await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`, withMasterPassword(owner));
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const scim = (method: string, path: string, body?: unknown) =>
    request.fetch(`/scim/v2/${orgId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${made.body.newToken}`, "Content-Type": "application/scim+json" },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
  const user = (email: string) => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    externalId: randomUUID(),
    userName: email.replace("@api.example.test", "@contoso.onmicrosoft.com"),
    active: true,
    emails: [{ primary: true, type: "work", value: email }],
  });

  // Entra adds a new hire, and matches someone already in the organization.
  const hireEmail = address("hire");
  const added = await scim("POST", "/Users", user(hireEmail));
  expect(added.status(), await added.text()).toBe(201);
  const matched = await scim("POST", "/Users", user(matchedAccount.email));
  expect(matched.status(), await matched.text()).toBe(201);
  // And asks to turn off the admin, whom provisioning never changes: refused,
  // only noted.
  const adminId = (await membership(api, owner, orgId, adminAccount.email)).id;
  const refused = await scim("PATCH", `/Users/${adminId}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  expect(refused.status(), await refused.text()).toBe(403);

  const marked = async () => {
    const listed = await api.call(owner, "GET", `/api/organizations/${orgId}/users`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const byEmail = new Map<string, { id: string; keykeeperProvisioned: unknown; externalId: unknown; claimedByOrganization: unknown }>(
      listed.body.data.map((m: { email: string }) => [m.email, m]),
    );
    // Upstream's fields stay as they were.
    for (const m of byEmail.values()) {
      expect(m.externalId ?? null).toBeNull();
      expect(m.claimedByOrganization).toBe(false);
      // The member dialog reads the same.
      const one = await api.call(owner, "GET", `/api/organizations/${orgId}/users/${m.id}`);
      expect(one.body.keykeeperProvisioned).toBe(m.keykeeperProvisioned);
    }
    return [...byEmail.entries()].filter(([, m]) => m.keykeeperProvisioned === true).map(([email]) => email).sort();
  };
  expect(await marked()).toEqual([hireEmail, matchedAccount.email].sort());

  // The hire signs up, and an owner lets them in: they get Everyone too.
  await api.account("hire", hireEmail);
  const hire = await membership(api, owner, orgId, hireEmail);
  expect(hire.status).toBe(ACCEPTED);
  await confirm(api, owner, orgId, hire.id, hireEmail);
  expect((await grants(api, owner, orgId, everyone)).filter((g) => g.id === hire.id)).toEqual([
    expect.objectContaining(canEdit),
  ]);

  // Revoked: provisioning is off, so nobody is the directory's.
  const revoked = await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/provisioning/token`);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  expect(await marked()).toEqual([]);
});

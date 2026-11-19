// A family's invite link (DESIGN.md, "A family's invite link"): the server's
// side, black box.
//
// - Only a family has one (an organization whose plan is Families, where
//   plans are enforced, that isn't an MSP's client), and only its owners and
//   admins see, make, replace, change, or turn off the link. Everyone else,
//   and every other organization, gets "not found", never 403.
// - The server keeps the token only as a hash and the settings as the browser
//   sealed them; no answer ever carries the token.
// - The join page's question answers with the family's name and who made the
//   link, and nothing else, without signing in; every link that doesn't work
//   gets the same answer.
// - Joining makes a member waiting for the family's key, counted against the
//   family's six people under the same lock as every other way in; the list of
//   who's waiting carries the link's sealed settings and the join's proof, and
//   says the server lets them in automatically only while the link is
//   automatic and was when they joined. Then the owner confirms them.
// - A family's owners are offered a legacy contact until they say No thanks.
//
// The test server sends no email. The tests stand in for the browser: tokens
// are random, and sealed settings and proofs are stand-ins of the right form,
// since the server can't read either.
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { familyLinkServerPort } from "../../paths.mjs";
import { DAY, fromNow, type PlansServer, startPlansServer } from "../support/plans";

import { type Account, Api, encString, type Result } from "./support";

const LINK_DOESNT_WORK = "This invite link doesn't work. Ask whoever sent it for a new one.";
const NOT_FOUND = "Organization not found";
const full = (has: number) => `A Families plan covers 6 people, and this one has ${has}. Remove someone first.`;

/** A year of a plan, paid for. */
const paid = (plan: "families" | "business") => ({
  plan,
  standing: "until",
  until: fromNow(365 * DAY),
  renews: true,
});

/** A link's token, as the browser makes one: 32 random bytes, base64url. */
const newToken = () => randomBytes(32).toString("base64url");
/** A join's proof, of the right form. */
const proof = (n: number) => Buffer.alloc(32, n).toString("base64");

const linkPath = (orgId: string) => `/api/keykeeper/organizations/${orgId}/family-link`;

function expectOk(answer: Result) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

function expectNotFound(answer: Result, message = NOT_FOUND) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(404);
  expect(answer.body.message).toBe(message);
}

function expectRefused(answer: Result, sentence: string) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(400);
  expect(answer.body.message).toBe(sentence);
}

let server: PlansServer | undefined;

test.describe.configure({ mode: "serial" });
test.use({ baseURL: `https://127.0.0.1:${familyLinkServerPort}` });

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120_000);
  server = await startPlansServer(playwright, familyLinkServerPort, true);
});

test.afterAll(async () => {
  await server?.stop();
});

/** A family: an organization the operator puts on Families. */
async function family(api: Api, owner: Account, name = "Rivera family"): Promise<string> {
  const orgId = await api.organization(owner, name);
  await server!.operator.setPlan("organizations", orgId, paid("families"));
  return orgId;
}

/** Makes or replaces the link, as the owner's browser does; returns its token. */
async function makeLink(
  api: Api,
  as: Account,
  orgId: string,
  more: { automatic?: boolean; days?: number; collectionId?: string } = {},
): Promise<string> {
  const token = newToken();
  expectOk(
    await api.call(as, "PUT", linkPath(orgId), {
      token,
      sealed: encString(`settings-${token}`),
      automatic: more.automatic ?? false,
      days: more.days ?? 7,
      collectionId: more.collectionId ?? null,
    }),
  );
  return token;
}

const info = (api: Api, orgId: string, token: string) =>
  api.call(null, "POST", "/api/keykeeper/family-link/info", { organizationId: orgId, token });

const join = (api: Api, as: Account, orgId: string, token: string, n = 1) =>
  api.call(as, "POST", "/api/keykeeper/family-link/join", { organizationId: orgId, token, proof: proof(n) });

/** Someone in the list of who's waiting, as an owner's or admin's apps get it. */
async function waitingEntry(api: Api, as: Account, email: string) {
  const pending = await api.call(as, "GET", "/api/keykeeper/organizations/pending");
  expectOk(pending);
  return pending.body.data.find((p: { email: string }) => p.email === email);
}

test("only a family's owners and admins see or change its link; everyone else gets not found", async ({ request }) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const owner = await api.account("link-owner");
  const admin = await api.account("link-admin");
  const member = await api.account("link-member");
  const manager = await api.account("link-manager");
  const outsider = await api.account("link-outsider");
  const orgId = await api.organization(owner, "Rivera family");
  await api.addMember(owner, orgId, admin, "admin");
  await api.addMember(owner, orgId, member, "user");
  await api.addMember(owner, orgId, manager, "manager");

  // Before it's a family (a Business trial), nobody has a link, its owner included.
  expectNotFound(await api.call(owner, "GET", linkPath(orgId)));
  expectNotFound(
    await api.call(owner, "PUT", linkPath(orgId), { token: newToken(), sealed: encString("s"), automatic: false, days: 7 }),
  );
  await server!.operator.setPlan("organizations", orgId, paid("families"));

  for (const who of [owner, admin]) {
    const view = await api.call(who, "GET", linkPath(orgId));
    expectOk(view);
    expect(view.body).toMatchObject({ on: false, live: false, sealed: null, joins: [] });
  }
  await makeLink(api, admin, orgId);

  const sealed = encString("someone-else");
  for (const who of [member, manager, outsider]) {
    expectNotFound(await api.call(who, "GET", linkPath(orgId)));
    expectNotFound(
      await api.call(who, "PUT", linkPath(orgId), { token: newToken(), sealed, automatic: true, days: 30 }),
    );
    expectNotFound(await api.call(who, "PUT", `${linkPath(orgId)}/approval`, { automatic: true, sealed }));
    expectNotFound(await api.call(who, "DELETE", linkPath(orgId), { sealed }));
  }
  // Signed out: not even asked.
  expect((await api.call(null, "GET", linkPath(orgId))).status).toBe(401);

  // The owner still sees the admin's link, unchanged by the refusals.
  const view = await api.call(owner, "GET", linkPath(orgId));
  expect(view.body).toMatchObject({ on: true, live: true, automatic: false, madeBy: admin.email });
});

test("a Business organization and an MSP's client have no link, whoever asks", async ({ request }) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const owner = await api.account("link-business");
  const business = await api.organization(owner, "Acme Dental");
  await server!.operator.setPlan("organizations", business, paid("business"));
  expectNotFound(await api.call(owner, "GET", linkPath(business)));
  expectNotFound(
    await api.call(owner, "PUT", linkPath(business), { token: newToken(), sealed: encString("s"), automatic: false, days: 7 }),
  );

  // An MSP's client, even one the operator put on Families: its MSP's admin
  // owns it, and its technician is an admin there.
  const mspAdmin = await api.account("link-msp-admin");
  const technician = await api.account("link-msp-tech");
  const mspId = await api.msp(mspAdmin, "Northwind IT");
  await api.addStaff(mspAdmin, mspId, technician, "technician");
  const client = await api.client(mspAdmin, mspId, "Client family");
  await api.confirmPending(mspAdmin, mspId);
  await server!.operator.setPlan("organizations", client, paid("families"));
  for (const who of [mspAdmin, technician]) {
    expectNotFound(await api.call(who, "GET", linkPath(client)));
    expectNotFound(
      await api.call(who, "PUT", linkPath(client), { token: newToken(), sealed: encString("s"), automatic: true, days: 7 }),
    );
  }
});

test("the server keeps the token only as a hash: no answer carries it", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("link-hash");
  const orgId = await family(api, owner);
  const token = newToken();
  const sealed = encString(`settings-${token}`);
  const made = await api.call(owner, "PUT", linkPath(orgId), { token, sealed, automatic: false, days: 1 });
  expectOk(made);
  const view = await api.call(owner, "GET", linkPath(orgId));
  for (const answer of [made, view]) {
    expect(JSON.stringify(answer.body)).not.toContain(token);
    expect(answer.body.sealed).toBe(sealed);
  }
  const hours = (Date.parse(view.body.expiresAt) - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(23);
  expect(hours).toBeLessThanOrEqual(24);

  // What the browser sends is checked to look right.
  for (const [bad, sentence] of [
    [{ token: "short", sealed, automatic: false, days: 7 }, "That invite link's token isn't one"],
    [{ token, sealed: "plain text", automatic: false, days: 7 }, "The link's settings must be encrypted with the family's key"],
    [{ token, sealed, automatic: false, days: 14 }, "An invite link works for 1, 7, or 30 days"],
    [{ token, sealed, automatic: false, days: 7, collectionId: randomUUID() }, "That shared folder isn't this family's"],
  ] as const) {
    expectRefused(await api.call(owner, "PUT", linkPath(orgId), bad), sentence);
  }
});

test("the join page learns only the family's name and who invited them, and one answer for every link that doesn't work", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("link-page-owner");
  const admin = await api.account("link-page-admin");
  const orgId = await family(api, owner, "Okafor family");
  await api.addMember(owner, orgId, admin, "admin");
  const token = await makeLink(api, owner, orgId);

  const good = await info(api, orgId, token);
  expectOk(good);
  expect(good.body).toEqual({ organizationName: "Okafor family", invitedBy: "link-page-owner" });

  const answers: Result[] = [];
  answers.push(await info(api, orgId, newToken()));
  answers.push(await info(api, orgId, ""));
  answers.push(await info(api, randomUUID(), token));
  // Replaced: the old token stops at once.
  const replaced = await makeLink(api, owner, orgId);
  answers.push(await info(api, orgId, token));
  expectOk(await info(api, orgId, replaced));
  // Off.
  expectOk(await api.call(owner, "DELETE", linkPath(orgId), { sealed: encString("off") }));
  answers.push(await info(api, orgId, replaced));
  // Made by an admin who's since a member only.
  const adminsToken = await makeLink(api, admin, orgId);
  expectOk(await info(api, orgId, adminsToken));
  const adminId = (await api.members(owner, orgId)).find((m) => m.email === admin.email)!.id;
  expectOk(
    await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${adminId}`, {
      type: 2,
      collections: [],
      groups: [],
      permissions: {},
    }),
  );
  answers.push(await info(api, orgId, adminsToken));
  // No longer a family.
  const ownersToken = await makeLink(api, owner, orgId);
  expectOk(await info(api, orgId, ownersToken));
  await server!.operator.setPlan("organizations", orgId, paid("business"));
  answers.push(await info(api, orgId, ownersToken));

  for (const answer of answers) {
    expectNotFound(answer, LINK_DOESNT_WORK);
    expect(Object.keys(answer.body).sort()).toEqual(Object.keys(answers[0].body).sort());
  }
});

test("joining with the link waits for the family's key, and the owner confirms them; automatic only while it was automatic", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const owner = await api.account("link-join-owner");
  const ben = await api.account("link-join-ben");
  const cleo = await api.account("link-join-cleo");
  const dee = await api.account("link-join-dee");
  const orgId = await family(api, owner, "Nguyen family");
  const folder = await api.collection(owner, orgId);
  const token = await makeLink(api, owner, orgId, { collectionId: folder });

  // One tap: Ben joins, and waits.
  const joined = await join(api, ben, orgId, token, 1);
  expectOk(joined);
  expect(joined.body).toEqual({ organizationId: orgId, organizationName: "Nguyen family", status: 1, automatic: false });
  const benEntry = await waitingEntry(api, owner, ben.email);
  expect(benEntry).toMatchObject({ autoConfirm: false, familyLink: { joinProof: proof(1) } });
  expect(benEntry.familyLink.sealed).toBe((await api.call(owner, "GET", linkPath(orgId))).body.sealed);
  // Joining again changes nothing.
  expectOk(await join(api, ben, orgId, token, 1));

  // The owner confirms him: upstream's confirm, with the family's key for him.
  expectOk(
    await api.call(owner, "POST", `/api/organizations/${orgId}/users/${benEntry.memberId}/confirm`, {
      key: encString(`org-key-for-${ben.email}`),
    }),
  );
  const benInSync = (await api.call(ben, "GET", "/api/sync?excludeDomains=true")).body.profile.organizations.find(
    (o: { id: string }) => o.id === orgId,
  );
  expect(benInSync.status).toBe(2);
  expect(benInSync.key).toBe(encString(`org-key-for-${ben.email}`));
  // With Can edit in the folder the link names.
  const access = await api.call(owner, "GET", `/api/organizations/${orgId}/collections/${folder}/users`);
  expectOk(access);
  const benAccess = access.body.find((u: { id: string }) => u.id === benEntry.memberId);
  expect(benAccess).toMatchObject({ readOnly: false, hidePasswords: false });

  // Dee joins while it's one tap; then the owner chooses automatic.
  expectOk(await join(api, dee, orgId, token, 3));
  const approval = await api.call(owner, "PUT", `${linkPath(orgId)}/approval`, {
    automatic: true,
    sealed: encString("automatic"),
  });
  expectOk(approval);
  expect(approval.body).toMatchObject({ automatic: true, sealed: encString("automatic"), live: true });

  // Cleo joins while it's automatic: the server says let her in.
  const cleoJoined = await join(api, cleo, orgId, token, 2);
  expect(cleoJoined.body.automatic).toBe(true);
  expect(await waitingEntry(api, owner, cleo.email)).toMatchObject({
    autoConfirm: true,
    familyLink: { joinProof: proof(2), sealed: encString("automatic") },
  });
  // Dee joined while it was one tap, so she still waits for a tap.
  expect((await waitingEntry(api, owner, dee.email)).autoConfirm).toBe(false);

  // Back to one tap: nobody is let in automatically, Cleo included.
  expectOk(await api.call(owner, "PUT", `${linkPath(orgId)}/approval`, { automatic: false, sealed: encString("one-tap") }));
  expect((await waitingEntry(api, owner, cleo.email)).autoConfirm).toBe(false);

  // The card lists who joined with the link, and how.
  const view = await api.call(owner, "GET", linkPath(orgId));
  const joins = Object.fromEntries(
    view.body.joins.map((j: { email: string; automatic: boolean; status: number }) => [j.email, [j.automatic, j.status]]),
  );
  expect(joins).toEqual({ [ben.email]: [false, 2], [dee.email]: [false, 1], [cleo.email]: [true, 1] });

  // Off: nobody joins, and nobody is let in automatically.
  expectOk(await api.call(owner, "DELETE", linkPath(orgId), { sealed: encString("off") }));
  const eve = await api.account("link-join-eve");
  expectNotFound(await join(api, eve, orgId, token, 4), LINK_DOESNT_WORK);
  const off = await api.call(owner, "GET", linkPath(orgId));
  expect(off.body).toMatchObject({ on: false, live: false, automatic: false, expiresAt: null, sealed: encString("off") });
});

test("an emailed invitation, someone revoked, and anyone added another way are never link joins", async ({ request }) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("link-ways-owner");
  const orgId = await family(api, owner, "Haddad family");
  const token = await makeLink(api, owner, orgId, { automatic: true });

  // Invited by email before they had an account. This server sends no
  // email, so signing up accepts the invitation (upstream's way); joining
  // with the link then changes nothing, and they're no link join. (Where the
  // server sends email, an invitation not yet accepted is refused with "You
  // have an emailed invitation to ...": the server's unit tests.)
  const invitedEmail = `link-ways-invited-${randomUUID().slice(0, 8)}@api.example.test`;
  expectOk(
    await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [invitedEmail],
      type: 2,
      collections: [],
      groups: [],
      permissions: {},
    }),
  );
  const invited = await api.account("link-ways-invited", invitedEmail);
  const invitedJoin = await join(api, invited, orgId, token);
  expectOk(invitedJoin);
  expect(invitedJoin.body.status).toBe(1);
  expect((await waitingEntry(api, owner, invitedEmail)).familyLink).toBeUndefined();

  // Added another way and waiting: no link join, so nothing about the link.
  const added = await api.account("link-ways-added");
  await api.addMember(owner, orgId, added, "user", { confirm: false });
  const addedEntry = await waitingEntry(api, owner, added.email);
  expect(addedEntry.familyLink).toBeUndefined();
  // Joining with the link now changes nothing: already in.
  const again = await join(api, added, orgId, token);
  expectOk(again);
  expect(again.body.status).toBe(1);
  expect((await waitingEntry(api, owner, added.email)).familyLink).toBeUndefined();

  // Revoked: stays out.
  const gone = await api.account("link-ways-gone");
  const goneId = await api.addMember(owner, orgId, gone, "user");
  expectOk(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${goneId}/revoke`));
  expectRefused(await join(api, gone, orgId, token), "Your access to Haddad family was turned off. Ask its owners.");
});

test("joining counts against the family's six people, and two joins at once for the last place let one in", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const owner = await api.account("link-full-owner");
  const orgId = await family(api, owner, "Silva family");
  const token = await makeLink(api, owner, orgId);
  // The owner and four more: one place left.
  for (let n = 0; n < 4; n++) {
    expectOk(await join(api, await api.account(`link-full-${n}`), orgId, token, n + 1));
  }
  const [first, second] = [await api.account("link-full-a"), await api.account("link-full-b")];
  const both = await Promise.all([join(api, first, orgId, token, 10), join(api, second, orgId, token, 11)]);
  const statuses = both.map((a) => a.status).sort();
  expect(statuses, JSON.stringify(both.map((a) => a.body))).toEqual([200, 400]);
  expect(both.find((a) => a.status === 400)!.body.message).toBe(full(6));
  expect((await api.members(owner, orgId)).length).toBe(6);

  const seventh = await api.account("link-full-seventh");
  expectRefused(await join(api, seventh, orgId, token, 12), full(6));
});

test("a family's owner is offered a legacy contact until they say No thanks", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("link-legacy-owner");
  const admin = await api.account("link-legacy-admin");
  const orgId = await family(api, owner, "Park family");
  await api.addMember(owner, orgId, admin, "admin");
  const businessOwner = await api.account("link-legacy-business");
  const business = await api.organization(businessOwner, "Acme");
  await server!.operator.setPlan("organizations", business, paid("business"));

  const asks = async (who: Account) => {
    const answer = await api.call(who, "GET", "/api/keykeeper/legacy-contact-suggestion");
    expectOk(answer);
    return answer.body.show;
  };
  expect(await asks(owner)).toBe(true);
  expect(await asks(admin)).toBe(false);
  expect(await asks(businessOwner)).toBe(false);
  expectOk(await api.call(owner, "POST", "/api/keykeeper/legacy-contact-suggestion/dismiss"));
  expect(await asks(owner)).toBe(false);
});

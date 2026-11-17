// Families (DESIGN.md, "Plans and billing", piece 7 of "Build order"): an
// organization whose plan is Families covers six people (PLAN_FAMILIES_PEOPLE)
// and has none of the company features, where plans are enforced.
//
// - The people limit is counted, not trusted: everyone invited or joined who
//   isn't revoked counts, the owner included. Every way someone comes in
//   (inviting one or several, sending an invitation again, confirming,
//   restoring, and their bulk forms) is refused past six with the design's
//   sentence, and the count and the write are one locked transaction, so
//   invitations sent at once can't both take the last place. Accepting an
//   emailed invitation is the mail tests' (tests/mail/plans.spec.ts).
// - Company features (policies, groups, the event log and event destinations,
//   single sign-on, provisioning, account recovery, custom roles, the install
//   command, and the organization's API key) answer a family as for an
//   organization without them: "That's part of the Business plan." where one
//   would be added or turned on, and an empty list where upstream's server
//   lists nothing without the feature. Turning one off and removing what's
//   there go on.
// - Where plans aren't enforced, a family's plan changes nothing, and every
//   answer is what it is for an organization with no plan at all.
//
// The operator's route needs the admin page, so these tests start two servers
// of their own, as tests/api/plans.spec.ts does: one that enforces plans, with
// groups and the event log on, and one that doesn't. Each takes an admin token
// made up for the run, kept in memory only.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { familiesOffServerPort, familiesServerPort } from "../../paths.mjs";

import { type Account, Api, type Result, encString } from "./support";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DAY = 86_400_000;

/** A moment this far from now, to the second, as the operator's route takes dates. */
const fromNow = (ms: number) => new Date(Math.floor((Date.now() + ms) / 1000) * 1000).toISOString();

/** A year of Families, paid for and set to renew. */
const families = () => ({ plan: "families", standing: "until", until: fromNow(365 * DAY), renews: true });
/** A year of Business. */
const business = () => ({ plan: "business", standing: "until", until: fromNow(365 * DAY), renews: true });

const BUSINESS_PLAN = "That's part of the Business plan.";
/** The design's sentence for a family with no room, with the people it has. */
const full = (has: number) => `A Families plan covers 6 people, and this one has ${has}. Remove someone first.`;

/** The organization's fields a family has off. */
const companyFeatures = [
  "usePolicies",
  "useGroups",
  "useEvents",
  "useSso",
  "useScim",
  "useResetPassword",
  "useCustomPermissions",
  "useApi",
];

async function result(response: { status(): number; text(): Promise<string> }): Promise<Result> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; keep the text.
  }
  return { status: response.status(), body };
}

/** The operator, signed in to one server's admin page. */
class Operator {
  constructor(private readonly http: APIRequestContext) {}

  async set(orgId: string, data: Record<string, unknown>) {
    const written = await result(await this.http.post(`/admin/plans/organizations/${orgId}`, { data }));
    expect(written.status, JSON.stringify(written.body)).toBe(200);
  }

  async dispose() {
    await this.http.dispose();
  }
}

type FamiliesServer = { process: ChildProcess; dataDir: string; operator: Operator };

async function startServer(
  playwright: { request: { newContext(options: object): Promise<APIRequestContext> } },
  port: string,
  enforced: boolean,
): Promise<FamiliesServer> {
  const adminToken = randomBytes(32).toString("base64url");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-families-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: port,
      KK_DATA_DIR: dataDir,
      KK_ADMIN_TOKEN: adminToken,
      KK_GROUPS: "1",
      KK_EVENTS: "1",
      ...(enforced ? { KK_PLANS_ENFORCED: "1" } : {}),
    },
    stdio: "ignore",
  });
  const http = await playwright.request.newContext({ baseURL: `https://127.0.0.1:${port}`, ignoreHTTPSErrors: true });
  await expect
    .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
    .toBe(200);
  const signedIn = await http.post("/admin", { form: { token: adminToken } });
  expect(signedIn.status(), "the operator's sign-in to the admin page").toBe(200);
  return { process: child, dataDir, operator: new Operator(http) };
}

async function stopServer(server: FamiliesServer | undefined) {
  if (!server) {
    return;
  }
  await server.operator.dispose();
  const exited = new Promise((resolve) => server.process.once("exit", resolve));
  server.process.kill("SIGTERM");
  await exited;
  fs.rmSync(server.dataDir, { recursive: true, force: true });
}

/** An address nobody has an account for yet: its invitation waits, invited. */
const nobody = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}@api.example.test`;

function invite(api: Api, owner: Account, orgId: string, emails: string[], type = 2, permissions = {}) {
  return api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails,
    type,
    collections: [],
    groups: [],
    permissions,
  });
}

function expectRefused(answer: Result, sentence: string) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(400);
  expect(answer.body.message).toBe(sentence);
}

function expectOk(answer: Result) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

/** A bulk form's answer for one member: the error it carries, or "" when it went through. */
function bulkError(answer: Result, id: string): string {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  const row = answer.body.data.find((r: { id: string }) => r.id === id);
  expect(row, `${id} in ${JSON.stringify(answer.body)}`).toBeTruthy();
  return row.error;
}

/** Someone's membership id, by email. */
async function idOf(api: Api, owner: Account, orgId: string, email: string): Promise<string> {
  const member = (await api.members(owner, orgId)).find((m) => m.email === email);
  expect(member, `${email} in the organization`).toBeTruthy();
  return member!.id;
}

/** The seats the web vault's invite form reads as taken (upstream's billing metadata). */
async function seatsTaken(api: Api, owner: Account, orgId: string): Promise<number> {
  const metadata = await api.call(owner, "GET", `/api/organizations/${orgId}/billing/vnext/self-host/metadata`);
  expectOk(metadata);
  return metadata.body.organizationOccupiedSeats;
}

/** An organization as someone's sync has it. */
async function orgOf(api: Api, account: Account, orgId: string): Promise<any> {
  const sync = await api.call(account, "GET", "/api/sync?excludeDomains=true");
  expectOk(sync);
  const org = sync.body.profile.organizations.find((o: { id: string }) => o.id === orgId);
  expect(org, `organization ${orgId} in the profile of ${account.email}`).toBeTruthy();
  return org;
}

/** A provisioning request (SCIM), with the organization's provisioning token. */
async function scim(request: APIRequestContext, token: string, method: string, path: string, body?: unknown) {
  return result(
    await request.fetch(path, {
      method,
      headers: {
        Accept: "application/scim+json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/scim+json" }),
      },
      data: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const scimUser = (email: string) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  externalId: randomUUID(),
  userName: email,
  active: true,
  emails: [{ primary: true, type: "work", value: email }],
});

/** The organization's API key's token, as Directory Connector signs in with it. */
async function orgApiToken(request: APIRequestContext, api: Api, owner: Account, orgId: string) {
  const key = await api.call(owner, "POST", `/api/organizations/${orgId}/api-key`, { masterPasswordHash: owner.password });
  expectOk(key);
  const token = await request.post("/identity/connect/token", {
    form: {
      grant_type: "client_credentials",
      scope: "api.organization",
      client_id: `organization.${orgId}`,
      client_secret: key.body.apiKey,
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "api-test",
    },
  });
  expect(token.status(), await token.text()).toBe(200);
  return (await token.json()).access_token as string;
}

async function directoryImport(request: APIRequestContext, token: string, emails: string[]) {
  return result(
    await request.post("/api/public/organization/import", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        groups: [],
        members: emails.map((email) => ({ email, externalId: randomUUID(), deleted: false })),
        overwriteExisting: false,
      },
    }),
  );
}

/** A group with nobody in it, as the admin console makes one. */
const aGroup = (name: string) => ({ name, accessAll: false, collections: [], users: [] });

/** The event log for the last day. */
async function eventLog(api: Api, owner: Account, orgId: string) {
  const start = encodeURIComponent(fromNow(-DAY));
  const end = encodeURIComponent(fromNow(DAY));
  const log = await api.call(owner, "GET", `/api/organizations/${orgId}/events?start=${start}&end=${end}`);
  expectOk(log);
  return log.body.data as unknown[];
}

test.describe("where plans are enforced", () => {
  test.use({ baseURL: `https://127.0.0.1:${familiesServerPort}` });

  let server: FamiliesServer | undefined;
  let operator: Operator;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, familiesServerPort, true);
    operator = server.operator;
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("a family counts everyone invited or joined, the owner included, and nobody gets past six by any way in", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const api = new Api(request);
    const owner = await api.account("families-owner");
    const ana = await api.account("families-ana");
    const ben = await api.account("families-ben");
    const waiting = await api.account("families-waiting");
    const gone = await api.account("families-gone");
    const orgId = await api.organization(owner, "Rivera Family");
    await api.addMember(owner, orgId, ana, "user");
    const benId = await api.addMember(owner, orgId, ben, "user");
    // Joined, and waiting to be confirmed.
    const waitingId = await api.addMember(owner, orgId, waiting, "user", { confirm: false });
    // Revoked: not counted.
    const goneId = await api.addMember(owner, orgId, gone, "user");
    expectOk(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${goneId}/revoke`));
    // Invited by an address with no account yet: counted while it waits.
    const invitedEmail = nobody("families-invited");
    expectOk(await invite(api, owner, orgId, [invitedEmail]));
    const invitedId = await idOf(api, owner, orgId, invitedEmail);

    // A Business trial counts nothing.
    expect(await seatsTaken(api, owner, orgId)).toBe(0);
    await operator.set(orgId, families());

    // The owner, two members, one waiting to be confirmed, and one invited.
    expect(await seatsTaken(api, owner, orgId)).toBe(5);
    const synced = await orgOf(api, owner, orgId);
    expect([synced.seats, synced.productTierType, synced.keykeeperPlan.people]).toEqual([6, 1, 6]);
    // The organization itself says the same.
    const itself = await api.call(owner, "GET", `/api/organizations/${orgId}`);
    expectOk(itself);
    expect(itself.body.seats).toBe(6);
    for (const feature of companyFeatures) {
      expect(itself.body[feature], feature).toBe(false);
    }

    // Two at once, with one place left: neither is added.
    const before = (await api.members(owner, orgId)).length;
    expectRefused(await invite(api, owner, orgId, [nobody("families-two"), nobody("families-three")]), full(5));
    expect((await api.members(owner, orgId)).length).toBe(before);

    // The sixth person takes the last place.
    const sixth = await api.account("families-sixth");
    expectOk(await invite(api, owner, orgId, [sixth.email]));
    expect(await seatsTaken(api, owner, orgId)).toBe(6);

    // A seventh, by every way in.
    const seventh = await api.account("families-seventh");
    expectRefused(await invite(api, owner, orgId, [seventh.email]), full(6));
    expectRefused(await invite(api, owner, orgId, [nobody("families-unknown")]), full(6));
    expectRefused(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${goneId}/restore`), full(6));
    expectRefused(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${goneId}/restore/vnext`), full(6));
    expect(bulkError(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/restore`, { ids: [goneId] }), goneId)).toBe(
      full(6),
    );
    expect((await api.members(owner, orgId)).length).toBe(before + 1);

    // Whoever already counts goes on at six: an invitation sent again, and confirming.
    expectOk(await api.call(owner, "POST", `/api/organizations/${orgId}/users/${invitedId}/reinvite`));
    expect(bulkError(await api.call(owner, "POST", `/api/organizations/${orgId}/users/reinvite`, { ids: [invitedId] }), invitedId)).toBe("");
    expectOk(
      await api.call(owner, "POST", `/api/organizations/${orgId}/users/${waitingId}/confirm`, {
        key: encString(`org-key-for-${waiting.email}`),
      }),
    );
    expect(await seatsTaken(api, owner, orgId)).toBe(6);

    // Revoking someone frees a place, and restoring then fits.
    expectOk(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${benId}/revoke`));
    expect(await seatsTaken(api, owner, orgId)).toBe(5);
    expectOk(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${goneId}/restore`));
    expect(await seatsTaken(api, owner, orgId)).toBe(6);

    // More than six, from before it was a family: whoever counts waits too
    // until enough people are removed.
    await operator.set(orgId, business());
    const late = await api.account("families-late");
    expectOk(await invite(api, owner, orgId, [late.email]));
    const lateId = await idOf(api, owner, orgId, late.email);
    const lateInvited = nobody("families-late-invited");
    expectOk(await invite(api, owner, orgId, [lateInvited]));
    const lateInvitedId = await idOf(api, owner, orgId, lateInvited);
    await operator.set(orgId, families());
    expect(await seatsTaken(api, owner, orgId)).toBe(8);
    const lateKey = encString(`org-key-for-${late.email}`);
    expectRefused(await api.call(owner, "POST", `/api/organizations/${orgId}/users/${lateId}/confirm`, { key: lateKey }), full(8));
    expect(
      bulkError(await api.call(owner, "POST", `/api/organizations/${orgId}/users/confirm`, { keys: [{ id: lateId, key: lateKey }] }), lateId),
    ).toBe(full(8));
    expectRefused(await api.call(owner, "POST", `/api/organizations/${orgId}/users/${lateInvitedId}/reinvite`), full(8));
    expectRefused(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${benId}/restore`), full(8));
    expectRefused(await invite(api, owner, orgId, [seventh.email]), full(8));

    // Removing two brings it back to six, and the one waiting is confirmed.
    expectOk(await api.call(owner, "DELETE", `/api/organizations/${orgId}/users/${lateInvitedId}`));
    expectOk(await api.call(owner, "DELETE", `/api/organizations/${orgId}/users/${invitedId}`));
    expect(await seatsTaken(api, owner, orgId)).toBe(6);
    expectOk(await api.call(owner, "POST", `/api/organizations/${orgId}/users/${lateId}/confirm`, { key: lateKey }));
    expect(await seatsTaken(api, owner, orgId)).toBe(6);

    // Business again: no limit, and nothing counted for the web vault.
    await operator.set(orgId, business());
    expect(await seatsTaken(api, owner, orgId)).toBe(0);
    expectOk(await invite(api, owner, orgId, [seventh.email]));
  });

  test("invitations and restores at once for the last places: as many go through as there are places", async ({ request }) => {
    test.setTimeout(180_000);
    const api = new Api(request);
    const owner = await api.account("families-race-owner");
    const orgId = await api.organization(owner, "Race Family");
    const memberIds: string[] = [];
    for (let n = 0; n < 4; n++) {
      memberIds.push(await api.addMember(owner, orgId, await api.account(`families-race-${n}`), "user"));
    }
    await operator.set(orgId, families());
    expect(await seatsTaken(api, owner, orgId)).toBe(5);

    // Six invitations at once for one place.
    const people = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => api.account(`families-racer-${n}`)));
    const answers = await Promise.all(people.map((person) => invite(api, owner, orgId, [person.email])));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    for (const refused of answers.filter((a) => a.status !== 200)) {
      expectRefused(refused, full(6));
    }
    expect(await seatsTaken(api, owner, orgId)).toBe(6);

    // Two places, and two restores and two invitations at once.
    for (const id of memberIds.slice(0, 2)) {
      expectOk(await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${id}/revoke`));
    }
    expect(await seatsTaken(api, owner, orgId)).toBe(4);
    const late = people.filter((_, n) => answers[n].status !== 200).slice(0, 2);
    const mixed = await Promise.all([
      api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberIds[0]}/restore`),
      invite(api, owner, orgId, [late[0].email]),
      api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberIds[1]}/restore`),
      invite(api, owner, orgId, [late[1].email]),
    ]);
    expect(mixed.filter((a) => a.status === 200)).toHaveLength(2);
    for (const refused of mixed.filter((a) => a.status !== 200)) {
      expectRefused(refused, full(6));
    }
    expect(await seatsTaken(api, owner, orgId)).toBe(6);
  });

  test("a family has none of the company features: each answers as for an organization without it, and turning one off goes on", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const api = new Api(request);
    const owner = await api.account("families-features-owner");
    const member = await api.account("families-features-member");
    const orgId = await api.organization(owner, "Features Family");
    const memberId = await api.addMember(owner, orgId, member, "user");

    // What it had while it was a Business trial: a group, an event in its log,
    // an install command, a provisioning token, and the directory's API key.
    const group = await api.call(owner, "POST", `/api/organizations/${orgId}/groups`, aGroup("Parents"));
    expectOk(group);
    const renamed = await api.call(owner, "PUT", `/api/organizations/${orgId}`, { name: "Features Family", billingEmail: owner.email });
    expectOk(renamed);
    expect((await eventLog(api, owner, orgId)).length).toBeGreaterThan(0);
    const command = await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/enrollment`);
    expectOk(command);
    const installToken = command.body.token as string;
    expect(installToken).toBeTruthy();
    const made = await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`, {
      masterPasswordHash: owner.password,
    });
    expectOk(made);
    const scimToken = made.body.newToken as string;
    const apiToken = await orgApiToken(request, api, owner, orgId);

    await operator.set(orgId, families());

    // Policies: none turned on, and turning one off goes on.
    const policy = (enabled: boolean) =>
      api.call(owner, "PUT", `/api/organizations/${orgId}/policies/6`, { policy: { enabled, data: null } });
    expectRefused(await policy(true), BUSINESS_PLAN);
    expectOk(await policy(false));

    // Groups: none made or changed, none listed, and deleting goes on.
    expectRefused(await api.call(owner, "POST", `/api/organizations/${orgId}/groups`, aGroup("Kids")), BUSINESS_PLAN);
    expectRefused(await api.call(owner, "PUT", `/api/organizations/${orgId}/groups/${group.body.id}`, aGroup("Grown-ups")), BUSINESS_PLAN);
    for (const list of ["groups", "groups/details"]) {
      const listed = await api.call(owner, "GET", `/api/organizations/${orgId}/${list}`);
      expectOk(listed);
      expect(listed.body.data, list).toEqual([]);
    }
    expectOk(await api.call(owner, "DELETE", `/api/organizations/${orgId}/groups/${group.body.id}`));

    // The event log lists nothing, for the organization and for a member.
    expect(await eventLog(api, owner, orgId)).toEqual([]);
    const start = encodeURIComponent(fromNow(-DAY));
    const end = encodeURIComponent(fromNow(DAY));
    const theirs = await api.call(owner, "GET", `/api/organizations/${orgId}/users/${memberId}/events?start=${start}&end=${end}`);
    expectOk(theirs);
    expect(theirs.body.data).toEqual([]);

    // Event destinations.
    expectRefused(
      await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/event-streaming`, {
        name: "Family webhook",
        kind: "webhook",
        webhook: { url: "https://127.0.0.1:9/events" },
        masterPasswordHash: owner.password,
      }),
      BUSINESS_PLAN,
    );

    // Single sign-on.
    expectRefused(
      await api.call(owner, "PUT", `/api/keykeeper/organizations/${orgId}/sso`, {
        enabled: true,
        identifier: "features-family",
        tenantId: randomUUID(),
        clientId: randomUUID(),
        clientSecret: "a-secret",
        masterPasswordHash: owner.password,
      }),
      BUSINESS_PLAN,
    );
    expectRefused(
      await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/sso/domains`, { domain: "rivera.example.test" }),
      BUSINESS_PLAN,
    );

    // Provisioning: no token, and the one it had adds nobody.
    expectRefused(
      await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`, { masterPasswordHash: owner.password }),
      BUSINESS_PLAN,
    );
    const provisioned = await scim(request, scimToken, "POST", `/scim/v2/${orgId}/Users`, scimUser(nobody("families-scim")));
    expect(provisioned.status, JSON.stringify(provisioned.body)).toBe(400);
    expect(provisioned.body.detail).toBe(BUSINESS_PLAN);

    // Account recovery: joining it, its details, and recovering someone.
    expectRefused(
      await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${owner.userId}/reset-password-enrollment`, {
        resetPasswordKey: encString(`recovery-key-${owner.email}`),
        masterPasswordHash: owner.password,
      }),
      BUSINESS_PLAN,
    );
    expectRefused(await api.call(owner, "GET", `/api/organizations/${orgId}/users/${memberId}/reset-password-details`), BUSINESS_PLAN);
    expectRefused(
      await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}/recover-account`, {
        newMasterPasswordHash: "new-hash",
        key: encString("new-key"),
      }),
      BUSINESS_PLAN,
    );

    // Custom roles, inviting and changing someone.
    const helper = await api.account("families-features-helper");
    expectRefused(await invite(api, owner, orgId, [helper.email], 4, { manageUsers: true }), BUSINESS_PLAN);
    expectRefused(
      await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
        type: 4,
        accessAll: false,
        permissions: { manageUsers: true },
        collections: [],
        groups: [],
      }),
      BUSINESS_PLAN,
    );

    // The install command: not there, none made, and the one it had lets nobody in.
    expect((await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/enrollment`)).status).toBe(404);
    expectRefused(await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/enrollment`), BUSINESS_PLAN);
    const joiner = await api.account("families-features-joiner");
    expectRefused(await api.call(joiner, "POST", "/api/keykeeper/enrollment/join", { token: installToken }), BUSINESS_PLAN);

    // The organization's API key, and the directory's import with the one it had.
    expectRefused(await api.call(owner, "POST", `/api/organizations/${orgId}/api-key`, { masterPasswordHash: owner.password }), BUSINESS_PLAN);
    expectRefused(await directoryImport(request, apiToken, [nobody("families-directory")]), BUSINESS_PLAN);

    // Nobody came in by any of them.
    expect((await api.members(owner, orgId)).map((m) => m.email).sort()).toEqual([member.email, owner.email].sort());

    // Business again: each is there again.
    await operator.set(orgId, business());
    expectOk(await policy(true));
    expectOk(await api.call(owner, "POST", `/api/organizations/${orgId}/groups`, aGroup("Kids")));
    expect((await eventLog(api, owner, orgId)).length).toBeGreaterThan(0);
    expectOk(await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/enrollment`));
    expectOk(await invite(api, owner, orgId, [helper.email], 4, { manageUsers: true }));
  });
});

test.describe("where plans aren't enforced", () => {
  test.use({ baseURL: `https://127.0.0.1:${familiesOffServerPort}` });

  let server: FamiliesServer | undefined;
  let operator: Operator;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, familiesOffServerPort, false);
    operator = server.operator;
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("a family's plan changes nothing: every answer is an organization's with no plan, past six people and with every company feature", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const api = new Api(request);
    const owner = await api.account("families-off-owner");
    const familyId = await api.organization(owner, "Off Family");
    const plainId = await api.organization(owner, "Off Plain");
    await operator.set(familyId, families());

    // Two members in each.
    for (let n = 0; n < 2; n++) {
      for (const orgId of [familyId, plainId]) {
        await api.addMember(owner, orgId, await api.account(`families-off-${n}`), "user");
      }
    }

    /** An answer about one organization, with its id and name taken out, so two can be compared byte for byte. */
    const same = (answer: Result, orgId: string, name: string) =>
      JSON.stringify(answer.body).replaceAll(orgId, "<org>").replaceAll(name, "<name>");
    const compare = async (method: "GET" | "POST" | "PUT", tail: (orgId: string) => string, data?: unknown) => {
      const a = await api.call(owner, method, `/api/organizations/${familyId}${tail(familyId)}`, data);
      const b = await api.call(owner, method, `/api/organizations/${plainId}${tail(plainId)}`, data);
      expect(a.status, `${method} ${tail("<org>")}`).toBe(b.status);
      expect(same(a, familyId, "Off Family"), `${method} ${tail("<org>")}`).toBe(same(b, plainId, "Off Plain"));
      return a;
    };

    // The organization, its billing metadata, and its entry in the sync.
    const itself = await compare("GET", () => "");
    expect(itself.body.seats).toBeNull();
    const metadata = await compare("GET", () => "/billing/vnext/self-host/metadata");
    expect(metadata.body).toEqual({ isOnSecretsManagerStandalone: false, organizationOccupiedSeats: 0 });
    await compare("PUT", () => "", { name: "Off Org", billingEmail: owner.email });
    const family = await orgOf(api, owner, familyId);
    const plain = await orgOf(api, owner, plainId);
    for (const org of [family, plain]) {
      expect(org.seats).toBe(20);
      expect(org.keykeeperPlan).toEqual({ enforced: false });
    }
    // Apart from whose it is, the two entries are the same.
    const apart = (org: any) => ({ ...org, id: null, name: null, organizationUserId: null });
    expect(apart(family)).toEqual(apart(plain));
    await compare("GET", () => "/groups");

    // Seven and more people.
    for (let n = 0; n < 6; n++) {
      expectOk(await invite(api, owner, familyId, [nobody(`families-off-more-${n}`)]));
    }
    expect((await api.members(owner, familyId)).length).toBe(9);

    // Every company feature.
    expectOk(await api.call(owner, "PUT", `/api/organizations/${familyId}/policies/6`, { policy: { enabled: true, data: null } }));
    expectOk(await api.call(owner, "POST", `/api/organizations/${familyId}/groups`, aGroup("Kids")));
    expectOk(await invite(api, owner, familyId, [(await api.account("families-off-helper")).email], 4, { manageUsers: true }));
    expectOk(await api.call(owner, "GET", `/api/keykeeper/organizations/${familyId}/enrollment`));
    expectOk(await api.call(owner, "POST", `/api/keykeeper/organizations/${familyId}/enrollment`));
    expectOk(
      await api.call(owner, "POST", `/api/keykeeper/organizations/${familyId}/provisioning/token`, { masterPasswordHash: owner.password }),
    );
    expectOk(await api.call(owner, "POST", `/api/organizations/${familyId}/api-key`, { masterPasswordHash: owner.password }));
  });
});

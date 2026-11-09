// A default policy an MSP requires for every client: it reaches every client,
// those with their own setting too, and nobody can change it in a client's
// admin console (its own owners, a point of contact, the MSP's own staff)
// until the MSP stops requiring it. Stopping changes nothing in the clients:
// each keeps the setting and follows the default again, and the MSP is told
// which clients had their own setting before. See DESIGN.md, "Required for
// every client".
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, request as apiRequest, test } from "@playwright/test";

import { singleOrgServerPort } from "../../paths.mjs";

import { type Account, Api } from "./support";

const TWO_STEP = 0;
const MASTER_PASSWORD = 1;
const SINGLE_ORG = 3;
const DISABLE_SEND = 6;
const RESET_PASSWORD = 8;
const ADMIN_TWO_STEP = 1000;

const STRONG = {
  minComplexity: 3,
  minLength: 12,
  requireUpper: false,
  requireLower: false,
  requireNumbers: false,
  requireSpecial: false,
  enforceOnLogin: false,
};

type Named = { id: string; name: string };
type Policy = { type: number; enabled: boolean; data: any; required?: boolean; hadOwn?: Named[] };
type Overview = {
  types: number[];
  defaults: Policy[];
  prerequisites: { type: number; needs: number[] }[];
  clients: { id: string; name: string; own: Policy[]; notInStep: Policy[] }[];
};
type Outcome = { changed: Named[]; kept: Named[]; refused: (Named & { error: string })[]; hadOwn?: Named[] };

const names = (clients: Named[]) => clients.map((c) => c.name).sort();
const requiredMessage = (msp: string) =>
  `${msp} requires this policy for every client, so it can only be changed in ${msp}'s console.`;

async function overview(api: Api, who: Account, mspId: string) {
  const result = await api.call(who, "GET", `/api/keykeeper/msp/${mspId}/policies`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as Overview;
}

async function defaultOf(api: Api, who: Account, mspId: string, type: number) {
  return (await overview(api, who, mspId)).defaults.find((p) => p.type === type)!;
}

/** Saves a default, required for every client or not. */
async function setDefault(
  api: Api,
  admin: Account,
  mspId: string,
  type: number,
  policy: { enabled: boolean; data: unknown; required?: boolean; keep?: string[] },
) {
  const result = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${type}`, policy);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as Outcome;
}

/** A client's policy, as its admin console reads it. */
async function clientPolicy(api: Api, who: Account, orgId: string, type: number) {
  const result = await api.call(who, "GET", `/api/organizations/${orgId}/policies/${type}`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as { enabled: boolean; data: any; canToggleState?: boolean };
}

/** Saves a client's policy in its admin console, and gives the raw answer. */
async function putClientPolicy(api: Api, who: Account, orgId: string, type: number, enabled: boolean, data: unknown) {
  return api.call(who, "PUT", `/api/organizations/${orgId}/policies/${type}`, { policy: { enabled, data } });
}

/** The policy types where a client has its own setting, and where it isn't in step. */
async function clientState(api: Api, who: Account, mspId: string, orgId: string) {
  const client = (await overview(api, who, mspId)).clients.find((c) => c.id === orgId);
  expect(client, `client ${orgId}`).toBeTruthy();
  return {
    own: client!.own.map((p) => p.type).sort((a, b) => a - b),
    notInStep: client!.notInStep.map((p) => p.type).sort((a, b) => a - b),
  };
}

async function memberId(api: Api, owner: Account, orgId: string, who: Account) {
  return (await api.members(owner, orgId)).find((m) => m.email === who.email)!.id;
}

test("requiring a default reaches the clients with their own setting, and nobody can change it in a client: its owners, a point of contact, or the MSP's own staff", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const owner = await api.account("law-owner");
  const contact = await api.account("law-contact");
  const member = await api.account("law-member");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const law = await api.client(admin, mspId, "Baker Law", "business");
  const bakery = await api.client(admin, mspId, "Corner Bakery", "business");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);
  await api.addMember(admin, law, owner, "owner");
  await api.addCustomMember(owner, law, contact, { managePolicies: true });
  await api.addMember(owner, law, member, "user");

  // Baker Law asks for longer master passwords in its own admin console:
  // its own setting.
  const own = await putClientPolicy(api, owner, law, MASTER_PASSWORD, true, { ...STRONG, minLength: 14 });
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  expect((await clientState(api, admin, mspId, law)).own).toEqual([MASTER_PASSWORD]);

  // The MSP requires its default for every client. Only Baker Law differs.
  const required = await setDefault(api, admin, mspId, MASTER_PASSWORD, { enabled: true, data: STRONG, required: true });
  expect(names(required.changed)).toEqual(["Baker Law"]);
  expect(required.kept).toEqual([]);
  expect(required.refused).toEqual([]);
  expect((await clientPolicy(api, owner, law, MASTER_PASSWORD)).data.minLength).toBe(12);
  const seen = await defaultOf(api, admin, mspId, MASTER_PASSWORD);
  expect(seen.required).toBe(true);
  expect(names(seen.hadOwn!)).toEqual(["Baker Law"]);
  expect(await clientState(api, admin, mspId, law)).toEqual({ own: [], notInStep: [] });

  // Nobody changes it in a client, with a 400 (a 401 or 403 signs the web
  // vault out): the client's owner, its point of contact with the policies
  // permission, the MSP's admin, and its technician. Turning it off or
  // asking for something else, in a client that had its own setting or not.
  for (const who of [owner, contact, admin, tech]) {
    for (const [enabled, data] of [
      [false, null],
      [true, { ...STRONG, minLength: 14 }],
      [true, STRONG],
    ] as const) {
      const refused = await putClientPolicy(api, who, law, MASTER_PASSWORD, enabled, data);
      expect(refused.status, `${who.email}: ${JSON.stringify(refused.body)}`).toBe(400);
      expect(refused.body.message).toBe(requiredMessage("Northwind IT"));
    }
  }
  for (const who of [admin, tech]) {
    const refused = await putClientPolicy(api, who, dental, MASTER_PASSWORD, false, null);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe(requiredMessage("Northwind IT"));
  }
  expect((await clientPolicy(api, owner, law, MASTER_PASSWORD)).data.minLength).toBe(12);

  // Upstream's policy dialog won't offer to save it, and the Policies page
  // knows it's required, for everyone who can open it.
  for (const who of [owner, contact]) {
    expect((await clientPolicy(api, who, law, MASTER_PASSWORD)).canToggleState).toBe(false);
    const page = await api.call(who, "GET", `/api/keykeeper/organizations/${law}/msp-policies`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.msp.name).toBe("Northwind IT");
    expect(page.body.required).toEqual([
      { type: MASTER_PASSWORD, name: "Master password requirements", neededBy: null },
    ]);
  }
  // Anyone else gets "not found", never a refusal that signs them out.
  const notTheirs = await api.call(member, "GET", `/api/keykeeper/organizations/${law}/msp-policies`);
  expect(notTheirs.status).toBe(404);

  // Every other policy is still the client's to change.
  const send = await putClientPolicy(api, contact, law, DISABLE_SEND, true, null);
  expect(send.status, JSON.stringify(send.body)).toBe(200);
  expect((await clientPolicy(api, owner, law, DISABLE_SEND)).canToggleState).not.toBe(false);
  expect((await clientState(api, admin, mspId, law)).own).toEqual([DISABLE_SEND]);
  expect((await clientPolicy(api, admin, bakery, MASTER_PASSWORD)).data.minLength).toBe(12);

  // The audit log says it was required and how many clients changed.
  const events = (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`)).body.data as {
    event: string;
    detail: string;
  }[];
  expect(events.find((e) => e.event === "default_policy_required")?.detail).toBe(
    "Master password requirements for every client: 1 client changed",
  );
});

test("changing a required default changes every client, and new clients get it, even without the default policies", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const law = await api.client(admin, mspId, "Baker Law", "business");
  await setDefault(api, admin, mspId, MASTER_PASSWORD, { enabled: true, data: STRONG, required: true });

  // Left out, `required` stays as it is: still required, and it reaches
  // every client.
  const raised = await setDefault(api, admin, mspId, MASTER_PASSWORD, {
    enabled: true,
    data: { ...STRONG, minLength: 16 },
  });
  expect(names(raised.changed)).toEqual(["Acme Dental", "Baker Law"]);
  expect((await defaultOf(api, admin, mspId, MASTER_PASSWORD)).required).toBe(true);
  for (const org of [dental, law]) {
    expect((await clientPolicy(api, admin, org, MASTER_PASSWORD)).data.minLength).toBe(16);
  }
  // Followers changing with the default aren't "had their own setting".
  expect((await defaultOf(api, admin, mspId, MASTER_PASSWORD)).hadOwn).toEqual([]);

  // A new client gets it, with the default policies or without them.
  const delta = await api.client(admin, mspId, "Delta Co", "business");
  const bare = await api.client(admin, mspId, "Bare Co");
  for (const org of [delta, bare]) {
    expect((await clientPolicy(api, admin, org, MASTER_PASSWORD)).data.minLength).toBe(16);
  }
  // Without the default policies, only the required one.
  expect((await clientPolicy(api, admin, bare, SINGLE_ORG)).enabled).toBe(false);
  expect((await clientState(api, admin, mspId, bare)).notInStep).toEqual([]);

  // A required policy reaches every client, so none can be kept as it is,
  // and only a policy that's on can be required.
  const refused = async (body: unknown, message: RegExp) => {
    const result = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${MASTER_PASSWORD}`, body);
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect(result.body.message).toMatch(message);
  };
  await refused({ enabled: true, data: { ...STRONG, minLength: 20 }, keep: [law] }, /no client can keep/);
  await refused({ enabled: false, data: null, required: true }, /Only a policy that's on can be required/);
  await refused({ enabled: false, data: null }, /Only a policy that's on can be required/);
  expect((await clientPolicy(api, admin, law, MASTER_PASSWORD)).data.minLength).toBe(16);
});

test("stopping a requirement keeps every client's setting, unlocks it, and names the clients that had their own setting before", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const owner = await api.account("law-owner");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const law = await api.client(admin, mspId, "Baker Law", "business");
  const bakery = await api.client(admin, mspId, "Corner Bakery", "business");
  await api.addMember(admin, law, owner, "owner");
  expect((await putClientPolicy(api, owner, law, MASTER_PASSWORD, true, { ...STRONG, minLength: 14 })).status).toBe(
    200,
  );
  expect((await putClientPolicy(api, admin, bakery, MASTER_PASSWORD, false, null)).status).toBe(200);

  const required = await setDefault(api, admin, mspId, MASTER_PASSWORD, { enabled: true, data: STRONG, required: true });
  expect(names(required.changed)).toEqual(["Baker Law", "Corner Bakery"]);
  expect(names((await defaultOf(api, admin, mspId, MASTER_PASSWORD)).hadOwn!)).toEqual([
    "Baker Law",
    "Corner Bakery",
  ]);

  // Stopping: nothing changes, and the answer names the clients that had
  // their own setting before, which the MSP then forgets.
  const stopped = await setDefault(api, admin, mspId, MASTER_PASSWORD, {
    enabled: true,
    data: STRONG,
    required: false,
  });
  expect(stopped.changed).toEqual([]);
  expect(stopped.refused).toEqual([]);
  expect(names(stopped.hadOwn!)).toEqual(["Baker Law", "Corner Bakery"]);
  const after = await defaultOf(api, admin, mspId, MASTER_PASSWORD);
  expect(after.required).toBe(false);
  expect(after.hadOwn).toBeUndefined();
  for (const org of [dental, law, bakery]) {
    expect((await clientPolicy(api, admin, org, MASTER_PASSWORD)).data.minLength).toBe(12);
    // Every client follows the default again.
    expect((await clientState(api, admin, mspId, org)).own).toEqual([]);
  }

  // Unlocked: Baker Law's owner sets its own again.
  expect((await clientPolicy(api, owner, law, MASTER_PASSWORD)).canToggleState).not.toBe(false);
  const own = await putClientPolicy(api, owner, law, MASTER_PASSWORD, true, { ...STRONG, minLength: 14 });
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  expect((await clientState(api, admin, mspId, law)).own).toEqual([MASTER_PASSWORD]);

  // The record started over: requiring it again names only Baker Law.
  await setDefault(api, admin, mspId, MASTER_PASSWORD, { enabled: true, data: STRONG, required: true });
  const again = await setDefault(api, admin, mspId, MASTER_PASSWORD, { enabled: true, data: STRONG, required: false });
  expect(names(again.hadOwn!)).toEqual(["Baker Law"]);

  const events = (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`)).body.data as {
    event: string;
    detail: string;
  }[];
  expect(
    events
      .filter((e) => ["default_policy_required", "default_policy_unrequired"].includes(e.event))
      .map((e) => `${e.event}: ${e.detail}`),
  ).toEqual([
    "default_policy_unrequired: Master password requirements for every client: 1 client had its own setting before",
    "default_policy_required: Master password requirements for every client: 1 client changed",
    "default_policy_unrequired: Master password requirements for every client: 2 clients had their own setting before",
    "default_policy_required: Master password requirements for every client: 2 clients changed",
  ]);
  // Stopping a requirement without changing the default isn't a change to it.
  expect(events.filter((e) => e.event === "default_policy_changed")).toEqual([]);
});

test("a client that refuses a requirement isn't in step, stays locked, and takes it when tried again", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const second = await api.account("second-admin");
  const owner = await api.account("bakery-owner");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const bakery = await api.client(admin, mspId, "Corner Bakery", "business");
  await api.addStaff(admin, mspId, second, "admin");
  await api.confirmPending(admin, mspId);
  await api.addMember(admin, bakery, owner, "owner");
  const own = await putClientPolicy(api, owner, bakery, MASTER_PASSWORD, true, { ...STRONG, minLength: 14 });
  expect(own.status, JSON.stringify(own.body)).toBe(200);

  // Corner Bakery's own owner revokes the second admin there, who then has
  // no place of their own in it: requiring a policy, it refuses.
  const secondId = await memberId(api, owner, bakery, second);
  expect((await api.call(owner, "PUT", `/api/organizations/${bakery}/users/${secondId}/revoke`)).status).toBe(200);
  const required = await setDefault(api, second, mspId, MASTER_PASSWORD, {
    enabled: true,
    data: { ...STRONG, minLength: 13 },
    required: true,
  });
  expect(names(required.changed)).toEqual(["Acme Dental"]);
  expect(names(required.refused)).toEqual(["Corner Bakery"]);
  expect(required.refused[0].error).toMatch(/You don't have access to Corner Bakery yourself/);

  // It's still required, Corner Bakery shows as not in step (not as having
  // its own setting, nor yet as one that had it), and still nobody changes
  // it there.
  expect((await defaultOf(api, admin, mspId, MASTER_PASSWORD)).required).toBe(true);
  expect(await clientState(api, admin, mspId, bakery)).toEqual({ own: [], notInStep: [MASTER_PASSWORD] });
  expect((await defaultOf(api, admin, mspId, MASTER_PASSWORD)).hadOwn).toEqual([]);
  const locked = await putClientPolicy(api, owner, bakery, MASTER_PASSWORD, true, { ...STRONG, minLength: 13 });
  expect(locked.status).toBe(400);
  expect(locked.body.message).toBe(requiredMessage("Northwind IT"));

  // Restored, the second admin tries again: Corner Bakery takes it, and is
  // listed as having had its own setting before. Acme Dental followed the
  // default, so it isn't.
  expect((await api.call(owner, "PUT", `/api/organizations/${bakery}/users/${secondId}/restore`)).status).toBe(200);
  const retried = await api.call(second, "POST", `/api/keykeeper/msp/${mspId}/policies/${MASTER_PASSWORD}/apply`, {
    clients: [bakery],
  });
  expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  expect(names(retried.body.changed)).toEqual(["Corner Bakery"]);
  expect((await clientPolicy(api, owner, bakery, MASTER_PASSWORD)).data.minLength).toBe(13);
  expect(await clientState(api, admin, mspId, bakery)).toEqual({ own: [], notInStep: [] });
  expect(names((await defaultOf(api, admin, mspId, MASTER_PASSWORD)).hadOwn!)).toEqual(["Corner Bakery"]);
  expect((await clientPolicy(api, admin, dental, MASTER_PASSWORD)).data.minLength).toBe(13);
});

test("a client that removes its MSP is no longer bound, and keeps its settings", async ({ request }) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const owner = await api.account("law-owner");
  const mspId = await api.msp(admin, "Northwind IT");
  const law = await api.client(admin, mspId, "Baker Law", "business");
  await api.addMember(admin, law, owner, "owner");
  expect((await putClientPolicy(api, owner, law, MASTER_PASSWORD, true, { ...STRONG, minLength: 14 })).status).toBe(
    200,
  );
  await setDefault(api, admin, mspId, MASTER_PASSWORD, { enabled: true, data: STRONG, required: true });
  expect((await putClientPolicy(api, owner, law, MASTER_PASSWORD, false, null)).status).toBe(400);
  expect(names((await defaultOf(api, admin, mspId, MASTER_PASSWORD)).hadOwn!)).toEqual(["Baker Law"]);

  const removed = await api.call(owner, "DELETE", `/api/keykeeper/organizations/${law}/msp`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  // It keeps the setting the requirement gave it, and it's its own to change.
  expect((await clientPolicy(api, owner, law, MASTER_PASSWORD)).data.minLength).toBe(12);
  const page = await api.call(owner, "GET", `/api/keykeeper/organizations/${law}/msp-policies`);
  expect(page.body).toEqual({ msp: null, required: [], own: [] });
  expect((await clientPolicy(api, owner, law, MASTER_PASSWORD)).canToggleState).not.toBe(false);
  const changed = await putClientPolicy(api, owner, law, MASTER_PASSWORD, true, { ...STRONG, minLength: 14 });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  // And the MSP no longer lists it as having had its own setting.
  expect((await defaultOf(api, admin, mspId, MASTER_PASSWORD)).hadOwn).toEqual([]);
});

test("two-step login for admins can be required too, and a client's Settings page can't change it", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  // Added without the default policies: two-step login for admins is off.
  const bare = await api.client(admin, mspId, "Bare Co");
  expect((await clientState(api, admin, mspId, bare)).own).toContain(ADMIN_TWO_STEP);

  const required = await setDefault(api, admin, mspId, ADMIN_TWO_STEP, { enabled: true, data: null, required: true });
  expect(names(required.changed)).toEqual(["Bare Co"]);
  for (const org of [dental, bare]) {
    const setting = await api.call(admin, "GET", `/api/keykeeper/organizations/${org}/admin-two-step`);
    expect(setting.body).toMatchObject({ required: true, requiredByMsp: true });
    // Refused before anything else is asked, such as the master password.
    const off = await api.call(admin, "PUT", `/api/keykeeper/organizations/${org}/admin-two-step`, {
      required: false,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(400);
    expect(off.body.message).toBe(requiredMessage("Northwind IT"));
  }
  expect((await clientState(api, admin, mspId, bare)).own).not.toContain(ADMIN_TWO_STEP);
});

test("only MSP admins require a default or stop requiring it; technicians see which are required", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const owner = await api.account("dental-owner");
  const contact = await api.account("dental-contact");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);
  await api.addMember(admin, dental, owner, "owner");
  await api.addCustomMember(owner, dental, contact, { managePolicies: true });

  const path = `/api/keykeeper/msp/${mspId}/policies/${TWO_STEP}`;
  for (const who of [tech, owner, contact]) {
    const result = await api.call(who, "PUT", path, { enabled: true, data: null, required: true });
    expect([403, 404], `${who.email}: ${result.status}`).toContain(result.status);
  }
  expect((await defaultOf(api, admin, mspId, TWO_STEP)).required).toBe(false);

  await setDefault(api, admin, mspId, TWO_STEP, { enabled: true, data: null, required: true });
  const seen = await defaultOf(api, tech, mspId, TWO_STEP);
  expect(seen).toMatchObject({ enabled: true, required: true });
  for (const who of [tech, owner, contact]) {
    const result = await api.call(who, "PUT", path, { enabled: true, data: null, required: false });
    expect([403, 404], `${who.email}: ${result.status}`).toContain(result.status);
  }
  expect((await defaultOf(api, admin, mspId, TWO_STEP)).required).toBe(true);
});

// ---- What a required policy needs: account recovery needs single
// organization where the server enforces it, as Bitwarden always does. This
// test server sends email (account recovery is offered only then) and
// enforces it (KK_SINGLE_ORG_FOR_RECOVERY, e2e/server.mjs).

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

test.describe("on a server where account recovery needs single organization", () => {
  let server: ChildProcess;
  let dataDir: string;
  let http: APIRequestContext;

  test.beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-single-org-"));
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: e2eDir,
      env: {
        ...process.env,
        KK_PORT: singleOrgServerPort,
        KK_DATA_DIR: dataDir,
        KK_MAIL: "1",
        KK_SINGLE_ORG_FOR_RECOVERY: "1",
      },
      stdio: "ignore",
    });
    http = await apiRequest.newContext({
      baseURL: `https://127.0.0.1:${singleOrgServerPort}`,
      ignoreHTTPSErrors: true,
    });
    await expect
      .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
      .toBe(200);
  });

  test.afterAll(async () => {
    await http?.dispose();
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("a required policy keeps what it needs on: in every client, and as the MSP's default", async () => {
    test.setTimeout(180_000);
    const api = new Api(http);
    const admin = await api.account("msp-admin");
    const mspId = await api.msp(admin, "Northwind IT");
    const dental = await api.client(admin, mspId, "Acme Dental", "business");
    const start = await overview(api, admin, mspId);
    expect(start.types).toContain(RESET_PASSWORD);
    expect(start.prerequisites).toEqual([{ type: RESET_PASSWORD, needs: [SINGLE_ORG] }]);

    const recovery = (await defaultOf(api, admin, mspId, RESET_PASSWORD)).data;
    const required = await setDefault(api, admin, mspId, RESET_PASSWORD, {
      enabled: true,
      data: recovery,
      required: true,
    });
    expect(required.refused).toEqual([]);

    // In the client: single organization can't be turned off, by anyone,
    // and its dialog won't offer to.
    const off = await putClientPolicy(api, admin, dental, SINGLE_ORG, false, null);
    expect(off.status, JSON.stringify(off.body)).toBe(400);
    expect(off.body.message).toBe(
      "Northwind IT requires Account recovery administration for every client, which needs this policy on, so it can only be changed in Northwind IT's console.",
    );
    expect((await clientPolicy(api, admin, dental, SINGLE_ORG)).enabled).toBe(true);
    expect((await clientPolicy(api, admin, dental, SINGLE_ORG)).canToggleState).toBe(false);
    const page = await api.call(admin, "GET", `/api/keykeeper/organizations/${dental}/msp-policies`);
    expect(page.body.required).toEqual([
      { type: RESET_PASSWORD, name: "Account recovery administration", neededBy: null },
      { type: SINGLE_ORG, name: "Single organization", neededBy: "Account recovery administration" },
    ]);

    // As the MSP's default: it stays on.
    const defaultOff = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${SINGLE_ORG}`, {
      enabled: false,
      data: null,
    });
    expect(defaultOff.status, JSON.stringify(defaultOff.body)).toBe(400);
    expect(defaultOff.body.message).toBe(
      "Account recovery administration is required for every client and needs Single organization, so this default stays on.",
    );

    // Once it's no longer required, single organization's default can go off
    // (the client keeps it, as upstream refuses it there while account
    // recovery is on), and then account recovery can't be required until
    // single organization's default is on again.
    await setDefault(api, admin, mspId, RESET_PASSWORD, { enabled: true, data: recovery, required: false });
    const singleOff = await setDefault(api, admin, mspId, SINGLE_ORG, { enabled: false, data: null });
    expect(names(singleOff.refused)).toEqual(["Acme Dental"]);
    const again = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${RESET_PASSWORD}`, {
      enabled: true,
      data: recovery,
      required: true,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(400);
    expect(again.body.message).toBe(
      "Account recovery administration needs Single organization. Turn on the Single organization default first.",
    );
  });
});

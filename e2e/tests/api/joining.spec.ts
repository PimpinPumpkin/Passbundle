// How people join an organization: let in automatically (an owner's or
// admin's unlocked app confirms them in the background) or approved by an
// admin, and how long invitations last. Each organization can have its own
// setting; an MSP's clients otherwise follow the MSP's default, and other
// organizations the server's. See DESIGN.md, "Joining".
import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api } from "./support";

type Setting = { autoConfirm: boolean; inviteHours: number };
type OrgJoining = Setting & { source: "own" | "msp" | "server"; mspName?: string; default: Setting };
type Pending = { organizationId: string; email: string; autoConfirm: boolean };

const SERVER_DEFAULT: Setting = { autoConfirm: true, inviteHours: 120 };

async function joining(api: Api, who: Account, orgId: string): Promise<OrgJoining> {
  const result = await api.call(who, "GET", `/api/keykeeper/organizations/${orgId}/joining`);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

async function setJoining(api: Api, who: Account, orgId: string, setting: Setting) {
  const result = await api.call(who, "PUT", `/api/keykeeper/organizations/${orgId}/joining`, setting);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as OrgJoining;
}

const settingOf = (j: Setting): Setting => ({ autoConfirm: j.autoConfirm, inviteHours: j.inviteHours });

/** Invites an account without confirming it. The test server sends no email, so it's accepted at once. */
async function inviteOnly(api: Api, owner: Account, orgId: string, member: Account, type: 1 | 2) {
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [member.email],
    type,
    collections: [],
    groups: [],
    accessSecretsManager: false,
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
}

async function pending(api: Api, who: Account): Promise<Pending[]> {
  const result = await api.call(who, "GET", "/api/keykeeper/organizations/pending");
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.data;
}

test("an organization outside an MSP starts with the server's default, and can have its own", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Corner Bakery");

  const start = await joining(api, owner, orgId);
  expect(start).toMatchObject({ ...SERVER_DEFAULT, source: "server", default: SERVER_DEFAULT });

  const own = await setJoining(api, owner, orgId, { autoConfirm: false, inviteHours: 2 });
  expect(own).toMatchObject({ autoConfirm: false, inviteHours: 2, source: "own", default: SERVER_DEFAULT });

  // Between an hour and 30 days.
  for (const inviteHours of [0, 721]) {
    const refused = await api.call(owner, "PUT", `/api/keykeeper/organizations/${orgId}/joining`, {
      autoConfirm: true,
      inviteHours,
    });
    expect(refused.status, `${inviteHours} hours`).toBe(400);
  }
  expect(settingOf(await joining(api, owner, orgId))).toEqual({ autoConfirm: false, inviteHours: 2 });

  const reset = await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/joining`);
  expect(reset.status).toBe(200);
  expect(reset.body).toMatchObject({ ...SERVER_DEFAULT, source: "server" });
});

test("an MSP's clients follow its default until one has its own setting, and go back on request", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental");
  const law = await api.client(admin, mspId, "Baker Law");

  expect(await joining(api, admin, dental)).toMatchObject({ ...SERVER_DEFAULT, source: "msp", mspName: "Northwind IT" });

  const setDefault = async (setting: Setting) => {
    const result = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/joining`, setting);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body as { default: Setting; ownSettings: { name: string }[] };
  };
  await setDefault({ autoConfirm: false, inviteHours: 24 });
  for (const client of [dental, law]) {
    expect(settingOf(await joining(api, admin, client))).toEqual({ autoConfirm: false, inviteHours: 24 });
  }

  // Baker Law's own setting; a later default leaves it alone.
  await setJoining(api, admin, law, { autoConfirm: true, inviteHours: 2 });
  const overview = await setDefault({ autoConfirm: true, inviteHours: 120 });
  expect(overview.default).toEqual({ autoConfirm: true, inviteHours: 120 });
  expect(overview.ownSettings.map((c) => c.name)).toEqual(["Baker Law"]);
  expect(settingOf(await joining(api, admin, dental))).toEqual({ autoConfirm: true, inviteHours: 120 });
  // Its own setting, with the MSP and its default to go back to.
  expect(await joining(api, admin, law)).toMatchObject({
    autoConfirm: true,
    inviteHours: 2,
    source: "own",
    mspName: "Northwind IT",
    default: { autoConfirm: true, inviteHours: 120 },
  });

  const reset = await api.call(admin, "DELETE", `/api/keykeeper/organizations/${law}/joining`);
  expect(reset.body).toMatchObject({ autoConfirm: true, inviteHours: 120, source: "msp" });

  const events = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  const recorded = (events.body.data as { event: string }[]).map((e) => e.event);
  for (const event of ["joining_default_set", "client_joining_set", "client_joining_default"]) {
    expect(recorded, event).toContain(event);
  }
});

test("who's waiting: owners see everyone, admins regular members, each with its organization's setting", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const auto = await api.organization(owner, "Auto Co");
  const approval = await api.organization(owner, "Approval Co");
  await setJoining(api, owner, approval, { autoConfirm: false, inviteHours: 120 });

  const admin = await api.account("admin");
  await api.addMember(owner, auto, admin, "admin");
  const user = await api.account("user");
  await inviteOnly(api, owner, auto, user, 2);
  const newAdmin = await api.account("new-admin");
  await inviteOnly(api, owner, auto, newAdmin, 1);
  const elsewhere = await api.account("elsewhere");
  await inviteOnly(api, owner, approval, elsewhere, 2);

  const byEmail = (list: Pending[]) =>
    Object.fromEntries(list.map((p) => [p.email, { org: p.organizationId, auto: p.autoConfirm }]));
  expect(byEmail(await pending(api, owner))).toEqual({
    [user.email]: { org: auto, auto: true },
    [newAdmin.email]: { org: auto, auto: true },
    [elsewhere.email]: { org: approval, auto: false },
  });
  // Upstream's rule: admins confirm regular members, not other admins.
  expect(byEmail(await pending(api, admin))).toEqual({ [user.email]: { org: auto, auto: true } });
  expect(await pending(api, user)).toEqual([]);
  expect(await pending(api, await api.account("stranger"))).toEqual([]);
});

test("the MSP console's list of who's waiting says whether each client lets people in automatically", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Tailspin IT");
  const dental = await api.client(admin, mspId, "Acme Dental");
  await setJoining(api, admin, dental, { autoConfirm: false, inviteHours: 120 });
  const person = await api.account("person");
  await inviteOnly(api, admin, dental, person, 2);
  const listed = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  const entry = (listed.body.data as (Pending & { email: string })[]).find((p) => p.email === person.email);
  expect(entry).toMatchObject({ organizationId: dental, autoConfirm: false });
});

type OrgActor = "owner" | "admin" | "user" | "manageUsers" | "stranger" | "anonymous";
const ORG_ACTORS: readonly OrgActor[] = ["owner", "admin", "user", "manageUsers", "stranger", "anonymous"];
type OrgCtx = { api: Api; orgId: string; owner: Account };

/** A different lifetime per caller, so a change shows who made it. */
const hoursFor = (caller: string) => 10 + ORG_ACTORS.indexOf(caller as OrgActor);

const orgRows: MatrixRow<OrgActor, OrgCtx>[] = [
  {
    name: "see how people join",
    allowed: ["owner", "admin"],
    request: async ({ orgId }) => ({ method: "GET", path: `/api/keykeeper/organizations/${orgId}/joining` }),
  },
  {
    name: "set how people join",
    allowed: ["owner", "admin"],
    request: async ({ api, orgId, owner }, caller) => ({
      method: "PUT",
      path: `/api/keykeeper/organizations/${orgId}/joining`,
      data: { autoConfirm: false, inviteHours: hoursFor(caller) },
      check: async (allowed) => {
        const hours = (await joining(api, owner, orgId)).inviteHours;
        expect(hours === hoursFor(caller), `${caller}'s change`).toBe(allowed);
      },
    }),
  },
  {
    name: "put the organization back on the default",
    allowed: ["owner", "admin"],
    request: async ({ api, orgId, owner }) => {
      await setJoining(api, owner, orgId, { autoConfirm: false, inviteHours: 3 });
      return {
        method: "DELETE",
        path: `/api/keykeeper/organizations/${orgId}/joining`,
        check: async (allowed) => {
          expect((await joining(api, owner, orgId)).source === "server").toBe(allowed);
        },
      };
    },
  },
];

test.describe("Joining permissions in an organization", () => {
  permissionMatrix(
    ORG_ACTORS,
    async (api) => {
      const owner = await api.account("owner");
      const orgId = await api.organization(owner, "Joining Org");
      const admin = await api.account("admin");
      await api.addMember(owner, orgId, admin, "admin");
      const user = await api.account("user");
      await api.addMember(owner, orgId, user, "user");
      const manageUsers = await api.account("manage-users");
      await api.addCustomMember(owner, orgId, manageUsers, { manageUsers: true });
      return {
        ctx: { api, orgId, owner },
        callers: { owner, admin, user, manageUsers, stranger: await api.account("stranger"), anonymous: null },
      };
    },
    orgRows,
  );
});

type MspActor = "mspAdmin" | "technician" | "otherMspAdmin" | "anonymous";
const MSP_ACTORS: readonly MspActor[] = ["mspAdmin", "technician", "otherMspAdmin", "anonymous"];
type MspCtx = { api: Api; mspId: string; admin: Account };

const mspRows: MatrixRow<MspActor, MspCtx>[] = [
  {
    name: "see the MSP's joining default",
    allowed: ["mspAdmin", "technician"],
    request: async ({ mspId }) => ({ method: "GET", path: `/api/keykeeper/msp/${mspId}/joining` }),
  },
  {
    name: "set the MSP's joining default",
    allowed: ["mspAdmin"],
    request: async ({ api, mspId, admin }, caller) => ({
      method: "PUT",
      path: `/api/keykeeper/msp/${mspId}/joining`,
      data: { autoConfirm: true, inviteHours: 20 + MSP_ACTORS.indexOf(caller) },
      check: async (allowed) => {
        const view = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/joining`);
        expect(view.body.default.inviteHours === 20 + MSP_ACTORS.indexOf(caller)).toBe(allowed);
      },
    }),
  },
];

test.describe("Joining permissions in an MSP", () => {
  permissionMatrix(
    MSP_ACTORS,
    async (api) => {
      const admin = await api.account("msp-admin");
      const mspId = await api.msp(admin, "Joining MSP");
      await api.client(admin, mspId, "Joining Client");
      const technician = await api.account("technician");
      await api.addStaff(admin, mspId, technician, "technician");
      const otherMspAdmin = await api.account("other-msp-admin");
      await api.msp(otherMspAdmin, "Other MSP");
      return {
        ctx: { api, mspId, admin },
        callers: { mspAdmin: admin, technician, otherMspAdmin, anonymous: null },
      };
    },
    mspRows,
  );
});

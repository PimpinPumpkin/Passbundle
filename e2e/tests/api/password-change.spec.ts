// Assisted password change in an organization (DESIGN.md, "Assisted password
// change", "Organizations" and "Activity"): the organization's setting, on by
// default, which its owners, admins, and its MSP's admins turn off, and an MSP
// as a default policy; its members learn it in sync. And the two events the
// extension sends: a change saved a new password to one of its items (1192),
// and someone put an item's earlier password back (1193). The server takes
// them only for a login of an organization that allows it, which the sender
// can edit and see the password of, so nobody else can write them.
import { expect, test } from "@playwright/test";

import { type Account, Api, encString } from "./support";

const PASSWORD_CHANGE_OFF = 1001;
const CHANGED = 1192;
const PUT_BACK = 1193;
const TURNED_ON = 1680;
const TURNED_OFF = 1681;

const setting = (api: Api, who: Account, orgId: string) =>
  api.call(who, "GET", `/api/keykeeper/organizations/${orgId}/password-change`);
const setTo = (api: Api, who: Account, orgId: string, allowed: boolean) =>
  api.call(who, "PUT", `/api/keykeeper/organizations/${orgId}/password-change`, { allowed });

/** What a member's apps learn in sync: whether the organization allows it. */
async function inSync(api: Api, who: Account, orgId: string): Promise<unknown> {
  const profile = await api.call(who, "GET", "/api/accounts/profile");
  return profile.body.organizations.find((o: { id: string }) => o.id === orgId)?.keykeeperPasswordChange;
}

const range = () => {
  const now = Date.now();
  return `start=${new Date(now - 3_600_000).toISOString()}&end=${new Date(now + 3_600_000).toISOString()}`;
};

async function orgEvents(api: Api, owner: Account, orgId: string) {
  const events = await api.call(owner, "GET", `/api/organizations/${orgId}/events?${range()}`);
  expect(events.status, JSON.stringify(events.body)).toBe(200);
  return events.body.data as { type: number; actingUserId: string; cipherId?: string }[];
}

async function itemEvents(api: Api, owner: Account, cipherId: string) {
  const events = await api.call(owner, "GET", `/api/ciphers/${cipherId}/events?${range()}`);
  expect(events.status, JSON.stringify(events.body)).toBe(200);
  return events.body.data as { type: number; actingUserId: string }[];
}

/** What the extension sends for an item, as upstream's apps send client events. */
async function send(api: Api, who: Account, type: number, cipherId: string, organizationId: string | null) {
  const sent = await api.call(who, "POST", "/events/collect", [
    { type, cipherId, organizationId, date: new Date().toISOString() },
  ]);
  // Upstream's endpoint answers 200 whether or not it keeps them.
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
}

function login(owner: Account, organizationId: string | null) {
  return {
    type: 1,
    name: encString("name"),
    notes: null,
    login: { username: encString("username"), password: encString("password"), uris: null, totp: null },
    organizationId,
    encryptedFor: owner.userId,
    favorite: false,
    reprompt: 0,
    fields: [],
  };
}

test("an organization allows it by default, and its owners and admins turn it off and on, in sync and in its event log", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("pc-owner");
  const admin = await api.account("pc-admin");
  const member = await api.account("pc-member");
  const manager = await api.account("pc-manager");
  const outsider = await api.account("pc-outsider");
  const orgId = await api.organization(owner, "Password Change Org");
  await api.addMember(owner, orgId, admin, "admin");
  await api.addMember(owner, orgId, member, "user");
  await api.addMember(owner, orgId, manager, "manager");

  expect((await setting(api, owner, orgId)).body).toMatchObject({ allowed: true, msp: null, requiredByMsp: false });
  expect(await inSync(api, member, orgId)).toBe(true);

  // Only owners and admins read or change it; anyone else gets "not found".
  for (const who of [member, manager, outsider]) {
    expect((await setting(api, who, orgId)).status).toBe(404);
    expect((await setTo(api, who, orgId, false)).status).toBe(404);
  }
  expect(await inSync(api, member, orgId)).toBe(true);

  const off = await setTo(api, admin, orgId, false);
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.allowed).toBe(false);
  expect(await inSync(api, member, orgId)).toBe(false);
  // The same again changes nothing, and logs nothing more.
  expect((await setTo(api, admin, orgId, false)).status).toBe(200);
  const on = await setTo(api, owner, orgId, true);
  expect(on.body.allowed).toBe(true);
  expect(await inSync(api, member, orgId)).toBe(true);

  const events = (await orgEvents(api, owner, orgId)).filter((e) => [TURNED_ON, TURNED_OFF].includes(e.type));
  expect(events.map((e) => [e.type, e.actingUserId]).sort()).toEqual(
    [
      [TURNED_OFF, admin.userId],
      [TURNED_ON, owner.userId],
    ].sort(),
  );
});

test("an MSP's admins change it in a client, technicians don't, and an MSP turns it off by default and can require that", async ({
  request,
}) => {
  const api = new Api(request);
  const mspAdmin = await api.account("pc-msp-admin");
  const technician = await api.account("pc-msp-tech");
  const member = await api.account("pc-client-member");
  const mspId = await api.msp(mspAdmin, "Password Change MSP");
  await api.addStaff(mspAdmin, mspId, technician, "technician");
  const clientId = await api.client(mspAdmin, mspId, "Lakeside Clinic");
  await api.addMember(mspAdmin, clientId, member, "user");

  // A client starts allowing it, following the MSP (which has no such default).
  expect((await setting(api, mspAdmin, clientId)).body).toMatchObject({
    allowed: true,
    msp: { id: mspId, name: "Password Change MSP" },
  });
  const overview = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`);
  expect(overview.body.types).toContain(PASSWORD_CHANGE_OFF);
  const own = async () =>
    (
      (await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`)).body.clients.find(
        (c: { id: string }) => c.id === clientId,
      ).own as { type: number }[]
    ).map((p) => p.type);
  expect(await own()).not.toContain(PASSWORD_CHANGE_OFF);
  expect((await setting(api, technician, clientId)).status).toBe(404);

  // An MSP admin turns it off in the client's own settings: its own setting
  // from then on, in the MSP's activity log.
  expect((await setTo(api, mspAdmin, clientId, false)).status).toBe(200);
  expect(await inSync(api, member, clientId)).toBe(false);
  expect(await own()).toContain(PASSWORD_CHANGE_OFF);
  const activity = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  expect(
    (activity.body.data as { event: string; detail: string | null }[]).map((e) => `${e.event}:${e.detail}`),
  ).toContain("client_password_change_set:off");

  // Use default puts it back as the MSP has it: allowed.
  const back = await api.call(mspAdmin, "POST", `/api/keykeeper/msp/${mspId}/policies/${PASSWORD_CHANGE_OFF}/apply`, {
    clients: [clientId],
  });
  expect(back.status, JSON.stringify(back.body)).toBe(200);
  expect(await inSync(api, member, clientId)).toBe(true);

  // A default that turns it off reaches every client that follows.
  const offByDefault = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${PASSWORD_CHANGE_OFF}`, {
    enabled: true,
    data: null,
  });
  expect(offByDefault.status, JSON.stringify(offByDefault.body)).toBe(200);
  expect(offByDefault.body.changed.map((c: { id: string }) => c.id)).toEqual([clientId]);
  expect(await inSync(api, member, clientId)).toBe(false);
  expect(await own()).not.toContain(PASSWORD_CHANGE_OFF);

  // Required for every client: nobody changes it in the client, and its page says so.
  const required = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${PASSWORD_CHANGE_OFF}`, {
    enabled: true,
    data: null,
    required: true,
  });
  expect(required.status, JSON.stringify(required.body)).toBe(200);
  const refused = await setTo(api, mspAdmin, clientId, true);
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(/requires this policy for every client/);
  expect((await setting(api, mspAdmin, clientId)).body).toMatchObject({ allowed: false, requiredByMsp: true });
  expect(await inSync(api, member, clientId)).toBe(false);
});

test("the events are taken only for a login the sender can edit and see the password of, in an organization that allows it", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("pc-ev-owner");
  const orgId = await api.organization(owner, "Password Change Events");
  const [editor, viewer, hidden, outsider] = await Promise.all(
    ["pc-ev-editor", "pc-ev-viewer", "pc-ev-hidden", "pc-ev-outsider"].map((name) => api.account(name)),
  );
  for (const who of [editor, viewer, hidden]) {
    await api.addMember(owner, orgId, who, "user");
  }
  const collection = await api.collection(owner, orgId);
  const members = await api.members(owner, orgId);
  const memberId = (who: Account) => members.find((m) => m.email === who.email)!.id;
  const shared = await api.call(owner, "PUT", `/api/organizations/${orgId}/collections/${collection}`, {
    name: encString("shared"),
    groups: [],
    users: [
      { id: memberId(editor), readOnly: false, hidePasswords: false, manage: false },
      { id: memberId(viewer), readOnly: true, hidePasswords: false, manage: false },
      { id: memberId(hidden), readOnly: false, hidePasswords: true, manage: false },
    ],
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  const created = await api.call(owner, "POST", "/api/ciphers/create", {
    cipher: login(owner, orgId),
    collectionIds: [collection],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const item = created.body.id as string;
  // A note in the same folder: only logins have passwords to change.
  const note = await api.orgItem(owner, orgId, collection);

  // Refused: read-only, hidden passwords, someone outside, and a note.
  for (const who of [viewer, hidden, outsider]) {
    await send(api, who, CHANGED, item, orgId);
    await send(api, who, PUT_BACK, item, orgId);
  }
  await send(api, editor, CHANGED, note, orgId);
  // Naming another organization doesn't move it there or let it in.
  await send(api, outsider, CHANGED, item, null);
  expect((await itemEvents(api, owner, item)).filter((e) => [CHANGED, PUT_BACK].includes(e.type))).toEqual([]);
  expect((await itemEvents(api, owner, note)).filter((e) => e.type === CHANGED)).toEqual([]);

  // Taken: the editor's, in the organization's log for that item.
  await send(api, editor, CHANGED, item, orgId);
  await send(api, editor, PUT_BACK, item, null);
  const taken = (await itemEvents(api, owner, item)).filter((e) => [CHANGED, PUT_BACK].includes(e.type));
  expect(taken.map((e) => [e.type, e.actingUserId]).sort()).toEqual(
    [
      [CHANGED, editor.userId],
      [PUT_BACK, editor.userId],
    ].sort(),
  );

  // Not while the organization has it off.
  expect((await setTo(api, owner, orgId, false)).status).toBe(200);
  await send(api, editor, CHANGED, item, orgId);
  expect((await itemEvents(api, owner, item)).filter((e) => e.type === CHANGED)).toHaveLength(1);

  // A personal item has no organization to log it in.
  const mine = await api.call(editor, "POST", "/api/ciphers", login(editor, null));
  expect(mine.status, JSON.stringify(mine.body)).toBe(200);
  await send(api, editor, CHANGED, mine.body.id, null);
  await send(api, editor, CHANGED, mine.body.id, orgId);
  expect((await orgEvents(api, owner, orgId)).filter((e) => e.cipherId === mine.body.id)).toEqual([]);
});

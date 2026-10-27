// Item history (DESIGN.md, "Item history"): every edit keeps the item as it
// was, encrypted as it was stored, with who saved it; an item keeps its newest
// versions and one a day before them, within size limits; only people who can
// open the item read them (without the encrypted fields when they can't see
// its passwords); people who can delete it can clear them; and they go with
// the item, when it moves into an organization, and when its owner's key
// changes.
import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api, encString, publicKey, serverDatabase } from "./support";

type Editor = { id: string | null; name: string | null; email: string | null } | null;
type Version = {
  object: string;
  id: string;
  revisionDate: string;
  savedBy: Editor;
  replacedDate: string;
  replacedBy: Editor;
  cipher: { id: string; key: string | null; organizationId: string | null; login: { password: string } } | null;
};

const ANOTHER_MEMBER = { id: null, name: null, email: null };
const named = (who: Account, name: string) => ({ id: who.userId, name, email: who.email });
const password = (label: string) => encString(`password-${label}`);

/** A stand-in login, with a password made from a label. */
function login(owner: Account, organizationId: string | null, label: string) {
  return {
    type: 1,
    name: encString("name"),
    notes: null,
    login: { username: encString("username"), password: password(label), uris: null, totp: null },
    organizationId,
    encryptedFor: owner.userId,
    favorite: false,
    reprompt: 0,
    fields: [],
  };
}

async function personalLogin(api: Api, owner: Account, label: string): Promise<string> {
  const created = await api.call(owner, "POST", "/api/ciphers", login(owner, null, label));
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id;
}

async function orgLogin(api: Api, owner: Account, orgId: string, collectionId: string, label: string) {
  const created = await api.call(owner, "POST", "/api/ciphers/create", {
    cipher: login(owner, orgId, label),
    collectionIds: [collectionId],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}

/** Saves the item as an app would after changing its password. */
async function setPassword(api: Api, who: Account, id: string, label: string) {
  const current = await api.call(who, "GET", `/api/ciphers/${id}`);
  expect(current.status, JSON.stringify(current.body)).toBe(200);
  const saved = await api.call(who, "PUT", `/api/ciphers/${id}`, {
    ...current.body,
    login: { ...current.body.login, password: password(label) },
    encryptedFor: who.userId,
    lastKnownRevisionDate: current.body.revisionDate,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return saved.body;
}

const history = (api: Api, who: Account | null, id: string) =>
  api.call(who, "GET", `/api/keykeeper/ciphers/${id}/history`);

async function versions(api: Api, who: Account, id: string): Promise<Version[]> {
  const read = await history(api, who, id);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data;
}

const passwords = (list: Version[]) => list.map((v) => v.cipher?.login.password);

/** A collection with these members, as its organization's owner sets it. */
async function shareCollection(
  api: Api,
  owner: Account,
  orgId: string,
  users: { member: Account; readOnly?: boolean; hidePasswords?: boolean }[],
  collection?: string,
) {
  collection ??= await api.collection(owner, orgId);
  const members = await api.members(owner, orgId);
  const shared = await api.call(owner, "PUT", `/api/organizations/${orgId}/collections/${collection}`, {
    name: encString("shared"),
    groups: [],
    users: users.map(({ member, readOnly = false, hidePasswords = false }) => ({
      id: members.find((m) => m.email === member.email)!.id,
      readOnly,
      hidePasswords,
      manage: false,
    })),
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  return collection;
}

/** Whether `who` sees names in the item's history: exactly when they can list the organization's members. */
async function seesNames(api: Api, who: Account, orgId: string, id: string, someoneElse: Account) {
  const lists = (await api.call(who, "GET", `/api/organizations/${orgId}/users`)).status === 200;
  const read = await history(api, who, id);
  expect(read.status, `${who.email}: ${JSON.stringify(read.body)}`).toBe(200);
  const others = read.body.data
    .flatMap((v: Version) => [v.savedBy, v.replacedBy])
    .filter((e: Editor) => e && e.id !== who.userId);
  expect(others.length, "someone else saved a version").toBeGreaterThan(0);
  const shown = others.every((e: Editor) => e!.email === someoneElse.email || e!.email != null);
  const hidden = others.every((e: Editor) => e!.id === null && e!.email === null);
  expect(shown || hidden, JSON.stringify(others)).toBe(true);
  expect(shown, `${who.email} lists members: ${lists}`).toBe(lists);
  return lists;
}

test("each edit keeps the item as it was, newest first, with who saved it", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const id = await personalLogin(api, ana, "one");

  const fresh = await history(api, ana, id);
  expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  expect(fresh.body).toMatchObject({ object: "keykeeperCipherHistory", cipherId: id, hidePasswords: false, data: [] });
  expect(fresh.body.savedBy).toEqual(named(ana, "ana"));

  const afterOne = await api.call(ana, "GET", `/api/ciphers/${id}`);
  await setPassword(api, ana, id, "two");
  const afterTwo = await setPassword(api, ana, id, "three");

  const list = await versions(api, ana, id);
  expect(passwords(list)).toEqual([password("two"), password("one")]);
  for (const version of list) {
    expect(version.object).toBe("keykeeperCipherVersion");
    // Each opens like the item: its id and owner, and its own fields.
    expect(version.cipher).toMatchObject({ id, organizationId: null, key: null });
    expect(version.savedBy).toEqual(named(ana, "ana"));
    expect(version.replacedBy).toEqual(named(ana, "ana"));
  }
  // When each was saved, and when the next save replaced it.
  expect(list[1].revisionDate).toBe(afterOne.body.revisionDate);
  expect(list[1].replacedDate).toBe(list[0].revisionDate);
  expect(list[0].replacedDate).toBe(afterTwo.revisionDate);
  expect((await history(api, ana, id)).body.revisionDate).toBe(afterTwo.revisionDate);
});

test("a save that leaves the encrypted fields as they are, and moving folders, keep nothing", async ({
  request,
}) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const id = await personalLogin(api, ana, "one");
  await setPassword(api, ana, id, "two");
  expect(await versions(api, ana, id)).toHaveLength(1);

  // The same encrypted fields again, with a favorite.
  const current = await api.call(ana, "GET", `/api/ciphers/${id}`);
  const same = await api.call(ana, "PUT", `/api/ciphers/${id}`, {
    ...current.body,
    favorite: true,
    encryptedFor: ana.userId,
    lastKnownRevisionDate: current.body.revisionDate,
  });
  expect(same.status, JSON.stringify(same.body)).toBe(200);

  // Into a folder, which isn't part of the item's encrypted fields.
  const folder = await api.call(ana, "POST", "/api/folders", { name: encString("folder") });
  expect(folder.status).toBe(200);
  const moved = await api.call(ana, "PUT", `/api/ciphers/${id}/partial`, { folderId: folder.body.id, favorite: true });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);

  expect(passwords(await versions(api, ana, id))).toEqual([password("one")]);
});

test("edits through sharing keep a version too, naming who saved it and who replaced it", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const editor = await api.account("editor");
  const orgId = await api.organization(owner, "Share Edits Org");
  await api.addMember(owner, orgId, editor, "user");
  const collection = await shareCollection(api, owner, orgId, [{ member: editor }]);
  const id = await orgLogin(api, owner, orgId, collection, "one");

  // An edit through the share endpoint, with no revision date, as some apps send it.
  const shared = await api.call(editor, "PUT", `/api/ciphers/${id}/share`, {
    cipher: login(editor, orgId, "two"),
    collectionIds: [collection],
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  // And through bulk sharing, which apps use to move several items at once.
  const bulk = await api.call(owner, "PUT", "/api/ciphers/share", {
    ciphers: [{ ...login(owner, orgId, "three"), id }],
    collectionIds: [collection],
  });
  expect(bulk.status, JSON.stringify(bulk.body)).toBe(200);

  const read = (await history(api, owner, id)).body;
  expect(passwords(read.data)).toEqual([password("two"), password("one")]);
  expect(read.data.map((v: Version) => [v.savedBy, v.replacedBy])).toEqual([
    [named(editor, "editor"), named(owner, "owner")],
    [named(owner, "owner"), named(editor, "editor")],
  ]);
  expect(read.savedBy).toEqual(named(owner, "owner"));
});

test("a burst of saves keeps the newest 20 and the item as it was before the burst", async ({ request }) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const ana = await api.account("ana");
  const id = await personalLogin(api, ana, "0");
  let revision = (await api.call(ana, "GET", `/api/ciphers/${id}`)).body;
  for (let i = 1; i <= 52; i++) {
    const saved = await api.call(ana, "PUT", `/api/ciphers/${id}`, {
      ...revision,
      login: { ...revision.login, password: password(String(i)) },
      encryptedFor: ana.userId,
      lastKnownRevisionDate: revision.revisionDate,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    revision = saved.body;
  }
  // Versions 0 to 51 were replaced, all today: the newest 20, and the first
  // one replaced today, which is the item before all of it.
  const expected = Array.from({ length: 20 }, (_, i) => password(String(51 - i)));
  expect(passwords(await versions(api, ana, id))).toEqual([...expected, password("0")]);
});

test("big saves can push out only the newest versions, never the item as it was before them", async ({ request }) => {
  // Someone who can edit an item, but not delete it or see its history, saves
  // it big over and over: the newest versions fill their own 4 MB, and the
  // item as it was before the day's saves stays (the days before too, in the
  // server's unit tests).
  test.setTimeout(180_000);
  const api = new Api(request);
  const ana = await api.account("ana");
  const id = await personalLogin(api, ana, "0");
  for (const label of ["1", "2"]) {
    await setPassword(api, ana, id, label);
  }
  // About 400 KB each as the server stores them (a field is kept in the
  // item's data too): under the 512 KB limit.
  const blob = [{ name: encString("blob"), value: encString("x".repeat(150 * 1024)), type: 1, linkedId: null }];
  let current = (await api.call(ana, "GET", `/api/ciphers/${id}`)).body;
  for (let i = 1; i <= 25; i++) {
    const saved = await api.call(ana, "PUT", `/api/ciphers/${id}`, {
      ...current,
      fields: blob,
      login: { ...current.login, password: password(`big-${i}`) },
      encryptedFor: ana.userId,
      lastKnownRevisionDate: current.revisionDate,
    });
    expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);
    current = saved.body;
  }
  const kept = passwords(await versions(api, ana, id));
  // The newest big ones that fit, newest first, then the item before the day's saves.
  expect(kept[0]).toBe(password("big-24"));
  expect(kept.length).toBeGreaterThan(5);
  expect(kept.length).toBeLessThanOrEqual(11);
  expect(kept.at(-1)).toBe(password("0"));
  const bigOnes = Array.from({ length: 25 }, (_, i) => password(`big-${i + 1}`));
  expect(kept.slice(0, -1).every((p) => bigOnes.includes(p))).toBe(true);
});

test("an item's versions keep the item key they were encrypted with", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const id = await personalLogin(api, ana, "one");
  const current = (await api.call(ana, "GET", `/api/ciphers/${id}`)).body;
  // An app gives the item its own key on this save.
  const keyed = await api.call(ana, "PUT", `/api/ciphers/${id}`, {
    ...current,
    key: encString("item-key-1"),
    login: { ...current.login, password: password("two") },
    encryptedFor: ana.userId,
    lastKnownRevisionDate: current.revisionDate,
  });
  expect(keyed.status, JSON.stringify(keyed.body)).toBe(200);
  const rekeyed = await api.call(ana, "PUT", `/api/ciphers/${id}`, {
    ...keyed.body,
    key: encString("item-key-2"),
    login: { ...keyed.body.login, password: password("three") },
    encryptedFor: ana.userId,
    lastKnownRevisionDate: keyed.body.revisionDate,
  });
  expect(rekeyed.status, JSON.stringify(rekeyed.body)).toBe(200);

  const list = await versions(api, ana, id);
  expect(list.map((v) => v.cipher?.key)).toEqual([encString("item-key-1"), null]);
});

test("an item is at most 512 KB encrypted, and its password history at most 100 entries", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const big = (label: string) => ({
    ...login(ana, null, label),
    fields: [{ name: encString("blob"), value: encString("x".repeat(400 * 1024)), type: 1, linkedId: null }],
  });
  const refused = await api.call(ana, "POST", "/api/ciphers", big("big"));
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain("too large");

  // An edit that would make an item too large is refused, and keeps nothing.
  const id = await personalLogin(api, ana, "one");
  const current = (await api.call(ana, "GET", `/api/ciphers/${id}`)).body;
  const tooBig = await api.call(ana, "PUT", `/api/ciphers/${id}`, {
    ...big("two"),
    lastKnownRevisionDate: current.revisionDate,
  });
  expect(tooBig.status).toBe(400);
  expect(await versions(api, ana, id)).toEqual([]);

  // Password history keeps the newest 100 entries, the first ones apps send.
  const entries = Array.from({ length: 150 }, (_, i) => ({
    password: password(`old-${i}`),
    lastUsedDate: "2026-10-01T00:00:00.000Z",
  }));
  const saved = await api.call(ana, "PUT", `/api/ciphers/${id}`, {
    ...current,
    passwordHistory: entries,
    encryptedFor: ana.userId,
    lastKnownRevisionDate: current.revisionDate,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const kept = (await api.call(ana, "GET", `/api/ciphers/${id}`)).body.passwordHistory;
  expect(kept).toHaveLength(100);
  expect(kept[0].password).toBe(password("old-0"));
  expect(kept[99].password).toBe(password("old-99"));
});

test("only people who can open the item read its history; without its passwords, only when and by whom", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "History Org");
  const [editor, viewer, hidden, outsider, admin, manager, stranger] = await Promise.all(
    ["editor", "viewer", "hidden", "outsider", "admin", "manager", "stranger"].map((n) => api.account(n)),
  );
  for (const member of [editor, viewer, hidden, outsider]) {
    await api.addMember(owner, orgId, member, "user");
  }
  await api.addMember(owner, orgId, admin, "admin");
  await api.addMember(owner, orgId, manager, "manager");
  const collection = await shareCollection(api, owner, orgId, [
    { member: editor },
    { member: viewer, readOnly: true },
    { member: hidden, readOnly: true, hidePasswords: true },
    { member: manager },
  ]);
  const id = await orgLogin(api, owner, orgId, collection, "one");
  await setPassword(api, editor, id, "two");
  await setPassword(api, owner, id, "three");

  // Everyone who can open the item and see its passwords gets its versions.
  for (const who of [owner, admin, editor, viewer, manager]) {
    expect(passwords(await versions(api, who, id)), who.email).toEqual([password("two"), password("one")]);
  }

  // Someone who can open it but not see its passwords: when and by whom, no
  // encrypted fields at all.
  const masked = await history(api, hidden, id);
  expect(masked.status, JSON.stringify(masked.body)).toBe(200);
  expect(masked.body.hidePasswords).toBe(true);
  expect(masked.body.data).toHaveLength(2);
  for (const version of masked.body.data) {
    expect(version.cipher).toBeNull();
    expect(version.revisionDate).toEqual(expect.any(String));
  }
  expect(JSON.stringify(masked.body)).not.toMatch(/"2\.[A-Za-z0-9+/=]+\|/);

  // Someone in the organization without its collection, someone from
  // elsewhere, and an item that doesn't exist: all the same 404.
  for (const who of [outsider, stranger]) {
    const refused = await history(api, who, id);
    expect(refused.status, who.email).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain(password("one"));
  }
  expect((await history(api, owner, "00000000-0000-0000-0000-000000000000")).status).toBe(404);
  expect((await history(api, null, id)).status).toBe(401);

  // Names, exactly for those who can list the organization's members.
  const read = (await history(api, owner, id)).body;
  expect(read.savedBy).toEqual(named(owner, "owner"));
  expect(read.data.map((v: Version) => v.savedBy)).toEqual([named(editor, "editor"), named(owner, "owner")]);
  expect(await seesNames(api, owner, orgId, id, editor)).toBe(true);
  expect(await seesNames(api, admin, orgId, id, editor)).toBe(true);
  // A manager with one collection, not access to all items, can't list members.
  expect(await seesNames(api, manager, orgId, id, editor)).toBe(false);
  expect(await seesNames(api, viewer, orgId, id, editor)).toBe(false);
  // A member sees their own name, and that someone else saved the rest.
  const asEditor = (await history(api, editor, id)).body;
  expect(asEditor.data[0].savedBy).toEqual(named(editor, "editor"));
  expect(asEditor.data[1].savedBy).toEqual(ANOTHER_MEMBER);
  expect(asEditor.savedBy).toEqual(ANOTHER_MEMBER);
  expect(JSON.stringify((await history(api, viewer, id)).body)).not.toContain(editor.email);
});

test("members who aren't confirmed or were revoked get 404, and access follows the collection", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Membership Org");
  const [waiting, revoked, removed, later] = await Promise.all(
    ["waiting", "revoked", "removed", "later"].map((n) => api.account(n)),
  );
  // Invited and accepted (the test server sends no mail, so an existing
  // account accepts at once), but not confirmed.
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [waiting.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  expect((await api.members(owner, orgId)).find((m) => m.email === waiting.email)?.status).toBe(1);
  const revokedId = await api.addMember(owner, orgId, revoked, "user");
  await api.addMember(owner, orgId, removed, "user");
  await api.addMember(owner, orgId, later, "user");
  const collection = await shareCollection(api, owner, orgId, [
    { member: waiting },
    { member: revoked },
    { member: removed },
  ]);
  const id = await orgLogin(api, owner, orgId, collection, "one");
  await setPassword(api, owner, id, "two");
  expect(passwords(await versions(api, removed, id))).toEqual([password("one")]);

  const revoke = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${revokedId}/revoke`);
  expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
  // Taken out of the collection after versions exist; added to it later.
  await shareCollection(api, owner, orgId, [{ member: waiting }, { member: revoked }, { member: later }], collection);

  for (const who of [waiting, revoked, removed]) {
    expect((await history(api, who, id)).status, who.email).toBe(404);
  }
  // Someone given the collection later reads the history from before.
  expect(passwords(await versions(api, later, id))).toEqual([password("one")]);
});

test("a group's members read the history of its collections' items", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const member = await api.account("member");
  const orgId = await api.organization(owner, "Group Org");
  const memberId = await api.addMember(owner, orgId, member, "user");
  const collection = await api.collection(owner, orgId);
  const group = await api.call(owner, "POST", `/api/organizations/${orgId}/groups`, {
    name: "Front desk",
    accessAll: false,
    collections: [{ id: collection, readOnly: false, hidePasswords: false, manage: false }],
    users: [memberId],
  });
  test.skip(
    group.status === 400 && /disabled/i.test(JSON.stringify(group.body)),
    "Groups are off on this server (ORG_GROUPS_ENABLED)",
  );
  expect(group.status, JSON.stringify(group.body)).toBe(200);
  const id = await orgLogin(api, owner, orgId, collection, "one");
  await setPassword(api, member, id, "two");
  expect(passwords(await versions(api, member, id))).toEqual([password("one")]);
});

test("custom roles and MSP technicians: history with their vault items, names when they can list members", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);

  // An organization's own custom roles, with the item's collection.
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Custom Org");
  const [people, policies, noItems] = await Promise.all(["people", "policies", "no-items"].map((n) => api.account(n)));
  await api.addCustomMember(owner, orgId, people, { manageUsers: true });
  await api.addCustomMember(owner, orgId, policies, { managePolicies: true });
  await api.addCustomMember(owner, orgId, noItems, { manageUsers: true });
  const collection = await shareCollection(api, owner, orgId, [{ member: people }, { member: policies }]);
  const id = await orgLogin(api, owner, orgId, collection, "one");
  await setPassword(api, people, id, "two");
  await setPassword(api, owner, id, "three");
  expect(await seesNames(api, people, orgId, id, owner)).toBe(true);
  expect(await seesNames(api, policies, orgId, id, people)).toBe(false);
  expect((await history(api, noItems, id)).status).toBe(404);

  // An MSP's technicians in a client, as an admin and with custom roles.
  const mspAdmin = await api.account("msp-admin");
  const mspId = await api.msp(mspAdmin, "Northwind IT");
  const client = await api.client(mspAdmin, mspId, "Acme Dental");
  const clientCollection = await api.collection(mspAdmin, client);
  const item = await orgLogin(api, mspAdmin, client, clientCollection, "one");
  await setPassword(api, mspAdmin, item, "two");
  const access = (custom: unknown) => ({ allClients: true, clients: [], custom, installCommands: false });
  const techs: [string, unknown, number][] = [
    ["tech-admin", null, 200],
    ["tech-helpdesk", { permissions: { manageUsers: true }, vaultItems: false }, 404],
    ["tech-items", { permissions: { accessEventLogs: true }, vaultItems: true }, 200],
    ["tech-people-items", { permissions: { manageUsers: true }, vaultItems: true }, 200],
  ];
  for (const [name, custom, status] of techs) {
    const tech = await api.account(name);
    await api.addStaff(mspAdmin, mspId, tech, "technician", custom ? access(custom) : undefined);
    await api.confirmPending(mspAdmin, mspId);
    const read = await history(api, tech, item);
    expect(read.status, `${name}: ${JSON.stringify(read.body)}`).toBe(status);
    if (status === 200) {
      // Saved by the MSP admin; named exactly when the technician can list members.
      const lists = (await api.call(tech, "GET", `/api/organizations/${client}/users`)).status === 200;
      expect(read.body.data[0].savedBy, name).toEqual(lists ? named(mspAdmin, "msp-admin") : ANOTHER_MEMBER);
    }
  }
});

test("whoever can delete an item can clear its history or delete a version, and it's logged", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Clear Org");
  const [editor, viewer, hidden, outsider] = await Promise.all(
    ["editor", "viewer", "hidden", "outsider"].map((n) => api.account(n)),
  );
  for (const member of [editor, viewer, hidden, outsider]) {
    await api.addMember(owner, orgId, member, "user");
  }
  const collection = await shareCollection(api, owner, orgId, [
    { member: editor },
    { member: viewer, readOnly: true },
    { member: hidden, readOnly: true, hidePasswords: true },
  ]);
  const id = await orgLogin(api, owner, orgId, collection, "one");
  await setPassword(api, owner, id, "two");
  await setPassword(api, owner, id, "three");
  const clear = (who: Account | null, item = id) =>
    api.call(who, "DELETE", `/api/keykeeper/ciphers/${item}/history`);

  // Read-only members can't; people who can't open it get 404.
  expect((await clear(viewer)).status).toBe(400);
  expect((await clear(hidden)).status).toBe(400);
  expect((await clear(outsider)).status).toBe(404);
  expect((await clear(null)).status).toBe(401);
  expect(await versions(api, owner, id)).toHaveLength(2);

  // One version, by its id; another item's version isn't this one's.
  const [newest, oldest] = await versions(api, owner, id);
  const other = await orgLogin(api, owner, orgId, collection, "other");
  const deleteVersion = (who: Account, item: string, version: string) =>
    api.call(who, "DELETE", `/api/keykeeper/ciphers/${item}/history/${version}`);
  expect((await deleteVersion(viewer, id, oldest.id)).status).toBe(400);
  expect((await deleteVersion(owner, other, oldest.id)).status).toBe(404);
  expect((await deleteVersion(editor, id, oldest.id)).status).toBe(200);
  expect((await deleteVersion(editor, id, oldest.id)).status).toBe(404);
  expect((await versions(api, owner, id)).map((v) => v.id)).toEqual([newest.id]);

  // The whole history.
  expect((await clear(editor)).status).toBe(200);
  expect(await versions(api, owner, id)).toEqual([]);
  // The item and who saved it stay.
  expect((await history(api, owner, id)).body.savedBy).toEqual(named(owner, "owner"));

  // In the item's event log, when the server keeps one.
  const now = Date.now();
  const range = `start=${new Date(now - 3_600_000).toISOString()}&end=${new Date(now + 3_600_000).toISOString()}`;
  const events = (await api.call(owner, "GET", `/api/ciphers/${id}/events?${range}`)).body.data as {
    type: number;
    actingUserId: string;
  }[];
  if (events.length > 0) {
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 1191, actingUserId: editor.userId }),
        expect.objectContaining({ type: 1190, actingUserId: editor.userId }),
      ]),
    );
  }

  // A personal item's owner clears theirs.
  const mine = await personalLogin(api, owner, "a");
  await setPassword(api, owner, mine, "b");
  expect((await clear(editor, mine)).status).toBe(404);
  expect((await clear(owner, mine)).status).toBe(200);
  expect(await versions(api, owner, mine)).toEqual([]);
});

test("moving an item into an organization starts its history over", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const orgId = await api.organization(ana, "Move Org");
  const collection = await api.collection(ana, orgId);
  const id = await personalLogin(api, ana, "one");
  await setPassword(api, ana, id, "two");
  expect(await versions(api, ana, id)).toHaveLength(1);

  const current = (await api.call(ana, "GET", `/api/ciphers/${id}`)).body;
  const moved = await api.call(ana, "PUT", `/api/ciphers/${id}/share`, {
    cipher: {
      ...login(ana, orgId, "two-in-org"),
      lastKnownRevisionDate: current.revisionDate,
    },
    collectionIds: [collection],
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body.organizationId).toBe(orgId);
  // The personal versions were under the owner's own key: gone.
  expect(await versions(api, ana, id)).toEqual([]);

  await setPassword(api, ana, id, "three");
  expect(passwords(await versions(api, ana, id))).toEqual([password("two-in-org")]);
});

test("history goes with the item, the vault, and the organization, and outlives an editor's account unnamed", async ({
  request,
}) => {
  const api = new Api(request);
  const db = await serverDatabase();
  const rows = (table: string, item: string) =>
    db ? db(`SELECT COUNT(*) FROM ${table} WHERE cipher_uuid = ?`, item) : null;
  const ana = await api.account("ana");
  const id = await personalLogin(api, ana, "one");
  await setPassword(api, ana, id, "two");
  if (db) {
    expect(rows("keykeeper_cipher_versions", id)).toBe(1);
    expect(rows("keykeeper_cipher_saves", id)).toBe(1);
  }

  // The trash keeps it; deleting for good doesn't.
  expect((await api.call(ana, "PUT", `/api/ciphers/${id}/delete`)).status).toBe(200);
  expect(await versions(api, ana, id)).toHaveLength(1);
  const deleted = await api.call(ana, "DELETE", `/api/ciphers/${id}`);
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect((await history(api, ana, id)).status).toBe(404);
  if (db) {
    expect(rows("keykeeper_cipher_versions", id)).toBe(0);
    expect(rows("keykeeper_cipher_saves", id)).toBe(0);
  }

  // Purging the vault.
  const other = await personalLogin(api, ana, "a");
  await setPassword(api, ana, other, "b");
  const purged = await api.call(ana, "POST", "/api/ciphers/purge", { masterPasswordHash: ana.password });
  expect(purged.status, JSON.stringify(purged.body)).toBe(200);
  expect((await history(api, ana, other)).status).toBe(404);
  if (db) {
    expect(rows("keykeeper_cipher_versions", other)).toBe(0);
  }

  // An editor who deletes their account: the versions stay, unnamed.
  const owner = await api.account("owner");
  const editor = await api.account("editor");
  const orgId = await api.organization(owner, "Cascade Org");
  await api.addMember(owner, orgId, editor, "admin");
  const collection = await api.collection(owner, orgId);
  const item = await orgLogin(api, owner, orgId, collection, "one");
  await setPassword(api, editor, item, "two");
  await setPassword(api, owner, item, "three");
  const gone = await api.call(editor, "DELETE", "/api/accounts", { masterPasswordHash: editor.password });
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  const read = (await history(api, owner, item)).body;
  expect(passwords(read.data)).toEqual([password("two"), password("one")]);
  expect(read.data.map((v: Version) => [v.savedBy, v.replacedBy])).toEqual([
    [null, named(owner, "owner")],
    [named(owner, "owner"), null],
  ]);

  // Deleting the organization deletes its items' history.
  const removed = await api.call(owner, "DELETE", `/api/organizations/${orgId}`, {
    masterPasswordHash: owner.password,
  });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  if (db) {
    expect(rows("keykeeper_cipher_versions", item)).toBe(0);
    expect(rows("keykeeper_cipher_saves", item)).toBe(0);
  }
});

test("changing the account's key deletes its own items' history, not its organizations'", async ({
  request,
}) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const orgId = await api.organization(ana, "Rotation Org");
  const collection = await api.collection(ana, orgId);
  const personal = await personalLogin(api, ana, "one");
  await setPassword(api, ana, personal, "two");
  const shared = await orgLogin(api, ana, orgId, collection, "org-one");
  await setPassword(api, ana, shared, "org-two");

  const item = (await api.call(ana, "GET", `/api/ciphers/${personal}`)).body;
  const profile = (await api.call(ana, "GET", "/api/accounts/profile")).body;
  const enrolled = profile.organizations.filter((o: { resetPasswordEnrolled: boolean }) => o.resetPasswordEnrolled);
  const rotated = await api.call(ana, "POST", "/api/accounts/key-management/rotate-user-account-keys", {
    oldMasterKeyAuthenticationHash: ana.password,
    accountUnlockData: {
      masterPasswordUnlockData: {
        kdfType: 0,
        kdfIterations: 600000,
        kdfParallelism: null,
        kdfMemory: null,
        email: ana.email,
        masterKeyAuthenticationHash: ana.password,
        masterKeyEncryptedUserKey: encString(`new-user-key-${ana.email}`),
      },
      emergencyAccessUnlockData: [],
      organizationAccountRecoveryUnlockData: enrolled.map((o: { id: string }) => ({
        organizationId: o.id,
        resetPasswordKey: encString(`recovery-${o.id}`),
      })),
    },
    accountKeys: {
      userKeyEncryptedAccountPrivateKey: encString(`new-private-key-${ana.email}`),
      accountPublicKey: publicKey(ana.email),
    },
    accountData: {
      ciphers: [{ ...login(ana, null, "two-new-key"), id: personal, lastKnownRevisionDate: item.revisionDate }],
      folders: [],
      sends: [],
    },
  });
  expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);

  // Rotating ends the sessions; a new one.
  const again = { ...ana, token: await api.logIn(ana.email, ana.password) };
  // Re-encrypting for the new key isn't an edit, and the old versions are gone.
  expect(await versions(api, again, personal)).toEqual([]);
  expect(passwords(await versions(api, again, shared))).toEqual([password("org-one")]);
});

// Every role, someone from another organization, and no one (AGENTS.md).
const ACTORS = ["owner", "admin", "manager", "member", "outsider", "stranger", "anonymous"] as const;
type Actor = (typeof ACTORS)[number];
type Context = { api: Api; orgItem: string; personalItem: string };

const rows: MatrixRow<Actor, Context>[] = [
  {
    name: "read an organization item's history",
    // The member has the item's collection; the manager and the outsider don't.
    allowed: ["owner", "admin", "member"],
    request: async ({ orgItem }) => ({ method: "GET", path: `/api/keykeeper/ciphers/${orgItem}/history` }),
  },
  {
    name: "read a personal item's history",
    allowed: ["owner"],
    request: async ({ personalItem }) => ({ method: "GET", path: `/api/keykeeper/ciphers/${personalItem}/history` }),
  },
  {
    name: "clear an organization item's history",
    allowed: ["owner", "admin", "member"],
    request: async ({ orgItem }) => ({ method: "DELETE", path: `/api/keykeeper/ciphers/${orgItem}/history` }),
  },
  {
    name: "clear a personal item's history",
    allowed: ["owner"],
    request: async ({ personalItem }) => ({ method: "DELETE", path: `/api/keykeeper/ciphers/${personalItem}/history` }),
  },
];

test.describe("who may read and clear an item's history", () => {
  permissionMatrix(
    ACTORS,
    async (api) => {
      const owner = await api.account("owner");
      const orgId = await api.organization(owner, "History Matrix Org");
      const callers = {
        owner,
        stranger: await api.account("stranger"),
        anonymous: null,
      } as Record<Actor, Account | null>;
      const roles = { admin: "admin", manager: "manager", member: "user", outsider: "user" } as const;
      for (const [actor, role] of Object.entries(roles) as [Actor, "admin" | "manager" | "user"][]) {
        callers[actor] = await api.account(actor);
        await api.addMember(owner, orgId, callers[actor]!, role);
      }
      const collection = await shareCollection(api, owner, orgId, [{ member: callers.member! }]);
      const orgItem = await orgLogin(api, owner, orgId, collection, "one");
      await setPassword(api, owner, orgItem, "two");
      const personalItem = await personalLogin(api, owner, "one");
      await setPassword(api, owner, personalItem, "two");
      return { ctx: { api, orgItem, personalItem }, callers };
    },
    rows,
  );
});

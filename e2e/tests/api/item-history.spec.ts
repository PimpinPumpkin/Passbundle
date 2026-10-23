// Item history (DESIGN.md, "Item history"): every save keeps the item as it
// was, encrypted as it was stored; the last 50 are kept; only people who can
// open the item can read them; and they go with the item, when it moves into
// an organization, and when its owner's key changes.
import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api, encString, publicKey } from "./support";

type Version = {
  object: string;
  id: string;
  revisionDate: string;
  replacedDate: string;
  savedBy: { id: string | null; name: string | null; email: string | null } | null;
  cipher: { id: string; key: string | null; organizationId: string | null; login: { password: string } };
};

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

const passwords = (list: Version[]) => list.map((v) => v.cipher.login.password);

/** A collection with these members, as its organization's owner sets it. */
async function shareCollection(
  api: Api,
  owner: Account,
  orgId: string,
  users: { member: Account; readOnly?: boolean; hidePasswords?: boolean }[],
) {
  const collection = await api.collection(owner, orgId);
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

test("each save keeps the item as it was, newest first", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const id = await personalLogin(api, ana, "one");

  const fresh = await history(api, ana, id);
  expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  expect(fresh.body).toMatchObject({ object: "keykeeperCipherHistory", cipherId: id, data: [] });
  // Only its owner edits a personal item.
  expect(fresh.body.savedBy).toEqual({ id: ana.userId, name: "ana", email: ana.email });

  const afterOne = await api.call(ana, "GET", `/api/ciphers/${id}`);
  await setPassword(api, ana, id, "two");
  const afterTwo = await setPassword(api, ana, id, "three");

  const list = await versions(api, ana, id);
  expect(passwords(list)).toEqual([password("two"), password("one")]);
  for (const version of list) {
    expect(version.object).toBe("keykeeperCipherVersion");
    // Each opens like the item: its id and owner, and its own fields.
    expect(version.cipher).toMatchObject({ id, organizationId: null, key: null });
    expect(version.savedBy).toEqual({ id: ana.userId, name: "ana", email: ana.email });
  }
  // When each was saved, and when the next save replaced it.
  expect(list[1].revisionDate).toBe(afterOne.body.revisionDate);
  expect(new Date(list[0].revisionDate).getTime()).toBeGreaterThanOrEqual(new Date(list[1].revisionDate).getTime());
  expect(new Date(list[0].replacedDate).getTime()).toBeLessThanOrEqual(new Date(afterTwo.revisionDate).getTime());
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

test("an item keeps its last 50 versions", async ({ request }) => {
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
  // Versions 0 to 51 were replaced; the two oldest are gone.
  const list = await versions(api, ana, id);
  expect(list).toHaveLength(50);
  expect(list[0].cipher.login.password).toBe(password("51"));
  expect(list[49].cipher.login.password).toBe(password("2"));
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
  expect(list.map((v) => v.cipher.key)).toEqual([encString("item-key-1"), null]);
});

test("only people who can open the item see its history, and names only where they may see members", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "History Org");
  const [editor, viewer, hidden, outsider, admin, stranger] = await Promise.all(
    ["editor", "viewer", "hidden", "outsider", "admin", "stranger"].map((n) => api.account(n)),
  );
  for (const member of [editor, viewer, hidden, outsider]) {
    await api.addMember(owner, orgId, member, "user");
  }
  await api.addMember(owner, orgId, admin, "admin");
  const collection = await shareCollection(api, owner, orgId, [
    { member: editor },
    { member: viewer, readOnly: true },
    { member: hidden, readOnly: true, hidePasswords: true },
  ]);
  const id = await orgLogin(api, owner, orgId, collection, "one");
  await setPassword(api, editor, id, "two");
  await setPassword(api, owner, id, "three");

  // Everyone who can open the item gets the same versions, including a
  // member who can't see its passwords: the app hides them, as for the item.
  for (const who of [owner, admin, editor, viewer, hidden]) {
    expect(passwords(await versions(api, who, id)), who.email).toEqual([password("two"), password("one")]);
  }

  // Someone in the organization without its collection, someone from
  // elsewhere, and an item that doesn't exist: all the same 404.
  for (const who of [outsider, stranger]) {
    const refused = await history(api, who, id);
    expect(refused.status, who.email).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain(password("one"));
  }
  expect((await history(api, owner, "00000000-0000-0000-0000-000000000000")).status).toBe(404);
  expect((await history(api, null, id)).status).toBe(401);

  // The owner and admin see who saved each version; the oldest kept has no
  // name, since the server records who replaces a version.
  const named = { id: editor.userId, name: "editor", email: editor.email };
  for (const who of [owner, admin]) {
    const read = (await history(api, who, id)).body;
    expect(read.savedBy).toEqual({ id: owner.userId, name: "owner", email: owner.email });
    expect(read.data.map((v: Version) => v.savedBy)).toEqual([named, null]);
  }
  // A member sees their own name, and that someone else saved the rest.
  const asEditor = (await history(api, editor, id)).body;
  expect(asEditor.data[0].savedBy).toEqual(named);
  expect(asEditor.savedBy).toEqual({ id: null, name: null, email: null });
  const asViewer = (await history(api, viewer, id)).body;
  expect(asViewer.data[0].savedBy).toEqual({ id: null, name: null, email: null });
  expect(JSON.stringify(asViewer)).not.toContain(editor.email);
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

test("deleting an item for good deletes its history; the trash keeps it", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const id = await personalLogin(api, ana, "one");
  await setPassword(api, ana, id, "two");

  expect((await api.call(ana, "PUT", `/api/ciphers/${id}/delete`)).status).toBe(200);
  expect(await versions(api, ana, id)).toHaveLength(1);

  const deleted = await api.call(ana, "DELETE", `/api/ciphers/${id}`);
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect((await history(api, ana, id)).status).toBe(404);

  // Purging the vault deletes every item's history with it.
  const other = await personalLogin(api, ana, "a");
  await setPassword(api, ana, other, "b");
  const purged = await api.call(ana, "POST", "/api/ciphers/purge", { masterPasswordHash: ana.password });
  expect(purged.status, JSON.stringify(purged.body)).toBe(200);
  expect((await history(api, ana, other)).status).toBe(404);
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
      organizationAccountRecoveryUnlockData: [],
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
];

test.describe("who may read an item's history", () => {
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

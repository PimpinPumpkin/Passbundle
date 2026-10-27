// Every item the server sends says whether the person may see its passwords
// (DESIGN.md, "Folders and permissions"): `viewPassword`, a boolean, on sync,
// the item by itself, what the item's own calls return, the organization's
// admin view, and an item's version history. The apps treat a missing one as
// "hidden" (fail closed), so it must never be missing.
import { expect, test } from "@playwright/test";

import { type Account, Api, encString } from "./support";

type Item = { id: string; viewPassword?: unknown };

/** Whether this item says, and what. */
function says(item: Item | null | undefined, where: string): boolean {
  expect(item, where).toBeTruthy();
  expect(typeof item!.viewPassword, `${where}: ${JSON.stringify(item)}`).toBe("boolean");
  return item!.viewPassword as boolean;
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

test("every item the server sends says whether its passwords show", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "View Password Org");
  const [admin, seer, hidden] = await Promise.all(
    ["admin", "seer", "hidden"].map((name) => api.account(name)),
  );
  await api.addMember(owner, orgId, admin, "admin");
  await api.addMember(owner, orgId, seer, "user");
  await api.addMember(owner, orgId, hidden, "user");

  const collection = await api.collection(owner, orgId);
  const members = await api.members(owner, orgId);
  const memberId = (who: Account) => members.find((m) => m.email === who.email)!.id;
  const shared = await api.call(owner, "PUT", `/api/organizations/${orgId}/collections/${collection}`, {
    name: encString("shared"),
    groups: [],
    users: [
      { id: memberId(seer), readOnly: false, hidePasswords: false, manage: false },
      { id: memberId(hidden), readOnly: true, hidePasswords: true, manage: false },
    ],
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  // What creating and changing an item return.
  const personal = await api.call(owner, "POST", "/api/ciphers", login(owner, null));
  expect(personal.status, JSON.stringify(personal.body)).toBe(200);
  expect(says(personal.body, "a new personal item")).toBe(true);
  const created = await api.call(owner, "POST", "/api/ciphers/create", {
    cipher: login(owner, orgId),
    collectionIds: [collection],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect(says(created.body, "a new organization item")).toBe(true);
  const orgItem = created.body.id as string;
  const changed = await api.call(owner, "PUT", `/api/ciphers/${orgItem}`, {
    ...created.body,
    encryptedFor: owner.userId,
    lastKnownRevisionDate: created.body.revisionDate,
  });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(says(changed.body, "a changed item")).toBe(true);

  // Sync, for each of them: every item says, and hidden members get no.
  const expected = new Map<Account, boolean>([
    [owner, true],
    [admin, true],
    [seer, true],
    [hidden, false],
  ]);
  for (const [who, sees] of expected) {
    const sync = await api.call(who, "GET", "/api/sync");
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    for (const item of sync.body.ciphers as Item[]) {
      says(item, `${who.email}'s sync`);
    }
    const synced = (sync.body.ciphers as Item[]).find((item) => item.id === orgItem);
    expect(says(synced, `${who.email}'s sync`)).toBe(sees);

    // The item by itself, by each way an app asks for one.
    for (const path of [
      `/api/ciphers/${orgItem}`,
      `/api/ciphers/${orgItem}/details`,
      `/api/ciphers/${orgItem}/admin`,
    ]) {
      const one = await api.call(who, "GET", path);
      expect(one.status, `${who.email} ${path}: ${JSON.stringify(one.body)}`).toBe(200);
      expect(says(one.body, `${who.email} ${path}`)).toBe(sees);
    }
    const listed = await api.call(who, "GET", "/api/ciphers");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    for (const item of listed.body.data as Item[]) {
      says(item, `${who.email}'s item list`);
    }
  }
  const own = await api.call(owner, "GET", `/api/ciphers/${personal.body.id}`);
  expect(says(own.body, "the owner's own item")).toBe(true);

  // The organization's admin view, for those with access to every item.
  for (const who of [owner, admin]) {
    const details = await api.call(who, "GET", `/api/ciphers/organization-details?organizationId=${orgId}`);
    expect(details.status, JSON.stringify(details.body)).toBe(200);
    expect(details.body.data.length).toBeGreaterThan(0);
    for (const item of details.body.data as Item[]) {
      expect(says(item, `${who.email}'s admin view`)).toBe(true);
    }
  }

  // Version history: each version sent with its contents says too.
  const history = await api.call(owner, "GET", `/api/keykeeper/ciphers/${orgItem}/history`);
  expect(history.status, JSON.stringify(history.body)).toBe(200);
  expect(history.body.data.length).toBeGreaterThan(0);
  for (const version of history.body.data as { cipher: Item | null }[]) {
    expect(says(version.cipher, "a version")).toBe(true);
  }
  // Without see passwords: no contents at all, so nothing to say.
  const masked = await api.call(hidden, "GET", `/api/keykeeper/ciphers/${orgItem}/history`);
  expect(masked.status, JSON.stringify(masked.body)).toBe(200);
  expect(masked.body.hidePasswords).toBe(true);
  for (const version of masked.body.data as { cipher: Item | null }[]) {
    expect(version.cipher).toBeNull();
  }
});

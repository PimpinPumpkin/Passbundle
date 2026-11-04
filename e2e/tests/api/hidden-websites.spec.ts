// Someone who can edit an item but not see its passwords can't change its
// websites (DESIGN.md, "Folders and permissions"): autofill sends the
// password where they point, so changing them would send it to a site of
// their choosing. The apps send the websites back exactly as stored
// (encrypted), and the server refuses any change it can see: another address
// or checksum, another match setting, one more, or one less. Someone who can
// see the passwords changes them as before.
import { expect, test } from "@playwright/test";

import { type Account, Api, encString } from "./support";

const website = (label: string, match: number | null = null) => ({
  uri: encString(`uri-${label}`),
  uriChecksum: encString(`checksum-${label}`),
  match,
});

test("without see passwords, an edit keeps the item's websites as they are", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Hidden Websites Org");
  const [editor, seer] = await Promise.all(["editor", "seer"].map((name) => api.account(name)));
  await api.addMember(owner, orgId, editor, "user");
  await api.addMember(owner, orgId, seer, "user");
  const collection = await api.collection(owner, orgId);
  const members = await api.members(owner, orgId);
  const memberId = (who: Account) => members.find((m) => m.email === who.email)!.id;
  const shared = await api.call(owner, "PUT", `/api/organizations/${orgId}/collections/${collection}`, {
    name: encString("shared"),
    groups: [],
    users: [
      // Upstream's "Can edit except passwords", and "Can edit".
      { id: memberId(editor), readOnly: false, hidePasswords: true, manage: false },
      { id: memberId(seer), readOnly: false, hidePasswords: false, manage: false },
    ],
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  const created = await api.call(owner, "POST", "/api/ciphers/create", {
    cipher: {
      type: 1,
      name: encString("Domain admin"),
      notes: null,
      login: {
        username: encString("username"),
        password: encString("password"),
        uris: [website("bank"), website("bank-sso", 1)],
        totp: null,
      },
      organizationId: orgId,
      encryptedFor: owner.userId,
      favorite: false,
      reprompt: 0,
      fields: [],
    },
    collectionIds: [collection],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.id as string;

  /** An edit by `who`, of the item as it is now, with `change` made to it. */
  async function edit(who: Account, change: (item: any) => void) {
    const now = await api.call(who, "GET", `/api/ciphers/${id}`);
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    const item = { ...now.body, encryptedFor: who.userId, lastKnownRevisionDate: now.body.revisionDate };
    change(item);
    return api.call(who, "PUT", `/api/ciphers/${id}`, item);
  }

  // Their edits that keep the websites as stored go through.
  const renamed = await edit(editor, (item) => (item.name = encString("Renamed")));
  expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

  // Any change to them is refused, and nothing is saved.
  for (const [what, change] of [
    ["another address", (item: any) => (item.login.uris[0] = website("evil"))],
    ["another match setting", (item: any) => (item.login.uris[1].match = 3)],
    ["one more", (item: any) => item.login.uris.push(website("evil"))],
    ["one less", (item: any) => item.login.uris.pop()],
    ["none", (item: any) => (item.login.uris = null)],
  ] as const) {
    const refused = await edit(editor, change);
    expect(refused.status, `${what}: ${JSON.stringify(refused.body)}`).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("can't change its websites");
  }
  const kept = await api.call(owner, "GET", `/api/ciphers/${id}`);
  expect(kept.body.login.uris.map((u: { uri: string }) => u.uri)).toEqual([
    encString("uri-bank"),
    encString("uri-bank-sso"),
  ]);

  // Someone who can see the passwords changes them.
  const changed = await edit(seer, (item) => (item.login.uris = [website("bank-new")]));
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  expect(changed.body.login.uris.map((u: { uri: string }) => u.uri)).toEqual([encString("uri-bank-new")]);
});

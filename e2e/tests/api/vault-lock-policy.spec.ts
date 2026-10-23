// The "Vault lock" policy (upstream's vault timeout policy, type 9), which
// upstream's open-source server leaves out: ours keeps the data upstream's
// open-source clients read, refuses data they couldn't, and sends it with
// each sync. See docs/core.md, "Locking by policy".
import { expect, test } from "@playwright/test";

import { Api, type Account, encString, publicKey } from "./support";

const VAULT_LOCK = 9;

async function makeOrg(api: Api, owner: Account, name: string) {
  const created = await api.call(owner, "POST", "/api/keykeeper/organizations", {
    name,
    collectionName: encString(`everyone-${name}`),
    key: encString(`org-key-for-${owner.email}`),
    keys: {
      publicKey: publicKey(`org-${name}`),
      encryptedPrivateKey: encString(`org-private-${name}`),
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}

const setVaultLock = (api: Api, owner: Account, orgId: string, enabled: boolean, data: unknown) =>
  api.call(owner, "PUT", `/api/organizations/${orgId}/policies/${VAULT_LOCK}`, {
    policy: { enabled, data },
  });

async function vaultLock(api: Api, owner: Account, orgId: string) {
  const got = await api.call(owner, "GET", `/api/organizations/${orgId}/policies/${VAULT_LOCK}`);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return { enabled: got.body.enabled, data: got.body.data };
}

test("an organization sets the vault lock policy, and each sync sends it", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await makeOrg(api, owner, "Lakeside Dental");

  // Not set yet: off, as upstream answers for any policy.
  expect(await vaultLock(api, owner, orgId)).toEqual({ enabled: false, data: null });

  for (const data of [
    { type: "custom", minutes: 15, action: "lock" },
    { type: "immediately", minutes: null, action: "logOut" },
    { type: "onSystemLock", minutes: null, action: null },
    { minutes: 240 },
  ]) {
    const set = await setVaultLock(api, owner, orgId, true, data);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(await vaultLock(api, owner, orgId)).toEqual({ enabled: true, data });
  }

  // The apps learn it from sync, with the organization it's from.
  const sync = await api.call(owner, "GET", "/api/sync");
  expect(sync.status, JSON.stringify(sync.body)).toBe(200);
  expect(sync.body.policies).toContainEqual(
    expect.objectContaining({ organizationId: orgId, type: VAULT_LOCK, enabled: true, data: { minutes: 240 } }),
  );

  // Off, with nothing.
  const off = await setVaultLock(api, owner, orgId, false, null);
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect((await vaultLock(api, owner, orgId)).enabled).toBe(false);
});

test("a changed policy changes each member's account, so their apps sync it at the next unlock", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const member = await api.account("member");
  const orgId = await makeOrg(api, owner, "Harbor Optometry");
  await api.addMember(owner, orgId, member, "user");

  const revision = async () => {
    const got = await api.call(member, "GET", "/api/accounts/revision-date");
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    return Number(got.body);
  };
  const before = await revision();
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const set = await setVaultLock(api, owner, orgId, true, { type: "custom", minutes: 15, action: "lock" });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(await revision()).toBeGreaterThan(before);
});

test("the vault lock policy refuses what a client couldn't read, and keeps what it had", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await makeOrg(api, owner, "Pinecrest Clinic");
  const kept = { type: "custom", minutes: 30, action: "lock" };
  expect((await setVaultLock(api, owner, orgId, true, kept)).status).toBe(200);

  for (const data of [
    null,
    "15",
    { type: "custom" },
    { type: "onIdle", minutes: 5 },
    { minutes: 0 },
    { minutes: 1441 },
    { minutes: 2.5 },
    { minutes: 15, action: "delete" },
  ]) {
    const refused = await setVaultLock(api, owner, orgId, true, data);
    expect(refused.status, JSON.stringify(data)).toBe(400);
  }
  expect(await vaultLock(api, owner, orgId)).toEqual({ enabled: true, data: kept });
});

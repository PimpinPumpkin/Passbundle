// Changes someone confirms with their master password (DESIGN.md,
// "Confirming sensitive changes"): making a provisioning token, saving single
// sign-on, adding or changing an event destination or its signing secret, and
// making a script token or adding an item to one. A session alone, such as
// one that single sign-on started, can't make them. Without the password, or
// with a wrong one, nothing changes; refreshing a script token's copy, which
// apps do on their own, needs nothing. The permission matrices for who may
// make each change are in each feature's own tests.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { settings, Tenant, newIdentifier } from "../support/entra";

import { type Account, Api, withMasterPassword, encString } from "./support";

// The master password these changes need is checked the way a sign-in is
// (600,000 rounds of PBKDF2 on the server, slow in its debug build), so tests
// that make several get more time.
test.describe.configure({ timeout: 120_000 });

const wrong = (who: Account) => ({ masterPasswordHash: Buffer.from(`not-${who.password}`).toString("base64") });

/** Refused for want of the master password, or for a wrong one. */
function expectUnconfirmed(result: { status: number; body: any }, label: string) {
  expect(result.status, `${label}: ${JSON.stringify(result.body)}`).toBe(400);
  expect(String(result.body?.message), label).toMatch(/Confirm this change with your master password|Invalid password/);
}

test("making a provisioning token takes the master password", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("confirm-scim");
  const orgId = await api.organization(owner, "Confirm SCIM");
  const path = `/api/keykeeper/organizations/${orgId}/provisioning/token`;
  for (const [label, data] of [
    ["none", undefined],
    ["empty", {}],
    ["wrong", wrong(owner)],
  ] as const) {
    expectUnconfirmed(await api.call(owner, "POST", path, data), label);
  }
  const view = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/provisioning`);
  expect(view.body.token ?? null, JSON.stringify(view.body)).toBeNull();
  const made = await api.call(owner, "POST", path, withMasterPassword(owner));
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.newToken).toMatch(/^pbscim1_/);
});

test("saving single sign-on takes the master password", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("confirm-sso");
  const orgId = await api.organization(owner, "Confirm SSO");
  const tenant = await new Tenant().register();
  const path = `/api/keykeeper/organizations/${orgId}/sso`;
  const body = settings(tenant, newIdentifier("confirm"));
  expectUnconfirmed(await api.call(owner, "PUT", path, body), "none");
  expectUnconfirmed(await api.call(owner, "PUT", path, { ...body, ...wrong(owner) }), "wrong");
  expect((await api.call(owner, "GET", path)).body.enabled).toBe(false);
  const saved = await api.call(owner, "PUT", path, withMasterPassword(owner, body));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.enabled).toBe(true);
});

test("adding or changing an event destination, or its signing secret, takes the master password", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("confirm-events");
  const orgId = await api.organization(owner, "Confirm Events");
  const mspId = await api.msp(owner, "Confirm MSP");
  const webhook = { name: "SIEM", kind: "webhook", webhook: { url: "https://127.0.0.1:9/confirm" } };
  for (const path of [
    `/api/keykeeper/organizations/${orgId}/event-streaming`,
    `/api/keykeeper/msp/${mspId}/event-streaming`,
  ]) {
    expectUnconfirmed(await api.call(owner, "POST", path, webhook), `${path} none`);
    expectUnconfirmed(await api.call(owner, "POST", path, { ...webhook, ...wrong(owner) }), `${path} wrong`);
    expect((await api.call(owner, "GET", path)).body.data).toEqual([]);

    const added = await api.call(owner, "POST", path, withMasterPassword(owner, webhook));
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const id = added.body.id;
    // Turning it off, renaming it, or pointing it elsewhere: each a change.
    for (const change of [{ enabled: false }, { name: "Renamed" }, { webhook: { url: "https://127.0.0.1:9/x" } }]) {
      expectUnconfirmed(await api.call(owner, "PUT", `${path}/${id}`, change), `${path} ${JSON.stringify(change)}`);
    }
    expectUnconfirmed(await api.call(owner, "POST", `${path}/${id}/secret`), `${path} secret`);
    expect((await api.call(owner, "GET", path)).body.data).toMatchObject([{ id, name: "SIEM", enabled: true }]);

    const off = await api.call(owner, "PUT", `${path}/${id}`, withMasterPassword(owner, { enabled: false }));
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.enabled).toBe(false);
    const secret = await api.call(owner, "POST", `${path}/${id}/secret`, withMasterPassword(owner));
    expect(secret.status, JSON.stringify(secret.body)).toBe(200);
    expect(secret.body.signingSecret).toMatch(/^whsec_/);
    // Removing it and sending a test don't change where events go.
    expect((await api.call(owner, "DELETE", `${path}/${id}`)).status).toBe(200);
  }
});

test("making a script token, or adding an item to one, takes the master password; refreshing a copy doesn't", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("confirm-script");
  const orgId = await api.organization(owner, "Confirm Script");
  const collection = await api.collection(owner, orgId);
  const [first, second] = [
    await api.orgItem(owner, orgId, collection),
    await api.orgItem(owner, orgId, collection),
  ];
  const revision = async (itemId: string) => (await api.call(owner, "GET", `/api/ciphers/${itemId}`)).body.revisionDate;
  const grant = async (itemId: string, spec = "spec") => ({
    itemId,
    copy: encString(`copy-${itemId}`),
    revision: await revision(itemId),
    sealedSpec: encString(`${spec}-${itemId}`),
  });
  const id = randomUUID();
  const token = {
    id,
    name: "Join domain",
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    networks: [],
    authHash: createHash("sha256").update(randomBytes(32)).digest("base64"),
    sealedKey: encString("sealed"),
    grants: [await grant(first)],
  };
  const path = `/api/keykeeper/organizations/${orgId}/script-tokens`;
  expectUnconfirmed(await api.call(owner, "POST", path, token), "none");
  expectUnconfirmed(await api.call(owner, "POST", path, { ...token, ...wrong(owner) }), "wrong");
  expect((await api.call(owner, "GET", path)).body.data).toEqual([]);
  const made = await api.call(owner, "POST", path, withMasterPassword(owner, token));
  expect(made.status, JSON.stringify(made.body)).toBe(200);

  // Another item, or other fields of one it has: a change.
  expectUnconfirmed(await api.call(owner, "PUT", `${path}/${id}/grants/${second}`, await grant(second)), "new item");
  expectUnconfirmed(
    await api.call(owner, "PUT", `${path}/${id}/grants/${first}`, await grant(first, "wider")),
    "other fields",
  );
  const added = await api.call(owner, "PUT", `${path}/${id}/grants/${second}`, withMasterPassword(owner, await grant(second)));
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  expect(added.body.grants).toHaveLength(2);
  // The same fields' copy again, as apps refresh it on their own: nothing to confirm.
  const refreshed = await api.call(owner, "PUT", `${path}/${id}/grants/${first}`, await grant(first));
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
});

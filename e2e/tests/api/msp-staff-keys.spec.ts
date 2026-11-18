// What the console needs for key fingerprints (DESIGN.md, "Key
// fingerprints"): the Staff list carries the public key the server holds for
// each person, the one confirming them encrypts each client's key to, so the
// console can show its phrase. And an app that confirms someone on its own
// says so, which the MSP's activity log records; nothing else about the
// confirm changes.
import { expect, test } from "@playwright/test";

import { Api, encString, publicKey } from "./support";

test("the Staff list gives each person's public key: the account's own, the one their waiting membership names", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("keys-admin");
  const tech = await api.account("keys-tech");
  const mspId = await api.msp(admin, "Keys IT");
  await api.client(admin, mspId, "Keys Dental");
  await api.addStaff(admin, mspId, tech, "technician");

  const msp = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`);
  const keys = Object.fromEntries(
    msp.body.staff.map((s: { email: string; publicKey: string }) => [s.email, s.publicKey]),
  );
  expect(keys).toEqual({
    [admin.email]: publicKey(admin.email),
    [tech.email]: publicKey(tech.email),
  });
  // Upstream's own lookup, and the membership waiting for the client's key.
  const upstream = await api.call(admin, "GET", `/api/users/${tech.userId}/public-key`);
  expect(upstream.body.publicKey).toBe(keys[tech.email]);
  const pending = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  expect(pending.body.data.map((p: { email: string; publicKey: string }) => [p.email, p.publicKey])).toEqual([
    [tech.email, keys[tech.email]],
  ]);
  // A technician sees the same.
  await api.confirmPending(admin, mspId);
  const asTech = await api.call(tech, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(asTech.body.staff.map((s: { publicKey: string }) => s.publicKey).sort()).toEqual(
    Object.values(keys).sort(),
  );
});

test("a confirm the app made on its own says so in the MSP's activity, and is otherwise upstream's confirm", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("auto-admin");
  const first = await api.account("auto-first");
  const second = await api.account("auto-second");
  const mspId = await api.msp(admin, "Auto IT");
  const orgId = await api.client(admin, mspId, "Auto Dental");
  await api.addStaff(admin, mspId, first, "technician");
  await api.addStaff(admin, mspId, second, "technician");

  const pending = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  const memberOf = (email: string) =>
    pending.body.data.find((p: { email: string }) => p.email === email).memberId;
  for (const [who, extra] of [
    [first, { keykeeperAutomatic: true }],
    [second, {}],
  ] as const) {
    const confirmed = await api.call(admin, "POST", `/api/organizations/${orgId}/users/${memberOf(who.email)}/confirm`, {
      key: encString(`org-key-for-${who.email}`),
      ...extra,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  }

  // Both are confirmed the same way, with the key the app sent.
  const members = await api.members(admin, orgId);
  for (const who of [first, second]) {
    expect(members.find((m) => m.email === who.email)?.status).toBe(2);
    const profile = await api.call(who, "GET", "/api/accounts/profile");
    const org = profile.body.organizations.find((o: { id: string }) => o.id === orgId);
    expect(org.key).toBe(encString(`org-key-for-${who.email}`));
  }

  const events = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  const confirms = events.body.data
    .filter((e: { event: string }) => e.event === "member_confirmed")
    .map((e: { targetEmail: string; detail: string | null }) => [e.targetEmail, e.detail])
    .sort();
  expect(confirms).toEqual([
    [first.email, "automatic"],
    [second.email, null],
  ].sort());
});

// Joining an organization that requires two-step login (DESIGN.md, "Joining"):
// someone who joins without it can't be confirmed until they turn it on. The
// server says so to those who confirm, so their apps don't keep trying (and
// use up the day's limit), and to the person, so their vault can tell them.
// Owners and admins are exempt, as upstream.
import { createHmac } from "node:crypto";

import { expect, test } from "@playwright/test";

import { Api, encString, type Account } from "./support";

const USER = 2;
const ADMIN = 1;
const ACCEPTED = 1;

/** The current code for an authenticator key (RFC 6238: SHA-1, 30 seconds, 6 digits). */
function totp(base32Key: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32Key.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

async function turnOnAuthenticator(api: Api, person: Account) {
  const started = await api.call(person, "POST", "/api/two-factor/get-authenticator", {
    masterPasswordHash: person.password,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const key = started.body.key;
  const on = await api.call(person, "POST", "/api/two-factor/authenticator", {
    key,
    token: totp(key),
    masterPasswordHash: person.password,
  });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
}

test("someone who must turn on two-step login is flagged until they do, then confirmed as usual; admins aren't", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("two-step-owner");
  const orgId = await api.organization(owner, "Strict Dental");
  const policy = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/0`, {
    policy: { enabled: true, data: null },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const member = await api.account("two-step-member");
  const admin = await api.account("two-step-admin");
  for (const [person, type] of [
    [member, USER],
    [admin, ADMIN],
  ] as const) {
    const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [person.email],
      type,
      collections: [],
      groups: [],
      permissions: {},
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  }
  const membershipOf = async (person: Account) =>
    (await api.members(owner, orgId)).find((m) => m.email === person.email)!;
  expect((await membershipOf(member)).status).toBe(ACCEPTED);

  const pendingFor = async (person: Account) =>
    (await api.call(owner, "GET", "/api/keykeeper/organizations/pending")).body.data.find(
      (p: { email: string }) => p.email === person.email,
    );
  const waitingOn = async (person: Account) =>
    (await api.call(person, "GET", "/api/keykeeper/organizations/two-step-needed")).body.data;
  const confirm = async (person: Account) =>
    api.call(owner, "POST", `/api/organizations/${orgId}/users/${(await membershipOf(person)).id}/confirm`, {
      key: encString(`org-key-for-${person.email}`),
    });

  // The member without two-step login: flagged both ways, and confirming fails.
  expect(await pendingFor(member)).toMatchObject({ needsTwoStep: true });
  expect(await waitingOn(member)).toEqual([{ organizationId: orgId, name: "Strict Dental" }]);
  expect((await confirm(member)).status).toBe(400);

  // An admin without it is exempt, as upstream: not flagged, and confirmed.
  expect(await pendingFor(admin)).toMatchObject({ needsTwoStep: false });
  expect(await waitingOn(admin)).toEqual([]);
  expect((await confirm(admin)).status).toBe(200);

  // Once the member turns it on, they're confirmed as usual.
  await turnOnAuthenticator(api, member);
  expect(await pendingFor(member)).toMatchObject({ needsTwoStep: false });
  expect(await waitingOn(member)).toEqual([]);
  const confirmed = await confirm(member);
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  expect(await waitingOn(member)).toEqual([]);
});

test("nobody's flagged where the organization doesn't require two-step login", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("relaxed-owner");
  const orgId = await api.organization(owner, "Relaxed Dental");
  const member = await api.account("relaxed-member");
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [member.email],
    type: USER,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const pending = (await api.call(owner, "GET", "/api/keykeeper/organizations/pending")).body.data;
  expect(pending.find((p: { email: string }) => p.email === member.email)).toMatchObject({
    needsTwoStep: false,
  });
  expect(
    (await api.call(member, "GET", "/api/keykeeper/organizations/two-step-needed")).body.data,
  ).toEqual([]);
});

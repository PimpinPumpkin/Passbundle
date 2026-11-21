// Approving a sign-in from another device, the server's side (DESIGN.md,
// "Approving a sign-in from another device"), every endpoint against every
// caller: a device the account knows asks; only the account's other devices
// see the request; only one that signed in with the master password or the
// organization's single sign-on approves it (not the device that asked, a
// session that itself came from an approval, an API key, another account, or
// no one); a single sign-on session's approval carries the real user key,
// which opens the account on the device that asked; an approval carries only
// a type 4 key, never a master password hash; an approval signs in the device
// that asked, once; a denial signs nothing in; a request lasts 15 minutes, and
// one that's gone (expired, denied, replaced, or purged) answers 404 whenever
// the purge runs; a
// device asks five times an hour at most; an organization's "Require single
// sign-on" holds for it too; a session an approval began can't use
// emergency access on either side, while a password's or single sign-on's
// can; and where a request comes from, from the server's own location
// database (on a server of its own with the tiny one in fixtures/location),
// and nothing without one.
// The server stores keys as it gets them, so the public key is a real one
// (from Node) and the wrapped key a stand-in of the right shape, except where
// a single sign-on session approves: that account has real keys
// (tests/support/vault-crypto.ts), and the test opens what the device asking
// gets, as it would.
import { type ChildProcess, spawn } from "node:child_process";
import {
  constants,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, request as apiRequest, test } from "@playwright/test";

import { locationServerPort, port } from "../../paths.mjs";
import { linkFromSession, ssoOrg, ssoSignIn } from "../support/entra";
import { decrypt, encryptTo, realAccount, realPersonalLogin, rsaKeyPair } from "../support/vault-crypto";

import { type Account, Api, ageSignInRequests, encString } from "./support";

// The web vault in Chrome, as upstream numbers device types.
const WEB = "9";

type Session = { token: string; refresh: string; device: string };

/** Signs in on a device of our choosing, with the master password or an approved request. */
async function signIn(
  request: APIRequestContext,
  who: { email: string; password: string },
  device: string,
  authRequest?: { id: string; code: string },
  deviceType = WEB,
  ip?: string,
) {
  const response = await request.post("/identity/connect/token", {
    headers: ip ? { "X-Real-IP": ip } : {},
    form: {
      grant_type: "password",
      username: who.email,
      password: authRequest ? authRequest.code : who.password,
      ...(authRequest ? { authRequest: authRequest.id } : {}),
      scope: "api offline_access",
      client_id: "web",
      deviceType,
      deviceIdentifier: device,
      deviceName: "chrome",
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status(), body };
}

async function session(request: APIRequestContext, who: Account, device = randomUUID()): Promise<Session> {
  const signedIn = await signIn(request, who, device);
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  return { token: signedIn.body.access_token, refresh: signedIn.body.refresh_token, device };
}

/** What a session's access token says: the device it signed in on, and how. */
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

/** What the access token says about how the session signed in. */
const signedInWith = (token: string) => claimsOf(token).keykeeper_signin;

function publicKey() {
  const { publicKey: key } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return key.export({ type: "spki", format: "der" });
}

/** Letters and digits, as the web vault makes them. */
const accessCode = () => randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 25);

type Asked = { id: string; code: string; key: Buffer };

async function ask(request: APIRequestContext, who: Account, device: string, ip?: string, key = publicKey()) {
  const code = accessCode();
  const response = await request.post("/api/auth-requests", {
    headers: { "Device-Type": WEB, ...(ip ? { "X-Real-IP": ip } : {}) },
    data: { email: who.email, deviceIdentifier: device, publicKey: key.toString("base64"), accessCode: code, type: 0 },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status(), body, asked: { id: body?.id, code, key } as Asked };
}

async function asked(request: APIRequestContext, who: Account, device: string, ip?: string): Promise<Asked> {
  const made = await ask(request, who, device, ip);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.asked;
}

/** The user key, wrapped to the request's public key, as an approving app sends it. */
const wrapped = (a: Asked) =>
  `4.${publicEncrypt({ key: a.key, format: "der", type: "spki", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, randomBytes(64)).toString("base64")}`;

const answer = (api: Api, as: { token: string } | null, device: string, a: Asked, approve: boolean, key?: string | null) =>
  api.call(as, "PUT", `/api/auth-requests/${a.id}`, {
    deviceIdentifier: device,
    key: key === undefined ? (approve ? wrapped(a) : null) : key,
    masterPasswordHash: null,
    requestApproved: approve,
  });

const pending = async (api: Api, as: { token: string }) => {
  const listed = await api.call(as, "GET", "/api/auth-requests/pending");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return (listed.body.data as { id: string }[]).map((r) => r.id);
};

/** The requesting device reading its answer, with its access code. */
async function poll(request: APIRequestContext, a: Asked, code = a.code, ip?: string) {
  const response = await request.get(`/api/auth-requests/${a.id}/response?code=${code}`, {
    headers: { "Device-Type": WEB, ...(ip ? { "X-Real-IP": ip } : {}) },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

test("a known device asks, only the account's other devices see it, and an approval signs it in once", async ({
  request,
}) => {
  const api = new Api(request);
  const [ana, ben] = await Promise.all([api.account("ana"), api.account("ben")]);
  const laptop = await session(request, ana);
  // The device asking signed in before, so the account knows it.
  const asking = await session(request, ana);
  const a = await asked(request, ana, asking.device);

  // Ana's other device sees it, with what the app shows; the device asking
  // doesn't, nor does Ben, nor anyone signed out.
  const listed = await api.call(laptop, "GET", "/api/auth-requests/pending");
  expect(listed.body.data).toEqual([
    expect.objectContaining({
      id: a.id,
      publicKey: a.key.toString("base64"),
      requestDeviceType: "Chrome",
      requestIpAddress: "127.0.0.1",
      requestApproved: null,
      // This server has no location database: nothing says where it is.
      location: null,
      locationSource: null,
    }),
  ]);
  expect(await pending(api, asking)).toEqual([]);
  expect(await pending(api, ben)).toEqual([]);
  expect((await api.call(null, "GET", "/api/auth-requests/pending")).status).toBe(401);
  // Another account's request is as good as gone to them.
  expect((await api.call(ben, "GET", `/api/auth-requests/${a.id}`)).status).toBe(404);
  expect((await api.call(null, "GET", `/api/auth-requests/${a.id}`)).status).toBe(401);
  const one = await api.call(laptop, "GET", `/api/auth-requests/${a.id}`);
  expect(one.status).toBe(200);
  expect(one.body).toMatchObject({ requestIpAddress: "127.0.0.1", location: null, locationSource: null });

  // Nobody else answers it, the device asking can't answer its own, and an
  // approval carries a key.
  const benLaptop = await session(request, ben);
  expect((await answer(api, benLaptop, benLaptop.device, a, true)).status).toBe(404);
  expect((await answer(api, null, laptop.device, a, true)).status).toBe(401);
  const own = await answer(api, asking, asking.device, a, true);
  expect(own.status).toBe(400);
  expect(JSON.stringify(own.body)).toContain("its own sign-in request");
  expect((await answer(api, laptop, laptop.device, a, true, null)).status).toBe(400);
  expect((await answer(api, laptop, laptop.device, a, true, "not an encrypted string")).status).toBe(400);
  // A device answers as itself only.
  expect((await answer(api, laptop, asking.device, a, true)).status).toBe(400);

  // Waiting: the device asking reads no key yet, and only with its code.
  const waiting = await poll(request, a);
  expect(waiting.status).toBe(200);
  expect(waiting.body).toMatchObject({ key: null, requestApproved: null });
  expect((await poll(request, a, accessCode())).status).toBe(400);
  // Signing in with it waits for the approval too.
  expect((await signIn(request, ana, asking.device, a)).status).toBe(400);

  const key = wrapped(a);
  const approved = await answer(api, laptop, laptop.device, a, true, key);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(400);
  expect(await pending(api, laptop)).toEqual([]);
  const read = await poll(request, a);
  expect(read.body).toMatchObject({ key, requestApproved: true });

  // The device signs in with its access code, once, and its session says so.
  const signedIn = await signIn(request, ana, asking.device, a);
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  expect(signedInWith(signedIn.body.access_token)).toBe("authrequest");
  expect(signedInWith(laptop.token)).toBe("password");
  expect((await signIn(request, ana, asking.device, a)).status).toBe(400);
});

test("a session from an approval doesn't approve, nor does an API key's; the master password's does", async ({
  request,
}) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const laptop = await session(request, ana);
  const phone = await session(request, ana);
  const first = await asked(request, ana, phone.device);
  expect((await answer(api, laptop, laptop.device, first, true)).status).toBe(200);
  const fromApproval = await signIn(request, ana, phone.device, first);
  expect(fromApproval.status).toBe(200);
  const approvedPhone = {
    token: fromApproval.body.access_token as string,
    refresh: fromApproval.body.refresh_token as string,
  };

  // A session that came from an approval can't approve another device...
  const tablet = await session(request, ana);
  const second = await asked(request, ana, tablet.device);
  const refused = await answer(api, approvedPhone, phone.device, second, true);
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain("signed in with your master password");
  // ...nor after refreshing its session...
  const refreshed = await request.post("/identity/connect/token", {
    form: { grant_type: "refresh_token", client_id: "web", refresh_token: approvedPhone.refresh },
  });
  expect(refreshed.status()).toBe(200);
  const refreshedToken = (await refreshed.json()).access_token as string;
  expect(signedInWith(refreshedToken)).toBe("authrequest");
  expect((await answer(api, { token: refreshedToken }, phone.device, second, true)).status).toBe(400);

  // ...nor does an API key's.
  const apiKey = await api.call(ana, "POST", "/api/accounts/api-key", { masterPasswordHash: ana.password });
  expect(apiKey.status, JSON.stringify(apiKey.body)).toBe(200);
  const cli = randomUUID();
  const byKey = await request.post("/identity/connect/token", {
    form: {
      grant_type: "client_credentials",
      client_id: `user.${ana.userId}`,
      client_secret: apiKey.body.apiKey,
      scope: "api",
      deviceType: "25",
      deviceIdentifier: cli,
      deviceName: "linux",
    },
  });
  expect(byKey.status(), await byKey.text()).toBe(200);
  const keyToken = (await byKey.json()).access_token as string;
  expect((await answer(api, { token: keyToken }, cli, second, true)).status).toBe(400);

  // A denial from it is fine: it hands nothing out. The request is gone.
  expect((await answer(api, approvedPhone, phone.device, second, false)).status).toBe(200);
  expect((await api.call(laptop, "GET", `/api/auth-requests/${second.id}`)).status).toBe(404);
  // The device that signed in with the master password still approves.
  const third = await asked(request, ana, tablet.device);
  expect((await answer(api, laptop, laptop.device, third, true)).status).toBe(200);
});

test("a denied request is gone and signs nothing in", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const laptop = await session(request, ana);
  const asking = await session(request, ana);
  const a = await asked(request, ana, asking.device);
  // A denial needn't carry a key.
  const denied = await answer(api, laptop, laptop.device, a, false, null);
  expect(denied.status, JSON.stringify(denied.body)).toBe(200);
  expect(await pending(api, laptop)).toEqual([]);
  expect((await api.call(laptop, "GET", `/api/auth-requests/${a.id}`)).status).toBe(404);
  expect((await poll(request, a)).status).toBe(400);
  expect((await signIn(request, ana, asking.device, a)).status).toBe(400);
  expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(404);
});

test("a request lasts fifteen minutes", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const laptop = await session(request, ana);
  const asking = await session(request, ana);
  const a = await asked(request, ana, asking.device);
  const aged = await ageSignInRequests(ana.email, 16);
  test.skip(aged === null, "the test server runs on PostgreSQL");
  expect(aged).toBe(1);
  // From here the server's purge (every minute, at :30) may delete it at any
  // moment; an expired request and a purged one answer the same.
  expect(await pending(api, laptop)).toEqual([]);
  expect((await api.call(laptop, "GET", `/api/auth-requests/${a.id}`)).status).toBe(404);
  expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(404);
  expect((await poll(request, a)).status).toBe(400);

  // Approved in time, but not signed in with in time: refused too.
  const b = await asked(request, ana, asking.device);
  expect((await answer(api, laptop, laptop.device, b, true)).status).toBe(200);
  await ageSignInRequests(ana.email, 16);
  expect((await poll(request, b)).status).toBe(400);
  expect((await signIn(request, ana, asking.device, b)).status).toBe(400);
});

test("a device has one request waiting, an account a few, and only a known device asks", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const laptop = await session(request, ana);
  const first = await session(request, ana);
  const replaced = await asked(request, ana, first.device);
  const again = await asked(request, ana, first.device);
  expect(await pending(api, laptop)).toEqual([again.id]);
  expect((await api.call(laptop, "GET", `/api/auth-requests/${replaced.id}`)).status).toBe(404);

  for (let i = 0; i < 4; i++) {
    await asked(request, ana, (await session(request, ana)).device);
  }
  expect(await pending(api, laptop)).toHaveLength(5);
  const tooMany = await ask(request, ana, (await session(request, ana)).device);
  expect(tooMany.status).toBe(429);
  // A device already waiting may still ask again.
  expect((await ask(request, ana, first.device)).status).toBe(200);

  // An unknown device, or one that says it's another kind, can't ask.
  expect((await ask(request, ana, randomUUID())).status).toBe(400);
  const asSomethingElse = await request.post("/api/auth-requests", {
    headers: { "Device-Type": "10" },
    data: { email: ana.email, deviceIdentifier: first.device, publicKey: publicKey().toString("base64"), accessCode: accessCode(), type: 0 },
  });
  expect(asSomethingElse.status()).toBe(400);
  // Nor with what isn't a public key, or an access code too short to guess at.
  for (const data of [
    { publicKey: "not base64!", accessCode: accessCode() },
    { publicKey: publicKey().toString("base64"), accessCode: "1234" },
  ]) {
    const refused = await request.post("/api/auth-requests", {
      headers: { "Device-Type": WEB },
      data: { email: ana.email, deviceIdentifier: first.device, type: 0, ...data },
    });
    expect(refused.status()).toBe(400);
  }
});

test("an approval signs in only the device that asked, as the type it asked as", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const laptop = await session(request, ana);
  const asking = await session(request, ana);
  const elsewhere = await session(request, ana);
  const a = await asked(request, ana, asking.device);
  expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(200);
  // The access code alone isn't enough: another of the account's devices,
  // or the same one saying it's something else, is refused.
  expect((await signIn(request, ana, elsewhere.device, a)).status).toBe(400);
  expect((await signIn(request, ana, randomUUID(), a)).status).toBe(400);
  expect((await signIn(request, ana, asking.device, a, "10")).status).toBe(400);
  // Refusals don't use it up: the device that asked still signs in, once.
  const signedIn = await signIn(request, ana, asking.device, a);
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  expect((await signIn(request, ana, asking.device, a)).status).toBe(400);
});

test("an approval carries only a type 4 key: never a master password hash", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const laptop = await session(request, ana);
  const asking = await session(request, ana);
  const a = await asked(request, ana, asking.device);
  // Not a symmetric string, not OAEP with SHA-256, not a short one.
  for (const key of [encString("user-key"), `3.${randomBytes(256).toString("base64")}`, `4.${randomBytes(16).toString("base64")}`]) {
    expect((await answer(api, laptop, laptop.device, a, true, key)).status, key.slice(0, 12)).toBe(400);
  }
  const approved = await api.call(laptop, "PUT", `/api/auth-requests/${a.id}`, {
    deviceIdentifier: laptop.device,
    key: wrapped(a),
    masterPasswordHash: Buffer.from("a master password hash").toString("base64"),
    requestApproved: true,
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(approved.body.masterPasswordHash).toBeNull();
  expect((await api.call(laptop, "GET", `/api/auth-requests/${a.id}`)).body.masterPasswordHash).toBeNull();
  const read = await poll(request, a);
  expect(read.body.requestApproved).toBe(true);
  expect(read.body.masterPasswordHash).toBeNull();
});

test("a device asks five times an hour at most", async ({ request }) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const laptop = await session(request, ana);
  const asking = await session(request, ana);
  for (let i = 0; i < 5; i++) {
    await asked(request, ana, asking.device);
  }
  const sixth = await ask(request, ana, asking.device);
  expect(sixth.status).toBe(429);
  // The one waiting is the last; another device still asks.
  expect(await pending(api, laptop)).toHaveLength(1);
  expect((await ask(request, ana, (await session(request, ana)).device)).status).toBe(200);
});

test("an organization that requires single sign-on requires it of a device's approval too", async ({ request }) => {
  const api = new Api(request);
  const sso = await ssoOrg(api, "approval-sso");
  const { owner, orgId, identifier, domain } = sso;
  const gus = await api.account("approval-gus", `gus-${randomUUID().slice(0, 8)}@${domain}`);
  await api.addMember(owner, orgId, gus, "user");
  // Signed in on two devices before the organization requires it.
  const laptop = await session(request, gus);
  const asking = await session(request, gus);
  for (const type of [3, 4]) {
    const on = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/${type}`, {
      policy: { enabled: true, data: null },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }
  // Gus's password goes to single sign-on now; so does a device's approval,
  // even one his still-open session gives.
  const a = await asked(request, gus, asking.device);
  expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(200);
  const refused = await signIn(request, gus, asking.device, a);
  expect(refused.status).toBe(400);
  expect(refused.body.SsoOrganizationIdentifier).toBe(identifier);
  expect(refused.body.access_token).toBeUndefined();
  // The owner, whom it never binds, still signs in with a device.
  const ownerLaptop = await session(request, owner);
  const ownerAsking = await session(request, owner);
  const b = await asked(request, owner, ownerAsking.device);
  expect((await answer(api, ownerLaptop, ownerLaptop.device, b, true)).status).toBe(200);
  expect((await signIn(request, owner, ownerAsking.device, b)).status).toBe(200);
});

// Single sign-on sessions approving (DESIGN.md, "Approving a sign-in from
// another device", "Who approves"): single sign-on only proves who's signing
// in, and the master password still unlocks the vault, so a session that
// signed in with the organization's single sign-on (the Entra stand-in)
// approves as a master password's does. The account here has real keys, and
// the device asking opens what it gets, as it would.

/**
 * A member of an organization with single sign-on, with real keys, linked
 * the way the web vault's Link SSO links (with the master password), then
 * signed in with single sign-on on a device of its own.
 */
async function ssoMember(request: APIRequestContext, api: Api, name: string) {
  const sso = await ssoOrg(api, name);
  const real = await realAccount(request, name, `${name}-${randomUUID().slice(0, 8)}@${sso.domain}`);
  // As an Account, its password is what the apps send for it: the hash.
  const member: Account = { email: real.email, password: real.passwordHash, token: real.token, userId: real.userId };
  await api.addMember(sso.owner, sso.orgId, member, "user");
  const person = await sso.tenant.person(member.email);
  await sso.tenant.next(person);
  const origin = `https://127.0.0.1:${port}`;
  const linked = await linkFromSession(request, origin, member, sso.identifier);
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);
  await sso.tenant.next(person);
  const viaSso = await ssoSignIn(request, origin, sso.identifier);
  expect(viaSso.token?.status, JSON.stringify(viaSso.token?.body)).toBe(200);
  const token = viaSso.token!.body.access_token as string;
  expect(signedInWith(token)).toBe("sso");
  const ssoSession = {
    token,
    refresh: viaSso.token!.body.refresh_token as string,
    device: claimsOf(token).device as string,
  };
  return { sso, real, member, ssoSession };
}

/** A request whose private key the test keeps, as the device asking keeps it. */
async function askedKeepingKey(request: APIRequestContext, who: Account, device: string) {
  const { publicKey: key, privateKey } = rsaKeyPair();
  const made = await ask(request, who, device, undefined, key);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { ...made.asked, privateKey };
}

/** What the device asking does with an approval's key: opens it with its private key (RSA-OAEP, SHA-1). */
function openApproval(privateKey: Buffer, key: string) {
  expect(key.startsWith("4."), key.slice(0, 12)).toBe(true);
  return privateDecrypt(
    { key: privateKey, format: "der", type: "pkcs8", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    Buffer.from(key.slice(2), "base64"),
  );
}

const STILL_REFUSED =
  "Approve sign-ins from a device where you signed in with your master password or single sign-on, not one another device approved";

test("a session that signed in with single sign-on approves, and the key it sends opens the account on the device that asked", async ({
  request,
}) => {
  const api = new Api(request);
  const { real, member, ssoSession } = await ssoMember(request, api, "sso-approves");
  const item = `Credit union ${randomUUID().slice(0, 8)}`;
  await realPersonalLogin(request, real, { name: item, username: "dee", password: "pw", uri: "https://cu.example.test" });

  // The device asking signed in before, so the account knows it.
  const phone = await session(request, member);
  const a = await askedKeepingKey(request, member, phone.device);

  // The single sign-on session sees it, and approves it with the user key
  // wrapped to the request's public key, as an approving app sends it.
  expect(await pending(api, ssoSession)).toEqual([a.id]);
  const approved = await answer(api, ssoSession, ssoSession.device, a, true, encryptTo(a.key, real.userKey));
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(approved.body).toMatchObject({ requestApproved: true, masterPasswordHash: null });

  // The device that asked reads it with its access code, and its private key
  // opens the account's user key.
  const read = await poll(request, a);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body.requestApproved).toBe(true);
  const userKey = openApproval(a.privateKey, read.body.key);
  expect(userKey.equals(real.userKey)).toBe(true);

  // It signs in with the approval, as a session from an approval, and that
  // key opens the account's private key in the answer, and its items.
  const signedIn = await signIn(request, member, phone.device, a);
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  expect(signedInWith(signedIn.body.access_token)).toBe("authrequest");
  const accountKey = createPrivateKey({ key: decrypt(userKey, signedIn.body.PrivateKey), format: "der", type: "pkcs8" });
  expect(createPublicKey(accountKey).export({ type: "spki", format: "der" }).equals(real.publicKey)).toBe(true);
  const synced = await api.call({ token: signedIn.body.access_token }, "GET", "/api/sync");
  expect(synced.status).toBe(200);
  const names = (synced.body.ciphers as { name: string }[]).map((c) => decrypt(userKey, c.name).toString());
  expect(names).toContain(item);
  // Once.
  expect((await signIn(request, member, phone.device, a)).status).toBe(400);
});

test("a session from a single sign-on session's approval can't approve, nor can an API key's, and they're told where to", async ({
  request,
}) => {
  const api = new Api(request);
  const { real, member, ssoSession } = await ssoMember(request, api, "sso-approves-next");
  // The single sign-on session approves the phone, which signs in with it.
  const phone = await session(request, member);
  const first = await asked(request, member, phone.device);
  expect((await answer(api, ssoSession, ssoSession.device, first, true, encryptTo(first.key, real.userKey))).status).toBe(200);
  const fromApproval = await signIn(request, member, phone.device, first);
  expect(fromApproval.status, JSON.stringify(fromApproval.body)).toBe(200);
  const approvedPhone = {
    token: fromApproval.body.access_token as string,
    refresh: fromApproval.body.refresh_token as string,
  };
  expect(signedInWith(approvedPhone.token)).toBe("authrequest");

  // The phone's session can't approve the next device, so one approval
  // doesn't spread...
  const tablet = await session(request, member);
  const second = await asked(request, member, tablet.device);
  const refused = await answer(api, approvedPhone, phone.device, second, true);
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain(STILL_REFUSED);
  // ...nor after refreshing its session...
  const refreshed = await request.post("/identity/connect/token", {
    form: { grant_type: "refresh_token", client_id: "web", refresh_token: approvedPhone.refresh },
  });
  expect(refreshed.status()).toBe(200);
  const refreshedToken = (await refreshed.json()).access_token as string;
  expect(signedInWith(refreshedToken)).toBe("authrequest");
  expect((await answer(api, { token: refreshedToken }, phone.device, second, true)).status).toBe(400);

  // ...nor does the member's API key's.
  const apiKey = await api.call(member, "POST", "/api/accounts/api-key", { masterPasswordHash: member.password });
  expect(apiKey.status, JSON.stringify(apiKey.body)).toBe(200);
  const cli = randomUUID();
  const byKey = await request.post("/identity/connect/token", {
    form: {
      grant_type: "client_credentials",
      client_id: `user.${member.userId}`,
      client_secret: apiKey.body.apiKey,
      scope: "api",
      deviceType: "25",
      deviceIdentifier: cli,
      deviceName: "linux",
    },
  });
  expect(byKey.status(), await byKey.text()).toBe(200);
  const byKeyRefused = await answer(api, { token: (await byKey.json()).access_token }, cli, second, true);
  expect(byKeyRefused.status).toBe(400);
  expect(JSON.stringify(byKeyRefused.body)).toContain(STILL_REFUSED);

  // Nothing was sent meanwhile: the tablet's request still waits, with no key.
  expect((await poll(request, second)).body).toMatchObject({ key: null, requestApproved: null });

  // The single sign-on session, refreshed, still says how it began, and
  // approves it; the tablet signs in.
  const ssoRefreshed = await request.post("/identity/connect/token", {
    form: { grant_type: "refresh_token", client_id: "web", refresh_token: ssoSession.refresh },
  });
  expect(ssoRefreshed.status(), await ssoRefreshed.text()).toBe(200);
  const ssoToken = (await ssoRefreshed.json()).access_token as string;
  expect(signedInWith(ssoToken)).toBe("sso");
  const approved = await answer(api, { token: ssoToken }, ssoSession.device, second, true, encryptTo(second.key, real.userKey));
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect((await signIn(request, member, tablet.device, second)).status).toBe(200);
});

test("with single sign-on required, a single sign-on session's approval still doesn't stand in for it", async ({
  request,
}) => {
  const api = new Api(request);
  const { sso, real, member, ssoSession } = await ssoMember(request, api, "sso-approves-required");
  // A device the account knows, from before the organization required it.
  const phone = await session(request, member);
  for (const type of [3, 4]) {
    const on = await api.call(sso.owner, "PUT", `/api/organizations/${sso.orgId}/policies/${type}`, {
      policy: { enabled: true, data: null },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }
  // The member's single sign-on session approves, but the device that asked
  // is sent to single sign-on, as a password would be.
  const a = await asked(request, member, phone.device);
  expect((await answer(api, ssoSession, ssoSession.device, a, true, encryptTo(a.key, real.userKey))).status).toBe(200);
  const refused = await signIn(request, member, phone.device, a);
  expect(refused.status).toBe(400);
  expect(refused.body.SsoOrganizationIdentifier).toBe(sso.identifier);
  expect(refused.body.access_token).toBeUndefined();
});

test("a session an approval began can't set up emergency access", async ({ request }) => {
  const api = new Api(request);
  const [ana, ben, cal] = await Promise.all([api.account("ana"), api.account("ben"), api.account("cal")]);
  const laptop = await session(request, ana);
  const phone = await session(request, ana);
  const a = await asked(request, ana, phone.device);
  expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(200);
  const fromApproval = await signIn(request, ana, phone.device, a);
  expect(fromApproval.status).toBe(200);
  const approvedPhone = { token: fromApproval.body.access_token as string };

  const invite = (email: string) => ({ email, type: 1, waitTimeDays: 1 });
  const refused = await api.call(approvedPhone, "POST", "/api/emergency-access/invite", invite(cal.email));
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain("signed in with your master password or single sign-on");

  // From the master password's session it's set up as usual (with no mail,
  // an existing account accepts at once)...
  expect((await api.call(laptop, "POST", "/api/emergency-access/invite", invite(ben.email))).status).toBe(200);
  const trusted = await api.call(laptop, "GET", "/api/emergency-access/trusted");
  const grant = trusted.body.data.find((g: { email: string }) => g.email === ben.email);
  expect(grant.status).toBe(1);
  // ...but the approval's session can't change it or confirm it.
  expect(
    (await api.call(approvedPhone, "PUT", `/api/emergency-access/${grant.id}`, { type: 1, waitTimeDays: 0 })).status,
  ).toBe(400);
  expect(
    (await api.call(approvedPhone, "POST", `/api/emergency-access/${grant.id}/confirm`, { key: encString("for-ben") })).status,
  ).toBe(400);
  const confirmed = await api.call(laptop, "POST", `/api/emergency-access/${grant.id}/confirm`, { key: encString("for-ben") });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
});

/** A session from a device's approval: the account's laptop approves its phone. */
async function approvedSession(request: APIRequestContext, api: Api, who: Account) {
  const laptop = await session(request, who);
  const phone = await session(request, who);
  const a = await asked(request, who, phone.device);
  expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(200);
  const signedIn = await signIn(request, who, phone.device, a);
  expect(signedIn.status).toBe(200);
  expect(signedInWith(signedIn.body.access_token)).toBe("authrequest");
  return { laptop, approved: { token: signedIn.body.access_token as string } };
}

const invite = (email: string) => ({ email, type: 1, waitTimeDays: 1 });

test("someone signed in with single sign-on uses emergency access; an approval's session of theirs can't", async ({
  request,
}) => {
  const api = new Api(request);
  const sso = await ssoOrg(api, "ea-sso");
  const dee = await api.account("ea-dee", `dee-${randomUUID().slice(0, 8)}@${sso.domain}`);
  await api.addMember(sso.owner, sso.orgId, dee, "user");
  const [ben, cal] = await Promise.all([api.account("ben"), api.account("cal")]);
  const person = await sso.tenant.person(dee.email);
  await sso.tenant.next(person);
  const origin = `https://127.0.0.1:${port}`;
  const linked = await linkFromSession(request, origin, dee, sso.identifier);
  expect(linked.status, JSON.stringify(linked.body)).toBe(200);
  await sso.tenant.next(person);
  const viaSso = await ssoSignIn(request, origin, sso.identifier);
  expect(viaSso.token?.status, JSON.stringify(viaSso.token?.body)).toBe(200);
  const ssoSession = { token: viaSso.token!.body.access_token as string };
  expect(signedInWith(ssoSession.token)).toBe("sso");

  // A session from a device's approval can't invite...
  const { approved } = await approvedSession(request, api, dee);
  expect((await api.call(approved, "POST", "/api/emergency-access/invite", invite(cal.email))).status).toBe(400);
  // ...the single sign-on session invites and confirms.
  const invited = await api.call(ssoSession, "POST", "/api/emergency-access/invite", invite(ben.email));
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const trusted = await api.call(ssoSession, "GET", "/api/emergency-access/trusted");
  const grant = trusted.body.data.find((g: { email: string }) => g.email === ben.email);
  expect(grant.status).toBe(1);
  expect((await api.call(approved, "POST", `/api/emergency-access/${grant.id}/confirm`, { key: encString("for-ben") })).status).toBe(400);
  const confirmed = await api.call(ssoSession, "POST", `/api/emergency-access/${grant.id}/confirm`, { key: encString("for-ben") });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
});

test("a grantee's session from an approval can't start a takeover, take over, or set the new password", async ({ request }) => {
  const api = new Api(request);
  const [ana, ben] = await Promise.all([api.account("ana"), api.account("ben")]);
  const anaLaptop = await session(request, ana);
  expect((await api.call(anaLaptop, "POST", "/api/emergency-access/invite", invite(ben.email))).status).toBe(200);
  const grant = (await api.call(anaLaptop, "GET", "/api/emergency-access/trusted")).body.data.find(
    (g: { email: string }) => g.email === ben.email,
  );
  expect((await api.call(anaLaptop, "POST", `/api/emergency-access/${grant.id}/confirm`, { key: encString("for-ben") })).status).toBe(200);

  const { laptop: benLaptop, approved: benPhone } = await approvedSession(request, api, ben);
  const refusedStart = await api.call(benPhone, "POST", `/api/emergency-access/${grant.id}/initiate`);
  expect(refusedStart.status).toBe(400);
  expect(JSON.stringify(refusedStart.body)).toContain("signed in with your master password or single sign-on");
  expect((await api.call(benLaptop, "POST", `/api/emergency-access/${grant.id}/initiate`)).status).toBe(200);
  // Ana lets it through early, from her own master password's session.
  expect((await api.call(anaLaptop, "POST", `/api/emergency-access/${grant.id}/approve`)).status).toBe(200);

  expect((await api.call(benPhone, "POST", `/api/emergency-access/${grant.id}/takeover`)).status).toBe(400);
  const takeover = await api.call(benLaptop, "POST", `/api/emergency-access/${grant.id}/takeover`);
  expect(takeover.status, JSON.stringify(takeover.body)).toBe(200);
  expect(takeover.body.keyEncrypted).toBe(encString("for-ben"));
  const newPassword = { newMasterPasswordHash: Buffer.from("new-hash").toString("base64"), key: encString("ana-new-key") };
  expect((await api.call(benPhone, "POST", `/api/emergency-access/${grant.id}/password`, newPassword)).status).toBe(400);
  expect((await api.call(benLaptop, "POST", `/api/emergency-access/${grant.id}/password`, newPassword)).status).toBe(200);
});

// Where a request comes from (DESIGN.md, "Approving a sign-in from another
// device", "Our apps" and "The web vault and the extension"): the
// new-device check's fields and words, from the server's location database
// alone, on a server of its own with the tiny database of made-up places
// (fixtures/location/make.mjs) and the new-device check off. The places are
// on documentation addresses no real database has, so seeing them means the
// server read that file. The main server, with no database, says nothing
// (the first test above).
test.describe("where a request comes from", () => {
  const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
  // Where the made-up places are.
  const BERLIN = "203.0.113.7";
  const CANADA = "198.51.100.4";
  const HOME_NETWORK = "10.1.2.3";
  const DB_IP = { name: "IP Geolocation by DB-IP", url: "https://db-ip.com" };

  let server: ChildProcess;
  let http: APIRequestContext;

  test.beforeAll(async () => {
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: e2eDir,
      env: { ...process.env, KK_PORT: locationServerPort, KK_LOCATION: "1" },
      stdio: "ignore",
    });
    http = await apiRequest.newContext({
      baseURL: `https://127.0.0.1:${locationServerPort}`,
      ignoreHTTPSErrors: true,
    });
    await expect
      .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
      .toBe(200);
  });

  test.afterAll(async () => {
    await http?.dispose();
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  });

  test("a request says where it comes from, with the database's credit, to the account's other devices", async () => {
    const api = new Api(http);
    const ana = await api.account("ana");
    const laptop = await session(http, ana);
    const berlin = await session(http, ana);
    const home = await session(http, ana);
    const fromBerlin = await asked(http, ana, berlin.device, BERLIN);
    const fromHome = await asked(http, ana, home.device, HOME_NETWORK);

    const listed = await api.call(laptop, "GET", "/api/auth-requests/pending");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const byId = new Map((listed.body.data as { id: string }[]).map((r) => [r.id, r]));
    expect(byId.get(fromBerlin.id)).toMatchObject({
      requestIpAddress: BERLIN,
      location: "Fixture City, Germany",
      locationSource: DB_IP,
    });
    // An address the database can't place (a private one): no location,
    // and the credit still says whose database it is.
    expect(byId.get(fromHome.id)).toMatchObject({
      requestIpAddress: HOME_NETWORK,
      location: null,
      locationSource: DB_IP,
    });

    // The request on its own, as the web vault's and the extension's dialog
    // reads it, says the same; upstream's fields are as they were, and
    // upstream's own country field stays unset (its dialog would show it
    // with no credit).
    const one = await api.call(laptop, "GET", `/api/auth-requests/${fromBerlin.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      id: fromBerlin.id,
      publicKey: fromBerlin.key.toString("base64"),
      requestDeviceType: "Chrome",
      requestDeviceIdentifier: berlin.device,
      requestIpAddress: BERLIN,
      requestApproved: null,
      object: "auth-request",
      location: "Fixture City, Germany",
      locationSource: DB_IP,
    });
    expect(one.body.requestCountryName).toBeUndefined();

    // Another account still sees nothing of it.
    const ben = await api.account("ben");
    expect((await api.call(ben, "GET", `/api/auth-requests/${fromBerlin.id}`)).status).toBe(404);
    expect(await pending(api, ben)).toEqual([]);
  });

  test("a location is a hint, never a check: a request from another country is approved and signs in as any other", async () => {
    const api = new Api(http);
    const ana = await api.account("ana");
    const laptop = await session(http, ana);
    const travelling = await session(http, ana);
    const a = await asked(http, ana, travelling.device, CANADA);
    const one = await api.call(laptop, "GET", `/api/auth-requests/${a.id}`);
    expect(one.body).toMatchObject({ location: "Canada", locationSource: DB_IP });

    expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(200);
    expect((await poll(http, a, a.code, CANADA)).body).toMatchObject({ requestApproved: true });
    const signedIn = await signIn(http, ana, travelling.device, a, WEB, CANADA);
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  });
});

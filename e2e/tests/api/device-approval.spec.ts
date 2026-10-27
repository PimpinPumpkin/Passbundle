// Approving a sign-in from another device, the server's side (DESIGN.md,
// "Approving a sign-in from another device"), every endpoint against every
// caller: a device the account knows asks; only the account's other devices
// see the request; only one that signed in with the master password approves
// it (not the device that asked, a session that itself came from an
// approval, an API key, another account, or no one); an approval carries only
// a type 4 key, never a master password hash; an approval signs in the device
// that asked, once; a denial signs nothing in; a request lasts 15 minutes; a
// device asks five times an hour at most; an organization's "Require single
// sign-on" holds for it too; and a session an approval began can't set up
// emergency access.
// The server stores keys as it gets them, so the public key is a real one
// (from Node) and the wrapped key a stand-in of the right shape.
import { constants, generateKeyPairSync, publicEncrypt, randomBytes, randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { ssoOrg } from "../support/entra";

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
) {
  const response = await request.post("/identity/connect/token", {
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

/** What the access token says about how the session signed in. */
const signedInWith = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).keykeeper_signin;

function publicKey() {
  const { publicKey: key } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return key.export({ type: "spki", format: "der" });
}

/** Letters and digits, as the web vault makes them. */
const accessCode = () => randomBytes(32).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 25);

type Asked = { id: string; code: string; key: Buffer };

async function ask(request: APIRequestContext, who: Account, device: string) {
  const key = publicKey();
  const code = accessCode();
  const response = await request.post("/api/auth-requests", {
    headers: { "Device-Type": WEB },
    data: { email: who.email, deviceIdentifier: device, publicKey: key.toString("base64"), accessCode: code, type: 0 },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status(), body, asked: { id: body?.id, code, key } as Asked };
}

async function asked(request: APIRequestContext, who: Account, device: string): Promise<Asked> {
  const made = await ask(request, who, device);
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
async function poll(request: APIRequestContext, a: Asked, code = a.code) {
  const response = await request.get(`/api/auth-requests/${a.id}/response?code=${code}`, {
    headers: { "Device-Type": WEB },
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
    }),
  ]);
  expect(await pending(api, asking)).toEqual([]);
  expect(await pending(api, ben)).toEqual([]);
  expect((await api.call(null, "GET", "/api/auth-requests/pending")).status).toBe(401);
  expect((await api.call(ben, "GET", `/api/auth-requests/${a.id}`)).status).toBe(400);
  expect((await api.call(null, "GET", `/api/auth-requests/${a.id}`)).status).toBe(401);
  expect((await api.call(laptop, "GET", `/api/auth-requests/${a.id}`)).status).toBe(200);

  // Nobody else answers it, the device asking can't answer its own, and an
  // approval carries a key.
  const benLaptop = await session(request, ben);
  expect((await answer(api, benLaptop, benLaptop.device, a, true)).status).toBe(400);
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

test("only a session that signed in with the master password approves", async ({ request }) => {
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
  expect((await api.call(laptop, "GET", `/api/auth-requests/${second.id}`)).status).toBe(400);
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
  expect((await api.call(laptop, "GET", `/api/auth-requests/${a.id}`)).status).toBe(400);
  expect((await poll(request, a)).status).toBe(400);
  expect((await signIn(request, ana, asking.device, a)).status).toBe(400);
  expect((await answer(api, laptop, laptop.device, a, true)).status).toBe(400);
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
  expect((await api.call(laptop, "GET", `/api/auth-requests/${replaced.id}`)).status).toBe(400);

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
  expect(JSON.stringify(refused.body)).toContain("signed in with your master password");

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

// Reload keys (DESIGN.md, "Staying unlocked across a reload"): the server
// keeps a web vault tab's R in memory and gives it back only to the same
// account, on the same device, for the same tab, with the tab's reload cookie,
// while the tab keeps checking in and within its timeout and the
// organization's Vault lock policy. Locking, signing out, a new master
// password, and "Deauthorize sessions" forget it at once. These requests
// share one cookie jar, as a browser does, so the tab's cookie goes along
// unless a test says otherwise.
import { randomBytes, randomUUID } from "node:crypto";

import { type APIRequestContext, type APIResponse, expect, test } from "@playwright/test";

import { limitsServerPort, port } from "../../paths.mjs";

import { Api, type Account, encString, publicKey } from "./support";

const VAULT_LOCK = 9;
const r = () => randomBytes(64).toString("base64");
const tab = () => randomBytes(16).toString("hex");

/** A session of its own: the account signed in on one device. */
async function session(request: APIRequestContext, account: Account, device = randomUUID()) {
  const response = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: account.email,
      password: account.password,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: device,
      deviceName: "reload-key-test",
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return { token: (await response.json()).access_token as string, device };
}

const keep = (
  api: Api,
  as: { token: string },
  tabId: string,
  key: string,
  timeoutMinutes = 15,
  pageId?: string,
) => api.call(as, "POST", "/api/keykeeper/reload-key", { tabId, pageId, key, timeoutMinutes });
const release = (api: Api, as: { token: string }, tabId: string, pageId?: string) =>
  api.call(as, "POST", "/api/keykeeper/reload-key/release", { tabId, pageId });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const checkIn = (
  api: Api,
  as: { token: string },
  tabId: string,
  idleSeconds: number,
  timeoutMinutes = 15,
) =>
  api.call(as, "POST", "/api/keykeeper/reload-key/check-in", {
    tabId,
    idleSeconds,
    timeoutMinutes,
  });

test("only the account, device, and tab that kept R get it back", async ({ request }) => {
  const api = new Api(request);
  const alice = await api.account("alice");
  const bob = await api.account("bob");
  const aliceElsewhere = await session(request, alice);
  const tabId = tab();
  const key = r();

  expect((await keep(api, alice, tabId, key)).status).toBe(200);
  const got = await release(api, alice, tabId);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  expect(got.body.key).toBe(key);
  // A second reload works too.
  expect((await release(api, alice, tabId)).body.key).toBe(key);

  // Another account, the same account on another device, another tab, or no
  // one: the same answer as a tab that never had one.
  for (const [as, id] of [
    [bob, tabId],
    [aliceElsewhere, tabId],
    [alice, tab()],
  ] as const) {
    const refused = await release(api, as, id);
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain(key);
  }
  expect((await release(api, null as unknown as Account, tabId)).status).toBe(401);
  // Bob checking in on Alice's tab doesn't keep it either.
  expect((await checkIn(api, bob, tabId, 0)).status).toBe(404);
});

test("a tab unused for its timeout loses R, and so does one that forgets it", async ({ request }) => {
  const api = new Api(request);
  const alice = await api.account("alice");

  const idle = tab();
  expect((await keep(api, alice, idle, r(), 5)).status).toBe(200);
  expect((await checkIn(api, alice, idle, 60, 5)).status).toBe(200);
  // Not used for 5 minutes: gone, now and at the next reload.
  expect((await checkIn(api, alice, idle, 300, 5)).status).toBe(404);
  expect((await release(api, alice, idle)).status).toBe(404);

  const locked = tab();
  expect((await keep(api, alice, locked, r())).status).toBe(200);
  const forget = await api.call(alice, "POST", "/api/keykeeper/reload-key/forget", { tabId: locked });
  expect(forget.status).toBe(200);
  expect((await release(api, alice, locked)).status).toBe(404);
  // Forgetting again, or a tab that never had one, answers the same.
  for (const tabId of [locked, tab()]) {
    expect((await api.call(alice, "POST", "/api/keykeeper/reload-key/forget", { tabId })).status).toBe(200);
  }
});

test("the server refuses what isn't a reload key, and never echoes it", async ({ request }) => {
  const api = new Api(request);
  const alice = await api.account("alice");
  const key = r();
  for (const body of [
    { tabId: tab(), key: randomBytes(32).toString("base64"), timeoutMinutes: 15 },
    { tabId: "not-a-tab", key, timeoutMinutes: 15 },
    { tabId: tab().toUpperCase(), key, timeoutMinutes: 15 },
    { tabId: tab(), key, timeoutMinutes: 0 },
    { tabId: tab(), key, timeoutMinutes: -1 },
    { tabId: tab(), key, timeoutMinutes: "15" },
    { tabId: tab(), key: "not base64!", timeoutMinutes: 15 },
    { tabId: tab(), timeoutMinutes: 15 },
  ]) {
    const refused = await api.call(alice, "POST", "/api/keykeeper/reload-key", body);
    expect(refused.status, JSON.stringify(body)).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain(key);
  }
  // Not even JSON.
  const garbled = await request.post("/api/keykeeper/reload-key", {
    headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
    data: `{"tabId":"${tab()}","key":"${key}",`,
  });
  expect(garbled.status()).toBe(400);
  expect(await garbled.text()).not.toContain(key);
});

test("a new master password, or Deauthorize sessions, forgets every tab's R at once", async ({
  request,
}) => {
  const api = new Api(request);
  for (const change of ["password", "deauthorize"] as const) {
    const alice = await api.account(`alice-${change}`);
    const laptop = await session(request, alice);
    const tabId = tab();
    expect((await keep(api, laptop, tabId, r())).status).toBe(200);

    let password = alice.password;
    if (change === "password") {
      password = Buffer.from(`new-hash-${alice.email}`).toString("base64");
      const changed = await api.call(alice, "POST", "/api/accounts/password", {
        masterPasswordHash: alice.password,
        newMasterPasswordHash: password,
        key: encString(`new-user-key-${alice.email}`),
      });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    } else {
      const deauthorized = await api.call(alice, "POST", "/api/accounts/security-stamp", {
        masterPasswordHash: alice.password,
      });
      expect(deauthorized.status, JSON.stringify(deauthorized.body)).toBe(200);
    }

    // The old session is over, and signing in again on the same device
    // doesn't bring R back.
    expect((await release(api, laptop, tabId)).status).toBe(401);
    const again = await session(request, { ...alice, password }, laptop.device);
    expect((await release(api, again, tabId)).status, change).toBe(404);
  }
});

test("the Vault lock policy caps the wait for everyone in the organization, owners included", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const member = await api.account("member");
  const orgId = await api.organization(owner, "Harbor Dental");
  await api.addMember(owner, orgId, member, "user");

  const setPolicy = async (data: unknown) => {
    const set = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/${VAULT_LOCK}`, {
      policy: { enabled: true, data },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  };

  // When the computer locks, with the web vault's wait at 1 minute. For
  // reload keys only, owners are bound too: refusing one costs a prompt.
  await setPolicy({ type: "onSystemLock", minutes: null, webMinutes: 1, action: "lock" });
  for (const who of [member, owner]) {
    const tabId = tab();
    expect((await keep(api, who, tabId, r(), 15)).status).toBe(200);
    expect((await checkIn(api, who, tabId, 59, 15)).status).toBe(200);
    // 61 seconds unused: past the minute.
    expect((await checkIn(api, who, tabId, 61, 15)).status).toBe(404);
    expect((await release(api, who, tabId)).status).toBe(404);
  }

  // A longest wait caps it the same way.
  await setPolicy({ type: "custom", minutes: 5, action: "lock" });
  const custom = tab();
  expect((await keep(api, member, custom, r(), 60)).status).toBe(200);
  expect((await checkIn(api, member, custom, 299, 60)).status).toBe(200);
  expect((await checkIn(api, member, custom, 300, 60)).status).toBe(404);

  // "Immediately", signing out at the timeout, and webReload: false each
  // refuse reload keys, for owners too, and end one kept before at the next
  // reload.
  for (const data of [
    { type: "immediately", minutes: null, action: "lock" },
    { type: "custom", minutes: 30, action: "logOut" },
    { type: "onSystemLock", minutes: null, action: "lock", webReload: false },
  ]) {
    await setPolicy({ type: "custom", minutes: 30, action: "lock" });
    const before = tab();
    expect((await keep(api, owner, before, r(), 15)).status).toBe(200);
    await setPolicy(data);
    for (const who of [member, owner]) {
      expect((await keep(api, who, tab(), r(), 1)).status, JSON.stringify(data)).toBe(400);
    }
    expect((await release(api, owner, before)).status, JSON.stringify(data)).toBe(404);
  }
});

test("the strictest policy of every organization someone is in applies", async ({ request }) => {
  const api = new Api(request);
  const member = await api.account("member");
  const owners = [await api.account("owner-a"), await api.account("owner-b")];
  const orgs: string[] = [];
  for (const [i, owner] of owners.entries()) {
    const orgId = await api.organization(owner, `Clinic ${i}`);
    await api.addMember(owner, orgId, member, "user");
    orgs.push(orgId);
  }
  const setPolicy = async (i: number, data: unknown) => {
    const set = await api.call(owners[i], "PUT", `/api/organizations/${orgs[i]}/policies/${VAULT_LOCK}`, {
      policy: { enabled: true, data },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  };

  await setPolicy(0, { type: "custom", minutes: 10, action: "lock" });
  await setPolicy(1, { type: "onSystemLock", webMinutes: 3, action: "lock" });
  const tabId = tab();
  expect((await keep(api, member, tabId, r(), 60)).status).toBe(200);
  expect((await checkIn(api, member, tabId, 179, 60)).status).toBe(200);
  expect((await checkIn(api, member, tabId, 181, 60)).status).toBe(404);

  // One organization that refuses outweighs the other's wait.
  await setPolicy(1, { type: "onSystemLock", webMinutes: 3, action: "lock", webReload: false });
  expect((await keep(api, member, tab(), r(), 5)).status).toBe(400);
});

test("the server's own clock ends an entry past the cap, with nothing from the tab", async ({
  request,
}) => {
  test.setTimeout(150_000);
  const api = new Api(request);
  const owner = await api.account("owner");
  const member = await api.account("member");
  const orgId = await api.organization(owner, "Pinecrest Clinic");
  await api.addMember(owner, orgId, member, "user");
  const set = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/${VAULT_LOCK}`, {
    policy: { enabled: true, data: { type: "onSystemLock", webMinutes: 1, action: "lock" } },
  });
  expect(set.status).toBe(200);

  // The tab asks for 15 minutes and never checks in; the server caps it at 1.
  const tabId = tab();
  expect((await keep(api, member, tabId, r(), 15)).status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 65_000));
  expect((await release(api, member, tabId)).status).toBe(404);
});

test("a page that leaves ends its entry unless a reload asks within seconds", async ({ request, playwright }) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const alice = await api.account("alice");
  const tabId = tab();
  // Each load of the tab has its own page id.
  const [first, second, third] = [tab(), tab(), tab()];
  expect((await keep(api, alice, tabId, r(), 15, first)).status).toBe(200);
  // A beacon: no access token, only the tab's cookie (in this jar).
  const leaving = (pageId: string) => request.post("/api/keykeeper/reload-key/leaving", { data: { tabId, pageId } });

  // A reload: the page leaving, then the new page asks.
  expect((await leaving(first)).status()).toBe(200);
  expect((await release(api, alice, tabId, second)).status).toBe(200);

  // Without the cookie, saying it's leaving changes nothing.
  const stranger = await playwright.request.newContext({
    baseURL: `https://127.0.0.1:${port}`,
    ignoreHTTPSErrors: true,
  });
  const strangerLeaving = await stranger.post("/api/keykeeper/reload-key/leaving", { data: { tabId, pageId: second } });
  expect(strangerLeaving.status()).toBe(200);
  await stranger.dispose();
  // Nor does a late beacon from the page before the reload.
  expect((await leaving(first)).status()).toBe(200);
  await sleep(16_000);
  expect((await release(api, alice, tabId, third)).status).toBe(200);

  // Closed: leaving, and nothing asks; a check-in doesn't count. Reopened
  // 16 seconds later, it finds nothing.
  expect((await leaving(third)).status()).toBe(200);
  expect((await checkIn(api, alice, tabId, 0)).status).toBe(200);
  await sleep(16_000);
  expect((await release(api, alice, tabId)).status).toBe(404);
});

test.describe("with the server's real limits", () => {
  test.use({ baseURL: `https://127.0.0.1:${limitsServerPort}` });

  test("closing many tabs never uses up an address's limit for signing up and signing in", async ({ request }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const alice = await api.account("leaving-alice");
    const tabId = tab();
    expect((await keep(api, alice, tabId, r())).status).toBe(200);

    // An office closing tabs whose entries already ended: far more than the
    // 150 that requests without a session share at one address.
    const unmatched = () =>
      request
        .post("/api/keykeeper/reload-key/leaving", { data: { tabId: tab(), pageId: tab() } })
        .then((response) => response.status());
    const statuses: number[] = [];
    for (let batch = 0; batch < 9; batch++) {
      statuses.push(...(await Promise.all(Array.from({ length: 50 }, unmatched))));
    }
    expect(statuses.slice(0, 250)).not.toContain(429);
    // Beacons that match nothing have a limit of their own; a tab's real
    // one, with its cookie, doesn't count against it.
    expect(statuses).toContain(429);
    expect(await unmatched()).toBe(429);
    const matched = await request.post("/api/keykeeper/reload-key/leaving", { data: { tabId } });
    expect(matched.status()).toBe(200);

    // Signing up, which shares that address's limit, still works.
    await api.account("leaving-bob");
  });
});

test("key rotation, and deleting the account, forget every tab's R", async ({ request }) => {
  test.setTimeout(90_000);
  const api = new Api(request);

  const ana = await api.account("ana");
  const laptop = await session(request, ana);
  const tabId = tab();
  expect((await keep(api, laptop, tabId, r())).status).toBe(200);
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
    accountData: { ciphers: [], folders: [], sends: [] },
  });
  expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
  // Signed in again on the same device: nothing comes back.
  const again = await session(request, ana, laptop.device);
  expect((await release(api, again, tabId)).status).toBe(404);

  const bo = await api.account("bo");
  const boTab = tab();
  expect((await keep(api, bo, boTab, r())).status).toBe(200);
  const deleted = await api.call(bo, "DELETE", "/api/accounts", { masterPasswordHash: bo.password });
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect((await release(api, bo, boTab)).status).toBe(401);
});

test("each tab's calls are limited, and an account's many tabs aren't", async ({ request }) => {
  const api = new Api(request);
  const alice = await api.account("alice");
  const forget = (tabId: string) =>
    api.call(alice, "POST", "/api/keykeeper/reload-key/forget", { tabId }).then((r) => r.status);

  // One tab asking far more than twice a minute.
  const busy = tab();
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) {
    statuses.push(await forget(busy));
  }
  expect(statuses).toContain(429);

  // A technician's twenty tabs, each kept and checking in twice: fine.
  const tech = await api.account("tech");
  const tabs = Array.from({ length: 20 }, tab);
  for (const tabId of tabs) {
    expect((await keep(api, tech, tabId, r())).status).toBe(200);
  }
  for (let round = 0; round < 2; round++) {
    for (const tabId of tabs) {
      expect((await checkIn(api, tech, tabId, 0)).status).toBe(200);
    }
  }
  // Others aren't held up.
  const bob = await api.account("bob");
  expect((await api.call(bob, "POST", "/api/keykeeper/reload-key/forget", { tabId: tab() })).status).toBe(200);
});

/** The response's Set-Cookie headers. */
const setCookies = (response: APIResponse) =>
  response
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);

test("R comes back only with the tab's reload cookie, which is HttpOnly, Secure, Strict, and for the session", async ({
  request,
  playwright,
}) => {
  const api = new Api(request);
  const alice = await api.account("alice");
  const tabId = tab();
  const key = r();
  const auth = { Authorization: `Bearer ${alice.token}` };

  const kept = await request.post("/api/keykeeper/reload-key", {
    headers: auth,
    data: { tabId, key, timeoutMinutes: 15 },
  });
  expect(kept.status()).toBe(200);
  const [header, ...more] = setCookies(kept);
  expect(more).toEqual([]);
  const name = `__Secure-pb-reload-${tabId}`;
  const value = new RegExp(`^${name}=([A-Za-z0-9_-]{43});`).exec(header)?.[1];
  expect(value, header).toBeDefined();
  for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/keykeeper/reload-key"]) {
    expect(header).toContain(part);
  }
  expect(header).not.toMatch(/Max-Age|Expires|Domain/i);

  // Another client with the same session and tab id, but not the cookie, or
  // a wrong one, gets the same answer as no entry, and changes nothing.
  const elsewhere = async (cookie?: string) => {
    const client = await playwright.request.newContext({
      baseURL: `https://127.0.0.1:${port}`,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { ...auth, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const got = await client.post("/api/keykeeper/reload-key/release", { data: { tabId } });
    const checkedIn = await client.post("/api/keykeeper/reload-key/check-in", {
      data: { tabId, idleSeconds: 0, timeoutMinutes: 15 },
    });
    const result = { release: got.status(), body: await got.text(), checkIn: checkedIn.status() };
    await client.dispose();
    return result;
  };
  for (const cookie of [undefined, `${name}=wrong`, `${name}=${value!.toUpperCase()}`]) {
    const got = await elsewhere(cookie);
    expect(got.release, cookie).toBe(404);
    expect(got.checkIn, cookie).toBe(404);
    expect(got.body).not.toContain(key);
  }
  // With the cookie itself, it opens.
  const withCookie = await elsewhere(`${name}=${value}`);
  expect(withCookie.release).toBe(200);
  expect(JSON.parse(withCookie.body).key).toBe(key);

  // The browser's jar keeps it only for the reload endpoints.
  const jar = (await request.storageState()).cookies.find((c) => c.name === name);
  expect(jar).toMatchObject({ path: "/api/keykeeper/reload-key", httpOnly: true, secure: true, sameSite: "Strict", expires: -1 });

  // Forgetting R expires the cookie too.
  const forgotten = await request.post("/api/keykeeper/reload-key/forget", { headers: auth, data: { tabId } });
  expect(forgotten.status()).toBe(200);
  const [removal] = setCookies(forgotten);
  expect(removal).toMatch(new RegExp(`^${name}=;`));
  expect(removal).toContain("Max-Age=0");
  expect(removal).toContain("Path=/api/keykeeper/reload-key");
  expect((await request.storageState()).cookies.find((c) => c.name === name)).toBeUndefined();
  expect((await release(api, alice, tabId)).status).toBe(404);
});

test("a tab's cookie that outlived its R is expired when the tab asks, or when another tab keeps one", async ({
  request,
}) => {
  const api = new Api(request);
  const alice = await api.account("alice");
  const auth = { Authorization: `Bearer ${alice.token}` };
  const names = () => request.storageState().then((s) => s.cookies.map((c) => c.name).filter((n) => n.includes("pb-reload")));

  // Unused past its timeout: the check-in that finds it gone expires the cookie.
  const idle = tab();
  expect((await keep(api, alice, idle, r(), 1)).status).toBe(200);
  expect(await names()).toEqual([`__Secure-pb-reload-${idle}`]);
  const late = await request.post("/api/keykeeper/reload-key/check-in", {
    headers: auth,
    data: { tabId: idle, idleSeconds: 61, timeoutMinutes: 1 },
  });
  expect(late.status()).toBe(404);
  expect(await names()).toEqual([]);

  // A cookie whose tab has nothing kept on the server any more (here, set
  // by hand, as a browser would still hold one after a restart) goes when
  // another tab keeps R.
  const gone = tab();
  const withStale = await request.post("/api/keykeeper/reload-key", {
    headers: { ...auth, Cookie: `__Secure-pb-reload-${gone}=left-over` },
    data: { tabId: tab(), key: r(), timeoutMinutes: 15 },
  });
  expect(withStale.status()).toBe(200);
  const headers = setCookies(withStale);
  expect(headers.some((h) => h.startsWith(`__Secure-pb-reload-${gone}=;`) && h.includes("Max-Age=0"))).toBe(true);
});

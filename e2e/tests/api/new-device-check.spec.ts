// The new-device check, the server's side (DESIGN.md, "New-device check"),
// on a test server of its own with the check on, email, and a tiny location
// database of made-up places (fixtures/location/make.mjs): an account without
// two-step login that signs in with its password on a device it has never
// used waits; the right number typed on another of its devices approves it
// and the new device signs in with its token, once; a wrong number denies it,
// with an email; a request without a number changes nothing; only the
// account's other signed-in sessions answer it; it ends after 10 minutes; the
// same device signing in again continues it only with the check's token, so
// nobody can take over a sign-in in progress; a device it knows, with
// its token, isn't asked, and the same identifier without it is; an account
// with two-step login, and an API key, aren't asked; with no device that can
// approve, a code by email; with one, a code only after a day's wait, and
// never for an admin two-step login is required of; and where it came from,
// from the test database alone, in the list, the email, and the event log.
//
// No login limits are tested here (they're the login limits' tests).
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, request as apiRequest, test } from "@playwright/test";

import { newDeviceServerPort } from "../../paths.mjs";
import { waitForMessage } from "../mail/mailbox";

import { type Account, Api, encString, publicKey, withMasterPassword } from "./support";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The web vault in Firefox, as upstream numbers device types.
const FIREFOX = "10";
// Where the made-up places are (fixtures/location/make.mjs).
const BERLIN = "203.0.113.7";
const CANADA = "198.51.100.4";
const HOME_NETWORK = "10.1.2.3";

let server: ChildProcess;
let dataDir: string;
let http: APIRequestContext;

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-new-device-"));
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: newDeviceServerPort,
      KK_DATA_DIR: dataDir,
      KK_MAIL: "1",
      KK_NEW_DEVICE: "1",
    },
    stdio: "ignore",
  });
  http = await apiRequest.newContext({
    baseURL: `https://127.0.0.1:${newDeviceServerPort}`,
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
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Runs SQL against the test server's database, to stand in for time passing. */
async function sql(statement: string, ...params: string[]): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "db.sqlite3"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return Number(db.prepare(statement).run(...params).changes);
  } finally {
    db.close();
  }
}

const accountUuid = "(SELECT uuid FROM users WHERE email = ?)";

/** As if `minutes` had passed for the account's checks. */
const ageChecks = (email: string, minutes: number) =>
  sql(
    `UPDATE new_device_checks
       SET created_at = strftime('%Y-%m-%d %H:%M:%f', created_at, ?),
           expires_at = strftime('%Y-%m-%d %H:%M:%f', expires_at, ?),
           email_after = CASE WHEN email_after IS NULL THEN NULL
                         ELSE strftime('%Y-%m-%d %H:%M:%f', email_after, ?) END
     WHERE user_uuid = ${accountUuid}`,
    `-${minutes} minutes`,
    `-${minutes} minutes`,
    `-${minutes} minutes`,
    email.toLowerCase(),
  );

/** As if the account's devices hadn't been used for `days`: none can approve. */
const ageDevices = (email: string, days: number) =>
  sql(
    `UPDATE devices
       SET created_at = strftime('%Y-%m-%d %H:%M:%f', created_at, ?),
           updated_at = strftime('%Y-%m-%d %H:%M:%f', updated_at, ?)
     WHERE user_uuid = ${accountUuid}`,
    `-${days} days`,
    `-${days} days`,
    email.toLowerCase(),
  );

type Device = { id: string; type: string; ip: string; token?: string };

const device = (ip = BERLIN, type = FIREFOX): Device => ({ id: randomUUID(), type, ip });

type Answer = { status: number; body: any };

/** A password sign-in from a device, with its token and anything extra. */
async function signIn(who: Account, d: Device, extra: Record<string, string> = {}): Promise<Answer> {
  const response = await http.post("/identity/connect/token", {
    headers: { "X-Real-IP": d.ip },
    form: {
      grant_type: "password",
      username: who.email,
      password: who.password,
      scope: "api offline_access",
      client_id: "web",
      deviceType: d.type,
      deviceIdentifier: d.id,
      deviceName: "firefox",
      ...(d.token ? { twoFactorProvider: "5", twoFactorToken: d.token } : {}),
      ...extra,
    },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

/** A sign-in the check holds: its check. */
async function held(who: Account, d: Device) {
  const answer = await signIn(who, d);
  expect(answer.status, JSON.stringify(answer.body)).toBe(400);
  expect(answer.body.ErrorModel.Message).toBe("new device verification required");
  const check = answer.body.KeykeeperNewDeviceCheck;
  expect(check.number).toMatch(/^[1-9][0-9]$/);
  expect(check.token).toHaveLength(43);
  return check as { id: string; token: string; number: string; approvers: boolean; email: string };
}

/** Signs in all the way, keeping the device's token. */
async function signedIn(who: Account, d: Device, extra: Record<string, string> = {}) {
  const answer = await signIn(who, d, extra);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  if (answer.body.TwoFactorToken) {
    d.token = answer.body.TwoFactorToken;
  }
  return { token: answer.body.access_token as string };
}

async function status(check: { id: string; token: string }, ip = BERLIN): Promise<Answer> {
  const response = await http.post("/api/keykeeper/new-device-check/status", {
    headers: { "X-Real-IP": ip },
    data: { id: check.id, token: check.token },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

async function email(check: { id: string; token: string }): Promise<Answer> {
  const response = await http.post("/api/keykeeper/new-device-check/email", {
    headers: { "X-Real-IP": BERLIN },
    data: { id: check.id, token: check.token },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

const list = (api: Api, as: { token: string }) => api.call(as, "GET", "/api/keykeeper/new-device-checks");

const approve = (api: Api, as: { token: string }, id: string, body: unknown) =>
  api.call(as, "POST", `/api/keykeeper/new-device-checks/${id}/approve`, body);

/**
 * A new account and its first device, signed in: the account's first sign-in
 * isn't asked, since no device has signed in to it before.
 */
async function account(api: Api, name: string) {
  const address = `${name}-${randomUUID().slice(0, 8)}@api.example.test`;
  const password = Buffer.from(`hash-${address}`).toString("base64");
  const verify = await http.post("/identity/accounts/register/send-verification-email", {
    data: { email: address, name, receiveMarketingEmails: false },
    headers: { Accept: "application/json" },
  });
  expect(verify.status(), await verify.text()).toBe(200);
  const finish = await http.post("/identity/accounts/register/finish", {
    data: {
      email: address,
      emailVerificationToken: await verify.json(),
      masterPasswordHash: password,
      masterPasswordHint: null,
      userSymmetricKey: encString(`user-key-${address}`),
      userAsymmetricKeys: { publicKey: publicKey(address), encryptedPrivateKey: encString(`private-${address}`) },
      kdf: 0,
      kdfIterations: 600000,
    },
  });
  expect(finish.status(), await finish.text()).toBe(200);
  const laptop = device("127.0.0.1");
  const partial = { email: address, password, token: "", userId: "" };
  const session = await signedIn(partial, laptop);
  const profile = await api.call(session, "GET", "/api/accounts/profile");
  const who: Account = { ...partial, token: session.token, userId: profile.body.id };
  return { who, laptop, session };
}

test("a new device waits; the right number typed on another device approves it, once", async () => {
  const api = new Api(http);
  const { who, laptop, session } = await account(api, "ana");
  // The first device got a token of its own, as two-step login's remembered one.
  expect(laptop.token).toHaveLength(43);

  const phone = device(BERLIN);
  const check = await held(who, phone);
  expect(check.approvers).toBe(true);
  expect(check.email).toBe("later");

  // The other device sees it, never with its number, with where it came from.
  const waiting = await list(api, session);
  expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);
  expect(waiting.body.data).toHaveLength(1);
  const request = waiting.body.data[0];
  expect(request).toMatchObject({
    id: check.id,
    device: "Web vault in Firefox",
    ipAddress: BERLIN,
    location: "Fixture City, Germany",
  });
  expect(JSON.stringify(waiting.body)).not.toContain(`"${check.number}"`);
  expect(waiting.body.locationSource).toEqual({ name: "IP Geolocation by DB-IP", url: "https://db-ip.com" });

  // Until then the new device can't sign in with its token: it's held again,
  // the same check, with the same token (it's the check's one holder).
  expect((await status(check)).body.status).toBe("waiting");
  const early = await signIn(who, phone, { newDeviceOtp: check.token });
  expect(early.status).toBe(400);
  expect(early.body.KeykeeperNewDeviceCheck).toMatchObject({ id: check.id, number: check.number, token: check.token });

  const approved = await approve(api, session, check.id, { number: check.number });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  expect(approved.body).toMatchObject({ approved: true, denied: false });
  expect((await status(check)).body.status).toBe("approved");
  expect((await list(api, session)).body.data).toEqual([]);

  // The new device signs in with the token, and gets a token of its own.
  const done = await signedIn(who, phone, { newDeviceOtp: check.token });
  expect(done.token).toBeTruthy();
  expect(phone.token).toHaveLength(43);
  // Once: the check is used up.
  expect((await status(check)).status).toBe(404);

  // A device it knows, with its token, isn't asked again.
  await signedIn(who, phone);
  await signedIn(who, laptop);
  // The same identifier without the token is a new device: identifiers aren't secrets.
  const copied = { ...phone, token: undefined };
  await held(who, copied);
  // Nor does another device's token stand in for it.
  await held(who, { ...copied, token: laptop.token });
});

test("a wrong number denies it, says why on both sides, and emails the account", async () => {
  const api = new Api(http);
  const { who, session } = await account(api, "ben");
  const phone = device(BERLIN);
  const check = await held(who, phone);
  const wrong = String(((Number(check.number) - 10 + 1) % 90) + 10);
  const denied = await approve(api, session, check.id, { number: wrong });
  expect(denied.status, JSON.stringify(denied.body)).toBe(200);
  expect(denied.body).toMatchObject({ approved: false, denied: true, deniedWhy: "number" });
  const now = await status(check);
  expect(now.body).toMatchObject({ status: "denied", deniedWhy: "number" });
  // The right number after it doesn't help: one try.
  expect((await approve(api, session, check.id, { number: check.number })).status).toBe(404);
  expect((await signIn(who, phone, { newDeviceOtp: check.token })).status).toBe(400);

  const mail = await waitForMessage(who.email, /A sign-in on a new device was denied/);
  expect(mail.text).toContain("didn't match");
  expect(mail.text).toContain("Web vault in Firefox");
  expect(mail.text).toContain("Fixture City, Germany");
  expect(mail.text).toContain("IP Geolocation by DB-IP (https://db-ip.com)");

  // Signing in again starts over, with a new check.
  const again = await held(who, phone);
  expect(again.id).not.toBe(check.id);
  // Deny, without a number, works too.
  const no = await api.call(session, "POST", `/api/keykeeper/new-device-checks/${again.id}/deny`);
  expect(no.body).toMatchObject({ denied: true, deniedWhy: "denied" });
  expect((await status(again)).body.status).toBe("denied");
});

test("a request without the number can't approve, or deny", async () => {
  const api = new Api(http);
  const { who, session } = await account(api, "cy");
  const check = await held(who, device(BERLIN));
  for (const body of [{}, { number: "" }, { number: "4" }, { number: "470" }, { number: "ab" }, { number: null }]) {
    const tapped = await approve(api, session, check.id, body);
    expect(tapped.status, JSON.stringify(body)).toBe(400);
  }
  expect((await status(check)).body.status).toBe("waiting");
  expect((await list(api, session)).body.data.map((r: { id: string }) => r.id)).toEqual([check.id]);
});

test("only the account's other signed-in sessions answer it", async () => {
  const api = new Api(http);
  const { who, session } = await account(api, "dee");
  const check = await held(who, device(BERLIN));

  // Another account doesn't see it, and can't answer it.
  const other = await account(api, "eve");
  expect((await list(api, other.session)).body.data).toEqual([]);
  expect((await approve(api, other.session, check.id, { number: check.number })).status).toBe(404);
  expect(
    (await api.call(other.session, "POST", `/api/keykeeper/new-device-checks/${check.id}/deny`)).status,
  ).toBe(404);
  // No one: no session.
  expect((await approve(api, null as never, check.id, { number: check.number })).status).toBe(401);
  // An API key's session isn't a person at a vault.
  const apiKey = await api.call(session, "POST", "/api/accounts/api-key", { masterPasswordHash: who.password });
  expect(apiKey.status, JSON.stringify(apiKey.body)).toBe(200);
  const byKey = await http.post("/identity/connect/token", {
    form: {
      grant_type: "client_credentials",
      client_id: `user.${who.userId}`,
      client_secret: apiKey.body.apiKey,
      scope: "api",
      deviceType: "25",
      deviceIdentifier: randomUUID(),
      deviceName: "linux",
    },
  });
  // An API key isn't asked: it's a secret of its own, which a password doesn't give.
  expect(byKey.status(), await byKey.text()).toBe(200);
  const keyed = { token: (await byKey.json()).access_token as string };
  expect((await list(api, keyed)).status).toBe(400);
  expect((await approve(api, keyed, check.id, { number: check.number })).status).toBe(400);
  // The status call needs the new device's token.
  expect((await status({ id: check.id, token: "x".repeat(43) })).status).toBe(404);
  expect((await status(check)).body.status).toBe("waiting");
});

test("it ends after 10 minutes; signing in again continues it only with its token", async () => {
  const api = new Api(http);
  const { who, session } = await account(api, "fay");
  const phone = device(BERLIN);
  const first = await held(who, phone);
  // With its token (sent while it waits), the same check, number, and token.
  const kept = await signIn(who, phone, { newDeviceOtp: first.token });
  expect(kept.status).toBe(400);
  expect(kept.body.KeykeeperNewDeviceCheck).toMatchObject({ id: first.id, number: first.number, token: first.token });
  expect((await status(first)).body.status).toBe("waiting");

  // Without it (a reload that lost it, or anyone else with the password and
  // this device's identifier), the check ends, denied by nobody, and a new
  // one starts with a new token.
  const again = await held(who, phone);
  expect(again.id).not.toBe(first.id);
  expect(again.token).not.toBe(first.token);
  expect((await status(first)).status).toBe(404);
  expect((await approve(api, session, first.id, { number: first.number })).status).toBe(404);
  expect((await list(api, session)).body.data.map((r: { id: string }) => r.id)).toEqual([again.id]);
  expect((await status(again)).body.status).toBe("waiting");

  expect(await ageChecks(who.email, 11)).toBe(1);
  expect((await status(again)).status).toBe(404);
  expect((await list(api, session)).body.data).toEqual([]);
  expect((await approve(api, session, again.id, { number: again.number })).status).toBe(404);
  // A new sign-in starts a new check.
  expect((await held(who, phone)).id).not.toBe(again.id);
});

test("signing in again can't take over a sign-in in progress, or the approval it got", async () => {
  const api = new Api(http);
  const { who, session } = await account(api, "gil");
  // Someone signs in on a new device, and approves it on their laptop.
  const phone = device(BERLIN);
  const theirs = await held(who, phone);
  expect((await approve(api, session, theirs.id, { number: theirs.number })).body.approved).toBe(true);
  expect((await status(theirs)).body.status).toBe("approved");

  // Someone else with the password and that device's identifier (but not the
  // check's token) signs in from it before it finishes: they get a new check,
  // waiting, and the approval stays with nobody.
  const taker = { ...phone, ip: CANADA };
  const taken = await held(who, taker);
  expect(taken.id).not.toBe(theirs.id);
  expect((await status(taken, CANADA)).body.status).toBe("waiting");
  for (const otp of [theirs.token, taken.token]) {
    const tried = await signIn(who, taker, { newDeviceOtp: otp });
    expect(tried.status, otp).toBe(400);
    expect(tried.body.access_token).toBeUndefined();
  }
  // The first holder's approval is gone with its check: it starts over.
  expect((await status(theirs)).status).toBe(404);
  const back = await signIn(who, phone, { newDeviceOtp: theirs.token });
  expect(back.status).toBe(400);
  expect(back.body.access_token).toBeUndefined();
  expect(back.body.KeykeeperNewDeviceCheck.id).not.toBe(theirs.id);
});

test("an account with two-step login isn't asked", async () => {
  const api = new Api(http);
  const { who } = await account(api, "gus");
  await api.giveAuthenticator(who);
  const phone = device(BERLIN);
  const asked = await signIn(who, phone);
  // Two-step login's own step, not the check.
  expect(asked.status).toBe(400);
  expect(asked.body.TwoFactorProviders2).toBeTruthy();
  expect(asked.body.KeykeeperNewDeviceCheck).toBeUndefined();
  const { nextTotp } = await import("./support");
  await signedIn(who, phone, { twoFactorProvider: "0", twoFactorToken: await nextTotp(who.email) });
});

test("with no device that can approve, a code by email", async () => {
  const api = new Api(http);
  const { who } = await account(api, "hal");
  // The laptop hasn't been used for 31 days: its session has ended.
  expect(await ageDevices(who.email, 31)).toBe(1);
  const phone = device(BERLIN);
  const check = await held(who, phone);
  expect(check.approvers).toBe(false);
  expect(check.email).toBe("now");

  const sent = await email(check);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.codeSent).toBe(true);
  expect(sent.body.emailTo).toMatch(/\*/);
  const mail = await waitForMessage(who.email, /Your code to sign in on a new device/);
  const code = /\b(\d{8})\b/.exec(mail.text)?.[1];
  expect(code, mail.text).toBeTruthy();
  expect(mail.text).toContain("Fixture City, Germany");

  const wrong = await signIn(who, phone, { newDeviceOtp: code === "12345678" ? "87654321" : "12345678" });
  expect(wrong.status).toBe(400);
  expect(wrong.body.ErrorModel?.Message ?? wrong.body.message).toMatch(/didn't work/);
  await signedIn(who, phone, { newDeviceOtp: code! });
  expect(phone.token).toHaveLength(43);
  await signedIn(who, phone);
});

test("with a device that can approve, a code by email only after a day's wait", async () => {
  const api = new Api(http);
  const { who, session } = await account(api, "ivy");
  const phone = device(BERLIN);
  const check = await held(who, phone);
  expect(check.email).toBe("later");

  const later = await email(check);
  expect(later.status, JSON.stringify(later.body)).toBe(200);
  expect(later.body.email).toBe("waiting");
  expect(later.body.codeSent).toBe(false);
  const after = Date.parse(later.body.emailAfter);
  expect(after - Date.now()).toBeGreaterThan(23.9 * 3600_000);
  // The account hears at once, and its devices see it.
  const notice = await waitForMessage(who.email, /asked to sign in on a new device with a code by email/);
  expect(notice.text).toContain("deny it");
  const listed = (await list(api, session)).body.data[0];
  expect(Date.parse(listed.emailAfter)).toBe(after);
  // Asking again sends nothing yet.
  expect((await email(check)).body.codeSent).toBe(false);

  // A day later, signing in again on that device offers the code.
  await ageChecks(who.email, 24 * 60 + 1);
  // (The page closed long ago, so without the check's token: a new check,
  // which keeps the day's wait.)
  const back = await held(who, phone);
  expect(back.id).not.toBe(check.id);
  expect(back.email).toBe("now");
  const sent = await email(back);
  expect(sent.body.codeSent).toBe(true);
  const mail = await waitForMessage(who.email, /Your code to sign in on a new device/);
  const code = /\b(\d{8})\b/.exec(mail.text)![1];
  await signedIn(who, phone, { newDeviceOtp: code });
});

test("an admin two-step login is required of gets no code by email", async () => {
  const api = new Api(http);
  const { who } = await account(api, "jo");
  const orgId = await api.organization(who, "Acme Dental");
  const on = await api.call(
    who,
    "PUT",
    `/api/keykeeper/organizations/${orgId}/admin-two-step`,
    withMasterPassword(who, { required: true }),
  );
  expect(on.status, JSON.stringify(on.body)).toBe(200);

  // Their devices can approve (the check comes before the setup session), but no email.
  const check = await held(who, device(BERLIN));
  expect(check.email).toBe("never");
  expect((await email(check)).status).toBe(400);

  // With no device that can approve, a new device can't get in at all.
  await ageDevices(who.email, 31);
  const refused = await signIn(who, device(BERLIN));
  expect(refused.status).toBe(400);
  expect(refused.body.KeykeeperNewDeviceCheck).toBeUndefined();
  expect(JSON.stringify(refused.body)).toMatch(/Sign in on a device you've used before/);
});

test("where it comes from: the test database's places, or unknown, in the list and the event log", async () => {
  const api = new Api(http);
  const { who, session } = await account(api, "kim");
  const orgId = await api.organization(who, "Kim's family");

  const canada = await held(who, device(CANADA));
  const home = await held(who, device(HOME_NETWORK));
  const byId = new Map(
    (await list(api, session)).body.data.map((r: { id: string; location: string | null }) => [r.id, r.location]),
  );
  expect(byId.get(canada.id)).toBe("Canada");
  // A private address says nothing about where someone is.
  expect(byId.get(home.id)).toBeNull();

  const log = await api.call(
    session,
    "GET",
    `/api/organizations/${orgId}/events?start=2020-01-01T00:00:00Z&end=2099-01-01T00:00:00Z`,
  );
  expect(log.status, JSON.stringify(log.body)).toBe(200);
  const started = log.body.data.filter((e: { type: number }) => e.type === 1090);
  expect(started.map((e: { keykeeperLocation: string | null }) => e.keykeeperLocation).sort()).toEqual([
    "Canada",
    null,
  ]);
  const located = started.find((e: { keykeeperLocation: string | null }) => e.keykeeperLocation);
  expect(located.keykeeperDetail).toBe("Web vault in Firefox");
  expect(located.keykeeperLocationSource).toEqual({ name: "IP Geolocation by DB-IP", url: "https://db-ip.com" });
});

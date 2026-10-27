// A small client for the server's HTTP API, for black-box tests. The server
// stores keys and encrypted values as opaque strings and never decrypts them,
// so tests use stand-in key material instead of real crypto.
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type APIRequestContext,
  type APIResponse,
  expect,
} from "@playwright/test";

import { port } from "../../paths.mjs";

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A well-formed stand-in for an encrypted value (type 2: AES-CBC with HMAC). */
export const encString = (label: string) =>
  `2.${b64(`${label}-iv`)}|${b64(`${label}-ct`)}|${b64(`${label}-mac`)}`;

/** A stand-in public key, unique per label. */
export const publicKey = (label: string) => b64(`public-key-${label}`);

export type Account = {
  email: string;
  password: string;
  token: string;
  userId: string;
};

export type Result = { status: number; body: any };

/** The code for an authenticator key at a time (RFC 6238: SHA-1, 30 seconds, 6 digits). */
export function totp(base32Key: string, now = Date.now()): string {
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

/** Each account's authenticator key from giveAuthenticator, and the last 30-second step it used. */
const authenticators = new Map<string, { key: string; lastStep: number }>();

const stepOf = (ms: number) => Math.floor(ms / 30_000);

/**
 * A code the server hasn't seen from this account's authenticator: it takes
 * the current 30-second step's or the next one's, each once, so after two
 * sign-ins in one step this waits for the next.
 */
export async function nextTotp(email: string): Promise<string> {
  const entry = authenticators.get(email.toLowerCase());
  expect(entry, `an authenticator for ${email}`).toBeTruthy();
  await expect
    .poll(() => stepOf(Date.now()) + 1 > entry!.lastStep, { timeout: 35_000, intervals: [1_000] })
    .toBe(true);
  const step = Math.max(stepOf(Date.now()), entry!.lastStep + 1);
  entry!.lastStep = step;
  return totp(entry!.key, step * 30_000 + 1_000);
}

/** Whether giveAuthenticator gave this account an authenticator app. */
export function hasTotp(email: string): boolean {
  return authenticators.has(email.toLowerCase());
}

async function result(response: APIResponse): Promise<Result> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; keep the text.
  }
  return { status: response.status(), body };
}

export class Api {
  constructor(private readonly request: APIRequestContext) {}

  /**
   * A new account, logged in. Pass a real public key (base64 SPKI) when a
   * client will encrypt to it, as confirming a member does.
   */
  async account(
    prefix: string,
    email = `${prefix.toLowerCase()}-${randomUUID().slice(0, 8)}@api.example.test`,
    accountPublicKey = publicKey(email),
  ): Promise<Account> {
    const password = b64(`hash-${email}`);
    const verify = await this.request.post(
      "/identity/accounts/register/send-verification-email",
      {
        data: { email, name: prefix, receiveMarketingEmails: false },
        headers: { Accept: "application/json" },
      },
    );
    expect(verify.status(), await verify.text()).toBe(200);
    const finish = await this.request.post(
      "/identity/accounts/register/finish",
      {
        data: {
          email,
          emailVerificationToken: await verify.json(),
          masterPasswordHash: password,
          masterPasswordHint: null,
          userSymmetricKey: encString(`user-key-${email}`),
          userAsymmetricKeys: {
            publicKey: accountPublicKey,
            encryptedPrivateKey: encString(`private-key-${email}`),
          },
          kdf: 0,
          kdfIterations: 600000,
        },
      },
    );
    expect(finish.status(), await finish.text()).toBe(200);
    const token = await this.logIn(email, password);
    const profile = await this.call({ token }, "GET", "/api/accounts/profile");
    expect(profile.status).toBe(200);
    return { email, password, token, userId: profile.body.id };
  }

  /**
   * Signs in and returns the access token, answering two-step login with the
   * next code for an account giveAuthenticator gave an authenticator.
   */
  async logIn(email: string, password: string): Promise<string> {
    const signIn = async (extra: Record<string, string> = {}) =>
      this.request.post("/identity/connect/token", {
        form: {
          grant_type: "password",
          username: email,
          password,
          scope: "api offline_access",
          client_id: "web",
          deviceType: "10",
          deviceIdentifier: randomUUID(),
          deviceName: "api-test",
          ...extra,
        },
      });
    let response = await signIn();
    if (response.status() === 400 && hasTotp(email)) {
      response = await signIn({ twoFactorProvider: "0", twoFactorToken: await nextTotp(email) });
    }
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).access_token;
  }

  /**
   * Gives an account an authenticator app, as someone who runs an MSP or a
   * Business organization sets one up (DESIGN.md, "Two-step login for
   * admins"): when the rule comes to cover them, their sessions go on. Does
   * nothing for an account that has one. Returns its key.
   */
  async giveAuthenticator(account: Account): Promise<string> {
    const had = authenticators.get(account.email.toLowerCase());
    if (had) {
      return had.key;
    }
    const key = await this.turnOnAuthenticator(account, account.password);
    // Its code was the current step's, as of a moment ago at most.
    authenticators.set(account.email.toLowerCase(), { key, lastStep: stepOf(Date.now()) });
    return key;
  }

  /**
   * A password sign-in as an app makes it, with anything extra (a two-step
   * provider and code, an approved request), and the raw answer.
   */
  async signIn(
    email: string,
    password: string,
    extra: Record<string, string> = {},
  ): Promise<Result> {
    const response = await this.request.post("/identity/connect/token", {
      form: {
        grant_type: "password",
        username: email,
        password,
        scope: "api offline_access",
        client_id: "web",
        deviceType: "10",
        deviceIdentifier: randomUUID(),
        deviceName: "api-test",
        ...extra,
      },
    });
    return result(response);
  }

  /**
   * Turns on an authenticator app for someone, as the web vault's two-step
   * login settings do, with their session (or a setup session's token).
   * Returns its key. The code used to turn it on can't be used again, so a
   * sign-in right after needs the next one (`totp(key, Date.now() + 30_000)`).
   */
  async turnOnAuthenticator(as: { token: string }, password: string): Promise<string> {
    const started = await this.call(as, "POST", "/api/two-factor/get-authenticator", {
      masterPasswordHash: password,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const key = started.body.key as string;
    const on = await this.call(as, "POST", "/api/two-factor/authenticator", {
      key,
      token: totp(key),
      masterPasswordHash: password,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    return key;
  }

  /** Calls the API as someone (or no one), and returns the status and parsed body. */
  async call(
    as: { token: string } | null,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    data?: unknown,
  ): Promise<Result> {
    const response = await this.request.fetch(path, {
      method,
      data,
      headers: as ? { Authorization: `Bearer ${as.token}` } : {},
    });
    return result(response);
  }

  /** A new organization owned by this account. */
  async organization(owner: Account, name: string): Promise<string> {
    const created = await this.call(owner, "POST", "/api/organizations", {
      name,
      billingEmail: owner.email,
      collectionName: encString(`collection-${name}`),
      key: encString(`org-key-for-${owner.email}`),
      keys: {
        publicKey: publicKey(`org-${name}`),
        encryptedPrivateKey: encString(`org-private-${name}`),
      },
      planType: 0,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body.id;
  }

  /**
   * Whether an organization requires two-step login for admins, as someone
   * who may read its setting sees it (false for anyone else).
   */
  async requiresTwoStep(as: Account, orgId: string): Promise<boolean> {
    const setting = await this.call(as, "GET", `/api/keykeeper/organizations/${orgId}/admin-two-step`);
    return setting.status === 200 && setting.body.required === true;
  }

  /**
   * The person accepts a role the server joined them to without asking, as
   * the web vault's vault page offers on a server that sends no email (this
   * test server): two-step login for admins counts it from then on.
   */
  async acceptRole(member: { token: string }, orgId: string) {
    const accepted = await this.call(member, "POST", `/api/keykeeper/organizations/${orgId}/accept`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  }

  /**
   * Adds an existing account to an organization with a role, confirmed like a
   * real member: invited (joined at once, since the test server sends no
   * mail), accepted by the member (acceptRole, unless `accept` is false), then
   * confirmed by the owner with the org key for them. An owner or admin of an
   * organization that requires two-step login for admins gets an
   * authenticator app first, as they'd set one up, unless `authenticator` is
   * false: accepting without one signs them out.
   */
  async addMember(
    owner: Account,
    orgId: string,
    member: Account,
    type: "admin" | "user" | "manager" | "owner",
    options: { authenticator?: boolean; accept?: boolean } = {},
  ) {
    if (
      options.authenticator !== false &&
      (type === "owner" || type === "admin") &&
      (await this.requiresTwoStep(owner, orgId))
    ) {
      await this.giveAuthenticator(member);
    }
    const types = { owner: 0, admin: 1, user: 2, manager: 3 };
    const invited = await this.call(
      owner,
      "POST",
      `/api/organizations/${orgId}/users/invite`,
      {
        emails: [member.email],
        type: types[type],
        collections: [],
        groups: [],
        accessSecretsManager: false,
        permissions: {},
      },
    );
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    const listed = await this.call(
      owner,
      "GET",
      `/api/organizations/${orgId}/users`,
    );
    const membership = listed.body.data.find(
      (m: { email: string }) => m.email === member.email,
    );
    expect(membership, `membership for ${member.email}`).toBeTruthy();
    if (options.accept !== false) {
      await this.acceptRole(member, orgId);
    }
    const confirmed = await this.call(
      owner,
      "POST",
      `/api/organizations/${orgId}/users/${membership.id}/confirm`,
      {
        key: encString(`org-key-for-${member.email}`),
      },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return membership.id as string;
  }

  /**
   * A new MSP with this account as its admin, who gets an authenticator app
   * first: the MSP requires two-step login of its staff.
   */
  async msp(admin: Account, name: string): Promise<string> {
    await this.giveAuthenticator(admin);
    const created = await this.call(admin, "POST", "/api/keykeeper/msp", {
      name,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body.id;
  }

  /** A new client organization of an MSP, created by one of its admins. */
  async client(
    admin: Account,
    mspId: string,
    name: string,
    preset?: "business",
  ): Promise<string> {
    const created = await this.call(
      admin,
      "POST",
      `/api/keykeeper/msp/${mspId}/clients`,
      {
        name,
        preset,
        collectionName: encString(`collection-${name}`),
        adminsCollectionName: preset ? encString(`admins-${name}`) : undefined,
        key: encString(`org-key-for-${admin.email}`),
        keys: {
          publicKey: publicKey(`org-${name}`),
          encryptedPrivateKey: encString(`org-private-${name}`),
        },
      },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body.id;
  }

  /**
   * Puts someone on an MSP's staff the only way there is: an invitation, which
   * they accept with its token. They get an authenticator app first, as the
   * MSP requires two-step login of its staff, unless `authenticator` is
   * false: then joining signs them out where the rule covers them. Returns
   * the invitation response.
   */
  async addStaff(
    admin: Account,
    mspId: string,
    member: Account,
    role: "admin" | "technician",
    access?: unknown,
    options: { authenticator?: boolean } = {},
  ) {
    const invited = await this.call(
      admin,
      "POST",
      `/api/keykeeper/msp/${mspId}/staff`,
      { email: member.email, role, access },
    );
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    expect(invited.body.invited).toBe(true);
    if (options.authenticator !== false) {
      await this.giveAuthenticator(member);
    }
    const token = new URL(invited.body.inviteUrl).hash.split("invite=")[1];
    const accepted = await this.call(member, "POST", "/api/keykeeper/msp/invites/accept", { token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return invited.body;
  }

  /** What the MSP console does when it opens: confirms everything waiting that this caller can confirm. */
  async confirmPending(caller: Account, mspId: string): Promise<string[]> {
    const pending = await this.call(
      caller,
      "GET",
      `/api/keykeeper/msp/${mspId}/pending`,
    );
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    const confirmed: string[] = [];
    for (const p of pending.body.data) {
      const result = await this.call(
        caller,
        "POST",
        `/api/organizations/${p.organizationId}/users/${p.memberId}/confirm`,
        {
          key: encString(`org-key-for-${p.email}`),
        },
      );
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      confirmed.push(p.email);
    }
    return confirmed;
  }

  /** An organization's memberships, as its owner sees them. */
  async members(
    owner: Account,
    orgId: string,
  ): Promise<{ id: string; email: string; status: number; type: number }[]> {
    const listed = await this.call(
      owner,
      "GET",
      `/api/organizations/${orgId}/users`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    return listed.body.data;
  }

  /** A stand-in secure note, in someone's own vault or an organization. */
  private note(owner: Account, organizationId: string | null) {
    return {
      type: 2,
      name: encString(`note-${randomUUID()}`),
      notes: null,
      secureNote: { type: 0 },
      organizationId,
      encryptedFor: owner.userId,
      favorite: false,
      reprompt: 0,
      fields: [],
    };
  }

  /** An item in someone's own vault, such as a template an MSP sends. */
  async personalItem(owner: Account): Promise<string> {
    const created = await this.call(
      owner,
      "POST",
      "/api/ciphers",
      this.note(owner, null),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body.id;
  }

  /** A new collection in an organization, as its owner. */
  async collection(owner: Account, orgId: string): Promise<string> {
    const created = await this.call(
      owner,
      "POST",
      `/api/organizations/${orgId}/collections`,
      { name: encString(`collection-${randomUUID()}`), groups: [], users: [] },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body.id;
  }

  /** An item in an organization's collection, as its owner. */
  async orgItem(
    owner: Account,
    orgId: string,
    collectionId: string,
  ): Promise<string> {
    const created = await this.call(owner, "POST", "/api/ciphers/create", {
      cipher: this.note(owner, orgId),
      collectionIds: [collectionId],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body.id;
  }

  /** The organization ids someone belongs to, from their profile. */
  async orgsOf(account: Account): Promise<string[]> {
    const profile = await this.call(account, "GET", "/api/accounts/profile");
    return profile.body.organizations.map((o: { id: string }) => o.id).sort();
  }

  /**
   * Adds an existing account with a custom role: upstream's Custom type (4)
   * with these permissions, accepted and confirmed like any member. One that manages
   * members, policies, or account recovery gets an authenticator app first
   * where the organization requires two-step login for admins, as addMember.
   */
  async addCustomMember(
    owner: Account,
    orgId: string,
    member: Account,
    permissions: Record<string, boolean>,
  ) {
    const elevated = ["manageUsers", "managePolicies", "manageResetPassword"].some((p) => permissions[p]);
    if (elevated && (await this.requiresTwoStep(owner, orgId))) {
      await this.giveAuthenticator(member);
    }
    const invited = await this.call(
      owner,
      "POST",
      `/api/organizations/${orgId}/users/invite`,
      {
        emails: [member.email],
        type: 4,
        collections: [],
        groups: [],
        permissions,
      },
    );
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    const membership = (await this.members(owner, orgId)).find(
      (m) => m.email === member.email,
    )!;
    await this.acceptRole(member, orgId);
    const confirmed = await this.call(
      owner,
      "POST",
      `/api/organizations/${orgId}/users/${membership.id}/confirm`,
      {
        key: encString(`org-key-for-${member.email}`),
      },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return membership.id;
  }
}

/**
 * Counts rows in the test server's SQLite database, read-only, for tests that
 * check what the server keeps (or no longer keeps) after a request. Null when
 * the server runs on PostgreSQL (KK_DATABASE_URL), where those checks are
 * left to the API's answers.
 */
export async function serverDatabase(): Promise<
  ((sql: string, ...params: string[]) => number) | null
> {
  if (process.env.KK_DATABASE_URL) {
    return null;
  }
  const data = fs.readFileSync(path.join(os.tmpdir(), `keykeeper-e2e-data-${port}`), "utf8");
  const { DatabaseSync } = await import("node:sqlite");
  return (sql, ...params) => {
    const db = new DatabaseSync(path.join(data, "db.sqlite3"), { readOnly: true });
    try {
      return Number(Object.values(db.prepare(sql).get(...params) ?? {})[0] ?? 0);
    } finally {
      db.close();
    }
  };
}

/**
 * Makes an account's sign-in requests older in the test server's SQLite
 * database, as if `minutes` had passed since they were made: the server's
 * clock can't be moved, and a request lasts 15 minutes (DESIGN.md,
 * "Approving a sign-in from another device"). Returns how many it changed,
 * or null when the server runs on PostgreSQL (KK_DATABASE_URL), where tests
 * leave this out.
 */
export async function ageSignInRequests(email: string, minutes: number): Promise<number | null> {
  if (process.env.KK_DATABASE_URL) {
    return null;
  }
  const data = fs.readFileSync(path.join(os.tmpdir(), `keykeeper-e2e-data-${port}`), "utf8");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(data, "db.sqlite3"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const changed = db
      .prepare(
        `UPDATE auth_requests
           SET creation_date = strftime('%Y-%m-%d %H:%M:%f', creation_date, ?)
         WHERE user_uuid = (SELECT uuid FROM users WHERE email = ?)`,
      )
      .run(`-${minutes} minutes`, email.toLowerCase());
    return Number(changed.changes);
  } finally {
    db.close();
  }
}

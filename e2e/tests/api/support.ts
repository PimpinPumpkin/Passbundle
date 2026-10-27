// A small client for the server's HTTP API, for black-box tests. The server
// stores keys and encrypted values as opaque strings and never decrypts them,
// so tests use stand-in key material instead of real crypto.
import { randomUUID } from "node:crypto";
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

/**
 * A change's body with the caller's master password hash, as the web vault
 * sends it after asking: making a provisioning token, saving single sign-on,
 * adding or changing an event destination or its signing secret, and making
 * a script token need it (DESIGN.md, "Confirming sensitive changes").
 */
export const confirmed = (
  who: { password?: string } | null,
  data: Record<string, unknown> = {},
): Record<string, unknown> => ({ ...data, ...(who?.password ? { masterPasswordHash: who.password } : {}) });

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

  async logIn(email: string, password: string): Promise<string> {
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
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).access_token;
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
   * Adds an existing account to an organization with a role, confirmed like a
   * real member: invited (accepted at once, since the test server sends no
   * mail), then confirmed by the owner with the org key for them.
   */
  async addMember(
    owner: Account,
    orgId: string,
    member: Account,
    type: "admin" | "user" | "manager" | "owner",
  ) {
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

  /** A new MSP with this account as its admin. */
  async msp(admin: Account, name: string): Promise<string> {
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
   * they accept with its token. Returns the invitation response.
   */
  async addStaff(
    admin: Account,
    mspId: string,
    member: Account,
    role: "admin" | "technician",
    access?: unknown,
  ) {
    const invited = await this.call(
      admin,
      "POST",
      `/api/keykeeper/msp/${mspId}/staff`,
      { email: member.email, role, access },
    );
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    expect(invited.body.invited).toBe(true);
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
   * with these permissions, confirmed like any member.
   */
  async addCustomMember(
    owner: Account,
    orgId: string,
    member: Account,
    permissions: Record<string, boolean>,
  ) {
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

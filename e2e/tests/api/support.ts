// A small client for the server's HTTP API, for black-box tests. The server
// stores keys and encrypted values as opaque strings and never decrypts them,
// so tests use stand-in key material instead of real crypto.
import { randomUUID } from "node:crypto";

import { type APIRequestContext, type APIResponse, expect } from "@playwright/test";

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A well-formed stand-in for an encrypted value (type 2: AES-CBC with HMAC). */
export const encString = (label: string) => `2.${b64(`${label}-iv`)}|${b64(`${label}-ct`)}|${b64(`${label}-mac`)}`;

/** A stand-in public key, unique per label. */
export const publicKey = (label: string) => b64(`public-key-${label}`);

export type Account = { email: string; password: string; token: string; userId: string };

export type Result = { status: number; body: any };

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

  /** A new account, logged in. */
  async account(prefix: string): Promise<Account> {
    const email = `${prefix}-${randomUUID().slice(0, 8)}@api.example.test`;
    const password = b64(`hash-${email}`);
    const verify = await this.request.post("/identity/accounts/register/send-verification-email", {
      data: { email, name: prefix, receiveMarketingEmails: false },
      headers: { Accept: "application/json" },
    });
    expect(verify.status(), await verify.text()).toBe(200);
    const finish = await this.request.post("/identity/accounts/register/finish", {
      data: {
        email,
        emailVerificationToken: await verify.json(),
        masterPasswordHash: password,
        masterPasswordHint: null,
        userSymmetricKey: encString(`user-key-${email}`),
        userAsymmetricKeys: { publicKey: publicKey(email), encryptedPrivateKey: encString(`private-key-${email}`) },
        kdf: 0,
        kdfIterations: 600000,
      },
    });
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
      keys: { publicKey: publicKey(`org-${name}`), encryptedPrivateKey: encString(`org-private-${name}`) },
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
  async addMember(owner: Account, orgId: string, member: Account, type: "admin" | "user" | "manager" | "owner") {
    const types = { owner: 0, admin: 1, user: 2, manager: 3 };
    const invited = await this.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [member.email],
      type: types[type],
      collections: [],
      groups: [],
      accessSecretsManager: false,
      permissions: {},
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    const listed = await this.call(owner, "GET", `/api/organizations/${orgId}/users`);
    const membership = listed.body.data.find((m: { email: string }) => m.email === member.email);
    expect(membership, `membership for ${member.email}`).toBeTruthy();
    const confirmed = await this.call(owner, "POST", `/api/organizations/${orgId}/users/${membership.id}/confirm`, {
      key: encString(`org-key-for-${member.email}`),
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return membership.id as string;
  }
}

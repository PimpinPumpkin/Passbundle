// Real keys and encryption for tests whose client decrypts what the server
// holds (the command-line tool, say), made with plain Node the way upstream's
// apps make them: a master key from PBKDF2, an account key wrapped by the
// stretched master key, an RSA key pair, organization keys wrapped to each
// member's public key, and values encrypted as type 2 (AES-256-CBC with
// HMAC-SHA256). Everything else in the API tests uses stand-ins
// (tests/api/support.ts), since the server never decrypts anything.
import {
  constants,
  createCipheriv,
  createHmac,
  generateKeyPairSync,
  pbkdf2Sync,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { type APIRequestContext, expect } from "@playwright/test";

const KDF_ITERATIONS = 600_000;

/** A 64-byte key: 32 bytes for AES-256-CBC, then 32 for HMAC-SHA256. */
export type SymmetricKey = Buffer;

/** A value encrypted with a symmetric key, as upstream's type 2 string. */
export function encrypt(key: SymmetricKey, value: string | Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const ct = Buffer.concat([cipher.update(value), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32))
    .update(Buffer.concat([iv, ct]))
    .digest();
  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
}

/** A value encrypted to an RSA public key (SPKI, DER), as upstream's type 4 string. */
export function encryptTo(publicKey: Buffer, value: Buffer): string {
  const sealed = publicEncrypt(
    {
      key: publicKey,
      format: "der",
      type: "spki",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    value,
  );
  return `4.${sealed.toString("base64")}`;
}

/** HKDF-Expand (RFC 5869) for one 32-byte block, as upstream stretches a master key. */
function expand(prk: Buffer, info: string): Buffer {
  return createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
}

function rsaKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return { publicKey, privateKey };
}

export type RealAccount = {
  email: string;
  /** The master password, as the person types it. */
  password: string;
  /** What the apps send for it: the master password hash. */
  passwordHash: string;
  token: string;
  userId: string;
  publicKey: Buffer;
};

/** A new account with real keys (PBKDF2, 600,000 iterations), signed in. */
export async function realAccount(
  request: APIRequestContext,
  prefix: string,
): Promise<RealAccount> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@cli.example.test`;
  const password = `correct horse ${randomUUID()}`;
  const masterKey = pbkdf2Sync(password, email, KDF_ITERATIONS, 32, "sha256");
  const passwordHash = pbkdf2Sync(
    masterKey,
    password,
    1,
    32,
    "sha256",
  ).toString("base64");
  const stretched = Buffer.concat([
    expand(masterKey, "enc"),
    expand(masterKey, "mac"),
  ]);
  const userKey = randomBytes(64);
  const { publicKey, privateKey } = rsaKeyPair();

  const verify = await request.post(
    "/identity/accounts/register/send-verification-email",
    {
      data: { email, name: prefix, receiveMarketingEmails: false },
      headers: { Accept: "application/json" },
    },
  );
  expect(verify.status(), await verify.text()).toBe(200);
  const finish = await request.post("/identity/accounts/register/finish", {
    data: {
      email,
      emailVerificationToken: await verify.json(),
      masterPasswordHash: passwordHash,
      masterPasswordHint: null,
      userSymmetricKey: encrypt(stretched, userKey),
      userAsymmetricKeys: {
        publicKey: publicKey.toString("base64"),
        encryptedPrivateKey: encrypt(userKey, privateKey),
      },
      kdf: 0,
      kdfIterations: KDF_ITERATIONS,
    },
  });
  expect(finish.status(), await finish.text()).toBe(200);
  const login = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: email,
      password: passwordHash,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "cli-test",
    },
  });
  expect(login.status(), await login.text()).toBe(200);
  const token = (await login.json()).access_token;
  const profile = await request.get("/api/accounts/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    email,
    password,
    passwordHash,
    token,
    userId: (await profile.json()).id,
    publicKey,
  };
}

export type RealOrganization = { id: string; key: SymmetricKey };

const auth = (account: { token: string }) => ({
  Authorization: `Bearer ${account.token}`,
});

/** A new organization with a real key, owned by this account. */
export async function realOrganization(
  request: APIRequestContext,
  owner: RealAccount,
  name: string,
): Promise<RealOrganization> {
  const key = randomBytes(64);
  const { publicKey, privateKey } = rsaKeyPair();
  const created = await request.post("/api/organizations", {
    headers: auth(owner),
    data: {
      name,
      billingEmail: owner.email,
      collectionName: encrypt(key, "Default collection"),
      key: encryptTo(owner.publicKey, key),
      keys: {
        publicKey: publicKey.toString("base64"),
        encryptedPrivateKey: encrypt(key, privateKey),
      },
      planType: 0,
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  return { id: (await created.json()).id, key };
}

/** A shared folder (collection) of the organization, with an encrypted name. */
export async function realCollection(
  request: APIRequestContext,
  owner: RealAccount,
  org: RealOrganization,
  name: string,
): Promise<string> {
  const created = await request.post(
    `/api/organizations/${org.id}/collections`,
    {
      headers: auth(owner),
      data: { name: encrypt(org.key, name), groups: [], users: [] },
    },
  );
  expect(created.status(), await created.text()).toBe(200);
  return (await created.json()).id;
}

/**
 * Adds an account to the organization as a regular member with these
 * folders (upstream's grant fields), confirmed with the organization's key
 * wrapped to the member's own public key, as an owner's app confirms them.
 */
export async function realMember(
  request: APIRequestContext,
  owner: RealAccount,
  org: RealOrganization,
  member: RealAccount,
  collections: {
    id: string;
    readOnly: boolean;
    hidePasswords: boolean;
    manage: boolean;
  }[],
): Promise<string> {
  const invited = await request.post(
    `/api/organizations/${org.id}/users/invite`,
    {
      headers: auth(owner),
      data: {
        emails: [member.email],
        type: 2,
        collections,
        groups: [],
        accessSecretsManager: false,
        permissions: {},
      },
    },
  );
  expect(invited.status(), await invited.text()).toBe(200);
  const listed = await request.get(`/api/organizations/${org.id}/users`, {
    headers: auth(owner),
  });
  const membership = (await listed.json()).data.find(
    (m: { email: string }) => m.email === member.email,
  );
  expect(membership, `membership for ${member.email}`).toBeTruthy();
  const confirmed = await request.post(
    `/api/organizations/${org.id}/users/${membership.id}/confirm`,
    {
      headers: auth(owner),
      data: { key: encryptTo(member.publicKey, org.key) },
    },
  );
  expect(confirmed.status(), await confirmed.text()).toBe(200);
  return membership.id;
}

export type LoginValues = {
  name: string;
  username: string;
  password: string;
  uri: string;
  totp?: string;
};

function loginBody(
  org: RealOrganization,
  owner: RealAccount,
  values: LoginValues,
) {
  return {
    type: 1,
    organizationId: org.id,
    encryptedFor: owner.userId,
    name: encrypt(org.key, values.name),
    notes: null,
    favorite: false,
    reprompt: 0,
    fields: [],
    login: {
      username: encrypt(org.key, values.username),
      password: encrypt(org.key, values.password),
      totp: values.totp ? encrypt(org.key, values.totp) : null,
      uris: [{ uri: encrypt(org.key, values.uri), match: null }],
    },
  };
}

/** A login in one of the organization's folders, encrypted with its key. */
export async function realLogin(
  request: APIRequestContext,
  owner: RealAccount,
  org: RealOrganization,
  collectionId: string,
  values: LoginValues,
): Promise<string> {
  const created = await request.post("/api/ciphers/create", {
    headers: auth(owner),
    data: {
      cipher: loginBody(org, owner, values),
      collectionIds: [collectionId],
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  return (await created.json()).id;
}

/** An item of any kind in one of the organization's folders: each value of its part, and its fields, encrypted. */
export async function realItem(
  request: APIRequestContext,
  owner: RealAccount,
  org: RealOrganization,
  collectionId: string,
  item: {
    type: number;
    name: string;
    part?: string;
    values?: Record<string, string>;
    fields?: { name: string; value: string; type: number }[];
  },
): Promise<string> {
  const cipher: Record<string, unknown> = {
    type: item.type,
    organizationId: org.id,
    encryptedFor: owner.userId,
    name: encrypt(org.key, item.name),
    notes: null,
    favorite: false,
    reprompt: 0,
    fields: (item.fields ?? []).map((f) => ({
      name: encrypt(org.key, f.name),
      value: encrypt(org.key, f.value),
      type: f.type,
      linkedId: null,
    })),
  };
  if (item.type === 2) {
    cipher.secureNote = { type: 0 };
  }
  if (item.part != null) {
    cipher[item.part] = Object.fromEntries(
      Object.entries(item.values ?? {}).map(([k, v]) => [k, encrypt(org.key, v)]),
    );
  }
  const created = await request.post("/api/ciphers/create", {
    headers: auth(owner),
    data: { cipher, collectionIds: [collectionId] },
  });
  expect(created.status(), await created.text()).toBe(200);
  return (await created.json()).id;
}

/** Saves new values for a login, as an edit in an app does (its last version goes to history). */
export async function editLogin(
  request: APIRequestContext,
  owner: RealAccount,
  org: RealOrganization,
  id: string,
  values: LoginValues,
): Promise<void> {
  const current = await request.get(`/api/ciphers/${id}`, {
    headers: auth(owner),
  });
  const revisionDate = (await current.json()).revisionDate;
  const saved = await request.put(`/api/ciphers/${id}`, {
    headers: auth(owner),
    data: {
      ...loginBody(org, owner, values),
      lastKnownRevisionDate: revisionDate,
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** The account's API key (client_credentials), as its account settings show it. */
export async function apiKey(request: APIRequestContext, account: RealAccount) {
  const answer = await request.post("/api/accounts/api-key", {
    headers: auth(account),
    data: { masterPasswordHash: account.passwordHash },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return {
    clientId: `user.${account.userId}`,
    clientSecret: (await answer.json()).apiKey as string,
  };
}

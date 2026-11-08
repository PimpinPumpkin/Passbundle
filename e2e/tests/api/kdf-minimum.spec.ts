// The KDF settings an account can have are the ones PassBundle's apps accept
// (DESIGN.md, "KDF settings an account can have"): registering or changing the
// KDF with anything else is refused with a plain message, and the account
// keeps what it had.
import { randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { type Account, Api, encString, publicKey } from "./support";

const TOO_FEW = "PBKDF2 needs at least 600,000 iterations.";

const pbkdf2 = (iterations: number) => ({ kdfType: 0, iterations, memory: null, parallelism: null });

/** A registration as the web vault sends it, or as Android before 2026.9.0 did. */
function registration(email: string, token: string, iterations: number, flat: boolean) {
  const password = Buffer.from(`hash-${email}`).toString("base64");
  const keys = { publicKey: publicKey(email), encryptedPrivateKey: encString(`private-key-${email}`) };
  const userKey = encString(`user-key-${email}`);
  return flat
    ? {
        email,
        emailVerificationToken: token,
        masterPasswordHash: password,
        masterPasswordHint: null,
        userSymmetricKey: userKey,
        userAsymmetricKeys: keys,
        kdf: 0,
        kdfIterations: iterations,
      }
    : {
        email,
        emailVerificationToken: token,
        masterPasswordHint: null,
        userAsymmetricKeys: keys,
        masterPasswordAuthentication: {
          kdf: pbkdf2(iterations),
          salt: email,
          masterPasswordAuthenticationHash: password,
        },
        masterPasswordUnlock: { kdf: pbkdf2(iterations), salt: email, masterKeyWrappedUserKey: userKey },
      };
}

async function verificationToken(request: APIRequestContext, email: string): Promise<string> {
  const verify = await request.post("/identity/accounts/register/send-verification-email", {
    data: { email, name: "Kdf", receiveMarketingEmails: false },
    headers: { Accept: "application/json" },
  });
  expect(verify.status(), await verify.text()).toBe(200);
  return verify.json();
}

async function prelogin(request: APIRequestContext, email: string) {
  const answer = await request.post("/identity/accounts/prelogin", { data: { email } });
  expect(answer.status(), await answer.text()).toBe(200);
  return answer.json();
}

for (const flat of [false, true]) {
  test(`registering with fewer than 600,000 PBKDF2 iterations is refused (${flat ? "flat" : "current"} format)`, async ({
    request,
  }) => {
    const api = new Api(request);
    const email = `kdf-${randomUUID().slice(0, 8)}@api.example.test`;
    const token = await verificationToken(request, email);

    for (const iterations of [100_000, 599_999]) {
      const refused = await request.post("/identity/accounts/register/finish", {
        data: registration(email, token, iterations, flat),
      });
      expect(refused.status(), await refused.text()).toBe(400);
      expect((await refused.json()).message).toBe(TOO_FEW);
    }

    // Nothing was made: the same email and token register at 600,000.
    const finish = await request.post("/identity/accounts/register/finish", {
      data: registration(email, token, 600_000, flat),
    });
    expect(finish.status(), await finish.text()).toBe(200);
    await api.logIn(email, Buffer.from(`hash-${email}`).toString("base64"));
    expect(await prelogin(request, email)).toMatchObject({ kdf: 0, kdfIterations: 600_000 });
  });
}

test("changing the KDF to settings the apps refuse is refused, and the account keeps its own", async ({
  request,
}) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const change = (who: Account, kdf: Record<string, unknown>, newHash: string) =>
    api.call(who, "POST", "/api/accounts/kdf", {
      authenticationData: { salt: who.email, kdf, masterPasswordAuthenticationHash: newHash },
      unlockData: { salt: who.email, kdf, masterKeyWrappedUserKey: encString(`user-key-${who.email}`) },
      masterPasswordHash: who.password,
    });
  const newHash = Buffer.from(`new-hash-${ana.email}`).toString("base64");

  for (const [kdf, message] of [
    [pbkdf2(100_000), TOO_FEW],
    [pbkdf2(599_999), TOO_FEW],
    [pbkdf2(2_000_001), "PBKDF2 allows at most 2,000,000 iterations."],
    [{ kdfType: 1, iterations: 1, memory: 64, parallelism: 4 }, "Argon2id needs 2 to 10 iterations."],
    [{ kdfType: 1, iterations: 3, memory: 15, parallelism: 4 }, "Argon2id needs 16 to 1,024 MiB of memory."],
    [{ kdfType: 1, iterations: 3, memory: 64, parallelism: 17 }, "Argon2id needs a parallelism of 1 to 16."],
  ] as const) {
    const refused = await change(ana, kdf, newHash);
    expect(refused.status, JSON.stringify(kdf)).toBe(400);
    expect(refused.body.message, JSON.stringify(kdf)).toBe(message);
  }
  // Still the account's own settings, password, and session.
  expect(await prelogin(request, ana.email)).toMatchObject({ kdf: 0, kdfIterations: 600_000 });
  expect((await api.call(ana, "GET", "/api/accounts/profile")).status).toBe(200);
  await api.logIn(ana.email, ana.password);

  const changed = await change(ana, pbkdf2(600_000), newHash);
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  await api.logIn(ana.email, newHash);
  expect(await prelogin(request, ana.email)).toMatchObject({ kdf: 0, kdfIterations: 600_000 });
});

// Settings that follow someone to each of their devices (DESIGN.md,
// "Generator settings"): the server keeps each account's own, only encrypted,
// shows them to nobody else, doesn't make the other devices download the
// vault when they change, and forgets them when the account's key changes.
import { expect, test } from "@playwright/test";

import { type Account, Api, encString, publicKey } from "./support";

const get = (api: Api, who: Account | null) => api.call(who, "GET", "/api/keykeeper/settings");
const put = (api: Api, who: Account, data: string) =>
  api.call(who, "PUT", "/api/keykeeper/settings", { data });

test("each account keeps its own settings, and only encrypted", async ({ request }) => {
  const api = new Api(request);
  const [ana, ben] = await Promise.all([api.account("ana"), api.account("ben")]);

  const none = await get(api, ana);
  expect(none.status, JSON.stringify(none.body)).toBe(200);
  expect(none.body).toMatchObject({ object: "keykeeperSettings", data: null, revisionDate: null });

  for (const notEncrypted of [
    '{"generator":{"length":20}}',
    "0.aXY=|Y3Q=",
    "2.only|two",
    "2.not base64!|YQ==|YQ==",
    `2.YQ==|${"A".repeat(17 * 1024)}|YQ==`,
  ]) {
    const refused = await put(api, ana, notEncrypted);
    expect(refused.status, notEncrypted.slice(0, 30)).toBe(400);
  }

  const data = encString("settings-ana");
  const saved = await put(api, ana, data);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body).toMatchObject({ object: "keykeeperSettings", data });
  expect(saved.body.revisionDate).toEqual(expect.any(String));
  expect((await get(api, ana)).body.data).toBe(data);

  // Nobody else's, either way.
  expect((await get(api, ben)).body.data).toBeNull();
  expect((await put(api, ben, encString("settings-ben"))).status).toBe(200);
  expect((await get(api, ana)).body.data).toBe(data);
  expect((await get(api, null)).status).toBe(401);
});

test("saving settings doesn't make the account's devices download the vault again", async ({
  request,
}) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const revision = async () => (await api.call(ana, "GET", "/api/accounts/revision-date")).body;
  const before = await revision();
  expect((await put(api, ana, encString("settings-ana"))).status).toBe(200);
  expect(await revision()).toBe(before);
});

test("changing the account's key forgets its settings, which nothing could read anymore", async ({
  request,
}) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  expect((await put(api, ana, encString("settings-ana"))).status).toBe(200);

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

  // Rotating ends the sessions; a new one.
  const token = await api.logIn(ana.email, ana.password);
  const after = await get(api, { ...ana, token });
  expect(after.status).toBe(200);
  expect(after.body.data).toBeNull();
});

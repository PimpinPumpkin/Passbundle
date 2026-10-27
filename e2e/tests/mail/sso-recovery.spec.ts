// Account recovery keeps working with single sign-on required (DESIGN.md,
// "Sign in with Microsoft Entra ID"). Recovery needs a server that sends
// email, so this runs on the mail test server. An owner resets a member's
// master password; the member, who must sign in with single sign-on, does,
// and the answer carries the account key wrapped by the new master password,
// so the new password unlocks.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { mailServerPort } from "../../paths.mjs";
import { Api, encString } from "../api/support";
import { linkFromSession, message, ssoOrg, ssoSignIn } from "../support/entra";

import { joinByEmail, waitForMessage } from "./mailbox";

const origin = `https://127.0.0.1:${mailServerPort}`;

test("an owner recovers a member who must sign in with single sign-on, and the new master password unlocks", async ({
  request,
}) => {
  const api = new Api(request);
  const { owner, orgId, tenant, identifier, domain } = await ssoOrg(api, "recovery");
  const orgName = (await api.call(owner, "GET", `/api/organizations/${orgId}`)).body.name as string;
  const recovery = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/8`, {
    policy: { enabled: true, data: { autoEnrollEnabled: true } },
  });
  expect(recovery.status, JSON.stringify(recovery.body)).toBe(200);
  for (const type of [3, 4]) {
    const on = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/${type}`, {
      policy: { enabled: true, data: null },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }

  // A member joins by email, enrolling in account recovery.
  const member = await api.account("recovered", `gus-${randomUUID().slice(0, 8)}@${domain}`);
  const memberId = await joinByEmail(api, owner, orgId, orgName, member, { type: 2 });
  const gus = await tenant.person(member.email);

  // They link their account from their signed-in session (it has keys, so an
  // email never links it), and the account hears about it.
  await tenant.next(gus);
  expect((await linkFromSession(request, origin, member, identifier)).status).toBe(200);
  const linked = await waitForMessage(member.email, /linked to .* single sign-on/);
  expect(linked.text).toContain("If you didn't do this");

  // They forget their master password; the owner sets a new one.
  const newHash = Buffer.from(`new-hash-${member.email}`).toString("base64");
  const newKey = encString(`user-key-after-recovery-${member.email}`);
  const recovered = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}/recover-account`, {
    newMasterPasswordHash: newHash,
    key: newKey,
    resetMasterPassword: true,
    resetTwoFactor: false,
  });
  expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
  await waitForMessage(member.email, /Admin account recovery/);

  // Their password still sends them to single sign-on (the new one checks out first).
  const byPassword = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: member.email,
      password: newHash,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "api-test",
    },
  });
  expect(byPassword.status()).toBe(400);
  expect((await byPassword.json()).SsoOrganizationIdentifier).toBe(identifier);

  // Single sign-on signs them in, and the new master password unlocks: the
  // account key comes wrapped by it.
  await tenant.next(gus);
  const signedIn = await ssoSignIn(request, origin, identifier);
  expect(signedIn.token?.status, message(signedIn.token?.body)).toBe(200);
  expect(signedIn.token!.body.Key).toBe(newKey);
  expect(signedIn.token!.body.UserDecryptionOptions.HasMasterPassword).toBe(true);
  expect(signedIn.token!.body.UserDecryptionOptions.MasterPasswordUnlock.MasterKeyWrappedUserKey).toBe(newKey);

  // And the owner, who recovered them, still signs in with a password.
  const ownerLogin = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: owner.email,
      password: owner.password,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "api-test",
    },
  });
  expect(ownerLogin.status()).toBe(200);
});

// Two-step login for admins (DESIGN.md, "Two-step login for admins") where it
// needs a server that sends email: email codes don't count, and account
// recovery leaves a covered person to set it up at their next sign-in.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { mailHttpPort } from "../../paths.mjs";
import { type Account, Api, type Result, encString, nextTotp, totp } from "../api/support";

import { joinByEmail, waitForMessage } from "./mailbox";

/** The number of messages to an address so far. */
async function messageCount(to: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${mailHttpPort}/messages?to=${encodeURIComponent(to)}`);
  return ((await response.json()) as unknown[]).length;
}

/** The code in the newest login code email to an address, once one more than `before` arrived. */
async function emailedCode(to: string, before: number): Promise<string> {
  await expect(async () => {
    expect(await messageCount(to)).toBeGreaterThan(before);
  }).toPass({ timeout: 15_000 });
  const message = await waitForMessage(to, /Login Verification Code/);
  const code = /code is: (\d+)/.exec(message.text)?.[1];
  expect(code, message.text).toBeTruthy();
  return code!;
}

function expectSetup(result: Result) {
  expect(result.status, JSON.stringify(result.body)).toBe(400);
  expect(result.body.KeykeeperTwoStepSetup, JSON.stringify(result.body)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.body).not.toHaveProperty("access_token");
}

async function requireIt(api: Api, owner: Account, orgId: string) {
  const on = await api.call(owner, "PUT", `/api/keykeeper/organizations/${orgId}/admin-two-step`, { required: true });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
}

test("an email code doesn't count: an owner with only email codes gets a setup session for the right one, and once they have an authenticator app, codes aren't taken", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("email-owner");
  const orgId = await api.organization(owner, `Email Co ${randomUUID().slice(0, 6)}`);

  // Email codes on, as upstream's two-step login settings do it.
  let before = await messageCount(owner.email);
  const sent = await api.call(owner, "POST", "/api/two-factor/send-email", {
    email: owner.email,
    masterPasswordHash: owner.password,
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const on = await api.call(owner, "PUT", "/api/two-factor/email", {
    email: owner.email,
    token: await emailedCode(owner.email, before),
    masterPasswordHash: owner.password,
  });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  await requireIt(api, owner, orgId);

  // The sign-in asks for the code first, as always.
  const asked = await api.signIn(owner.email, owner.password);
  expect(asked.status).toBe(400);
  expect(asked.body.TwoFactorProviders).toEqual(["1"]);
  expect(asked.body).not.toHaveProperty("KeykeeperTwoStepSetup");

  // A wrong code is a wrong code.
  const wrong = await api.signIn(owner.email, owner.password, { twoFactorProvider: "1", twoFactorToken: "000000" });
  expect(wrong.status).toBe(400);
  expect(wrong.body).not.toHaveProperty("KeykeeperTwoStepSetup");

  // The right code checks out, but doesn't count for an owner.
  before = await messageCount(owner.email);
  const requested = await api.call(null, "POST", "/api/two-factor/send-email-login", {
    email: owner.email,
    masterPasswordHash: owner.password,
  });
  expect(requested.status, JSON.stringify(requested.body)).toBe(200);
  const code = await emailedCode(owner.email, before);
  const setup = await api.signIn(owner.email, owner.password, { twoFactorProvider: "1", twoFactorToken: code });
  expectSetup(setup);

  // With an authenticator app as well, email codes aren't offered or taken
  // any more: the people who run the mailbox could read them.
  const key = await api.turnOnAuthenticator({ token: setup.body.KeykeeperTwoStepSetup }, owner.password);
  const offered = await api.signIn(owner.email, owner.password);
  expect(offered.status).toBe(400);
  expect(offered.body.TwoFactorProviders).toEqual(["0"]);
  before = await messageCount(owner.email);
  await api.call(null, "POST", "/api/two-factor/send-email-login", {
    email: owner.email,
    masterPasswordHash: owner.password,
  });
  const refused = await api.signIn(owner.email, owner.password, {
    twoFactorProvider: "1",
    twoFactorToken: await emailedCode(owner.email, before),
  });
  expect(refused.status).toBe(400);
  expect(refused.body).not.toHaveProperty("access_token");
  expect(refused.body).not.toHaveProperty("KeykeeperTwoStepSetup");
  expect(refused.body.TwoFactorProviders).toEqual(["0"]);
  const signedIn = await api.signIn(owner.email, owner.password, {
    twoFactorProvider: "0",
    twoFactorToken: totp(key, Date.now() + 30_000),
  });
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
});

test("an MSP resets a client admin's two-step login, which signs them out at once, and recovers their account; they set it up at their next sign-in", async ({
  request,
}) => {
  const api = new Api(request);
  const mspAdmin = await api.account("recovery-msp-admin");
  const mspId = await api.msp(mspAdmin, `Recovery IT ${randomUUID().slice(0, 6)}`);
  const clientName = `Recovered Dental ${randomUUID().slice(0, 6)}`;
  // The Business defaults, with this server's account recovery.
  const clientId = await api.client(mspAdmin, mspId, clientName, "business");

  // A client admin with an authenticator app joins by email, enrolling in
  // account recovery, and signs in.
  const admin = await api.account("recovered-admin");
  await api.giveAuthenticator(admin);
  const memberId = await joinByEmail(api, mspAdmin, clientId, clientName, admin, { type: 1 });
  const session = await api.signIn(admin.email, admin.password, {
    twoFactorProvider: "0",
    twoFactorToken: await nextTotp(admin.email),
  });
  expect(session.status, JSON.stringify(session.body)).toBe(200);
  const works = async (token: string) => (await api.call({ token }, "GET", "/api/sync")).status === 200;
  expect(await works(session.body.access_token)).toBe(true);

  // They lose their phone; the MSP resets their two-step login only. That
  // leaves them without a method that counts, so every session of theirs
  // ends at once, and their next sign-in sets one up.
  const recover = (data: Record<string, unknown>) =>
    api.call(mspAdmin, "PUT", `/api/organizations/${clientId}/users/${memberId}/recover-account`, data);
  const reset = await recover({ resetMasterPassword: false, resetTwoFactor: true });
  expect(reset.status, JSON.stringify(reset.body)).toBe(200);
  expect(await works(session.body.access_token)).toBe(false);
  expect(await works(admin.token)).toBe(false);
  const signIn = await api.signIn(admin.email, admin.password);
  expectSetup(signIn);
  expect(signIn.body.KeykeeperTwoStepRequiredBy).toEqual([clientName]);
  const setup = { token: signIn.body.KeykeeperTwoStepSetup as string };
  expect((await api.call(setup, "GET", "/api/keykeeper/two-step-setup")).status).toBe(200);

  // They lose their master password too, before they set it up: recovering
  // it ends the setup session with the old password, as every session.
  const newHash = Buffer.from(`new-hash-${admin.email}`).toString("base64");
  const recovered = await recover({
    newMasterPasswordHash: newHash,
    key: encString(`user-key-after-recovery-${admin.email}`),
    resetMasterPassword: true,
    resetTwoFactor: false,
  });
  expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
  expect((await api.call(setup, "GET", "/api/keykeeper/two-step-setup")).status).toBe(401);

  // The new password works, and leads straight to setting up two-step login.
  const next = await api.signIn(admin.email, newHash);
  expectSetup(next);
  const key = await api.turnOnAuthenticator({ token: next.body.KeykeeperTwoStepSetup }, newHash);
  expect(key).toMatch(/^[A-Z2-7]+$/);
});

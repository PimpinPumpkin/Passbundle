// The web vault's two-step login settings, as upstream's clients drive them
// (DESIGN.md, "Two-step login settings"): a dialog confirms with the master
// password once, gets a short-lived token in the first answer, and sends the
// token instead of the password with the requests that follow. The token is
// upstream's (Vaultwarden 1.37.5): signed by the server, for one person, one
// method, and that method's state when it was given, for five minutes. (The
// security key's dialog works the same way; this test server, at an IP
// address, can't offer security keys, so the extension and web vault tests
// cover that one: e2e/tests/connector-origins.spec.ts.)
import { expect, test } from "@playwright/test";

import { Api, totp } from "./support";

test("two-step login's settings take the token their first answer gives, for that method and state only, and nothing else does", async ({
  request,
}) => {
  const api = new Api(request);
  const [ana, ben] = await Promise.all([api.account("ana"), api.account("ben")]);

  // The first answer, after the master password: the details where upstream's
  // clients read them, and the token, a signed JWT.
  const started = await api.call(ana, "POST", "/api/two-factor/get-authenticator", {
    masterPasswordHash: ana.password,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const token = started.body.userVerificationToken as string;
  expect(token.split(".")).toHaveLength(3);
  expect(started.body.authenticator.enabled).toBe(false);
  const key = started.body.authenticator.key as string;

  // Without it, or with a made-up one, someone else's, or another method's,
  // nothing happens.
  const turnOn = (as: typeof ana, extra: Record<string, unknown>) =>
    api.call(as, "POST", "/api/two-factor/authenticator", { key, token: totp(key), ...extra });
  expect([400, 422]).toContain((await turnOn(ana, {})).status);
  expect((await turnOn(ana, { userVerificationToken: "v1.AAAA" })).status).toBe(400);
  expect((await turnOn(ben, { userVerificationToken: token })).status).toBe(400);
  const email = await api.call(ana, "POST", "/api/two-factor/get-email", {
    masterPasswordHash: ana.password,
  });
  expect(email.status, JSON.stringify(email.body)).toBe(200);
  expect((await turnOn(ana, { userVerificationToken: email.body.userVerificationToken })).status).toBe(400);
  // Nor for another key than the one it was given with.
  const otherKey = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const swapped = await api.call(ana, "POST", "/api/two-factor/authenticator", {
    key: otherKey,
    token: totp(otherKey),
    userVerificationToken: token,
  });
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(400);
  // Nothing outside two-step login's settings takes it.
  const apiKey = await api.call(ana, "POST", "/api/accounts/api-key", { userVerificationToken: token });
  expect(apiKey.status, JSON.stringify(apiKey.body)).toBe(400);

  // With it, the dialog's next step turns the app on.
  const on = await turnOn(ana, { userVerificationToken: token });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  expect(on.body.authenticator).toEqual({ enabled: true, key });

  // It was for the app while it was off: it doesn't turn it on again, and it
  // doesn't remove it.
  expect((await turnOn(ana, { userVerificationToken: token })).status).toBe(400);
  const stale = await api.call(ana, "DELETE", "/api/two-factor/authenticator", {
    key,
    userVerificationToken: token,
  });
  expect(stale.status, JSON.stringify(stale.body)).toBe(400);

  // Remove takes a token given while it's on.
  const off = await api.turnOffAuthenticator(ana, ana.password);
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  const methods = await api.call(ana, "GET", "/api/two-factor");
  expect(methods.body.data).toEqual([]);
});

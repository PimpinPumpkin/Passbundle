// The web vault's two-step login settings, as upstream's clients drive them
// (DESIGN.md, "Two-step login settings"): a dialog confirms with the master
// password once, gets a short-lived token in the first answer, and sends the
// token instead of the password with the requests that follow. The token is
// one person's, works only on two-step login's settings, and ends when their
// security stamp changes. (The security key's dialog works the same way; this
// test server, at an IP address, can't offer security keys, so the extension
// and web vault tests cover that one: e2e/tests/connector-origins.spec.ts.)
import { expect, test } from "@playwright/test";

import { Api, totp } from "./support";

test("two-step login's settings take the token their first answer gives, and nothing else does", async ({
  request,
}) => {
  const api = new Api(request);
  const [ana, ben] = await Promise.all([api.account("ana"), api.account("ben")]);

  // The first answer, after the master password: the details, both ways
  // upstream's clients have read them, and the token.
  const started = await api.call(ana, "POST", "/api/two-factor/get-authenticator", {
    masterPasswordHash: ana.password,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const token = started.body.userVerificationToken as string;
  expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
  expect(started.body.authenticator).toEqual({ enabled: false, key: started.body.key });

  // Without it, or with a made-up one, or someone else's, nothing happens.
  const key = started.body.key as string;
  const turnOn = (as: typeof ana, extra: Record<string, unknown>) =>
    api.call(as, "POST", "/api/two-factor/authenticator", { key, token: totp(key), ...extra });
  expect((await turnOn(ana, {})).status).toBe(400);
  expect((await turnOn(ana, { userVerificationToken: "v1.AAAA" })).status).toBe(400);
  expect((await turnOn(ben, { userVerificationToken: token })).status).toBe(400);
  // Nothing outside two-step login's settings takes it.
  const apiKey = await api.call(ana, "POST", "/api/accounts/api-key", { userVerificationToken: token });
  expect(apiKey.status, JSON.stringify(apiKey.body)).toBe(400);

  // With it, the dialog's next step turns the app on, and its Remove turns it off.
  const on = await turnOn(ana, { userVerificationToken: token });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  expect(on.body.authenticator).toEqual({ enabled: true, key });
  const off = await api.call(ana, "DELETE", "/api/two-factor/authenticator", { key, userVerificationToken: token });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.enabled).toBe(false);
});

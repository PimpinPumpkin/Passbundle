// Login limits (DESIGN.md, "Login limits"), on the test server that keeps the
// real ones: each account has a strict limit, so guessing one person's
// password stops after 10 tries from anywhere, and an address has a generous
// one, so an office behind one address logs in together on rollout day.
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { limitsServerPort } from "../../paths.mjs";

import { Api } from "./support";

test.use({ baseURL: `https://127.0.0.1:${limitsServerPort}` });

const attempt = (request: APIRequestContext, username: string, password: string) =>
  request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username,
      password,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "limits-test",
    },
  });

test("an office behind one address signs up and logs in together", async ({ request }) => {
  // Upstream's limits stop this office twice: signing up (a burst of 50
  // requests shared with pre-login, and each signup takes two) and logging in
  // (10, then one a minute).
  test.setTimeout(180_000);
  const api = new Api(request);
  const office = [];
  for (let i = 0; i < 30; i++) {
    office.push(await api.account(`office-${i}`));
  }
  for (const person of office) {
    // As the apps do: pre-login for the key settings, then the login.
    const prelogin = await request.post("/identity/accounts/prelogin", { data: { email: person.email } });
    expect(prelogin.status(), await prelogin.text()).toBe(200);
    const again = await attempt(request, person.email, person.password);
    expect(again.status(), await again.text()).toBe(200);
  }
});

test("guessing one account's password stops after 10 tries, for that account only, whether or not it exists", async ({
  request,
}) => {
  const api = new Api(request);
  // Making the account logged it in once: that's its first of 10.
  const target = await api.account("target");
  for (let i = 0; i < 9; i++) {
    const wrong = await attempt(request, target.email, Buffer.from(`guess-${i}`).toString("base64"));
    expect(wrong.status(), await wrong.text()).toBe(400);
  }
  // Now even the right password waits, typed any way.
  const right = await attempt(request, ` ${target.email.toUpperCase()} `, target.password);
  expect(right.status()).toBe(429);
  expect(await right.text()).toContain("Too many login attempts for this account. Wait a minute and try again.");

  // Someone else at the same address isn't affected.
  const colleague = await api.account("colleague");
  expect((await attempt(request, colleague.email, colleague.password)).status()).toBe(200);

  // An email with no account is limited the same way, so a refusal doesn't
  // say which emails have accounts.
  const nobody = `nobody-${randomUUID().slice(0, 8)}@api.example.test`;
  for (let i = 0; i < 10; i++) {
    expect((await attempt(request, nobody, "eA==")).status()).toBe(400);
  }
  expect((await attempt(request, nobody, "eA==")).status()).toBe(429);
});

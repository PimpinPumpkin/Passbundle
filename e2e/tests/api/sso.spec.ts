// Sign in with Microsoft Entra ID, per organization (DESIGN.md, "Sign in with
// Microsoft Entra ID"), against the local stand-in for Entra
// (e2e/entra-standin.mjs), signing in step by step as the web vault does:
// the settings, domain verification, how accounts link (by tenant id and
// object id, never by the email Entra sends), the ID token checks, single-use
// states and codes, "Require single sign-on", and the event log.
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { entraPort, port } from "../../paths.mjs";
import {
  message,
  newDomain,
  newIdentifier,
  redeem,
  settings,
  setTxt,
  ssoOrg,
  ssoSignIn,
  Tenant,
  tokenRequests,
  verifyDomain,
} from "../support/entra";

import { Api, encString, publicKey, type Account } from "./support";

const origin = `https://127.0.0.1:${port}`;
const CONFIRMED = 2;

async function events(api: Api, owner: Account, orgId: string) {
  const start = new Date(Date.now() - 3_600_000).toISOString();
  const end = new Date(Date.now() + 3_600_000).toISOString();
  const listed = await api.call(owner, "GET", `/api/organizations/${orgId}/events?start=${start}&end=${end}`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.data as {
    type: number;
    organizationUserId: string | null;
    actingUserId: string | null;
    domainName: string | null;
    keykeeperDetail: string | null;
  }[];
}

/** Who a token belongs to. */
async function whoIs(api: Api, token: string) {
  const profile = await api.call({ token }, "GET", "/api/accounts/profile");
  expect(profile.status).toBe(200);
  return profile.body.email as string;
}

async function setPolicy(api: Api, owner: Account, orgId: string, type: number, enabled: boolean) {
  return api.call(owner, "PUT", `/api/organizations/${orgId}/policies/${type}`, {
    policy: { enabled, data: null },
  });
}

async function passwordLogin(request: APIRequestContext, who: Account) {
  const response = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: who.email,
      password: who.password,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "api-test",
    },
  });
  return { status: response.status(), body: await response.json() };
}

test("owners and admins set it up; the secret never comes back; the tenant must exist", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("sso-setup-owner");
  const orgId = await api.organization(owner, `SSO Setup ${Date.now()}`);
  const url = `/api/keykeeper/organizations/${orgId}/sso`;

  const empty = await api.call(owner, "GET", url);
  expect(empty.status).toBe(200);
  expect(empty.body).toMatchObject({ enabled: false, identifier: null, callbackUrl: `${origin}/identity/connect/oidc-signin` });

  const tenant = new Tenant();
  const identifier = newIdentifier("setup");
  for (const [bad, why] of [
    [{ identifier: "A B" }, /SSO identifier/],
    [{ tenantId: "contoso.onmicrosoft.com" }, /tenant ID/],
    [{ tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad" }, /personal Microsoft accounts/],
    [{ clientId: "not-a-guid" }, /client ID/],
  ] as const) {
    const refused = await api.call(owner, "PUT", url, { ...settings(tenant, identifier), ...bad });
    expect(refused.status, JSON.stringify(bad)).toBe(400);
    expect(message(refused.body)).toMatch(why);
  }
  // On needs a secret, and a tenant Microsoft knows.
  const noSecret = await api.call(owner, "PUT", url, settings(tenant, identifier, true, false));
  expect(message(noSecret.body)).toMatch(/client secret/);
  const unknown = await api.call(owner, "PUT", url, settings(tenant, identifier));
  expect(unknown.status).toBe(400);
  expect(message(unknown.body)).toMatch(/didn't recognize the tenant/);

  await tenant.register();
  const saved = await api.call(owner, "PUT", url, settings(tenant, identifier));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body).toMatchObject({
    enabled: true,
    identifier,
    tenantId: tenant.tenantId,
    clientId: tenant.clientId,
    signInUrl: `${origin}/#/sso?identifier=${identifier}`,
  });
  expect(saved.body.secretSavedAt).toBeTruthy();
  expect(JSON.stringify(saved.body)).not.toContain(tenant.clientSecret);
  expect(JSON.stringify((await api.call(owner, "GET", url)).body)).not.toContain(tenant.clientSecret);

  // Saving again without a secret keeps it.
  const kept = await api.call(owner, "PUT", url, settings(tenant, identifier, true, false));
  expect(kept.status, JSON.stringify(kept.body)).toBe(200);

  // An identifier belongs to one organization.
  const other = await api.account("sso-setup-other");
  const otherOrg = await api.organization(other, `SSO Other ${Date.now()}`);
  const taken = await api.call(other, "PUT", `/api/keykeeper/organizations/${otherOrg}/sso`, settings(tenant, identifier));
  expect(message(taken.body)).toMatch(/Another organization uses that SSO identifier/);

  // Members and outsiders get "not found", never 403 (the web vault signs out on 403).
  const member = await api.account("sso-setup-member");
  await api.addMember(owner, orgId, member, "user");
  const admin = await api.account("sso-setup-admin");
  await api.addMember(owner, orgId, admin, "admin");
  for (const who of [member, other]) {
    expect((await api.call(who, "GET", url)).status).toBe(404);
    expect((await api.call(who, "PUT", url, settings(tenant, identifier))).status).toBe(404);
  }
  expect((await api.call(null, "GET", url)).status).toBe(401);
  expect((await api.call(admin, "GET", url)).status).toBe(200);

  // Every change is in the event log: on (high severity), and what changed.
  const log = await events(api, owner, orgId);
  expect(log.some((e) => e.type === 1604)).toBe(true);
  expect(log.some((e) => e.type === 1694 && e.keykeeperDetail === "identifier, tenant, app, client secret")).toBe(true);
});

test("a domain is verified by its DNS TXT record, belongs to one organization, and lets an email find the sign-in", async ({
  request,
}) => {
  const api = new Api(request);
  const { owner, orgId, identifier } = await ssoOrg(api, "domains", { domain: false });
  const domain = newDomain();
  const base = `/api/keykeeper/organizations/${orgId}/sso/domains`;

  for (const bad of ["", "com", "192.168.1.1", "acme..test"]) {
    expect((await api.call(owner, "POST", base, { domain: bad })).status, bad).toBe(400);
  }
  const added = await api.call(owner, "POST", base, { domain: `Someone@${domain.toUpperCase()}` });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const row = added.body.domains[0];
  expect(row).toMatchObject({ domain, txtName: domain, verifiedAt: null });
  expect(row.txtValue).toMatch(/^passbundle-verification=[A-Za-z0-9_-]{43}$/);
  expect((await api.call(owner, "POST", base, { domain })).status).toBe(400);

  // Not found yet, then a wrong value, then the right one.
  const discover = () => request.post("/api/organizations/domain/sso/verified", { data: { email: `ana@${domain}` } });
  const notYet = await api.call(owner, "POST", `${base}/${row.id}/verify`);
  expect(notYet.body.check.found).toBe(false);
  expect((await (await discover()).json()).data).toEqual([]);
  await setTxt(domain, ["v=spf1 -all", "passbundle-verification=not-the-token"]);
  expect((await api.call(owner, "POST", `${base}/${row.id}/verify`)).body.check.found).toBe(false);
  await setTxt(domain, ["v=spf1 -all", row.txtValue]);
  const verified = await api.call(owner, "POST", `${base}/${row.id}/verify`);
  expect(verified.body.check.found).toBe(true);
  expect(verified.body.domains[0].verifiedAt).toBeTruthy();

  // Typing an email at the domain finds the organization's sign-in.
  const found = await (await discover()).json();
  expect(found.data).toEqual([{ organizationIdentifier: identifier, organizationName: expect.any(String), domainName: domain }]);
  const elsewhere = await (await request.post("/api/organizations/domain/sso/verified", { data: { email: "ana@elsewhere.example.test" } })).json();
  expect(elsewhere.data).toEqual([]);

  // Another organization can't add or verify it.
  const other = await api.account("domains-other");
  const otherOrg = await api.organization(other, `Domains Other ${Date.now()}`);
  const otherAdd = await api.call(other, "POST", `/api/keykeeper/organizations/${otherOrg}/sso/domains`, { domain });
  expect(otherAdd.status).toBe(400);
  expect(message(otherAdd.body)).toMatch(/Another organization verified/);

  // The event log names the domain.
  const log = await events(api, owner, orgId);
  expect(log.filter((e) => e.domainName === domain).map((e) => e.type)).toEqual(expect.arrayContaining([2000, 2002, 2003]));

  // Removing it stops discovery.
  expect((await api.call(owner, "DELETE", `${base}/${row.id}`)).status).toBe(200);
  expect((await (await discover()).json()).data).toEqual([]);
  expect((await events(api, owner, orgId)).some((e) => e.type === 2001 && e.domainName === domain)).toBe(true);
});

test("a member links by tenant and object id, signs in with their master password still unlocking, and a spoofed email changes nothing", async ({
  request,
}) => {
  const api = new Api(request);
  const { owner, orgId, tenant, identifier, domain } = await ssoOrg(api, "link");
  const member = await api.account("link-member", `ana-${randomUUID().slice(0, 8)}@${domain}`);
  const memberId = await api.addMember(owner, orgId, member, "user");
  const ana = await tenant.person(member.email);

  // The web vault checks the identifier first.
  expect((await request.get(`/identity/sso/prevalidate?domainHint=${identifier}`)).status()).toBe(200);
  expect((await request.get("/identity/sso/prevalidate?domainHint=no-such-org")).status()).toBe(400);

  await tenant.next(ana);
  const first = await ssoSignIn(request, origin, identifier);
  expect(first.token?.status, JSON.stringify(first.token?.body)).toBe(200);
  // The master password still unlocks: the answer carries what a password
  // sign-in's does, the account key wrapped by the master key.
  expect(first.token!.body.UserDecryptionOptions.HasMasterPassword).toBe(true);
  expect(first.token!.body.Key).toBe(encString(`user-key-${member.email}`));
  expect(first.token!.body.UserDecryptionOptions.MasterPasswordUnlock.Salt).toBe(member.email);
  expect(await whoIs(api, first.token!.body.access_token)).toBe(member.email);

  // The server redeemed Microsoft's code with the app's secret and its own PKCE verifier.
  const sent = (await tokenRequests()).filter((r) => r.tenantId === tenant.tenantId);
  expect(sent.at(-1)).toMatchObject({ secretOk: true, verifierOk: true, codeKnown: true, redirectUri: `${origin}/identity/connect/oidc-signin` });

  // Ana's Entra account now claims the owner's email, vouched for and at the
  // verified domain: she still signs in as herself, never as the owner.
  await tenant.next(ana, { claims: { email: owner.email, xms_edov: true } });
  const spoofed = await ssoSignIn(request, origin, identifier);
  expect(spoofed.token?.status, JSON.stringify(spoofed.token?.body)).toBe(200);
  expect(await whoIs(api, spoofed.token!.body.access_token)).toBe(member.email);

  // Someone else in the tenant with Ana's email can't take her account.
  const impostor = await tenant.person(member.email, true);
  await tenant.next(impostor);
  const taken = await ssoSignIn(request, origin, identifier);
  expect(taken.token?.status).toBe(400);
  expect(message(taken.token!.body)).toMatch(/already linked to a different Microsoft account/);

  // The settings page lists the link; unlinking lets the next sign-in link again.
  const view = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/sso`);
  expect(view.body.links).toEqual([expect.objectContaining({ email: member.email, memberId })]);
  const unlinked = await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/sso/links/${member.userId}`);
  expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
  expect(unlinked.body.links).toEqual([]);
  await tenant.next(impostor);
  expect((await ssoSignIn(request, origin, identifier)).token?.status).toBe(200);

  const log = await events(api, owner, orgId);
  expect(log.some((e) => e.type === 1510 && e.organizationUserId === memberId)).toBe(true);
  expect(log.some((e) => e.type === 1590 && e.organizationUserId === memberId && e.actingUserId === member.userId)).toBe(true);
  expect(log.some((e) => e.type === 1505 && e.organizationUserId === memberId)).toBe(true);
  expect(log.some((e) => e.type === 1591 && /linked to another Microsoft account/.test(e.keykeeperDetail ?? ""))).toBe(true);
});

test("linking is refused for non-members, unvouched emails, and people with no account", async ({ request }) => {
  const api = new Api(request);
  const { owner, orgId, tenant, identifier, domain } = await ssoOrg(api, "refuse");

  // A vouched email at the verified domain whose account belongs to another organization.
  const elsewhere = await api.account("refuse-elsewhere", `bob-${randomUUID().slice(0, 8)}@${domain}`);
  await api.organization(elsewhere, `Bob's Side Business ${Date.now()}`);
  await tenant.next(await tenant.person(elsewhere.email, true));
  const notMember = await ssoSignIn(request, origin, identifier);
  expect(notMember.token?.status).toBe(400);
  expect(message(notMember.token!.body)).toMatch(/isn't a member of/);

  // A member's email nobody vouches for: not at a verified domain, no xms_edov.
  const outside = await api.account("refuse-outside");
  await api.addMember(owner, orgId, outside, "user");
  await tenant.next(await tenant.person(outside.email));
  const unvouched = await ssoSignIn(request, origin, identifier);
  expect(unvouched.token?.status).toBe(400);
  expect(message(unvouched.token!.body)).toMatch(/didn't confirm that .* is yours/);
  // With xms_edov, the same member links.
  await tenant.next(await tenant.person(outside.email, true));
  expect((await ssoSignIn(request, origin, identifier)).token?.status).toBe(200);

  // Nobody is made an account.
  await tenant.next(await tenant.person(`new-${randomUUID().slice(0, 8)}@${domain}`, true));
  const none = await ssoSignIn(request, origin, identifier);
  expect(message(none.token!.body)).toMatch(/no PassBundle account or invitation/);

  // An account at the verified domain in no organization at all links (its own vault only).
  const solo = await api.account("refuse-solo", `solo-${randomUUID().slice(0, 8)}@${domain}`);
  await tenant.next(await tenant.person(solo.email));
  const soloSignIn = await ssoSignIn(request, origin, identifier);
  expect(soloSignIn.token?.status, JSON.stringify(soloSignIn.token?.body)).toBe(200);
  expect(await api.orgsOf(solo)).toEqual([]);

  // No email at all.
  await tenant.next(await tenant.person(undefined));
  expect(message((await ssoSignIn(request, origin, identifier)).token!.body)).toMatch(/no email address/);

  const log = await events(api, owner, orgId);
  expect(log.filter((e) => e.type === 1591).map((e) => e.keykeeperDetail)).toEqual(
    expect.arrayContaining([
      `${elsewhere.email} isn't a member`,
      `${outside.email} not vouched for (unverified domain, no xms_edov)`,
      "no email in the Microsoft account",
    ]),
  );
});

test("MSP staff are never signed in by a client's single sign-on, and never required to use it", async ({ request }) => {
  const api = new Api(request);
  const domain = newDomain();
  const mspAdmin = await api.account("staff-msp-admin", `admin-${randomUUID().slice(0, 8)}@${domain}`);
  const tech = await api.account("staff-tech", `tech-${randomUUID().slice(0, 8)}@${domain}`);
  const mspId = await api.msp(mspAdmin, `Staff IT ${Date.now()}`);
  const orgId = await api.client(mspAdmin, mspId, `Staff Client ${Date.now()}`, "business");
  await api.addStaff(mspAdmin, mspId, tech, "technician");
  await api.confirmPending(mspAdmin, mspId);

  // The client's single sign-on, set up by the MSP's admin (who may), with
  // the staff's own domain verified and their emails vouched for.
  const tenant = await new Tenant().register();
  const identifier = newIdentifier("staff");
  const saved = await api.call(mspAdmin, "PUT", `/api/keykeeper/organizations/${orgId}/sso`, settings(tenant, identifier));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  await verifyDomain(api, mspAdmin, orgId, domain);
  // A technician (an admin in the client through the MSP) can't open the settings.
  expect((await api.call(tech, "GET", `/api/keykeeper/organizations/${orgId}/sso`)).status).toBe(404);

  for (const staff of [tech, mspAdmin]) {
    await tenant.next(await tenant.person(staff.email, true));
    const refused = await ssoSignIn(request, origin, identifier);
    expect(refused.token?.status).toBe(400);
    expect(message(refused.token!.body)).toMatch(/IT provider staff sign in with their email and master password/);
  }

  // Require single sign-on (the Business preset has Single organization on):
  // the staff still sign in with their passwords.
  const required = await setPolicy(api, mspAdmin, orgId, 4, true);
  expect(required.status, JSON.stringify(required.body)).toBe(200);
  for (const staff of [tech, mspAdmin]) {
    expect((await passwordLogin(request, staff)).status).toBe(200);
  }
});

test("each ID token check refuses the sign-in: issuer, tenant, audience, expiry, signature, nonce, version", async ({ request }) => {
  const api = new Api(request);
  const { owner, orgId, tenant, identifier, domain } = await ssoOrg(api, "tokens");
  const member = await api.account("tokens-member", `cy-${randomUUID().slice(0, 8)}@${domain}`);
  await api.addMember(owner, orgId, member, "user");
  const cy = await tenant.person(member.email);
  const other = new Tenant();
  const now = Math.floor(Date.now() / 1000);

  for (const [tweak, why] of [
    [{ claims: { iss: `http://127.0.0.1:1/${tenant.tenantId}/v2.0` } }, "another issuer"],
    [{ claims: { iss: `http://127.0.0.1:${entraPort}/${other.tenantId}/v2.0` } }, "another issuer"],
    [{ claims: { tid: other.tenantId } }, "another tenant"],
    [{ claims: { aud: other.clientId } }, "another app"],
    [{ claims: { aud: [tenant.clientId, other.clientId] } }, "another app"],
    [{ claims: { exp: now - 3600, nbf: now - 7200, iat: now - 7200 } }, "expired"],
    [{ claims: { nbf: now + 3600 } }, "wasn't valid yet"],
    [{ claims: { iat: now + 3600 } }, "issue time"],
    [{ signWith: "other" as const }, "signature"],
    [{ kid: "a-key-nobody-published" }, "key the tenant doesn't publish"],
    [{ claims: { nonce: null } }, "nonce"],
    [{ claims: { nonce: "someone-elses-sign-in" } }, "nonce"],
    [{ claims: { ver: "1.0" } }, "v2.0"],
    [{ claims: { oid: null } }, "object id"],
  ] as const) {
    await tenant.next(cy, tweak);
    const refused = await ssoSignIn(request, origin, identifier);
    expect(refused.token?.status, `${JSON.stringify(tweak)}: ${JSON.stringify(refused.token?.body)}`).toBe(400);
    expect(message(refused.token!.body), JSON.stringify(tweak)).toContain(why);
    expect(message(refused.token!.body)).toMatch(/didn't check out/);
  }
  // Microsoft's own refusal is passed on, and nobody is signed in.
  await tenant.next(cy, undefined, { error: "access_denied", error_description: "AADSTS50105: The signed in user isn't assigned to a role for the application." });
  const denied = await ssoSignIn(request, origin, identifier);
  expect(message(denied.token!.body)).toMatch(/Microsoft didn't sign you in \(access_denied\)\. AADSTS50105/);

  // After all that, the real thing still works, and the log has each refusal.
  await tenant.next(cy);
  expect((await ssoSignIn(request, origin, identifier)).token?.status).toBe(200);
  const refusals = (await events(api, owner, orgId)).filter((e) => e.type === 1591);
  expect(refusals.length).toBeGreaterThanOrEqual(15);
});

test("a sign-in's state and code work once, only with the app's PKCE verifier, redirect URI, and browser", async ({
  request,
  playwright,
}) => {
  const api = new Api(request);
  const { owner, orgId, tenant, identifier, domain } = await ssoOrg(api, "replay");
  const member = await api.account("replay-member", `dee-${randomUUID().slice(0, 8)}@${domain}`);
  await api.addMember(owner, orgId, member, "user");
  const dee = await tenant.person(member.email);

  // Replayed state: Microsoft's answer is taken once.
  await tenant.next(dee);
  const done = await ssoSignIn(request, origin, identifier);
  expect(done.token?.status).toBe(200);
  const replayed = await request.get(done.callbackUrl!, { maxRedirects: 0 });
  expect(replayed.status()).toBe(400);
  expect(message(await replayed.json())).toMatch(/expired or was already used/);
  // And the code this server gave the app works once.
  const again = await redeem(request, done.code!, done.verifier, `${origin}/sso-connector.html`);
  expect(again.status).toBe(400);

  // The wrong PKCE verifier ends the sign-in; the right one can't use it after.
  await tenant.next(dee);
  const wrongVerifier = await ssoSignIn(request, origin, identifier, { redeemWith: "x".repeat(64) });
  expect(message(wrongVerifier.token!.body)).toMatch(/didn't come from the app that started it/);
  expect((await redeem(request, wrongVerifier.code!, wrongVerifier.verifier, `${origin}/sso-connector.html`)).status).toBe(400);

  // Another redirect URI or client.
  await tenant.next(dee);
  const otherRedirect = await ssoSignIn(request, origin, identifier, { redirectUri: `${origin}/other.html` });
  expect(otherRedirect.token?.status).toBe(400);
  await tenant.next(dee);
  const otherClient = await ssoSignIn(request, origin, identifier);
  expect((await redeem(request, otherClient.code!, otherClient.verifier, `${origin}/sso-connector.html`, "browser")).status).toBe(400);

  // Only the web vault's connector page, and only its clients.
  expect((await request.get(`/identity/connect/authorize?client_id=web&redirect_uri=${encodeURIComponent("https://evil.example.test/cb")}&response_type=code&state=s_identifier=${identifier}&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&domain_hint=${identifier}`, { maxRedirects: 0 })).status()).toBe(400);
  expect((await request.get(`/identity/connect/authorize?client_id=web&redirect_uri=${encodeURIComponent(`${origin}/sso-connector.html`)}&response_type=code&state=s_identifier=${identifier}&code_challenge=${"a".repeat(43)}&code_challenge_method=plain&domain_hint=${identifier}`, { maxRedirects: 0 })).status()).toBe(400);
  expect((await ssoSignIn(request, origin, identifier, { clientId: "desktop" })).authorize).toBe(400);

  // Microsoft's answer in another browser (no binding cookie) is refused, and
  // the sign-in can't be finished in the first one after that.
  await tenant.next(dee);
  const started = await request.get(
    `${origin}/identity/connect/authorize?client_id=web&redirect_uri=${encodeURIComponent(`${origin}/sso-connector.html`)}&response_type=code&scope=api%20offline_access&state=s1_identifier=${identifier}&code_challenge=${"b".repeat(43)}&code_challenge_method=S256&response_mode=query&domain_hint=${identifier}`,
    { maxRedirects: 0 },
  );
  expect(started.status()).toBe(307);
  const atEntra = await request.get(started.headers()["location"], { maxRedirects: 0 });
  const callbackUrl = atEntra.headers()["location"];
  const otherBrowser = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  const elsewhere = await otherBrowser.get(callbackUrl, { maxRedirects: 0 });
  expect(elsewhere.status()).toBe(400);
  expect(message(await elsewhere.json())).toMatch(/started in another browser/);
  await otherBrowser.dispose();
  expect((await request.get(callbackUrl, { maxRedirects: 0 })).status()).toBe(400);
});

test("Require single sign-on: members are sent to it, owners and MSP staff aren't, and its prerequisites stay on", async ({
  request,
}) => {
  const api = new Api(request);
  const { owner, orgId, tenant, identifier, domain } = await ssoOrg(api, "require");
  const member = await api.account("require-member", `eve-${randomUUID().slice(0, 8)}@${domain}`);
  await api.addMember(owner, orgId, member, "user");
  const admin = await api.account("require-admin", `adm-${randomUUID().slice(0, 8)}@${domain}`);
  await api.addMember(owner, orgId, admin, "admin");
  const memberSession = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: member.email,
      password: member.password,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "api-test",
    },
  });
  const refreshToken = (await memberSession.json()).refresh_token;

  // It needs Single organization first.
  const tooSoon = await setPolicy(api, owner, orgId, 4, true);
  expect(tooSoon.status).toBe(400);
  expect(message(tooSoon.body)).toMatch(/Single organization policy/);
  expect((await setPolicy(api, owner, orgId, 3, true)).status).toBe(200);
  const on = await setPolicy(api, owner, orgId, 4, true);
  expect(on.status, JSON.stringify(on.body)).toBe(200);

  // A member's (and the client's own admin's) password sign-in sends them to
  // the organization's single sign-on, by its identifier, once the password
  // checks out. A wrong password says nothing about it.
  for (const who of [member, admin]) {
    const sent = await passwordLogin(request, who);
    expect(sent.status).toBe(400);
    expect(sent.body.SsoOrganizationIdentifier).toBe(identifier);
  }
  const wrong = await passwordLogin(request, { ...member, password: "d3Jvbmc=" });
  expect(wrong.status).toBe(400);
  expect(wrong.body.SsoOrganizationIdentifier).toBeUndefined();
  // The member's existing password session ends at its next refresh.
  const refresh = await request.post("/identity/connect/token", {
    form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: "web" },
  });
  expect(refresh.status()).toBe(400);

  // The owner is never locked out.
  expect((await passwordLogin(request, owner)).status).toBe(200);

  // The member signs in with single sign-on, and that session refreshes.
  await tenant.next(await tenant.person(member.email));
  const signedIn = await ssoSignIn(request, origin, identifier);
  expect(signedIn.token?.status, JSON.stringify(signedIn.token?.body)).toBe(200);
  const ssoRefresh = await request.post("/identity/connect/token", {
    form: { grant_type: "refresh_token", refresh_token: signedIn.token!.body.refresh_token, client_id: "web" },
  });
  expect(ssoRefresh.status(), await ssoRefresh.text()).toBe(200);

  // Its prerequisites can't be turned off under it.
  const singleOff = await setPolicy(api, owner, orgId, 3, false);
  expect(message(singleOff.body)).toMatch(/Turn off Require single sign-on before/);
  const ssoOff = await api.call(owner, "PUT", `/api/keykeeper/organizations/${orgId}/sso`, settings(tenant, identifier, false, false));
  expect(message(ssoOff.body)).toMatch(/Turn off the Require single sign-on policy first/);

  // Off again: passwords work.
  expect((await setPolicy(api, owner, orgId, 4, false)).status).toBe(200);
  expect((await passwordLogin(request, member)).status).toBe(200);
  const view = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/sso`);
  expect(view.body).toMatchObject({ requireSso: false, singleOrg: true });
});

test("someone invited without an account signs in with single sign-on, then sets a master password and joins", async ({
  request,
}) => {
  const api = new Api(request);
  const { owner, orgId, tenant, identifier, domain } = await ssoOrg(api, "invited");
  const email = `fay-${randomUUID().slice(0, 8)}@${domain}`;
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);

  await tenant.next(await tenant.person(email));
  const signedIn = await ssoSignIn(request, origin, identifier);
  expect(signedIn.token?.status, JSON.stringify(signedIn.token?.body)).toBe(200);
  // No master password yet: the web vault asks for one (upstream's first single sign-on).
  expect(signedIn.token!.body.UserDecryptionOptions.HasMasterPassword).toBe(false);
  const token = signedIn.token!.body.access_token;

  // The identifier names the organization, and setting the password joins it.
  const status = await api.call({ token }, "GET", `/api/organizations/${identifier}/auto-enroll-status`);
  expect(status.body.id).toBe(orgId);
  const set = await api.call({ token }, "POST", "/api/accounts/set-password", {
    masterPasswordHash: Buffer.from(`hash-${email}`).toString("base64"),
    key: encString(`user-key-${email}`),
    masterPasswordHint: null,
    orgIdentifier: identifier,
    keys: { publicKey: publicKey(email), encryptedPrivateKey: encString(`private-key-${email}`) },
    kdf: 0,
    kdfIterations: 600000,
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const member = (await api.members(owner, orgId)).find((m) => m.email === email)!;
  expect(member.status).toBeGreaterThanOrEqual(1);
  expect(member.status).toBeLessThanOrEqual(CONFIRMED);
});

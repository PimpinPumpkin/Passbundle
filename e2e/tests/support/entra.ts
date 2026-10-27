// Helpers for single sign-on tests: setting up the local stand-in for
// Microsoft Entra ID (e2e/entra-standin.mjs), and signing in the way the web
// vault does, step by step over HTTP. See DESIGN.md, "Sign in with Microsoft
// Entra ID".
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { type APIRequestContext, expect } from "@playwright/test";

import type { Account, Api } from "../api/support";

import { entraPort } from "../../paths.mjs";

const standIn = `http://127.0.0.1:${entraPort}`;

async function control(path: string, body: unknown) {
  const response = await fetch(`${standIn}/control/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

export type Person = { oid: string; email?: string; name?: string; edov?: boolean };

/** Claims the stand-in changes in the next ID token (null removes one). */
export type Tweak = { claims?: Record<string, unknown>; signWith?: "other"; kid?: string };

/** A tenant with its app registration: a new one per test, so tests never share. */
export class Tenant {
  readonly tenantId = randomUUID();
  readonly clientId = randomUUID();
  readonly clientSecret = `${randomBytes(3).toString("hex")}~${randomBytes(24).toString("base64url")}`;

  async register() {
    await control("tenant", { tenantId: this.tenantId, clientId: this.clientId, clientSecret: this.clientSecret });
    return this;
  }

  /** Someone in the tenant's directory, with a new object id. */
  async person(email?: string, edov?: boolean, name?: string): Promise<Person> {
    const person = { oid: randomUUID(), email, edov, name };
    await control("user", { tenantId: this.tenantId, ...person });
    return person;
  }

  /** Who the next sign-in at this tenant is, and anything to change. */
  async next(person: Person, tweak?: Tweak, error?: { error: string; error_description?: string }) {
    await control("next", { tenantId: this.tenantId, oid: person.oid, tweak, error });
  }
}

/** Sets a domain's TXT records in the stand-in's DNS (none removes them). */
export async function setTxt(name: string, values: string[]) {
  await control("dns", { name, values });
}

/** What the server sent the stand-in's token endpoint. */
export async function tokenRequests(): Promise<
  { tenantId: string; clientId: string; secretOk: boolean; verifierOk: boolean; codeKnown: boolean; redirectUri: string }[]
> {
  const response = await fetch(`${standIn}/control/log`);
  return (await response.json()).tokenRequests;
}

/** The settings an owner saves for an organization's single sign-on. */
export function settings(tenant: Tenant, identifier: string, enabled = true, withSecret = true) {
  return {
    enabled,
    identifier,
    tenantId: tenant.tenantId,
    clientId: tenant.clientId,
    clientSecret: withSecret ? tenant.clientSecret : null,
  };
}

const b64url = (b: Buffer) => b.toString("base64url");

/** A PKCE pair, as the web vault makes one. */
export function pkce() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export type SignIn = {
  /** Each step's status, for tests that stop early. */
  authorize: number;
  callback?: number;
  callbackBody?: unknown;
  /** The connector URL the server sent the browser back to. */
  returned?: URL;
  /** The answer to the token request: tokens, or why not. */
  token?: { status: number; body: any };
  /** For replay tests. */
  callbackUrl?: string;
  code?: string;
  verifier: string;
};

/**
 * Signs in with an organization's single sign-on as the web vault does:
 * authorize, the stand-in's answer, this server's callback, then the token
 * request with the PKCE verifier. `origin` is the test server's own address.
 */
export async function ssoSignIn(
  request: APIRequestContext,
  origin: string,
  identifier: string,
  options: { verifier?: string; redeemWith?: string; redirectUri?: string; clientId?: string } = {},
): Promise<SignIn> {
  const { verifier, challenge } = pkce();
  const connector = `${origin}/sso-connector.html`;
  const state = `${b64url(randomBytes(24))}_identifier=${identifier}`;
  const authorizeUrl =
    `${origin}/identity/connect/authorize?client_id=${options.clientId ?? "web"}` +
    `&redirect_uri=${encodeURIComponent(connector)}&response_type=code&scope=api%20offline_access` +
    `&state=${encodeURIComponent(state)}&code_challenge=${challenge}&code_challenge_method=S256` +
    `&response_mode=query&domain_hint=${encodeURIComponent(identifier)}&ssoToken=`;
  const authorize = await request.get(authorizeUrl, { maxRedirects: 0 });
  const result: SignIn = { authorize: authorize.status(), verifier };
  if (authorize.status() !== 307) {
    return result;
  }
  const atEntra = await request.get(authorize.headers()["location"], { maxRedirects: 0 });
  expect(atEntra.status(), await atEntra.text()).toBe(302);
  const callbackUrl = atEntra.headers()["location"];
  result.callbackUrl = callbackUrl;
  const callback = await request.get(callbackUrl, { maxRedirects: 0 });
  result.callback = callback.status();
  if (callback.status() !== 307) {
    result.callbackBody = await callback.json().catch(() => null);
    return result;
  }
  const returned = new URL(callback.headers()["location"]);
  result.returned = returned;
  expect(returned.origin + returned.pathname).toBe(connector);
  expect(returned.searchParams.get("state")).toBe(state);
  result.code = returned.searchParams.get("code")!;
  result.token = await redeem(request, result.code, options.redeemWith ?? verifier, options.redirectUri ?? connector, options.clientId);
  return result;
}

export type LinkResult = {
  /** The status of the step it ended at: 200 once linked, or the refusal's. */
  status: number;
  body: any;
  /** Where authorize sent the browser (to Microsoft, for linking). */
  atMicrosoft?: URL;
  /** The pending link's code, once Microsoft answered. */
  code?: string;
  /** What the web vault's linking page shows before confirming. */
  pending?: { status: number; body: any };
};

/**
 * Links an account to an organization's single sign-on, as the web vault's
 * Link SSO does: a ticket for the session (proving the master password, or
 * none for a linking session), then authorize with it as `user_identifier`
 * from the same browser, Microsoft (the stand-in, whose next sign-in the
 * caller queued), the callback, which holds the link, and the session's
 * confirmation on the linking page. `browser` finishes from another request
 * context (another browser); `confirmAs` confirms with another token.
 */
export async function linkFromSession(
  request: APIRequestContext,
  origin: string,
  as: { token: string; password?: string | null },
  identifier: string,
  options: { browser?: APIRequestContext; confirm?: boolean; confirmAs?: string } = {},
): Promise<LinkResult> {
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const ticket = await request.post(`${origin}/api/accounts/sso/user-identifier`, {
    headers: auth(as.token),
    data: as.password ? { masterPasswordHash: as.password } : {},
  });
  if (ticket.status() !== 200) {
    return { status: ticket.status(), body: await ticket.json().catch(() => null) };
  }
  const userIdentifier = (await ticket.json()) as string;
  const browser = options.browser ?? request;
  const { challenge } = pkce();
  const state = `${b64url(randomBytes(24))}_identifier=${identifier}`;
  const authorize = await browser.get(
    `${origin}/identity/connect/authorize?client_id=web&redirect_uri=${encodeURIComponent(`${origin}/sso-connector.html`)}` +
      `&response_type=code&scope=api%20offline_access&state=${encodeURIComponent(state)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&response_mode=query&domain_hint=${encodeURIComponent(identifier)}&ssoToken=` +
      `&user_identifier=${encodeURIComponent(userIdentifier)}`,
    { maxRedirects: 0 },
  );
  if (authorize.status() !== 307) {
    return { status: authorize.status(), body: await authorize.json().catch(() => null) };
  }
  const atMicrosoft = new URL(authorize.headers()["location"]);
  const atEntra = await browser.get(atMicrosoft.toString(), { maxRedirects: 0 });
  expect(atEntra.status(), await atEntra.text()).toBe(302);
  const callback = await browser.get(atEntra.headers()["location"], { maxRedirects: 0 });
  if (callback.status() !== 307) {
    return { status: callback.status(), body: await callback.json().catch(() => null), atMicrosoft };
  }
  // Back to the web vault's linking page with the pending link's code.
  const back = callback.headers()["location"];
  expect(back.startsWith(`${origin}/#/sso-link?code=`), back).toBe(true);
  const code = new URLSearchParams(back.slice(back.indexOf("?") + 1)).get("code")!;
  const confirmer = options.confirmAs ?? as.token;
  const pendingResponse = await request.post(`${origin}/api/accounts/sso/link/pending`, {
    headers: auth(confirmer),
    data: { code },
  });
  const pending = { status: pendingResponse.status(), body: await pendingResponse.json().catch(() => null) };
  if (options.confirm === false) {
    return { status: pending.status, body: pending.body, atMicrosoft, code, pending };
  }
  const confirmed = await request.post(`${origin}/api/accounts/sso/link/confirm`, {
    headers: auth(confirmer),
    data: { code },
  });
  return {
    status: confirmed.status(),
    body: await confirmed.json().catch(() => null),
    atMicrosoft,
    code,
    pending,
  };
}

/** Confirms a pending link (the linking page's button) as someone. */
export async function confirmLink(request: APIRequestContext, origin: string, token: string, code: string) {
  const response = await request.post(`${origin}/api/accounts/sso/link/confirm`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { code },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

/** The web vault's token request for a sign-in's code. */
export async function redeem(
  request: APIRequestContext,
  code: string,
  verifier: string,
  redirectUri: string,
  clientId = "web",
  extra: Record<string, string> = {},
) {
  const response = await request.post("/identity/connect/token", {
    form: {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      scope: "api offline_access",
      client_id: clientId,
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "sso-test",
      ...extra,
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: response.status(), body: body as any };
}

/** The message a refused request carries. */
export function message(body: any): string {
  return body?.message ?? body?.ErrorModel?.Message ?? body?.error_description ?? JSON.stringify(body);
}

/** A new email domain, so tests never share one. */
export const newDomain = () => `d${randomBytes(4).toString("hex")}.example.test`;
export const newIdentifier = (name: string) => `${name}-${randomBytes(3).toString("hex")}`;

/** An organization with its single sign-on on, an owner, and a verified domain. */
export async function ssoOrg(api: Api, name: string, options: { domain?: boolean } = {}) {
  const domain = newDomain();
  const owner = await api.account(`${name}-owner`, `owner-${randomUUID().slice(0, 8)}@${domain}`);
  const orgId = await api.organization(owner, `${name} ${Date.now()}`);
  const tenant = await new Tenant().register();
  const identifier = newIdentifier(name);
  const saved = await api.call(owner, "PUT", `/api/keykeeper/organizations/${orgId}/sso`, settings(tenant, identifier));
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  if (options.domain !== false) {
    await verifyDomain(api, owner, orgId, domain);
  }
  return { owner, orgId, tenant, identifier, domain };
}

export async function verifyDomain(api: Api, owner: Account, orgId: string, domain: string) {
  const added = await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/sso/domains`, { domain });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const row = added.body.domains.find((d: { domain: string }) => d.domain === domain);
  await setTxt(row.txtName, [row.txtValue]);
  const checked = await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/sso/domains/${row.id}/verify`);
  expect(checked.status, JSON.stringify(checked.body)).toBe(200);
  expect(checked.body.check.found).toBe(true);
  return row.id as string;
}

// A stand-in for Microsoft Entra ID's sign-in, for single sign-on tests: a
// small OpenID provider that answers at Entra's per-tenant v2.0 paths, and a
// DNS server for domain checks. The test servers point at it
// (SSO_ENTRA_AUTHORITY, SSO_DOMAIN_DNS_SERVER), so no test reaches Microsoft
// or the internet. Signing keys are made when it starts. Behaves as
// Microsoft's public docs describe ("OpenID Connect on the Microsoft identity
// platform", "ID token claims reference"): tenant-specific issuer, `tid`,
// `oid`, `nonce`, PKCE, client secrets checked at the token endpoint, codes
// used once. Tests set it up through /control. No dependencies.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";

import { dnsPort, entraPort } from "./paths.mjs";

const base = `http://127.0.0.1:${entraPort}`;
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid: b64url(randomBytes(12)), privateKey, jwk: publicKey.export({ format: "jwk" }) };
}
const key = makeKey();
// Someone else's key, for tokens that claim the tenant's key id.
const otherKey = makeKey();

/** tenantId -> { clientId, clientSecret, users: Map<oid, user>, next: [] } */
const tenants = new Map();
/** Pending authorizations and issued codes. */
const requests = new Map();
const codes = new Map();
/** Every token request, for tests that check what the server sent. */
const tokenLog = [];
/** DNS name (lowercase, no trailing dot) -> TXT values. */
const txt = new Map();

function reset() {
  tenants.clear();
  requests.clear();
  codes.clear();
  tokenLog.length = 0;
  txt.clear();
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function signJwt(header, claims, privateKey) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(sign("sha256", Buffer.from(input), privateKey))}`;
}

/** The ID token for a sign-in, with a test's changes. */
function idToken(tenantId, tenant, grant) {
  const now = Math.floor(Date.now() / 1000);
  const user = grant.user;
  const claims = {
    aud: tenant.clientId,
    iss: `${base}/${tenantId}/v2.0`,
    iat: now,
    nbf: now,
    exp: now + 3600,
    name: user.name ?? user.email ?? "Test person",
    nonce: grant.nonce,
    oid: user.oid,
    preferred_username: user.email ?? `${user.oid}@${tenantId}.test`,
    sub: b64url(createHash("sha256").update(`${user.oid}:${tenant.clientId}`).digest()).slice(0, 43),
    tid: tenantId,
    ver: "2.0",
  };
  if (user.email) claims.email = user.email;
  if (user.edov !== undefined) claims.xms_edov = user.edov;
  for (const [k, v] of Object.entries(grant.tweak?.claims ?? {})) {
    if (v === null) delete claims[k];
    else claims[k] = v;
  }
  const signer = grant.tweak?.signWith === "other" ? otherKey : key;
  return signJwt({ typ: "JWT", alg: "RS256", kid: grant.tweak?.kid ?? key.kid }, claims, signer.privateKey);
}

function redirectWith(res, redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}

function approve(res, request, user, extra = {}) {
  requests.delete(request.id);
  if (extra.error) {
    redirectWith(res, request.redirectUri, { error: extra.error.error, error_description: extra.error.error_description ?? "", state: request.state });
    return;
  }
  const code = b64url(randomBytes(32));
  codes.set(code, { ...request, user, tweak: extra.tweak });
  redirectWith(res, request.redirectUri, { code, state: request.state });
}

async function handle(req, res) {
  const url = new URL(req.url, base);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/alive") return json(res, 200, { ok: true });

  // Tests set the stand-in up here.
  if (parts[0] === "control") {
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    switch (parts[1]) {
      case "reset":
        reset();
        return json(res, 200, {});
      case "tenant":
        tenants.set(body.tenantId, {
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          users: new Map(),
          next: [],
        });
        return json(res, 200, {});
      case "user": {
        const t = tenants.get(body.tenantId);
        if (!t) return json(res, 404, { error: "no such tenant" });
        t.users.set(body.oid, { oid: body.oid, email: body.email, name: body.name, edov: body.edov });
        return json(res, 200, {});
      }
      case "next": {
        // The next sign-in at this tenant: who (an oid), and what to change.
        const t = tenants.get(body.tenantId);
        if (!t) return json(res, 404, { error: "no such tenant" });
        t.next.push({ oid: body.oid, tweak: body.tweak, error: body.error });
        return json(res, 200, {});
      }
      case "dns":
        if (body.values?.length) txt.set(body.name.toLowerCase(), body.values);
        else txt.delete(body.name.toLowerCase());
        return json(res, 200, {});
      case "log":
        return json(res, 200, { tokenRequests: tokenLog });
      default:
        return json(res, 404, { error: "unknown control" });
    }
  }

  const [tenantId, ...rest] = parts;
  const tenant = tenants.get(tenantId);
  const path = rest.join("/");

  if (path === "v2.0/.well-known/openid-configuration") {
    if (!tenant) {
      return json(res, 400, {
        error: "invalid_tenant",
        error_description: `AADSTS90002: Tenant '${tenantId}' not found.`,
      });
    }
    return json(res, 200, {
      issuer: `${base}/${tenantId}/v2.0`,
      authorization_endpoint: `${base}/${tenantId}/oauth2/v2.0/authorize`,
      token_endpoint: `${base}/${tenantId}/oauth2/v2.0/token`,
      jwks_uri: `${base}/${tenantId}/discovery/v2.0/keys`,
      userinfo_endpoint: `${base}/oidc/userinfo`,
      response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
      response_modes_supported: ["query", "fragment", "form_post"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt", "client_secret_basic"],
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "nonce", "name", "tid", "ver", "oid", "email", "preferred_username"],
      code_challenge_methods_supported: ["plain", "S256"],
    });
  }

  if (path === "discovery/v2.0/keys") {
    if (!tenant) return json(res, 400, { error: "invalid_tenant" });
    return json(res, 200, { keys: [{ kty: "RSA", use: "sig", kid: key.kid, x5t: key.kid, n: key.jwk.n, e: key.jwk.e }] });
  }

  if (path === "oauth2/v2.0/authorize") {
    const q = Object.fromEntries(url.searchParams);
    if (!tenant || q.client_id !== tenant.clientId) {
      res.writeHead(400, { "Content-Type": "text/html" });
      return res.end(`<h1>AADSTS700016: Application with identifier '${escape(q.client_id)}' was not found in the directory.</h1>`);
    }
    const problem =
      q.response_type !== "code"
        ? "unsupported_response_type"
        : !q.scope?.split(" ").includes("openid")
          ? "invalid_scope"
          : !q.nonce || !q.state || !q.redirect_uri
            ? "invalid_request"
            : q.code_challenge_method !== "S256" || !q.code_challenge
              ? "invalid_request"
              : null;
    if (problem) return redirectWith(res, q.redirect_uri, { error: problem, state: q.state ?? "" });
    const request = {
      id: randomUUID(),
      tenantId,
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      state: q.state,
      nonce: q.nonce,
      codeChallenge: q.code_challenge,
      scope: q.scope,
    };
    requests.set(request.id, request);
    const next = tenant.next.shift();
    if (next) {
      const user = tenant.users.get(next.oid) ?? { oid: next.oid };
      return approve(res, request, user, next);
    }
    // Nobody queued: an account picker, like Entra's.
    res.writeHead(200, { "Content-Type": "text/html" });
    const buttons = [...tenant.users.values()]
      .map(
        (u) =>
          `<li><a href="/${tenantId}/oauth2/v2.0/approve?request=${request.id}&amp;oid=${u.oid}">Sign in as ${escape(u.email ?? u.oid)}</a></li>`,
      )
      .join("");
    return res.end(
      `<!doctype html><title>Test sign-in</title><h1>Test sign-in (a stand-in for Microsoft Entra ID)</h1><ul>${buttons}</ul>`,
    );
  }

  if (path === "oauth2/v2.0/approve") {
    const request = requests.get(url.searchParams.get("request"));
    const user = tenant?.users.get(url.searchParams.get("oid"));
    if (!request || !user) return json(res, 400, { error: "no such request" });
    return approve(res, request, user);
  }

  if (path === "oauth2/v2.0/token" && req.method === "POST") {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const grant = codes.get(form.code);
    const entry = {
      tenantId,
      clientId: form.client_id,
      secretOk: !!tenant && form.client_secret === tenant.clientSecret,
      verifierOk:
        !!grant && b64url(createHash("sha256").update(form.code_verifier ?? "").digest()) === grant.codeChallenge,
      codeKnown: !!grant,
      redirectUri: form.redirect_uri,
    };
    tokenLog.push(entry);
    if (!tenant || form.client_id !== tenant.clientId || !entry.secretOk) {
      return json(res, 401, {
        error: "invalid_client",
        error_description: "AADSTS7000215: Invalid client secret provided.",
      });
    }
    if (form.grant_type !== "authorization_code" || !grant || grant.tenantId !== tenantId) {
      return json(res, 400, { error: "invalid_grant", error_description: "AADSTS54005: OAuth2 Authorization code was already redeemed." });
    }
    codes.delete(form.code);
    if (form.redirect_uri !== grant.redirectUri || !entry.verifierOk) {
      return json(res, 400, { error: "invalid_grant", error_description: "AADSTS501481: The Code_Verifier does not match the code_challenge." });
    }
    return json(res, 200, {
      token_type: "Bearer",
      scope: grant.scope,
      expires_in: 3600,
      access_token: b64url(randomBytes(32)),
      id_token: idToken(tenantId, tenant, grant),
    });
  }

  return json(res, 404, { error: "not found" });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => json(res, 500, { error: String(e) }));
  })
  .listen(Number(entraPort), "127.0.0.1");

// DNS: answers TXT questions from what tests set, and nothing else.
function readName(msg, offset) {
  const labels = [];
  for (;;) {
    const len = msg[offset];
    if (len === 0) return { name: labels.join("."), end: offset + 1 };
    labels.push(msg.subarray(offset + 1, offset + 1 + len).toString("latin1"));
    offset += len + 1;
  }
}

const dns = dgram.createSocket("udp4");
dns.on("message", (msg, rinfo) => {
  if (msg.length < 12) return;
  const { name, end } = readName(msg, 12);
  const qtype = msg.readUInt16BE(end);
  const question = msg.subarray(12, end + 4);
  const values = qtype === 16 ? (txt.get(name.toLowerCase().replace(/\.$/, "")) ?? []) : [];
  const known = [...txt.keys()].includes(name.toLowerCase().replace(/\.$/, ""));
  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2);
  // QR, the query's opcode and RD, AA, RA; NXDOMAIN for names nobody set.
  header.writeUInt16BE(0x8000 | (msg.readUInt16BE(2) & 0x7900) | 0x0400 | 0x0080 | (known ? 0 : 3), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(values.length, 6);
  const answers = values.map((value) => {
    const bytes = Buffer.from(value, "utf8");
    const strings = [];
    for (let i = 0; i < bytes.length; i += 255) {
      const chunk = bytes.subarray(i, i + 255);
      strings.push(Buffer.from([chunk.length]), chunk);
    }
    const rdata = Buffer.concat(strings);
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(16, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(0, 6);
    rr.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([rr, rdata]);
  });
  dns.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);
});
dns.bind(Number(dnsPort), "127.0.0.1");

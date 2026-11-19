// A site with passkeys whose checks we didn't write (DESIGN.md, "Passkeys"):
// Harbor Books, at https://www.harbor-books.test with the RP ID
// harbor-books.test, as a site that signs people in at www. but names its
// passkeys for the whole domain does. Its server is SimpleWebAuthn's
// @simplewebauthn/server and its page uses @simplewebauthn/browser, each at
// the version e2e/package-lock.json pins, called the way their docs show:
// generateRegistrationOptions, then startRegistration in the page, then
// verifyRegistrationResponse; generateAuthenticationOptions, then
// startAuthentication, then verifyAuthenticationResponse, which checks the
// signature with the public key kept at registration and the counter.
//
// It runs in the test's own process, over HTTPS with a certificate from a
// certificate authority the test makes (makeCertificates), which only the
// test's Chrome trusts (by its key, with --ignore-certificate-errors-spki-list).
// The page reads what to ask for from its address:
//
//   ?account=ana@harbor-books.test  the account (a site's signed-in user)
//   &ask=required                   residentKey and userVerification "required";
//                                   otherwise the library's defaults
//   &exclude=1                      registration names the account's passkeys
//                                   (excludeCredentials)
//   &allow=1                        sign-in names them (allowCredentials);
//                                   otherwise it's discoverable
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

const require = createRequire(import.meta.url);

export const siteHost = "www.harbor-books.test";
export const rpID = "harbor-books.test";
export const rpName = "Harbor Books";
export const origin = `https://${siteHost}`;

/** The library's browser bundle (next to its script/ entry point), served to the page as a site would serve it. */
const browserBundle = path.join(
  path.dirname(require.resolve("@simplewebauthn/browser")),
  "..",
  "dist/bundle/index.umd.min.js",
);

/** A key's SHA-256, base64: what --ignore-certificate-errors-spki-list takes. */
export function spkiHash(certificate) {
  const spki = new crypto.X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spki).digest("base64");
}

/**
 * A throwaway certificate authority, made in `dir`, and the site's
 * certificate from it, for its host name only. Nothing trusts the
 * authority but a browser told its key's hash.
 */
export function makeCertificates(dir) {
  const file = (name) => path.join(dir, name);
  const openssl = (...args) => execFileSync("openssl", args, { stdio: "pipe" });
  openssl(
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", file("ca-key.pem"), "-out", file("ca.pem"),
    "-subj", "/CN=Harbor Books test CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  );
  openssl(
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", file("site-key.pem"), "-out", file("site.csr"),
    "-subj", `/CN=${siteHost}`,
  );
  fs.writeFileSync(
    file("site.ext"),
    [
      `subjectAltName=DNS:${siteHost}`,
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
    ].join("\n"),
  );
  openssl(
    "x509", "-req", "-in", file("site.csr"), "-days", "2", "-sha256",
    "-CA", file("ca.pem"), "-CAkey", file("ca-key.pem"), "-set_serial", `0x${crypto.randomBytes(8).toString("hex")}`,
    "-extfile", file("site.ext"), "-out", file("site.pem"),
  );
  const ca = fs.readFileSync(file("ca.pem"), "utf8");
  return {
    ca,
    // The site sends its own certificate, then the authority's, as a site sends its chain.
    chain: fs.readFileSync(file("site.pem"), "utf8") + ca,
    key: fs.readFileSync(file("site-key.pem"), "utf8"),
  };
}

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Harbor Books</title>
  <script src="/simplewebauthn-browser.js"></script>
</head>
<body>
  <h1>Harbor Books</h1>
  <button id="register">Add a passkey</button>
  <button id="signin">Sign in with a passkey</button>
  <p id="result" role="status"></p>
  <script>
    const { startRegistration, startAuthentication } = SimpleWebAuthnBrowser;
    const asked = new URLSearchParams(location.search);
    const say = (text) => (document.getElementById("result").textContent = text);
    const post = async (where, body) => {
      const answer = await fetch(where, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return answer.json();
    };
    // The library's errors carry WebAuthn's name and, where it can tell, a code of its own.
    const why = (e) => [e.name, e.code, e.message].filter(Boolean).join(" ");
    document.getElementById("register").onclick = async () => {
      try {
        const { ceremony, optionsJSON } = await post("/register/options", {
          account: asked.get("account"),
          ask: asked.get("ask"),
          exclude: asked.get("exclude") === "1",
        });
        const response = await startRegistration({ optionsJSON });
        const verified = await post("/register/verify", { ceremony, response });
        say(verified.ok ? "Passkey added" : "The site refused the passkey: " + verified.error);
      } catch (e) {
        say("Couldn't add a passkey: " + why(e));
      }
    };
    document.getElementById("signin").onclick = async () => {
      try {
        const { ceremony, optionsJSON } = await post("/login/options", {
          account: asked.get("allow") === "1" ? asked.get("account") : null,
          ask: asked.get("ask"),
        });
        const response = await startAuthentication({ optionsJSON });
        const verified = await post("/login/verify", { ceremony, response });
        say(verified.ok ? "Signed in as " + verified.account : "The site refused the sign-in: " + verified.error);
      } catch (e) {
        say("Couldn't sign in: " + why(e));
      }
    };
  </script>
</body>
</html>
`;

/**
 * Starts the site on 127.0.0.1:port. What its server keeps (accounts, their
 * passkeys, each verification's result) is in `accounts` and `verifications`,
 * for the test to read as the site's database.
 */
export async function startRelyingParty({ port, chain, key }) {
  /** account name -> { webauthnUserID, credentials: [{ id, publicKey, counter, transports }] } */
  const accounts = new Map();
  /** Each verification the site's server made, in order, with the library's answer. */
  const verifications = [];
  /** ceremony id -> what the site expects back: the challenge, and the account and ask, if any. */
  const ceremonies = new Map();

  const ask = (body) => (body.ask === "required" ? "required" : "defaults");

  const routes = {
    "/register/options": async (body) => {
      const account = accounts.get(body.account) ?? { webauthnUserID: undefined, credentials: [] };
      const optionsJSON = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: body.account,
        // The library makes a user ID the first time; the site keeps it with
        // the account (its docs' webauthnUserID) and gives it back after.
        ...(account.webauthnUserID ? { userID: Buffer.from(account.webauthnUserID, "base64url") } : {}),
        ...(body.exclude
          ? { excludeCredentials: account.credentials.map(({ id, transports }) => ({ id, transports })) }
          : {}),
        ...(ask(body) === "required"
          ? { authenticatorSelection: { residentKey: "required", userVerification: "required" } }
          : {}),
      });
      const ceremony = crypto.randomUUID();
      ceremonies.set(ceremony, {
        challenge: optionsJSON.challenge,
        account: body.account,
        userID: optionsJSON.user.id,
      });
      return { ceremony, optionsJSON };
    },
    "/register/verify": async (body) => {
      const expected = ceremonies.get(body.ceremony);
      ceremonies.delete(body.ceremony);
      const verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: expected.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
      verifications.push({ kind: "registration", verification });
      if (!verification.verified) return { ok: false, error: "not verified" };
      const { credential } = verification.registrationInfo;
      const account = accounts.get(expected.account) ?? { webauthnUserID: expected.userID, credentials: [] };
      account.credentials.push({ ...credential });
      accounts.set(expected.account, account);
      return { ok: true };
    },
    "/login/options": async (body) => {
      const named = body.account ? accounts.get(body.account) : null;
      const optionsJSON = await generateAuthenticationOptions({
        rpID,
        ...(named
          ? { allowCredentials: named.credentials.map(({ id, transports }) => ({ id, transports })) }
          : {}),
        ...(ask(body) === "required" ? { userVerification: "required" } : {}),
      });
      const ceremony = crypto.randomUUID();
      ceremonies.set(ceremony, { challenge: optionsJSON.challenge, account: body.account });
      return { ceremony, optionsJSON };
    },
    "/login/verify": async (body) => {
      const expected = ceremonies.get(body.ceremony);
      ceremonies.delete(body.ceremony);
      // Whose passkey: by the credential's ID, among the account named, or,
      // for a discoverable one, the account whose user ID came back.
      const found = [...accounts].find(
        ([name, account]) =>
          (expected.account
            ? name === expected.account
            : account.webauthnUserID === body.response.response.userHandle) &&
          account.credentials.some((c) => c.id === body.response.id),
      );
      if (!found) throw new Error("no such passkey");
      const [name, account] = found;
      const credential = account.credentials.find((c) => c.id === body.response.id);
      const verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: expected.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential,
      });
      verifications.push({ kind: "authentication", verification });
      if (!verification.verified) return { ok: false, error: "not verified" };
      credential.counter = verification.authenticationInfo.newCounter;
      return { ok: true, account: name };
    },
  };

  const server = https.createServer({ cert: chain, key }, (req, res) => {
    const where = new URL(req.url, origin).pathname;
    if (req.method === "GET" && where === "/") {
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    }
    if (req.method === "GET" && where === "/simplewebauthn-browser.js") {
      return res.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(browserBundle));
    }
    const route = routes[where];
    if (req.method !== "POST" || !route) return res.writeHead(404).end("not found");
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (text += chunk));
    req.on("end", async () => {
      let answer;
      try {
        answer = await route(JSON.parse(text));
      } catch (error) {
        // A refusal: the library's, in its words, or the site's own.
        answer = { ok: false, error: String(error?.message ?? error) };
        verifications.push({ kind: where, error: answer.error });
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise((resolve) => server.listen(Number(port), "127.0.0.1", resolve));
  return {
    accounts,
    verifications,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

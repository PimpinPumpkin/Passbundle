// Makes docs/vectors/sso-client-secret-v1.json
// (node docs/vectors/make-sso-client-secret-v1.mjs > docs/vectors/sso-client-secret-v1.json):
// fixed inputs and what the server must compute from them to keep an
// organization's single sign-on client secret at rest (DESIGN.md, "Sign in
// with Microsoft Entra ID", "The client secret"). It's sealed the way event
// streaming seals its destinations' secrets (event-streaming-secrets-v1.json),
// but under a key of its own, derived over another label, and bound to the
// organization, so neither feature's ciphertexts open as the other's. Uses
// only Node's crypto, independently of the server's code (ring and OpenSSL),
// whose unit tests check their own results against a copy of the file
// (passbundle-server, src/api/core/keykeeper_sso/vectors/sso-client-secret-v1.json).
//
// The RSA key is event streaming's vectors' key, made for vectors only; it
// protects nothing. The plaintexts aren't real client secrets.
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

const streaming = JSON.parse(readFileSync(new URL("./event-streaming-secrets-v1.json", import.meta.url), "utf8"));

const label = "passbundle sso client secrets v1";
// From the RSA key's PKCS#1 DER, as event streaming's key is.
const der = createPrivateKey(streaming.rsaPkcs1Pem).export({ type: "pkcs1", format: "der" });
const deriveKey = (l) => createHmac("sha256", der).update(l, "utf8").digest();
const key = deriveKey(label);
const streamingKey = deriveKey(streaming.label);
if (streamingKey.toString("hex") !== streaming.key || key.equals(streamingKey)) {
  throw new Error("Event streaming's key must be its vectors' key, and differ from this one");
}

/** An organization's client secret is bound to it, with its own kind. */
const kind = "entra-sso-client-secret";
const binding = (organization) => ({ id: organization, owner: organization, kind });
/** The associated data event streaming's module writes for a binding. */
const aad = ({ id, owner, kind }) => Buffer.from(`event destination ${id}\u0000owner ${owner}\u0000kind ${kind}`, "utf8");

/** "v1." and base64 of nonce, ciphertext, and the 16-byte tag. */
function seal(k, b, nonce, plaintext) {
  const cipher = createCipheriv("aes-256-gcm", k, nonce);
  cipher.setAAD(aad(b));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([nonce, data, cipher.getAuthTag()]).toString("base64")}`;
}

/** Whether a ciphertext opens with this key and binding. */
function opens(k, b, sealed) {
  const bytes = Buffer.from(sealed.slice("v1.".length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", k, bytes.subarray(0, 12));
  decipher.setAAD(aad(b));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  try {
    decipher.update(bytes.subarray(12, bytes.length - 16));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

// The first organization is event streaming's vectors' owner, on purpose.
const organization = streaming.cases[0].binding.owner;
const cases = [
  {
    organization,
    nonce: Buffer.from("a0a1a2a3a4a5a6a7a8a9aaab", "hex"),
    plaintext: "not-a-real-secret.vector-1",
  },
  {
    organization: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    nonce: Buffer.from("0f0e0d0c0b0a090807060504", "hex"),
    plaintext: "not.a~real_secret-2",
  },
];
const sealed = cases.map((c) => seal(key, binding(c.organization), c.nonce, c.plaintext));

// The same plaintext and binding sealed with event streaming's key: a
// ciphertext event streaming's module could have made, which must not open
// as this organization's client secret.
const streamingSealed = seal(streamingKey, binding(organization), cases[0].nonce, cases[0].plaintext);

const wrongOrganizations = ["0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e", cases[1].organization];
if (
  !opens(key, binding(organization), sealed[0]) ||
  !opens(streamingKey, binding(organization), streamingSealed) ||
  wrongOrganizations.some((o) => opens(key, binding(o), sealed[0])) ||
  opens(key, binding(organization), streamingSealed) ||
  opens(streamingKey, binding(organization), sealed[0]) ||
  opens(key, streaming.cases[0].binding, streaming.cases[0].sealed)
) {
  throw new Error("A ciphertext opened where it mustn't, or didn't where it must");
}

const vectors = {
  version: 1,
  label,
  rsaPkcs1Der: der.toString("base64"),
  key: key.toString("hex"),
  streamingLabel: streaming.label,
  streamingKey: streamingKey.toString("hex"),
  kind,
  cases: cases.map((c, i) => ({
    organization: c.organization,
    aad: aad(binding(c.organization)).toString("utf8"),
    nonce: c.nonce.toString("hex"),
    plaintext: c.plaintext,
    sealed: sealed[i],
  })),
  // The first case's ciphertext must not open as these organizations' secret.
  wrongOrganizations,
  // The first case's plaintext, organization, and nonce, sealed with event
  // streaming's key: it must not open as a client secret. And the first
  // case's ciphertext must not open with event streaming's key.
  streamingSealed,
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

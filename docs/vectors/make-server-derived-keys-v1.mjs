// Makes docs/vectors/server-derived-keys-v1.json
// (node docs/vectors/make-server-derived-keys-v1.mjs > docs/vectors/server-derived-keys-v1.json):
// fixed inputs and what the server must compute from them for two keys it
// derives from its private RSA key, as it derives event streaming's
// (event-streaming-secrets-v1.json), each over a label of its own, so they're
// never kept in the database:
// - Site fixes (DESIGN.md, "Site fixes (opt-in)"): the key for the hashes
//   that count each person once per fix, HMAC-SHA256 over the account id, a
//   zero byte, and the fix's id, in base64.
// - Install command tokens (DESIGN.md, "Onboarding through the RMM"): the key
//   that seals a token for the database, so admins can see the command again,
//   with AES-256-GCM bound to its organization by associated data. The
//   server finds a token by its SHA-256 in base64.
// Uses only Node's crypto, independently of the server's code (ring), whose
// unit tests check their own results against a copy of the file
// (passbundle-server, src/db/models/vectors/server-derived-keys-v1.json).
//
// The RSA key is event streaming's vectors' key, made for vectors only; it
// protects nothing. The accounts, fixes, and tokens aren't real.
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

const streaming = JSON.parse(readFileSync(new URL("./event-streaming-secrets-v1.json", import.meta.url), "utf8"));

// From the RSA key's PKCS#1 DER, as event streaming's key is.
const der = createPrivateKey(streaming.rsaPkcs1Pem).export({ type: "pkcs1", format: "der" });
const deriveKey = (label) => createHmac("sha256", der).update(label, "utf8").digest();
if (deriveKey(streaming.label).toString("hex") !== streaming.key) {
  throw new Error("Event streaming's key must be its vectors' key");
}

// Site fixes' reporters.
const reportersLabel = "passbundle site fix reporters v1";
const reportersKey = deriveKey(reportersLabel);
const reporterHash = (user, fix) =>
  createHmac("sha256", reportersKey).update(`${user}\u0000${fix}`, "utf8").digest("base64");
const reporterCases = [
  { user: "5b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", fix: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d" },
  { user: "5b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d", fix: "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f" },
  { user: "6c2d3e4f-5061-4b7c-9d8e-0f1a2b3c4d5e", fix: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d" },
].map((c) => ({ ...c, hash: reporterHash(c.user, c.fix) }));
// One person, one fix: one hash. Another fix or another person: another hash.
if (new Set(reporterCases.map((c) => c.hash)).size !== reporterCases.length) {
  throw new Error("Hashes must differ across fixes and people");
}

// Install command tokens.
const tokensLabel = "passbundle install command tokens v1";
const tokensKey = deriveKey(tokensLabel);
const aad = (organization) => Buffer.from(`install command token\u0000organization ${organization}`, "utf8");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("base64");

/** "v1." and base64 of nonce, ciphertext, and the 16-byte tag, as event streaming seals. */
function seal(key, associated, nonce, plaintext) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associated);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([nonce, data, cipher.getAuthTag()]).toString("base64")}`;
}

function opens(key, associated, sealed) {
  const bytes = Buffer.from(sealed.slice("v1.".length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(associated);
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  try {
    decipher.update(bytes.subarray(12, bytes.length - 16));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

// Tokens are 32 bytes in base64url without padding; these are fixed for the vectors.
const tokenCases = [
  {
    organization: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    nonce: Buffer.from("b0b1b2b3b4b5b6b7b8b9babb", "hex"),
    token: Buffer.alloc(32, 7).toString("base64url"),
  },
  {
    organization: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
    nonce: Buffer.from("1f1e1d1c1b1a191817161514", "hex"),
    token: Buffer.from("not a real install command token", "utf8").toString("base64url"),
  },
].map((c) => ({ ...c, sealed: seal(tokensKey, aad(c.organization), c.nonce, c.token), hash: sha256(c.token) }));
const wrongOrganizations = ["0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e", tokenCases[1].organization];
if (
  !tokenCases.every((c) => opens(tokensKey, aad(c.organization), c.sealed)) ||
  wrongOrganizations.some((o) => opens(tokensKey, aad(o), tokenCases[0].sealed)) ||
  opens(reportersKey, aad(tokenCases[0].organization), tokenCases[0].sealed) ||
  tokensKey.equals(reportersKey)
) {
  throw new Error("A token opened where it mustn't, or didn't where it must");
}

const vectors = {
  version: 1,
  rsaPkcs1Der: der.toString("base64"),
  siteFixReporters: {
    label: reportersLabel,
    key: reportersKey.toString("hex"),
    cases: reporterCases,
  },
  installTokens: {
    label: tokensLabel,
    key: tokensKey.toString("hex"),
    cases: tokenCases.map((c) => ({
      organization: c.organization,
      aad: aad(c.organization).toString("utf8"),
      nonce: c.nonce.toString("hex"),
      token: c.token,
      sealed: c.sealed,
      hash: c.hash,
    })),
    // The first case's sealed token must not open as these organizations'.
    wrongOrganizations,
  },
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

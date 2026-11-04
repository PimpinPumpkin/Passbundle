// Makes docs/vectors/script-grants-v3.json
// (node docs/vectors/make-script-grants-v3.mjs > docs/vectors/script-grants-v3.json):
// the version 3 seals an app opens before it refreshes a script token's copy
// (docs/script-access.md, "Keeping copies current"). Version 2 bound the
// sealed token key to its token and the sealed spec to its token and item;
// version 3 also binds when the token ends, in both, so a hacked server that
// keeps listing a grant can't have apps refresh its copy once the token has
// ended. Uses only Node's crypto, independently of the apps' code, so their
// tests check themselves against it. Encrypted values use fixed IVs here only
// so the file is stable; apps always use random IVs and are tested by
// decrypting these, never by comparing ciphertext.
import { createCipheriv, createHmac, hkdfSync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const hkdf = (ikm, info, length) =>
  Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, length));

/** Upstream's EncString type 2: AES-256-CBC with PKCS#7, then HMAC-SHA256 over IV and ciphertext. */
function encString(key64, plaintext, iv) {
  const encKey = key64.subarray(0, 32);
  const macKey = key64.subarray(32, 64);
  const cipher = createCipheriv("aes-256-cbc", encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", macKey).update(Buffer.concat([iv, ct])).digest();
  return `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
}

// The same token, organization, item, and seed as script-access-v1.json and
// script-grants-v2.json.
const tokenId = "5b0f3c1a-7e2d-4a9b-8c6d-1f2e3a4b5c6d";
const organizationId = "8f9a7c1e-3b2d-4e5f-9a8b-7c6d5e4f3a2b";
const itemId = "0d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e";
const organizationKey = bytes(0x00, 64);
const seed = bytes(0x20, 32);
// Another token in the same organization, whose seed someone else knows, and
// another item the token was never granted.
const otherTokenId = "77777777-7e2d-4a9b-8c6d-1f2e3a4b5c6d";
const otherItemId = "99999999-4b5c-4d6e-8f70-819a2b3c4d5e";
const otherSeed = bytes(0xc0, 32);
const otherOrganizationKey = bytes(0x10, 64);

const DAY = 86_400;
/** When the token was made: 2026-10-27T00:00:00Z. */
const madeAt = 1_793_059_200;
/** When it ends (Unix seconds): 90 days on, the default. */
const expires = madeAt + 90 * DAY;
/**
 * The furthest ahead an app accepts a seal's end: a token lasts at most a
 * year, with a day's slack for a sealing device whose clock runs ahead.
 */
const maxAheadSeconds = 366 * DAY;

const tokenKey = hkdf(seed, "passbundle script key v1", 64);
const otherTokenKey = hkdf(otherSeed, "passbundle script key v1", 64);

const fields = { username: true, password: true, totp: false, fields: ["Break-glass PIN"] };
const keyJson = (token, key, ends = expires) => JSON.stringify({ v: 3, token, expires: ends, key: b64(key) });
const specJson = (token, item, ends = expires) => JSON.stringify({ v: 3, token, item, expires: ends, ...fields });

let iv = 0x40;
/** Sealed with the organization key (or another), each with an IV of its own. */
const seal = (plaintext, key = organizationKey) => encString(key, plaintext, bytes((iv += 8), 16));

const sealedKey = seal(keyJson(tokenId, tokenKey));
const sealedSpec = seal(specJson(tokenId, itemId));

const vectors = {
  version: 3,
  inputs: {
    tokenId,
    organizationId,
    itemId,
    organizationKey: b64(organizationKey),
    seed: b64(seed),
    madeAt,
  },
  maxAheadSeconds,
  tokenKey: b64(tokenKey),
  expires,
  sealedTokenKey: {
    note: "The token key, sealed with the organization key together with the id of the token it belongs to and when the token ends (Unix seconds).",
    encString: sealedKey,
    plaintext: keyJson(tokenId, tokenKey),
  },
  sealedSpec: {
    note: "What a grant copies, sealed with the organization key together with the ids of the token and the item it's for, and when the token ends.",
    encString: sealedSpec,
    plaintext: specJson(tokenId, itemId),
  },
  // An app refreshes this token's copy of this item, at `at` (Unix seconds),
  // only with a pair that opens with the organization key, both version 3,
  // both naming the token, the spec naming the item, both ending at the same
  // time, before then, and not further ahead than any token lasts.
  checks: [
    { why: "the pair, when it's made", sealedKey, sealedSpec, at: madeAt, refreshes: true },
    { why: "the pair, a second before the token ends", sealedKey, sealedSpec, at: expires - 1, refreshes: true },
    { why: "the pair, once the token has ended", sealedKey, sealedSpec, at: expires, refreshes: false },
    { why: "the pair, long after the token ended", sealedKey, sealedSpec, at: expires + 365 * DAY, refreshes: false },
    {
      why: "a spec sealed for another item, served for this one",
      sealedKey,
      sealedSpec: seal(specJson(tokenId, otherItemId)),
      at: madeAt,
      refreshes: false,
    },
    {
      why: "a spec sealed for another token, served for this one",
      sealedKey,
      sealedSpec: seal(specJson(otherTokenId, itemId)),
      at: madeAt,
      refreshes: false,
    },
    {
      why: "another token's key, whose seed someone else knows, served for this token",
      sealedKey: seal(keyJson(otherTokenId, otherTokenKey)),
      sealedSpec,
      at: madeAt,
      refreshes: false,
    },
    {
      why: "a spec that ends later than its token key",
      sealedKey,
      sealedSpec: seal(specJson(tokenId, itemId, expires + 30 * DAY)),
      at: madeAt,
      refreshes: false,
    },
    {
      why: "a pair that says it lasts longer than any token",
      sealedKey: seal(keyJson(tokenId, tokenKey, madeAt + 2 * 365 * DAY)),
      sealedSpec: seal(specJson(tokenId, itemId, madeAt + 2 * 365 * DAY)),
      at: madeAt,
      refreshes: false,
    },
    {
      why: "a version 2 token key, which says nothing of when the token ends",
      sealedKey: seal(JSON.stringify({ v: 2, token: tokenId, key: b64(tokenKey) })),
      sealedSpec,
      at: madeAt,
      refreshes: false,
    },
    {
      why: "a version 2 spec, which says nothing of when the token ends",
      sealedKey,
      sealedSpec: seal(JSON.stringify({ v: 2, token: tokenId, item: itemId, ...fields })),
      at: madeAt,
      refreshes: false,
    },
    {
      why: "a spec sealed with another organization's key",
      sealedKey,
      sealedSpec: seal(specJson(tokenId, itemId), otherOrganizationKey),
      at: madeAt,
      refreshes: false,
    },
    {
      why: "a token key sealed with another organization's key",
      sealedKey: seal(keyJson(tokenId, tokenKey), otherOrganizationKey),
      sealedSpec,
      at: madeAt,
      refreshes: false,
    },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

// Makes docs/vectors/script-grants-v2.json
// (node docs/vectors/make-script-grants-v2.mjs > docs/vectors/script-grants-v2.json):
// the version 2 seals an app opens before it refreshes a script token's copy
// (docs/script-access.md, "Keeping copies current"). Version 2 binds the
// sealed token key to its token and the sealed spec to its token and item, so
// a hacked server can't pair a token's key with an item it was never granted.
// Uses only Node's crypto, independently of the apps' code, so their tests
// check themselves against it. Encrypted values use fixed IVs here only so
// the file is stable; apps always use random IVs and are tested by
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

// The same token, organization, item, and seed as script-access-v1.json.
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

const tokenKey = hkdf(seed, "passbundle script key v1", 64);
const otherTokenKey = hkdf(otherSeed, "passbundle script key v1", 64);

const fields = { username: true, password: true, totp: false, fields: ["Break-glass PIN"] };
const keyJson = (token, key) => JSON.stringify({ v: 2, token, key: b64(key) });
const specJson = (token, item) => JSON.stringify({ v: 2, token, item, ...fields });

const sealedKey = encString(organizationKey, keyJson(tokenId, tokenKey), bytes(0x50, 16));
const sealedSpec = encString(organizationKey, specJson(tokenId, itemId), bytes(0x58, 16));

const vectors = {
  version: 2,
  inputs: {
    tokenId,
    organizationId,
    itemId,
    organizationKey: b64(organizationKey),
    seed: b64(seed),
  },
  tokenKey: b64(tokenKey),
  sealedTokenKey: {
    note: "The token key, sealed with the organization key together with the id of the token it belongs to.",
    encString: sealedKey,
    plaintext: keyJson(tokenId, tokenKey),
  },
  sealedSpec: {
    note: "What a grant copies, sealed with the organization key together with the ids of the token and the item it's for.",
    encString: sealedSpec,
    plaintext: specJson(tokenId, itemId),
  },
  refused: [
    {
      why: "a spec sealed for another item, served for this one",
      sealedKey,
      sealedSpec: encString(organizationKey, specJson(tokenId, otherItemId), bytes(0x60, 16)),
    },
    {
      why: "a spec sealed for another token, served for this one",
      sealedKey,
      sealedSpec: encString(organizationKey, specJson(otherTokenId, itemId), bytes(0x68, 16)),
    },
    {
      why: "another token's key, whose seed someone else knows, served for this token",
      sealedKey: encString(organizationKey, keyJson(otherTokenId, otherTokenKey), bytes(0x70, 16)),
      sealedSpec,
    },
    {
      why: "a version 1 spec, which names no token or item",
      sealedKey,
      sealedSpec: encString(
        organizationKey,
        JSON.stringify({ v: 1, ...fields }),
        bytes(0x78, 16),
      ),
    },
    {
      why: "a version 1 token key, which names no token",
      sealedKey: encString(organizationKey, b64(tokenKey), bytes(0x80, 16)),
      sealedSpec,
    },
    {
      why: "a spec sealed with another organization's key",
      sealedKey,
      sealedSpec: encString(otherOrganizationKey, specJson(tokenId, itemId), bytes(0x88, 16)),
    },
    {
      why: "a token key sealed with another organization's key",
      sealedKey: encString(otherOrganizationKey, keyJson(tokenId, tokenKey), bytes(0x90, 16)),
      sealedSpec,
    },
  ],
};

console.log(JSON.stringify(vectors, null, 2));

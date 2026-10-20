// Makes docs/vectors/script-access-v1.json
// (node docs/vectors/make-script-access-v1.mjs > docs/vectors/script-access-v1.json):
// fixed inputs and the values every app must compute or accept for "Script
// access" (docs/script-access.md). Uses only Node's crypto, independently of
// the apps' code, so their tests check themselves against it. Encrypted
// values use fixed IVs here only so the file is stable; apps always use
// random IVs and are tested by decrypting these, never by comparing
// ciphertext.
import { createCipheriv, createHash, createHmac, hkdfSync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();
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

const tokenId = "5b0f3c1a-7e2d-4a9b-8c6d-1f2e3a4b5c6d";
const organizationId = "8f9a7c1e-3b2d-4e5f-9a8b-7c6d5e4f3a2b";
const itemId = "0d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e";
const organizationKey = bytes(0x00, 64);
const seed = bytes(0x20, 32);

const authSecret = hkdf(seed, "passbundle script auth v1", 32);
const tokenKey = hkdf(seed, "passbundle script key v1", 64);
const tokenString = `pbs1_${tokenId.replaceAll("-", "")}_${b64url(seed)}`;

const copy = {
  v: 1,
  token: tokenId,
  item: itemId,
  revision: "2026-10-20T18:00:00.000Z",
  name: "Domain admin",
  username: "admin@contoso.example",
  password: "not-a-real-password-1",
  fields: { "Break-glass PIN": "0000" },
};
const copyJson = JSON.stringify(copy);
const otherItemCopy = JSON.stringify({ ...copy, item: "99999999-4b5c-4d6e-8f70-819a2b3c4d5e" });
const otherTokenCopy = JSON.stringify({ ...copy, token: "77777777-7e2d-4a9b-8c6d-1f2e3a4b5c6d" });
const spec = JSON.stringify({ v: 1, username: true, password: true, totp: false, fields: ["Break-glass PIN"] });

const flip = (encStr, part) => {
  const [head, rest] = encStr.split(".");
  const pieces = rest.split("|");
  const b = Buffer.from(pieces[part], "base64");
  b[0] ^= 1;
  pieces[part] = b64(b);
  return `${head}.${pieces.join("|")}`;
};

const copyEnc = encString(tokenKey, copyJson, bytes(0x60, 16));

const vectors = {
  version: 1,
  inputs: {
    tokenId,
    organizationId,
    itemId,
    organizationKey: b64(organizationKey),
    seed: b64(seed),
  },
  tokenString,
  authSecret: b64url(authSecret),
  authHash: b64(sha256(authSecret)),
  authorization: `PassBundleScript ${tokenId}.${b64url(authSecret)}`,
  tokenKey: b64(tokenKey),
  sealedTokenKey: {
    note: "The token key, sealed with the organization key, so apps that hold the organization key can write and refresh copies.",
    encString: encString(organizationKey, b64(tokenKey), bytes(0x50, 16)),
    plaintext: b64(tokenKey),
  },
  sealedSpec: {
    note: "What a grant copies, sealed with the organization key.",
    encString: encString(organizationKey, spec, bytes(0x58, 16)),
    plaintext: spec,
  },
  copy: { encString: copyEnc, plaintext: copyJson },
  refused: [
    { why: "IV changed", encString: flip(copyEnc, 0) },
    { why: "ciphertext changed", encString: flip(copyEnc, 1) },
    { why: "MAC changed", encString: flip(copyEnc, 2) },
    { why: "sealed with the organization key instead of the token key", encString: encString(organizationKey, copyJson, bytes(0x60, 16)) },
  ],
  mismatched: [
    {
      why: "a copy of another item, served for this one",
      encString: encString(tokenKey, otherItemCopy, bytes(0x68, 16)),
    },
    {
      why: "a copy made for another token",
      encString: encString(tokenKey, otherTokenCopy, bytes(0x70, 16)),
    },
  ],
};

console.log(JSON.stringify(vectors, null, 2));

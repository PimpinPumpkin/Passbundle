// Makes docs/vectors/reload-key-v1.json
// (node docs/vectors/make-reload-key-v1.mjs > docs/vectors/reload-key-v1.json):
// the web vault's reload key wrap (DESIGN.md, "Staying unlocked across a
// reload"). A tab wraps the user key with a random key R using upstream's own
// key wrap, an EncString of type 2: AES-256-CBC with PKCS #7 padding under
// R's first 32 bytes, then HMAC-SHA256 under its last 32 bytes over the IV
// and the ciphertext, written "2.<iv>|<ciphertext>|<mac>" in base64. The
// plaintext is the user key's own 64 bytes.
//
// Uses only Node's crypto, independently of the clients' code. The IV here is
// fixed so the file is the same every time; the web vault's IVs are random.
// check-reload-key-vectors.mjs opens these with upstream's own crypto, and
// the web vault's unit test (passbundle-clients,
// apps/web/src/app/keykeeper/reload-key/reload-key-v1.json, a copy of this
// file) opens them, and its own wraps, through upstream's EncryptService.
//
// Every key here was made for these vectors and protects nothing.
import { createCipheriv, createHash, createHmac } from "node:crypto";

const label = "passbundle reload key v1";
const sha512 = (what) => createHash("sha512").update(`${label} ${what}`).digest();
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

function wrap(key, wrappingKey, iv) {
  const cipher = createCipheriv("aes-256-cbc", wrappingKey.subarray(0, 32), iv);
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  const mac = createHmac("sha256", wrappingKey.subarray(32, 64)).update(iv).update(ct).digest();
  return { iv, ct, mac, encString: `2.${b64(iv)}|${b64(ct)}|${b64(mac)}` };
}

const wrappingKey = sha512("wrapping key R");
const userKey = sha512("user key");
const otherKey = sha512("another tab's R");
const iv = createHash("sha256").update(`${label} iv`).digest().subarray(0, 16);
const wrapped = wrap(userKey, wrappingKey, iv);

// The same bytes with the MAC's last byte changed, and with the ciphertext's
// first byte changed: both must be refused.
const flip = (bytes, at) => {
  const copy = Buffer.from(bytes);
  copy[at] ^= 0x01;
  return copy;
};
const badMac = `2.${b64(iv)}|${b64(wrapped.ct)}|${b64(flip(wrapped.mac, 31))}`;
const badCiphertext = `2.${b64(iv)}|${b64(flip(wrapped.ct, 0))}|${b64(wrapped.mac)}`;

const vectors = {
  version: 1,
  label,
  wrap: {
    wrappingKey: b64(wrappingKey),
    userKey: b64(userKey),
    wrappedUserKey: wrapped.encString,
  },
  refused: {
    // R from another tab: the MAC doesn't match.
    otherWrappingKey: b64(otherKey),
    badMac,
    badCiphertext,
  },
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

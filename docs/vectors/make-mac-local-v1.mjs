// Makes docs/vectors/mac-local-v1.json:
//
//   node docs/vectors/make-mac-local-v1.mjs > docs/vectors/mac-local-v1.json
//
// What the Mac app keeps on the Mac itself while it has no Apple developer
// account (docs/core.md, "The Mac without an Apple developer account"):
//
// - the session's refresh token, sealed under a key derived from the
//   account's user key, in the account's folder instead of the login
//   keychain;
// - the user key for Touch ID, sealed to a Secure Enclave key that only the
//   Mac's current fingerprints can use.
//
// Plain Node only, independently of the core (Rust) and the Mac app's
// Swift, so both are checked against it. A software P-256 key stands in for
// the Secure Enclave's: the enclave does the same key agreement, it just
// never lets its key out. Every input is fixed (bytes counted up from a
// start), so this file comes out the same every time; the apps use random
// IVs, nonces, and ephemeral keys, and are tested by opening what's here
// and by making exactly it from the same inputs.
import { createCipheriv, createDecipheriv, createECDH, createHmac, hkdfSync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");

// HKDF-Expand alone (RFC 5869, 2.3): Node's hkdf always extracts first.
const hkdfExpand = (prk, info, length) => {
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  for (let i = 1; out.length < length; i++) {
    t = createHmac("sha256", prk).update(Buffer.concat([t, Buffer.from(info, "utf8"), Buffer.from([i])])).digest();
    out = Buffer.concat([out, t]);
  }
  return out.subarray(0, length);
};

// Type 2 (AES-256-CBC with PKCS#7, then HMAC-SHA256 over the IV and the
// ciphertext), as docs/core.md's format has it, under a 64-byte key.
const type2 = (key, iv, plaintext) => {
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32)).update(Buffer.concat([iv, data])).digest();
  return `2.${b64(iv)}|${b64(data)}|${b64(mac)}`;
};
const openType2 = (key, text) => {
  const [iv, data, mac] = text.slice(2).split("|").map((part) => Buffer.from(part, "base64"));
  const expected = createHmac("sha256", key.subarray(32)).update(Buffer.concat([iv, data])).digest();
  if (!expected.equals(mac)) throw new Error("bad MAC");
  const decipher = createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
};

// The session's refresh token. The key is HKDF-Expand-SHA256 of the user
// key (all 64 bytes as the PRK) with this info, 64 bytes: its own key, so
// a sealed token is never a string the vault's own key opens, and nothing
// else under the user key passes for one.
const refreshInfo = "keykeeper refresh token v1";
const userKey = bytes(0x40, 64);
const refreshKey = hkdfExpand(userKey, refreshInfo, 64);
const token = "a-refresh-token-from-the-server.4f6c2a9e";
const refreshIv = bytes(0xa0, 16);
const sealedToken = type2(refreshKey, refreshIv, Buffer.from(token, "utf8"));
if (openType2(refreshKey, sealedToken).toString("utf8") !== token) throw new Error("the token doesn't open");
// Changed after sealing: the last byte of its ciphertext.
const [, ivPart, dataPart, macPart] = sealedToken.match(/^2\.([^|]*)\|([^|]*)\|(.*)$/);
const changed = Buffer.from(dataPart, "base64");
changed[changed.length - 1] ^= 1;
const tamperedToken = `2.${ivPart}|${b64(changed)}|${macPart}`;
// Sealed under the user key itself, as an item's field is: refused.
const underUserKey = type2(userKey, refreshIv, Buffer.from(token, "utf8"));

// Touch ID. An ephemeral P-256 key agrees with the enclave's public key;
// HKDF-SHA256 of the shared secret (the x coordinate, 32 bytes), salted
// with both public keys (X9.63, 65 bytes each, the ephemeral's first), with
// this info, gives a 32-byte AES-256-GCM key. The user key is sealed with a
// 12-byte nonce, authenticating this info, a zero byte, and the account's id
// on this Mac, so one account's file never opens as another's.
const touchInfo = "keykeeper Touch ID v1";
const enclave = createECDH("prime256v1");
enclave.setPrivateKey(bytes(0x11, 32));
const ephemeral = createECDH("prime256v1");
ephemeral.setPrivateKey(bytes(0x22, 32));
const enclavePublic = enclave.getPublicKey(); // X9.63, uncompressed
const ephemeralPublic = ephemeral.getPublicKey();
const shared = ephemeral.computeSecret(enclavePublic);
if (!shared.equals(enclave.computeSecret(ephemeralPublic))) throw new Error("the agreement doesn't agree");
const salt = Buffer.concat([ephemeralPublic, enclavePublic]);
const touchKey = Buffer.from(hkdfSync("sha256", shared, salt, touchInfo, 32));
const account = "0123456789abcdef0123456789abcdef";
const aad = (id) => Buffer.concat([Buffer.from(touchInfo, "utf8"), Buffer.from([0]), Buffer.from(id, "ascii")]);
const nonce = bytes(0x33, 12);
const touchUserKey = bytes(0x80, 64);
const gcm = createCipheriv("aes-256-gcm", touchKey, nonce);
gcm.setAAD(aad(account));
const sealedKey = Buffer.concat([nonce, gcm.update(touchUserKey), gcm.final(), gcm.getAuthTag()]);

const openTouch = (sealed, id) => {
  const d = createDecipheriv("aes-256-gcm", touchKey, sealed.subarray(0, 12));
  d.setAAD(aad(id));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
};
if (!openTouch(sealedKey, account).equals(touchUserKey)) throw new Error("the user key doesn't open");
let refusedForAnother = false;
try {
  openTouch(sealedKey, "fedcba9876543210fedcba9876543210");
} catch {
  refusedForAnother = true;
}
if (!refusedForAnother) throw new Error("another account's id opened it");

const vectors = {
  about:
    "What the Mac app keeps on the Mac while it has no Apple developer account (docs/core.md, \"The Mac without an Apple developer account\"). Made by make-mac-local-v1.mjs. All binary values are base64.",
  refreshToken: {
    about:
      "The session's refresh token, kept in the account's folder (session.sealed) as a type 2 string under its own key: HKDF-Expand-SHA256 of the user key (the 64 bytes as the PRK) with `info`, 64 bytes (32 for AES-256-CBC, then 32 for HMAC-SHA256).",
    userKey: b64(userKey),
    info: refreshInfo,
    key: b64(refreshKey),
    token,
    iv: b64(refreshIv),
    sealed: sealedToken,
    tampered: tamperedToken,
    tamperedAbout: "The last byte of the ciphertext changed after sealing: its MAC fails, and it's refused.",
    underUserKey,
    underUserKeyAbout: "The same token under the user key itself, as an item's field would be: refused, since the token's key isn't the user key.",
  },
  touchId: {
    about:
      "The user key for Touch ID, sealed to a key in the Secure Enclave (this software key stands in for it). The shared secret is ECDH on P-256 of the ephemeral key and the enclave's public key; the key is HKDF-SHA256 of it with salt ephemeralPublicKey || enclavePublicKey and `info`, 32 bytes; sealed is AES-256-GCM's nonce || ciphertext || tag (CryptoKit's combined form), authenticating `info`, a zero byte, and the account's id.",
    enclavePrivateKey: b64(bytes(0x11, 32)),
    enclavePublicKey: b64(enclavePublic),
    ephemeralPrivateKey: b64(bytes(0x22, 32)),
    ephemeralPublicKey: b64(ephemeralPublic),
    sharedSecret: b64(shared),
    info: touchInfo,
    key: b64(touchKey),
    account,
    nonce: b64(nonce),
    userKey: b64(touchUserKey),
    sealed: b64(sealedKey),
    otherAccount: "fedcba9876543210fedcba9876543210",
    otherAccountAbout: "Opening `sealed` as this account's is refused: the tag covers the account's id.",
  },
};
process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

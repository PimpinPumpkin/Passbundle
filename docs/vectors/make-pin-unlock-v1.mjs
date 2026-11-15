// Makes docs/vectors/pin-unlock-v1.json:
//
//   node docs/vectors/make-pin-unlock-v1.mjs > docs/vectors/pin-unlock-v1.json
//
// Unlocking our apps with a PIN (DESIGN.md, "Unlock with a PIN"): the
// account's user key, wrapped under a key made from the PIN, and on the Mac
// the seal that keeps the record to that Mac's Secure Enclave.
//
// Plain Node only (24.7 or later, for Argon2 in node:crypto), independently
// of the core (Rust) and the Mac app's Swift, so both are checked against
// it. Every input is fixed (bytes counted up from a start), so this file
// comes out the same every time; the apps use random salts, IVs, nonces,
// and ephemeral keys, and are tested by opening what's here and by making
// exactly it from the same inputs.
import {
  argon2Sync,
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
} from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");

// HKDF-Expand alone (RFC 5869, 2.3): Node's hkdf always extracts first.
const hkdfExpand = (prk, info, length) => {
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  for (let i = 1; out.length < length; i++) {
    t = createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
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
const refuses = (key, text) => {
  try {
    openType2(key, text);
  } catch {
    return true;
  }
  return false;
};

// The PIN key: Argon2id (version 0x13) of the PIN as typed (UTF-8, nothing
// trimmed or normalized), 32 bytes. The floor is 64 MiB, 3 passes, 4 lanes.
const pinKeyOf = (pin, salt, { memoryMib, iterations, parallelism }) =>
  argon2Sync("argon2id", {
    message: Buffer.from(pin, "utf8"),
    nonce: salt,
    memory: memoryMib * 1024,
    passes: iterations,
    parallelism,
    tagLength: 32,
  });

// The wrapping key: HKDF-Expand-SHA256 with the PIN key as the PRK, 64 bytes
// (32 for AES-256-CBC, then 32 for HMAC-SHA256). The info is the label, then,
// each after one zero byte, the server's address as the account's settings
// keep it, the account's id on that server, and the account's own id on the
// device. None of the three may hold a zero byte.
const label = "keykeeper PIN unlock v1";
const infoOf = (versionLabel, server, userId, account) =>
  Buffer.concat(
    [versionLabel, server, userId, account].flatMap((part, i) =>
      i === 0 ? [Buffer.from(part, "utf8")] : [Buffer.from([0]), Buffer.from(part, "utf8")],
    ),
  );
const wrappingKeyOf = (pinKey, versionLabel, server, userId, account) =>
  hkdfExpand(pinKey, infoOf(versionLabel, server, userId, account), 64);

const floor = { memoryMib: 64, iterations: 3, parallelism: 4 };
const server = "https://vault.example.test";
const userId = "0f3c6a52-9d1e-4b7a-8c25-6e1f0a9b4d73";
const account = "0123456789abcdef0123456789abcdef";
const userKey = bytes(0x80, 64);

const pin = "2580";
const salt = bytes(0x50, 16);
const iv = bytes(0xc0, 16);
const pinKey = pinKeyOf(pin, salt, floor);
const wrappingKey = wrappingKeyOf(pinKey, label, server, userId, account);
const wrapped = type2(wrappingKey, iv, userKey);
if (!openType2(wrappingKey, wrapped).equals(userKey)) throw new Error("the user key doesn't open");

// The record the core keeps (sealed to the device before it's written),
// exactly as it writes it.
const recordOf = (saltBytes, parameters, wrappedKey) =>
  JSON.stringify({
    version: 1,
    salt: b64(saltBytes),
    memoryMib: parameters.memoryMib,
    iterations: parameters.iterations,
    parallelism: parameters.parallelism,
    wrapped: wrappedKey,
  });
const record = recordOf(salt, floor, wrapped);

// A PIN that isn't digits, used as typed: its spaces, its capitals, and its
// letters outside ASCII as UTF-8, precomposed here (U+00E9), not normalized.
const longPin = " Tr0ub4dor & 3 café ";
const longSalt = bytes(0x60, 16);
const longIv = bytes(0xd0, 16);
const longPinKey = pinKeyOf(longPin, longSalt, floor);
const longWrappingKey = wrappingKeyOf(longPinKey, label, server, userId, account);
const longWrapped = type2(longWrappingKey, longIv, userKey);

// Refusals. Each of these is a different wrapping key, so the MAC fails.
const wrongPin = "2581";
const otherAccount = "fedcba9876543210fedcba9876543210";
const otherServer = "https://vault.example.test:8443";
const otherUserId = "7b1d2c4e-55aa-4c0f-9e3b-2a6d8f1c0e94";
const otherLabel = "keykeeper PIN unlock v2";
const others = {
  wrongPin: wrappingKeyOf(pinKeyOf(wrongPin, salt, floor), label, server, userId, account),
  otherAccount: wrappingKeyOf(pinKey, label, server, userId, otherAccount),
  otherServer: wrappingKeyOf(pinKey, label, otherServer, userId, account),
  otherUserId: wrappingKeyOf(pinKey, label, server, otherUserId, account),
  otherLabel: wrappingKeyOf(pinKey, otherLabel, server, userId, account),
};
for (const [name, key] of Object.entries(others)) {
  if (!refuses(key, wrapped)) throw new Error(`${name} opened it`);
}
// The same user key, wrapped with the right PIN for each of the others: this
// account, server, and version must refuse them.
const madeForOthers = {
  otherAccount: type2(others.otherAccount, iv, userKey),
  otherServer: type2(others.otherServer, iv, userKey),
  otherUserId: type2(others.otherUserId, iv, userKey),
  otherLabel: type2(others.otherLabel, iv, userKey),
};
for (const [name, text] of Object.entries(madeForOthers)) {
  if (!refuses(wrappingKey, text)) throw new Error(`one made for ${name} opened`);
}
// Changed after wrapping: the last byte of the ciphertext, and of the MAC.
const [, ivPart, dataPart, macPart] = wrapped.match(/^2\.([^|]*)\|([^|]*)\|(.*)$/);
const flipLast = (text) => {
  const changed = Buffer.from(text, "base64");
  changed[changed.length - 1] ^= 1;
  return b64(changed);
};
const tamperedCiphertext = `2.${ivPart}|${flipLast(dataPart)}|${macPart}`;
const tamperedMac = `2.${ivPart}|${dataPart}|${flipLast(macPart)}`;
if (!refuses(wrappingKey, tamperedCiphertext) || !refuses(wrappingKey, tamperedMac)) {
  throw new Error("a changed one opened");
}
// Under the floor, or over the most the core takes: refused before the PIN
// is used. The first has a record whose wrap is right for its parameters, so
// only the floor refuses it.
const weak = { memoryMib: 16, iterations: 2, parallelism: 1 };
const weakWrapped = type2(
  wrappingKeyOf(pinKeyOf(pin, salt, weak), label, server, userId, account),
  iv,
  userKey,
);
const refusedParameters = [
  weak,
  { memoryMib: 63, iterations: 3, parallelism: 4 },
  { memoryMib: 64, iterations: 2, parallelism: 4 },
  { memoryMib: 64, iterations: 3, parallelism: 3 },
  { memoryMib: 1025, iterations: 3, parallelism: 4 },
  { memoryMib: 64, iterations: 11, parallelism: 4 },
  { memoryMib: 64, iterations: 3, parallelism: 17 },
];

// What the PIN was made for: SHA-256 of the account's protected user key as
// the sync has it (`profile.key`), which changes with the master password,
// the KDF settings, and the account's key.
const protectedUserKey = type2(bytes(0x10, 64), bytes(0xe0, 16), userKey);
const madeFor = createHash("sha256").update(protectedUserKey, "utf8").digest();

// The Mac's seal of the record: Touch ID's construction (mac-local-v1.json,
// "touchId") under its own label, with no fingerprint asked. An ephemeral
// P-256 key agrees with the enclave's public key; HKDF-SHA256 of the shared
// secret, salted with both public keys (X9.63, the ephemeral's first), with
// this info, gives a 32-byte AES-256-GCM key; the record is sealed with a
// 12-byte nonce, authenticating this info, a zero byte, and the account's id
// on this Mac. A software key stands in for the enclave's.
const sealInfo = "keykeeper PIN device seal v1";
const enclave = createECDH("prime256v1");
enclave.setPrivateKey(bytes(0x15, 32));
const ephemeral = createECDH("prime256v1");
ephemeral.setPrivateKey(bytes(0x26, 32));
const enclavePublic = enclave.getPublicKey(); // X9.63, uncompressed
const ephemeralPublic = ephemeral.getPublicKey();
const shared = ephemeral.computeSecret(enclavePublic);
if (!shared.equals(enclave.computeSecret(ephemeralPublic))) throw new Error("the agreement doesn't agree");
const sealKey = Buffer.from(
  hkdfSync("sha256", shared, Buffer.concat([ephemeralPublic, enclavePublic]), sealInfo, 32),
);
const aad = (id) => Buffer.concat([Buffer.from(sealInfo, "utf8"), Buffer.from([0]), Buffer.from(id, "ascii")]);
const nonce = bytes(0x37, 12);
const gcm = createCipheriv("aes-256-gcm", sealKey, nonce);
gcm.setAAD(aad(account));
const sealedRecord = Buffer.concat([nonce, gcm.update(Buffer.from(record, "utf8")), gcm.final(), gcm.getAuthTag()]);
const openSeal = (sealed, id) => {
  const d = createDecipheriv("aes-256-gcm", sealKey, sealed.subarray(0, 12));
  d.setAAD(aad(id));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
};
if (openSeal(sealedRecord, account).toString("utf8") !== record) throw new Error("the record doesn't open");
let refusedForAnother = false;
try {
  openSeal(sealedRecord, otherAccount);
} catch {
  refusedForAnother = true;
}
if (!refusedForAnother) throw new Error("another account's id opened the seal");

const vectors = {
  about:
    "Unlocking our apps with a PIN (DESIGN.md, \"Unlock with a PIN\"). Made by make-pin-unlock-v1.mjs. All binary values are base64.",
  floor: {
    about:
      "What v1 writes, and the least it opens: Argon2id (version 0x13), 32 bytes out. A record with less memory, fewer passes, or fewer lanes, or with more than the core takes anywhere (1,024 MiB, 10 passes, 16 lanes), is refused before the PIN is used.",
    ...floor,
  },
  wrap: {
    about:
      "pinKey is Argon2id of `pin` (UTF-8, as typed) with `salt` and the parameters. wrappingKey is HKDF-Expand-SHA256 with pinKey as the PRK and `info`, 64 bytes (32 for AES-256-CBC, then 32 for HMAC-SHA256); info is `label`, then, each after one zero byte, `server`, `userId` (the account's id on its server), and `account` (its own id on the device). wrapped is `userKey` as a type 2 string under wrappingKey with `iv`. record is what the core keeps, sealed to the device first.",
    pin,
    salt: b64(salt),
    ...floor,
    pinKey: b64(pinKey),
    label,
    server,
    userId,
    account,
    info: b64(infoOf(label, server, userId, account)),
    wrappingKey: b64(wrappingKey),
    userKey: b64(userKey),
    iv: b64(iv),
    wrapped,
    record,
  },
  asTyped: {
    about:
      "A PIN that isn't digits, for the same account: used exactly as typed, with its spaces at both ends, as UTF-8 (the e with an acute accent is U+00E9, two bytes).",
    pin: longPin,
    pinUtf8: b64(Buffer.from(longPin, "utf8")),
    salt: b64(longSalt),
    ...floor,
    pinKey: b64(longPinKey),
    wrappingKey: b64(longWrappingKey),
    iv: b64(longIv),
    wrapped: longWrapped,
  },
  refused: {
    about:
      "Each of these must fail to open. The first five are opening `wrap.wrapped` with something that isn't what it was made with; `madeFor*` are the same user key wrapped, with the right PIN, for another account, server, or version, opened as `wrap`'s; the tampered ones changed the last byte after wrapping.",
    wrongPin,
    otherAccount,
    otherServer,
    otherUserId,
    otherLabel,
    madeForOtherAccount: madeForOthers.otherAccount,
    madeForOtherServer: madeForOthers.otherServer,
    madeForOtherUserId: madeForOthers.otherUserId,
    madeForOtherLabel: madeForOthers.otherLabel,
    tamperedCiphertext,
    tamperedMac,
    parameters: refusedParameters,
    weakRecord: recordOf(salt, weak, weakWrapped),
    weakRecordAbout:
      "A record with the first of `parameters`, whose wrap is right for `wrap.pin` at those parameters: only the floor refuses it.",
  },
  madeFor: {
    about:
      "What the PIN was made for: SHA-256 of the account's protected user key as the sync has it (`profile.key`, the string's UTF-8). The PIN is removed when a sync's no longer matches.",
    protectedUserKey,
    madeFor: b64(madeFor),
  },
  macDeviceSeal: {
    about:
      "The Mac's seal of `wrap.record`, to a key in the Secure Enclave that asks for no fingerprint (this software key stands in for it). The shared secret is ECDH on P-256 of the ephemeral key and the enclave's public key; the key is HKDF-SHA256 of it with salt ephemeralPublicKey || enclavePublicKey and `info`, 32 bytes; sealed is AES-256-GCM's nonce || ciphertext || tag (CryptoKit's combined form), authenticating `info`, a zero byte, and the account's id.",
    enclavePrivateKey: b64(bytes(0x15, 32)),
    enclavePublicKey: b64(enclavePublic),
    ephemeralPrivateKey: b64(bytes(0x26, 32)),
    ephemeralPublicKey: b64(ephemeralPublic),
    sharedSecret: b64(shared),
    info: sealInfo,
    key: b64(sealKey),
    account,
    nonce: b64(nonce),
    record,
    sealed: b64(sealedRecord),
    otherAccount,
    otherAccountAbout: "Opening `sealed` as this account's is refused: the tag covers the account's id.",
  },
};
process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

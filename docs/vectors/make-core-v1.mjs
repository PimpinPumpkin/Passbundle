// Makes docs/vectors/core-v1.json
// (node docs/vectors/make-core-v1.mjs > docs/vectors/core-v1.json): fixed
// inputs and the values the core (docs/core.md) must compute or open, for the
// vault format it shares with the other apps. Uses only Node's crypto,
// independently of the core and of upstream, so both are checked against it.
// Symmetric values use fixed IVs only so the file is stable; the core always
// uses random IVs and is tested by opening these, never by comparing
// ciphertext. RSA-OAEP is randomized, so rerunning this changes the type 4
// strings (and only those).
import {
  argon2Sync,
  createCipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  pbkdf2Sync,
  publicEncrypt,
  constants,
} from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const sha256 = (data) => createHash("sha256").update(data).digest();
const hkdfExpand = (prk, info, length) =>
  // HKDF-Expand alone: Node's hkdf always extracts first, so expand by hand (RFC 5869, 2.3).
  (() => {
    let t = Buffer.alloc(0);
    let out = Buffer.alloc(0);
    for (let i = 1; out.length < length; i++) {
      t = createHmac("sha256", prk).update(Buffer.concat([t, Buffer.from(info), Buffer.from([i])])).digest();
      out = Buffer.concat([out, t]);
    }
    return out.subarray(0, length);
  })();

let ivCounter = 0;
/** A fixed, distinct IV per string, so the file is stable. */
const nextIv = () => bytes(0x80 + 16 * ivCounter++, 16);

/** EncString type 2: AES-256-CBC with PKCS#7, then HMAC-SHA256 over IV and ciphertext. */
function enc2(key64, plaintext, iv = nextIv()) {
  const cipher = createCipheriv("aes-256-cbc", key64.subarray(0, 32), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", key64.subarray(32, 64)).update(Buffer.concat([iv, ct])).digest();
  return `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
}
const enc = (key64, text) => enc2(key64, Buffer.from(text, "utf8"));

// The account.
const emailAsTyped = "  Ana.Lopez@Example.TEST ";
const salt = emailAsTyped.trim().toLowerCase();
const password = "correct horse battery staple 1";
const pbkdf2 = { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null };
const argon2 = { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 };

const masterKeyPbkdf2 = pbkdf2Sync(password, salt, pbkdf2.kdfIterations, 32, "sha256");
const masterKeyArgon2 = argon2Sync("argon2id", {
  message: Buffer.from(password, "utf8"),
  nonce: sha256(Buffer.from(salt, "utf8")),
  parallelism: argon2.kdfParallelism,
  tagLength: 32,
  memory: argon2.kdfMemory * 1024,
  passes: argon2.kdfIterations,
});
const loginHash = (masterKey) => b64(pbkdf2Sync(masterKey, Buffer.from(password, "utf8"), 1, 32, "sha256"));
const stretch = (masterKey) => Buffer.concat([hkdfExpand(masterKey, "enc", 32), hkdfExpand(masterKey, "mac", 32)]);

const userKey = bytes(0x40, 64);
const organizationKey = bytes(0x00, 64);
const itemKey = bytes(0xc0, 64);
const otherKey = bytes(0x10, 64);

// A fixed RSA-2048 key (PKCS#8), made once with Node for these vectors only.
const privateKeyDer = Buffer.from(
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCdawXcc0/cSS+B4cSoYYQI+38g" +
  "nJBVE/bmivUmDLYD6q+/8XtNswK+32Ja3sSjH3n3mQwqwnbyjRQUXOBzJ05r00rs92raHSi7tQKx" +
  "qGhIGX5QtjH6s4xWHyLQFM5BhNw2Qx2dDu49bHVbfIi6FE92f5ARozMt0ThxYm91uE2jttx0+R+q" +
  "RcSsyiJS6pi65sB8XLfgtV/VLl5PbrX376QqNub4Zdpt5WkNdtirTe1R07jmQ/AvbDBssvdS06nJ" +
  "nfVPkFT5M88uqUxlyJIkUXEyJJewJKgA7CUBpDgVvbiWoa/RsLOkPYFVSEMNsW71GCYYZvK0aIE0" +
  "lhRWRCweEuYxAgMBAAECggEABYSg9GfnI7Fd0MVqjq246nTw8VJlqZLRJcaXFnfteTSMx7th+3C4" +
  "CttzI9zxWwe9X3daJqVRlLnq61YQYN7+y+8wnh8D7AyHvxE2vIYrDiR1IeSKGtf4hlQR9QX2rzOm" +
  "YcFPaGATrDvpHv1uAEpaGPz6npCoSI3QBwL4peFxmMiQCbyUL4iEkssBBKR2ID7jFhLzdRkWXByk" +
  "ls4QuX21q87wCnK2q6dpihYiqsUBljExO/xEB3biT9SKNXUMGHMrRr6j1RRKnP+TnCuidHFV66yC" +
  "esGmx/lpz6irFBxKtdmckTTKsbq8izLPMZEXH1ZExr/8N9utmpmRpof8emQ7gQKBgQDSaf41+UYc" +
  "GwbGXW/Ppjb/qUwI3Vvzj/uDmHxgWHdqrr+K3tNsUpmhjZ6AARbTjnPODiSyJGt3UjDbEX3eYOqE" +
  "2/MsTmhsUQyM8yrXoUra++3H+ENLXucqxTgHh/RwyZgRiVBFTHgPXMEN+Y4boEiPuXDE2XvmdTv1" +
  "Gi/Au/UAgQKBgQC/hcLSONCQw61bpmtJfG4/mXvzKCVE8Idq8dKUTG/0Dnpka+TPDjbQpOYEgChB" +
  "CutdcRuVk7jIPBn03QlRFP9++b+nN+0tnATUXrDafexPdrUpPX8kW70AMJIwtDCdPAoNZz0m9a6H" +
  "ZPagRYjXmvF2/HH6wITSREDY4y55JScNsQKBgQDIGtENl3DbjcBVqcqJ2fL4FJMg4xNtgIKbVcsC" +
  "/V8j7+htMxgyLiO5Biu0ZFTHAPSVA9JWMFibc2jPDcV8VQLzMxICEtcwG6wp55/YzaWYuHob8Lhe" +
  "13RUspZkYyFOmgmqs8HJBb4wLe/TUH+bOkWHmb3rF0HDm75XjH3Zd2a7AQKBgQCVkzK/Ga4RkTDf" +
  "5g3eO3ai5wy9r3nD6JHp/Oh392Zr1a7SpMzyxGgc9NvLYgeOHKgKtx5S6CalAwNGkCYJk/uiQAzk" +
  "3LG4MCQ5c6ZtTXDz8oKzrZqRW7A06LoTnXZmJhC3vQwuVCu1BC30p7mioRi505h0vEw/Jxz6Bhsy" +
  "c8iXUQKBgGGdwzLzAfnU11UYZyDHqjPTtV0JQ9MtyLX1si6CGPKyhdvJjStb9CuKm/y/vtGEz9w2" +
  "X1mxINxyDNzMR9/7KDo69caReuUTKq641SH9sCobgGmsVoaBNz5u+fXr6GKxDEW4aS2eti98aw7v" +
  "KobRpK3VYCrWHOipXKOVytNP/mUZ",
  "base64",
);
const publicKeyDer = createPublicKey(createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" }))
  .export({ type: "spki", format: "der" });
const rsa = (oaepHash, data) =>
  publicEncrypt(
    { key: publicKeyDer, format: "der", type: "spki", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
    data,
  );

const ids = {
  user: "6a1f0c2e-8b3d-4c5e-9f60-7a8b9c0d1e2f",
  organization: "8f9a7c1e-3b2d-4e5f-9a8b-7c6d5e4f3a2b",
  folder: "1b2c3d4e-5f60-4718-89a0-b1c2d3e4f506",
  collection: "2c3d4e5f-6071-4829-9ab0-c1d2e3f40516",
  personal: "3d4e5f60-7182-4930-abc1-d2e3f4051627",
  shared: "4e5f6071-8293-4a41-bcd2-e3f405162738",
  withKey: "5f607182-93a4-4b52-cde3-f40516273849",
  note: "60718293-a4b5-4c63-def4-05162738495a",
};

// What each item opens to.
const items = {
  personal: {
    name: "Example Mail",
    notes: "Recovery codes are in the safe.",
    username: "ana.lopez@example.test",
    password: "not-a-real-password-1",
    totp: "otpauth://totp/Example:ana?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example",
    uris: ["https://mail.example.test/login"],
    fields: [
      { name: "Account number", value: "12345", type: 0 },
      { name: "Recovery PIN", value: "8642", type: 1 },
    ],
  },
  shared: {
    name: "Office Wi-Fi",
    notes: null,
    username: "office",
    password: "not-a-real-password-2",
    totp: null,
    uris: [],
    fields: [],
  },
  withKey: {
    name: "Backup service",
    notes: "Item with its own key.",
    username: "backup@example.test",
    password: "not-a-real-password-3",
    totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    uris: ["https://backup.example.test"],
    fields: [{ name: "API key", value: "k-123", type: 1 }],
  },
};

const encLogin = (key, item) => ({
  name: enc(key, item.name),
  notes: item.notes == null ? null : enc(key, item.notes),
  login: {
    username: enc(key, item.username),
    password: enc(key, item.password),
    totp: item.totp == null ? null : enc(key, item.totp),
    uris: item.uris.map((uri) => ({ uri: enc(key, uri), match: null })),
  },
  fields: item.fields.map((f) => ({ name: enc(key, f.name), value: enc(key, f.value), type: f.type, linkedId: null })),
});

const protectedUserKeyPbkdf2 = enc2(stretch(masterKeyPbkdf2), userKey);
const protectedUserKeyArgon2 = enc2(stretch(masterKeyArgon2), userKey);
const encryptedPrivateKey = enc2(userKey, privateKeyDer);
const encryptedOrganizationKey = `4.${b64(rsa("sha1", organizationKey))}`;
const encryptedOrganizationKeySha256 = `3.${b64(rsa("sha256", organizationKey))}`;
const encryptedItemKey = enc2(userKey, itemKey);

const cipher = (id, fields, extra = {}) => ({
  id,
  organizationId: null,
  folderId: null,
  type: 1,
  key: null,
  favorite: false,
  reprompt: 0,
  revisionDate: "2026-10-20T18:00:00.000Z",
  creationDate: "2026-10-20T18:00:00.000Z",
  deletedDate: null,
  collectionIds: [],
  ...fields,
  ...extra,
});

const sync = {
  object: "sync",
  profile: {
    id: ids.user,
    name: "Ana Lopez",
    email: salt,
    key: protectedUserKeyPbkdf2,
    privateKey: encryptedPrivateKey,
    organizations: [{ id: ids.organization, name: "Contoso", key: encryptedOrganizationKey, type: 0, status: 2, enabled: true }],
  },
  folders: [{ id: ids.folder, name: enc(userKey, "Personal"), revisionDate: "2026-10-20T18:00:00.000Z" }],
  collections: [{ id: ids.collection, organizationId: ids.organization, name: enc(organizationKey, "IT"), readOnly: false }],
  ciphers: [
    cipher(ids.personal, encLogin(userKey, items.personal), { folderId: ids.folder, favorite: true }),
    cipher(ids.shared, encLogin(organizationKey, items.shared), {
      organizationId: ids.organization,
      collectionIds: [ids.collection],
    }),
    cipher(ids.withKey, encLogin(itemKey, items.withKey), { key: encryptedItemKey }),
    {
      ...cipher(ids.note, { name: enc(userKey, "Gate code"), notes: enc(userKey, "4417#") }),
      type: 2,
      secureNote: { type: 0 },
    },
  ],
  policies: [],
  sends: [],
};

// Strings the core must refuse, each for a stated reason.
const flip = (encStr, part) => {
  const [head, rest] = encStr.split(".");
  const pieces = rest.split("|");
  const b = Buffer.from(pieces[part], "base64");
  b[0] ^= 1;
  pieces[part] = b64(b);
  return `${head}.${pieces.join("|")}`;
};
const good = enc(userKey, "secret");
const type0 = (() => {
  const iv = nextIv();
  const c = createCipheriv("aes-256-cbc", userKey.subarray(0, 32), iv);
  const ct = Buffer.concat([c.update("secret"), c.final()]);
  return `0.${b64(iv)}|${b64(ct)}`;
})();
const badPadding = (() => {
  // A correct MAC over a ciphertext whose last block doesn't end in valid padding.
  const iv = nextIv();
  const c = createCipheriv("aes-256-cbc", userKey.subarray(0, 32), iv);
  c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(Buffer.alloc(16, 0x00)), c.final()]);
  const mac = createHmac("sha256", userKey.subarray(32)).update(Buffer.concat([iv, ct])).digest();
  return `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
})();

// One-time codes (RFC 6238, with Steam's variant), computed here by hand.
const base32 = (text) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...text.toUpperCase().replace(/[\s=]/g, "")].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
};
const hotp = (key, counter, algorithm) => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac(algorithm, key).update(message).digest();
  const offset = hash[hash.length - 1] & 0xf;
  return hash.readUInt32BE(offset) & 0x7fffffff;
};
const code = (key, at, { digits = 6, period = 30, algorithm = "sha1" } = {}) =>
  (hotp(key, Math.floor(at / period), algorithm) % 10 ** digits).toString().padStart(digits, "0");
const steamCode = (key, at) => {
  const alphabet = "23456789BCDFGHJKMNPQRTVWXY";
  let n = hotp(key, Math.floor(at / 30), "sha1");
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += alphabet[n % alphabet.length];
    n = Math.floor(n / alphabet.length);
  }
  return out;
};
const rfcSeeds = {
  SHA1: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  SHA256: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA",
  SHA512: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA",
};
const totpTimes = [59, 1111111109, 1234567890, 2000000000, 20000000000];
const totp = [
  // RFC 6238, appendix B: 8 digits, each hash.
  ...Object.entries(rfcSeeds).flatMap(([algorithm, seed]) =>
    totpTimes.map((at) => ({
      secret: `otpauth://totp/Test?secret=${seed}&digits=8&algorithm=${algorithm}`,
      at,
      code: code(base32(seed), at, { digits: 8, algorithm: algorithm.toLowerCase() }),
    })),
  ),
  // The sample items' secrets, and the forms people paste.
  ...[items.personal.totp, items.withKey.totp, "gezd gnbv gy3t qojq gezd gnbv gy3t qojq", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ===="].map(
    (secret) => ({ secret, at: 1234567890, code: code(base32(rfcSeeds.SHA1), 1234567890) }),
  ),
  { secret: `otpauth://totp/Test?secret=${rfcSeeds.SHA1}&period=60`, at: 1234567890, code: code(base32(rfcSeeds.SHA1), 1234567890, { period: 60 }) },
  { secret: `steam://${rfcSeeds.SHA1}`, at: 1234567890, code: steamCode(base32(rfcSeeds.SHA1), 1234567890) },
];
const totpRefused = [
  { why: "not base32", secret: "not a secret!" },
  { why: "an otpauth address without a secret", secret: "otpauth://totp/Test?digits=6" },
  { why: "a HOTP (counter) address", secret: `otpauth://hotp/Test?secret=${rfcSeeds.SHA1}&counter=1` },
  { why: "an unknown algorithm", secret: `otpauth://totp/Test?secret=${rfcSeeds.SHA1}&algorithm=MD5` },
  { why: "too many digits", secret: `otpauth://totp/Test?secret=${rfcSeeds.SHA1}&digits=11` },
];

const vectors = {
  description:
    "PassBundle core, version 1: docs/core.md. Made by docs/vectors/make-core-v1.mjs with plain Node. Byte values are base64.",
  account: {
    emailAsTyped,
    salt,
    password,
    pbkdf2: {
      prelogin: pbkdf2,
      masterKey: b64(masterKeyPbkdf2),
      loginHash: loginHash(masterKeyPbkdf2),
      stretchedKey: b64(stretch(masterKeyPbkdf2)),
      protectedUserKey: protectedUserKeyPbkdf2,
    },
    argon2id: {
      prelogin: argon2,
      masterKey: b64(masterKeyArgon2),
      loginHash: loginHash(masterKeyArgon2),
      stretchedKey: b64(stretch(masterKeyArgon2)),
      protectedUserKey: protectedUserKeyArgon2,
    },
  },
  keys: {
    userKey: b64(userKey),
    privateKey: b64(privateKeyDer),
    publicKey: b64(publicKeyDer),
    encryptedPrivateKey,
    organizationKey: b64(organizationKey),
    encryptedOrganizationKey,
    encryptedOrganizationKeySha256,
    itemKey: b64(itemKey),
    encryptedItemKey,
  },
  // Prelogin answers the core refuses before deriving anything.
  weakKdf: [
    { why: "PBKDF2 below 600,000 iterations", prelogin: { ...pbkdf2, kdfIterations: 100000 } },
    { why: "PBKDF2 above 2,000,000 iterations", prelogin: { ...pbkdf2, kdfIterations: 2000001 } },
    { why: "Argon2id below 16 MiB", prelogin: { ...argon2, kdfMemory: 15 } },
    { why: "Argon2id above 1,024 MiB", prelogin: { ...argon2, kdfMemory: 1025 } },
    { why: "Argon2id below 2 iterations", prelogin: { ...argon2, kdfIterations: 1 } },
    { why: "Argon2id above 10 iterations", prelogin: { ...argon2, kdfIterations: 11 } },
    { why: "Argon2id parallelism 0", prelogin: { ...argon2, kdfParallelism: 0 } },
    { why: "Argon2id parallelism above 16", prelogin: { ...argon2, kdfParallelism: 17 } },
    { why: "an unknown KDF", prelogin: { kdf: 2, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 } },
  ],
  ids,
  sync,
  opened: {
    folders: { [ids.folder]: "Personal" },
    collections: { [ids.collection]: "IT" },
    items: {
      [ids.personal]: { ...items.personal, type: 1, folderId: ids.folder, organizationId: null, favorite: true },
      [ids.shared]: { ...items.shared, type: 1, folderId: null, organizationId: ids.organization, favorite: false },
      [ids.withKey]: { ...items.withKey, type: 1, folderId: null, organizationId: null, favorite: false },
      [ids.note]: { name: "Gate code", notes: "4417#", type: 2, folderId: null, organizationId: null, favorite: false },
    },
  },
  totp,
  totpRefused,
  refused: [
    { why: "MAC changed", encString: flip(good, 2), key: "userKey" },
    { why: "IV changed", encString: flip(good, 0), key: "userKey" },
    { why: "ciphertext changed", encString: flip(good, 1), key: "userKey" },
    { why: "made with another key", encString: enc(otherKey, "secret"), key: "userKey" },
    { why: "type 0 has no MAC", encString: type0, key: "userKey" },
    { why: "bad padding under a correct MAC", encString: badPadding, key: "userKey" },
    { why: "an unknown type", encString: `7.${b64(bytes(0, 48))}`, key: "userKey" },
    { why: "not an encrypted string", encString: "secret", key: "userKey" },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

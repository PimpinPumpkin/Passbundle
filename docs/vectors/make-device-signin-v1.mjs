// Makes docs/vectors/device-signin-v1.json:
//
//   node docs/vectors/make-device-signin-v1.mjs <eff-large.txt> > docs/vectors/device-signin-v1.json
//
// Signing in with a device from PassBundle's apps, the asking side (DESIGN.md,
// "Approving a sign-in from another device", "Our apps asking"): the request's
// key pair and the fingerprint phrase the app shows for it, the user key an
// approving device wraps to it, the account's private key that user key must
// open before anything is kept, and the wraps the apps refuse. Plain Node only,
// independently of the core and of upstream, so both are checked against it.
// The word list is EFF's long list, one word per line, as passbundle-apps
// keeps it (core/src/words/eff-large.txt). The wraps are RSA-OAEP, encoded here
// by hand with fixed seeds (RFC 8017, 7.1.1), and the account's private key is
// a type 2 string with a fixed IV, so this file comes out the same every time.
import { constants, createCipheriv, createHash, createHmac, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt } from "node:crypto";
import fs from "node:fs";

const [wordListPath] = process.argv.slice(2);
if (!wordListPath) {
  console.error("make-device-signin-v1.mjs <eff-large.txt>");
  process.exit(2);
}
const words = fs.readFileSync(wordListPath, "utf8").trim().split("\n");
if (words.length !== 7776) {
  throw new Error(`EFF's long list has 7,776 words, not ${words.length}`);
}

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const hash = (algorithm, data) => createHash(algorithm).update(data).digest();

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

// The fingerprint phrase, as the approving side's vectors make it
// (make-device-approval-v1.mjs): SHA-256 of the public key (DER), expanded
// with HKDF-SHA256 under the email in lower case to 32 bytes, read as one
// big-endian number, then written in base 7,776 from its lowest digit up, one
// word per digit, five words joined by hyphens.
function phrase(email, publicKeyDer) {
  let n = BigInt(`0x${hkdfExpand(hash("sha256", publicKeyDer), email.toLowerCase(), 32).toString("hex")}`);
  const picked = [];
  for (let i = 0; i < 5; i++) {
    picked.push(words[Number(n % 7776n)]);
    n /= 7776n;
  }
  return picked.join("-");
}

// RSA-OAEP with SHA-1 or SHA-256 (MGF1 with the same hash), with the seed given.
const mgf1 = (algorithm, seed, length) => {
  let out = Buffer.alloc(0);
  for (let counter = 0; out.length < length; counter++) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    out = Buffer.concat([out, hash(algorithm, Buffer.concat([seed, c]))]);
  }
  return out.subarray(0, length);
};
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));
function oaep(algorithm, publicKeyDer, message, seed) {
  const k = 256;
  const hLen = hash(algorithm, Buffer.alloc(0)).length;
  if (seed.length !== hLen) {
    throw new Error(`an OAEP seed with ${algorithm} is ${hLen} bytes`);
  }
  const db = Buffer.concat([
    hash(algorithm, Buffer.alloc(0)),
    Buffer.alloc(k - message.length - 2 * hLen - 2),
    Buffer.from([1]),
    message,
  ]);
  const maskedDb = xor(db, mgf1(algorithm, seed, k - hLen - 1));
  const maskedSeed = xor(seed, mgf1(algorithm, maskedDb, hLen));
  const encoded = Buffer.concat([Buffer.from([0]), maskedSeed, maskedDb]);
  return publicEncrypt({ key: publicKeyDer, format: "der", type: "spki", padding: constants.RSA_NO_PADDING }, encoded);
}

// A type 2 string: AES-256-CBC (PKCS#7) under the key's first 32 bytes, then
// HMAC-SHA256 under its last 32 over the IV and the ciphertext.
function type2(key, iv, plain) {
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32, 64)).update(Buffer.concat([iv, data])).digest();
  return `2.${b64(iv)}|${b64(data)}|${b64(mac)}`;
}

// Fixed keys, made once with Node for these vectors only (PKCS#8): the asking
// device's RSA-2048 key, another device's, and the account's own.
const requestKey = Buffer.from(
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDN2FEg+hT2CJP4m661Mw18+ihY" +
  "UwD7iLFco92r0Pi1093QhyGzuyBlu26tIo+M3djUFQbSbqqT18vzlwMp2sCYJ6f3E9h7YTPmAR85" +
  "uBuIus3nZCUOnUmYQnT9+A1QZjb4PtCyIkNOhfI5qrGCtRjw/diHwUzoT1vGgFzBEEY5PRa8J67m" +
  "KajLG/tZKqJczytCDJ+zdGLFbn4m8zZ6v1HnjmfgSWLMbz03tngruiYZ+JhQ5ll5grjrRdsq7feq" +
  "f1sPoZng60qfZwd9fjDcMIeGlnAAS7ztUCd2XEm6L+hjA9K2pd5K+h1ROK9ItGs2XgSneudsFj3g" +
  "T2tgUxnYQrxlAgMBAAECggEAAsGSOIRQsoij3pDLEo8H77PzxVb7LOMEKO7iwXGvWtPm5OtiRqNL" +
  "SEFttnC/hk3UIObVLA0iSI97ohvUBYPxzze8toC0Bdbj2IEMV3wBFmAV8LK1ElCF0z2Ujm/7UafE" +
  "tac1qSTvTMZbW21PKiZdmqBzfUHX00Z4vpwqYcVjg1GpafH53qfwUIMZWXV0vVF38da70HMDOY/o" +
  "legUjkFUGKqkCCoZgJlWWg3VSGcjrzvl98IcJM5EtSi5Z5JkhBGqbz3GdWjYVhNpWK0Mnq1skVjf" +
  "TOGLwFgB2q7Cd9ZF4qA4Aahd9Nk6c12D9yy6X6Jv4Qg92OdxAFWyudk0AQ47YQKBgQD2vip3oXhm" +
  "TwsK4bTHH9w8AA1hEWI5Qe50y48CNEnAjeis89pOlhF8tSqHgFZk5oGQcCbhFO7zK7aBJQDuPj17" +
  "pKekKRr5i1YoHJpe6ZlOAZTtsDiTmfkxZBasC7IFASW1M+HDFK6+L0O59q1X4mnPnCNiP9vWyfRH" +
  "F3QIgGqYVQKBgQDVkVlQLGNf0ZIS3/WUaWDX1EBnRvQP9v1LfVSbc9u4JxuIzS35BdaxFFyUjq0Z" +
  "7SHI0R4Fnl3xYl6c4/9kBMiCPBdd9d2E4otHgN2beOxXMpuA7RMfcErL3B8QA8E2/qV6wdF+Mbf0" +
  "6alNOVG/DkipT5LHNXrCLML7ktj7+IXj0QKBgCahzZpfcK9sDsmMXzaSGXRXecDJ7PwUA5bLzD9H" +
  "GokIbvatU2/cdS52WwtOH7i6kmyf8qZpFaSDIpcDySqEGjJCrHC6ctvBYiLzn4PexT7+Zmf0oFcT" +
  "031VM2uKhTvdWx8M2XsmwNlMIyl5othQvcpgovWeE/iENDfxRxyRpp7lAoGAHfX4G6E+h7C012UH" +
  "5Lwr09t49YQktSCnRDHe7rgAOQNzf2uZaXgCOHFs04J4kkyMEsoTdiJTd4ufTk9GAtgQ8QRRGuNl" +
  "IkFN3MgdTrRWI51750hbCGwOci79RJfiQT7UJDaQly2OaxNkpurFpxHv66C4LK45/IefCv/85Mxm" +
  "rCECgYEA8NrQk+m3lkfL/NUGRoPtGH3fOCRs3aKWxz2X1kFrPygh7DRz91BKUyI8AaxiaQ3nyo07" +
  "CCq08aMObAN/a6TckQyXSQDiwnieGjKkX+r5u0sZtwbMJSsh4+VCI3e+lXjILvyMC2sYm7FCU0RF" +
  "satJvqo1tnr1ZGIqL5gA2NHYo1Y=",
  "base64",
);
const otherKey = Buffer.from(
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC3+fo5C/w3bky9lD4UklUolT1Z" +
  "Qq5klZw0Oa6gm3c/V7X+i7PlOHKFNDyPCXIws3bZtvwcB7omr+DYItWcDT5j8IEOUGd1i/5Sm+AN" +
  "y2CP0F8hF7Z/GghSb4UyVoE7FNawhjJk65mrz3NO8E6iv9l9m0QOBVVUIwSgM6N9LzanW4+jBQMW" +
  "Sk5V8gvIsv/4Zy/z6PvkRaMkDMo4FBMkJAOdpWBVWkjsuehOU1x3I2LMa5ORkIjDsDl7JwmLNdXK" +
  "/zE5k5LiR2N3/z6Mk6BJquN6yfGgHNBlJPMKIWWIwmhy5kBtMyadVMbAOYaUSTnEtzjSw0p4x7/G" +
  "X1SdT8KgRDBnAgMBAAECggEAH1WKEpFCAcbddyR6dlJ+Ao14h21d+m+ozRRN87jG1JkBvDrbBt1Y" +
  "U+uTrOD0++p1AZuy0KtYPyKRbv5v10ZCLA9YS7HSDSksxbEatf6/kX7x1NcPFBLA/BlWXD5zgDaK" +
  "YkJY7utZnvOUNgujuQBn8IazTpgF8nCMZySkYbva2SHqJKaEwug9rMQWFsKXg1b6JRlxx3S6mzYY" +
  "E4WTlzBZVdB9OocFOGsuSWYy5Dz3B01y20lQcbwryl883sS2oKt076jstojnz1Glsxhyl/yb3JU5" +
  "m9aueG8VccIXTkeUGoG8Uoj3b8wPYKH4VRPsl6QEpy9qlCWLK5iYUOeHGTAosQKBgQD/4fPSMMyv" +
  "bTZ9tvGoEyWZ2Pkw1yjDEX6n0Hd1Phy6lLpUXdg1ZpMCiAiDsiH2cLmr2YUxOoeoV9hk5pv0891i" +
  "+XX2eOAxZZDHNDTmuGGSGI9lN0CNhvoggQn0ppABdNd4QwC8FktsmyQv3hInNXZoh9YilGPL+JNE" +
  "TjVO9cSx8wKBgQC4D5TOJtUU0UxwPAgdRn06o4v1yAVjcf6T8QvHqyID83R+tcVTzPdEtkXLXZJ7" +
  "E4fWuu4hBKwKf0x1cVP8g5nbNL49Jv4CCoIqubPd1zXfXqA82Ma9uk6mTC/dfrsKPdITtNUGjzaB" +
  "znM2WXXUge/YtIRwsp5oAxp1GMBFgSPwvQKBgDFSBAUHkuxdSJuCn6GdzymQQLfBQQIYZSlDbUMT" +
  "7cWo1SFd1Ua1trBOOBXqR9GQeLk+/AU5Gty/0d3g9T6JoqppGuue8NeUlAtRbMDr2SKnyTvhIngl" +
  "BCEvvhOB50/gjYeIoqOeSHtui9MOIsGb9G7Bf+y6XWH7T6diy7Oke30xAoGAIKprP1b29BXdGgId" +
  "coyjBvgli74u7qI5iyn5bDs78zWO1DoQRjoXHDO5GUmHCJ7DueE9B9Ebc1V6TVGKlUMJ2DR5GsND" +
  "yzrwNQL2IAXkwrq5d3MFeoCJGsxkpkuqiDvGf8bVE6/w/YKVQe0Ik2loFq6a3qFkqZL7bBKzdOJh" +
  "bYUCgYEAyIO3kYcay5ZbZd7gG1zzcQ+V3pKZ/zoA46pQv4qM42GJN4IwnFB8xPNXxO4r2+Q7//lm" +
  "dEqL74rWa/jpntagxSQ5pY6wFh+krsU21FX3vtDZVIzeGw2VQH5HlRbbY74PsG+Cu5IWEPoe5ZGl" +
  "maFJYmZWazA9QSyH0W0Fi7KHMho=",
  "base64",
);
const accountKey = Buffer.from(
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC8waj0/LjyXk1TPFEfH/1hEGjP" +
  "tn1JiiynTKBAijiY2TnSyjOH+R57MQ41HRCRNU2A2L8hDeoMfY2fDXeqxdc94swAp03dFHxiWCSA" +
  "dz58Dp/t+SCOjaFqGyq8M9m+/P/zUX7Q4VGTtBaNY84fiht581MHAIzm0/mg7+ey6fSAfu4nnPTM" +
  "q9PER7Pc1rF7jXeBos2JoFzwBdIjfsU1srnxUHN69fASoQvvxNhrNNWDE5RE84eRcoPEFZbZ2/aM" +
  "RwutGXdYloR8pZi901kBCQ+unJgygREOlCKAywLmNQywhXbf/jeCP3ZL4Umk3WN4oziGhFJzaeqO" +
  "MFJ0ux9a/+PvAgMBAAECggEABU7g5HrS7KXwQL36fgiVRIyElgrIvS+wj8fc3dPFQa8iLCZZiqJb" +
  "1BUOFDpMA/lew5fU0CYnBdDmEan8SoYjxm7BU+dgji4MTWuzIxW3YR+8KaIO41NiTayT6BUBM5jD" +
  "zeDl0xPzCldPJwy+eC6XFTfdht3iGH+vjnIQrvxbTt22kaTvG5i5PWSrmOdrKxYkToPBXGQ3ef7A" +
  "7wSHQ73RabHwqJogK1iYDQODDe6TXq3HW4vXxdBWx/yUHEg0iVtn8/69LulfTImI0+U6iC4xAUEx" +
  "ZtbLH6UWQmrIqCWS8MCwb7p/246tIL1z2v1q3VB3LjRfL0d+yY20e903T68suQKBgQDdYWNuAmxu" +
  "KEHsK5srpR7ykjW/pD/L5tXVFBlKeWD75VQerarGWYt5NjwPnkqCqyozKJYEYisBNb44/YDD8CWF" +
  "CuV61RdHRrKbW3jdWkqGqu3VbhUvtk1iXWWgzX+R5QNkC4Hrbd7TmhZrpASzmWywnMCzcvOBCsXV" +
  "p47qtjSdMwKBgQDaRjlsC/j+zebOR6nNcSCtroyaTrmfUEY5GTHEmFTqbMCxPJXs0UlURb/H58Zx" +
  "yJyPdacWVOgjo665R2hHpSrtpQYfkOS/p3T0BJXf4hg9zi1ZnM6B219Zjp+2a73NQi77kzWnDcZb" +
  "YQI1CN1uEZbcjS1pbu+G9EbIs+8QQ8WGVQKBgQC657VNtMgc/OojXfGFGMSXIfA1G5QtL3fLjUuJ" +
  "AA9svIKX4CH1krZZoPt2aDsaNS7MwHBfxQ3v2JMAhK7JPqA+wiNa4DvmFn9HASR7JfcT2Y4xCt7i" +
  "SHTvHlFmQPl6kLKbLcgDn+BoIIjbWkAJ7ffA6KcdGmkRwqmip/PWn/yt1wKBgCORI9Q2Uzl55a0h" +
  "QksGrxN+CM0wHNEX7IlrUI+/Xr7gP7nhrHBtXeyMfQae/tgVn2VE/5gE99qu1k68kwJxqIAWztuf" +
  "6ZZNPCJzCNT1a4vOp9cdVQ0V6QCX2/CGt+PVcABwaWKyPOsw8IIh0qsX1KRVoNu4RvGPpmUX5NGa" +
  "qXoNAoGBAKs9ZtddJHw99a9KM9bAuNJ8QeoI0GaMweGOY/P4KRV5j6RXawzEliEPiDuzCg4wB3AP" +
  "/0+UH7d+WDccb4HUsihaKF4GVaeFrOwOD+i4o2wmnEBixyK9Ui1bUeicJai+D8IhTHaFtg4IEt1r" +
  "pTmlFHSZJ4POWezCeZrsRNfUVcox",
  "base64",
);

const spki = (pkcs8) =>
  createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" });
const requestPublic = spki(requestKey);
const otherPublic = spki(otherKey);
const accountPublic = spki(accountKey);
const opens = (wrap, algorithm) =>
  privateDecrypt(
    { key: requestKey, format: "der", type: "pkcs8", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: algorithm },
    wrap,
  );

const email = "dana@example.test";
// The account's user key, and the one wrap of it here, as an approving device
// sends it: RSA-OAEP with SHA-1 to the request's public key, type 4.
const userKey = bytes(0x40, 64);
const seed = bytes(0xa0, 20);
const wrapped = oaep("sha1", requestPublic, userKey, seed);
// Node's own OAEP opens it, or this file is wrong.
if (!opens(wrapped, "sha1").equals(userKey)) {
  throw new Error("the wrap doesn't open with Node's OAEP");
}

// Another account's user key, wrapped the same way: it opens, and is 64 bytes,
// but it doesn't open this account's private key, so the apps keep nothing.
const otherUserKey = bytes(0x90, 64);
const otherSeed = bytes(0xc0, 20);
const otherWrapped = oaep("sha1", requestPublic, otherUserKey, otherSeed);

// The account's private key under its user key, as the server's sign-in
// answer carries it (`PrivateKey`).
const accountIv = bytes(0x10, 16);
const accountPrivate = type2(userKey, accountIv, accountKey);

// What the apps refuse: each ends the request, and nothing is kept.
const changed = Buffer.from(wrapped);
changed[changed.length - 1] ^= 1;
const shortKey = oaep("sha1", requestPublic, bytes(0x40, 32), bytes(0xa1, 20));
const longKey = oaep("sha1", requestPublic, bytes(0x40, 65), bytes(0xa2, 20));
const sha256 = oaep("sha256", requestPublic, userKey, bytes(0xa3, 32));
if (!opens(sha256, "sha256").equals(userKey) || opens(shortKey, "sha1").length !== 32 || opens(longKey, "sha1").length !== 65) {
  throw new Error("a refused wrap doesn't open as this file says");
}

const vectors = {
  description:
    "Signing in with a device from PassBundle's apps, the asking side, version 1: DESIGN.md, \"Approving a sign-in from another device\", \"Our apps asking\". Made by docs/vectors/make-device-signin-v1.mjs with Node's crypto and EFF's long word list.",
  // The access code: this many characters from these, at random (upstream's
  // generator's letters and digits without look-alikes).
  accessCode: {
    alphabet: "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789",
    length: 25,
  },
  email,
  // The request's key pair: the private key (PKCS#8) stays on the asking
  // device; the public key (SubjectPublicKeyInfo) goes to the server.
  request: {
    privateKey: b64(requestKey),
    publicKey: b64(requestPublic),
  },
  // The phrase the asking device shows, for the email in lower case whatever
  // case it was typed in.
  fingerprints: [
    { why: "the account's email and the request's key", email, phrase: phrase(email, requestPublic) },
    { why: "the same email typed with capitals: the same phrase", email: "Dana@Example.TEST", phrase: phrase("Dana@Example.TEST", requestPublic) },
  ],
  // The approval: the user key wrapped to the request's public key.
  approval: {
    userKey: b64(userKey),
    seed: b64(seed),
    key: `4.${b64(wrapped)}`,
  },
  // The account's keys, as the server's sign-in answer has them: the private
  // key, a type 2 string under the user key, and its public key.
  account: {
    iv: b64(accountIv),
    privateKey: accountPrivate,
    publicKey: b64(accountPublic),
  },
  // A wrap that opens to a 64-byte key that isn't this account's: refused
  // when it doesn't open the account's private key.
  notTheAccount: {
    why: "another account's user key: it opens, but not the account's private key",
    userKey: b64(otherUserKey),
    seed: b64(otherSeed),
    key: `4.${b64(otherWrapped)}`,
  },
  // Approvals the apps refuse before signing in.
  refused: [
    { why: "wrapped to another device's key", key: `4.${b64(oaep("sha1", otherPublic, userKey, bytes(0xa4, 20)))}` },
    { why: "a 32-byte key, not a user key", key: `4.${b64(shortKey)}` },
    { why: "a 65-byte key, not a user key", key: `4.${b64(longKey)}` },
    { why: "RSA-OAEP with SHA-256 (type 3), not what an approval carries", key: `3.${b64(sha256)}` },
    { why: "a symmetric string (type 2), not a wrap", key: type2(otherUserKey, bytes(0x20, 16), userKey) },
    { why: "the wrap, changed", key: `4.${b64(changed)}` },
    { why: "not an encrypted string", key: "not a key" },
    { why: "empty", key: "" },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

// Makes docs/vectors/recovery-at-unlock-v1.json:
//
//   node docs/vectors/make-recovery-at-unlock-v1.mjs > docs/vectors/recovery-at-unlock-v1.json
//
// Enrolling in account recovery at unlock in our apps (DESIGN.md, "Enrolling
// at unlock", "Our apps"): the install command's fingerprint of an
// organization's public key, which pins the one key the apps enroll to, and
// the user key wrapped to that key as upstream's enrollment wraps it. Plain
// Node only, independently of the core and of upstream, so both are checked
// against it. The wrap is RSA-OAEP with SHA-1, encoded here by hand with a
// fixed seed (RFC 8017, 7.1.1) so this file comes out the same every time;
// the apps always use a random seed, and are tested by opening the wrap here
// and their own with the private key here, never by comparing ciphertext.
import { constants, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const hash = (algorithm, data) => createHash(algorithm).update(data).digest();

// The pin: the SHA-256 of the organization's public key as SPKI (DER), in
// base64url without padding, as the install command's -OrgKey carries it
// and the extension checks it (DESIGN.md, "Joins a hacked server can't
// forge").
const fingerprint = (spki) => b64url(hash("sha256", spki));

// RSA-OAEP with SHA-1 (and MGF1 with SHA-1), with the seed given.
const mgf1 = (seed, length) => {
  let out = Buffer.alloc(0);
  for (let counter = 0; out.length < length; counter++) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    out = Buffer.concat([out, hash("sha1", Buffer.concat([seed, c]))]);
  }
  return out.subarray(0, length);
};
const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]));
function oaepSha1(publicKeyDer, message, seed) {
  const k = 256;
  const hLen = 20;
  const db = Buffer.concat([
    hash("sha1", Buffer.alloc(0)),
    Buffer.alloc(k - message.length - 2 * hLen - 2),
    Buffer.from([1]),
    message,
  ]);
  const maskedDb = xor(db, mgf1(seed, k - hLen - 1));
  const maskedSeed = xor(seed, mgf1(maskedDb, hLen));
  const encoded = Buffer.concat([Buffer.from([0]), maskedSeed, maskedDb]);
  return publicEncrypt({ key: publicKeyDer, format: "der", type: "spki", padding: constants.RSA_NO_PADDING }, encoded);
}

// Fixed keys, made once with Node for these vectors only: the
// organization's RSA-2048 key pair (PKCS#8), and another one, which a
// hacked server could serve in its place.
const organizationKey = Buffer.from(
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDr3e7Eb3dv6uKBottG2npvhdfq" +
  "WXFvamb46M1y2nQnMx+YOgnlNh4Tqc2kqkzfISUxu6+hNI6+ihJgJkh5l3ZS5YdYvlR3/ZCJyA7S" +
  "9xMWgPl62lQqKLLnmXNs6imP1ymyEiN9+Fi/8fG7SXbmphDXUjqSESSSbXfvQKJwgD4YBGbVHNkh" +
  "y3xxengnIyWagvjtvyoJqL6CeM7hqxmmPSXglWxOGkFcdKeKLAB+EFSsWP+xQ9fybW/eb++Bf7zL" +
  "M0aH4W2aMrAThRyza4LyHgH21L8CI+uwrXN7MQ5hgQljbXlIfA8zM8DDF/Cd7s6ZzU+sY8ITjaSe" +
  "bSal7sqN/sH3AgMBAAECggEAHHkwsz7/jJ+u01Z9IRsLz725GH3Or1QJdT/pWVWc0wSdakuLWUPE" +
  "srv7asbyO7dtHYlaRNwq5T6WxEuq0R7jNlOmGKT1XnzaP3/KplYUVFGijF2h7mr2WfYQ1JOaC9a+" +
  "HlSJO1JJKHbFJ0ZRl7txagTvtCVkpFaZtWS4l1sr48sc5MZSDUu3+dgl7S0F9P3quXLGguIGYEjf" +
  "tqER5DiFcRxycKHaN+is5OwgJNk1tNl252DUq2Nd9ciJKEQKozOLusRU1rS5d1zD4AXkw9Gy1cBV" +
  "UWnS/k8kzeEU0xsvrZw55hQmpDjtHkdTgQEo953KKuW4FuJycxyUF975dO8VSQKBgQD7cXMZoutO" +
  "UA3dTvbKc+wJ6IctO7bt95d1c3REqeSpAULXVEQUOHKh93yu6KVcP3MqtGFZ8es8zXLYoqJHQIMc" +
  "dPGnIR9FZCESCPza8jphVxPXmRx8iRxqYp5wvwtI/zY44J+qKtf++tpalSO1Gk+nG0YfkSUdWKrN" +
  "XrL0cLUSyQKBgQDwJDfm888BaOpGQA9kMb2xBuKYnn2PbaMDBLv314625u4oSHDaKpifQQNAymzH" +
  "2qqoQg73d3iw7xgDWVVhgRqwYbntn/fTdRcmxobFEPmwydiF5D5ZQpS8oiVzGBCK9XlLPFqh0jir" +
  "f0JNGuBLg7SLaAI2PH9tUcug/DGFD4jOvwKBgQCWeE7r8Y4lIE0buix//R0s1MVIMWsIP1mZBM14" +
  "Zb8b0FBisd/Hxfv7pzIrLbf/W00dKjLz84zVpxDqSXEZeKa9edI/NNgU25XayBwhHkIHjGeoZs0g" +
  "TaD+nSO5zun+9hNJuEp0OA1oXlAbUxK6RxORqgWt0FtIk44rNlebZnNF2QKBgCiJhKJI793GDx4S" +
  "vEZmmyXiCqhGwN1QXZ8p0m0xBxda/kLwj5RUcnUXrWvnf9twzzQeCpa9pTMA+WW/U8lk2NODe7Zg" +
  "NZ6Nen4CL0fe6LduK03WzKuWsLLzEC1Ql6JNc88+ffIpIYXZsqB/c/NrZTPPN+hd6AjVMPGZAOb8" +
  "S1TTAoGAGL7Jv2KBMmO479fzZ+KAxyhI/KGpMn90S+9eTOeQc/pk8Q+zZk6SYBWe4bxnM/faLi/w" +
  "RoeIkaZHP5hD4+kkGllKHD3RN66rSDuq+cLqoTV+N34AZPt2xgi2QyYF1psiZqDwPK07pcXbCZqF" +
  "HWWKppm/Li0ntUjqfGqTHTpzsIo=",
  "base64",
);
const otherKey = Buffer.from(
  "MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCs8QDSU2pKPT2Srz3LtES9IJTX" +
  "TAI8eDRDL6J+NPaKrE/Ufvyk2FV41ESCcyPJrrqZQ95zN4VQtCKUfLaDftMADFsA+Ja7VBMKOOmi" +
  "M5ddTtQ61Y1BDCQwYwY9z/u5SRjGNDZBJd/Qn8bwqF/KD2qfd4IYOpkGVmKQOGj9TtGLxFOKagU7" +
  "GTUeLFp7Wc4oFqR+8CfhjiaC9XfQOl0okP6hOwmE0SmuIPf3bjQEnk9F9uUOY3BUvoiqeKxgQfXx" +
  "J/95Y0TgQnMmjxlktnUZ79FjuraVyKdXxTrUDXgskXqpoyqD2cpRizuFb/LFlqIYC8bhpgd+MNro" +
  "1lH1y0fE2UXDAgMBAAECggEAA3SfVRSIm6okmFE7FV5pPzQu9SxWIRovxSXnA8mQIY423CKbbrnJ" +
  "32uyYL7nOKjunpBeGgRCfC3VQQ1K4k6+7ZHRoa/V5zFTXhFsDaslO56PHAvXUjTpZjQcVFDbEUU2" +
  "IwO5D80vby46HeXnYBS1xzDunwhQtXE1b/dIlcMk6bt+nD9qfH2wAftDuTp7z0UTRtjPvOHksn0+" +
  "bi5I/CiN5rkYX9585e4o6mpZarka/kjAnidAMgdNKzRlN3FkDdhDxqFk76dEGN7weXy+x7tH9yMf" +
  "3/t3ymGXL/UDJd3GWtHktavlthAxaKI+PdyOBaauGISeM4k2LwcW6RKmdr3tmQKBgQDY2wGuEEFp" +
  "N+ev/parKn3k5Z9EvyJ0xCj/qHKDIiduhi3MdY/+/Skw4Iw72X4DpjkW3hE8kqKi9q4EUVwCRw2Z" +
  "bIvrmLHOeBrWp/QvyRubUBJRW1p5rqseoFprqKbGBm6zkMdwSRgEVjmcNjIZwnvbTKso0Y2en8TL" +
  "LVTbFgoSqQKBgQDMKLTtt16XFTs9/UJlaMAIoZtzqip7Oa2x10rl9hS05vQAK4fJJ9EymLypqc1d" +
  "C2ks7Juj0djN2c2BrNY3EGHUCUn+RH7N528DN0p6ZaMahy1tUgSn38QURm2Hs1beW2jy+mG+0W/l" +
  "y3r7JWBzLjpw3tXH3oF4QWQJiYBjOPKEiwKBgCOrgo87JUdFZtrQKcBl8OdhzdzlA6npSkUjVBK1" +
  "336Sm53yCImM4uWjSe3eTJgVE3breDJafF4J7X3QVC4bueTuseVC7JxlrSR54/SoQ948QYcYW72A" +
  "Oa2D+tuSljwkerkWq3eQzl6IQFmtoHgUQYNFDTJdpcndxeUVw8t1yJphAoGAJD0hiIShDK5fGqzG" +
  "yVtjouSUxF4zNjZRx5yQlestV8MbEqCndKRVtOZ5rqAObPKmk6vYIKcSFdAQc3ErgRCuXMXdVX3x" +
  "CDmJcgexd7Js1juia6JAY1AL7RFnRcwmokeVhHO/P/DLLP4GcWf8C9Xr17cmOVkcoCzzReIbYQFt" +
  "wusCgYBausE1QL9iF536lwstQV1pXrPJ5GrwWsMez9GtaT4rAs3uGkHzWo1JHneyR/N4wfjYtnWV" +
  "tpMjpCckoA+owXpLBL0/l+SyeZnDfBLAxdLL+u/MXBHR1wLCCyF7H8SMLaJCSm0K4/1vaw738/Kr" +
  "8lyFcxsiiZE+m6BiaSVwwazMGg==",
  "base64",
);

const spki = (pkcs8) =>
  createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" });
const pkcs1 = (pkcs8) =>
  createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ type: "pkcs1", format: "der" });
const organizationPublic = spki(organizationKey);
const otherPublic = spki(otherKey);
const pin = fingerprint(organizationPublic);
if (pin.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(pin)) {
  throw new Error("a fingerprint is 43 base64url characters");
}

// The account's user key (64 bytes: the AES-256 key, then the HMAC key), and
// the seed of its one wrap here.
const userKey = bytes(0x40, 64);
const seed = bytes(0xc0, 20);
const wrapped = oaepSha1(organizationPublic, userKey, seed);
// Node's own OAEP opens it, or this file is wrong.
const opened = privateDecrypt(
  { key: organizationKey, format: "der", type: "pkcs8", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
  wrapped,
);
if (!opened.equals(userKey)) {
  throw new Error("the wrap doesn't open with Node's OAEP");
}

const organizationId = "8f9a7c1e-3b2d-4e5f-9a8b-7c6d5e4f3a2b";
const userId = "6a1f0c2e-8b3d-4c5e-9f60-7a8b9c0d1e2f";
const resetPasswordKey = `4.${b64(wrapped)}`;

const vectors = {
  description:
    "Enrolling in account recovery at unlock in our apps, version 1: DESIGN.md, \"Enrolling at unlock\", \"Our apps\". Made by docs/vectors/make-recovery-at-unlock-v1.mjs with Node's crypto.",
  organization: {
    id: organizationId,
    privateKey: b64(organizationKey),
    // SPKI (DER), as the server serves it (GET /api/organizations/<id>/keys, publicKey).
    publicKey: b64(organizationPublic),
    // SHA-256 of the SPKI, base64url without padding: the pin.
    fingerprint: pin,
  },
  // Another organization key: what a hacked server could serve in the
  // organization's place. Its fingerprint isn't the pin.
  other: {
    publicKey: b64(otherPublic),
    fingerprint: fingerprint(otherPublic),
  },
  // Whether the key the server serves is the pinned one: only the
  // organization's own SPKI, hashed and written exactly as the pin is.
  checks: [
    { why: "the organization's key, and its own fingerprint as the pin", publicKey: b64(organizationPublic), pin, takes: true },
    { why: "another key (a hacked server's) with the organization's pin", publicKey: b64(otherPublic), pin, takes: false },
    {
      why: "the organization's key with the other key's fingerprint as the pin",
      publicKey: b64(organizationPublic),
      pin: fingerprint(otherPublic),
      takes: false,
    },
    {
      why: "the organization's key as PKCS#1 (RSAPublicKey) rather than SPKI: not the key the pin names",
      publicKey: b64(pkcs1(organizationKey)),
      pin,
      takes: false,
    },
    { why: "no key from the server", publicKey: "", pin, takes: false },
    { why: "not base64", publicKey: "not base64!", pin, takes: false },
  ],
  // What counts as a pin where an administrator set one: 43 base64url
  // characters, around which spaces are trimmed. Anything else is none, and
  // with none nothing is sent.
  pinForms: [
    { why: "the install command's fingerprint", value: pin, pin },
    { why: "with spaces around it", value: ` ${pin} `, pin },
    { why: "with base64's padding", value: `${pin}=`, pin: null },
    { why: "one character short", value: pin.slice(0, 42), pin: null },
    { why: "in hex", value: hash("sha256", organizationPublic).toString("hex"), pin: null },
    { why: "with a character that isn't base64url", value: `${pin.slice(0, 42)}+`, pin: null },
    { why: "empty", value: "", pin: null },
  ],
  enrollment: {
    userId,
    userKey: b64(userKey),
    seed: b64(seed),
    // The user key, RSA-2048 OAEP with SHA-1 to the organization's public
    // key, as an encrypted string of type 4: upstream's enrollment
    // (encapsulateKeyUnsigned), what the apps send.
    resetPasswordKey,
    // The two requests, in order: the key, then the enrollment, without
    // the master password hash (the server's no-password path).
    requests: [
      { method: "GET", path: `/api/organizations/${organizationId}/keys` },
      {
        method: "PUT",
        path: `/api/organizations/${organizationId}/users/${userId}/reset-password-enrollment`,
        body: { resetPasswordKey },
      },
    ],
  },
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

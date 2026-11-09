// Makes docs/vectors/device-approval-v1.json:
//
//   node docs/vectors/make-device-approval-v1.mjs <eff-large.txt> > docs/vectors/device-approval-v1.json
//
// Approving a sign-in from another device (DESIGN.md, "Approving a sign-in
// from another device"): the fingerprint phrase both devices show, and the
// user key wrapped to the requesting device's public key. Plain Node only,
// independently of the core and of upstream, so both are checked against it.
// The word list is EFF's long list, one word per line, as passbundle-apps
// keeps it (core/src/words/eff-large.txt). The wrap is RSA-OAEP with SHA-1,
// encoded here by hand with a fixed seed (RFC 8017, 7.1.1) so this file comes
// out the same every time; the apps always use a random seed, and are tested
// by opening the wrap here, never by comparing ciphertext.
import { constants, createHash, createHmac, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt } from "node:crypto";
import fs from "node:fs";

const [wordListPath] = process.argv.slice(2);
if (!wordListPath) {
  console.error("make-device-approval-v1.mjs <eff-large.txt>");
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

// The fingerprint phrase: SHA-256 of the requesting device's public key
// (SubjectPublicKeyInfo, DER), expanded with HKDF-SHA256 under the account's
// email in lower case to 32 bytes, read as one big-endian number, then
// written in base 7,776 from its lowest digit up, one word per digit, as many
// words as 64 bits need (5).
const wordsNeeded = Math.ceil(64 / Math.log2(words.length));
function fingerprint(email, publicKeyDer) {
  const material = email.toLowerCase();
  const keyHash = hash("sha256", publicKeyDer);
  const expanded = hkdfExpand(keyHash, material, 32);
  let n = BigInt(`0x${expanded.toString("hex")}`);
  const indices = [];
  for (let i = 0; i < wordsNeeded; i++) {
    indices.push(Number(n % 7776n));
    n /= 7776n;
  }
  const phraseWords = indices.map((i) => words[i]);
  return {
    email,
    publicKey: b64(publicKeyDer),
    publicKeySha256: b64(keyHash),
    expanded: b64(expanded),
    indices,
    words: phraseWords,
    phrase: phraseWords.join("-"),
  };
}

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

// Fixed keys, made once with Node for these vectors only. The requesting
// device's RSA-2048 key (PKCS#8), and another device's.
const requestKey = Buffer.from(
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDhkpgz/cdioz6f6pJoRRFrXvp1" +
  "nxuH5OUTCNR/eNQMKusWE95IXt8V4YmhfhgO+wCvx8Jd+56pVHzo5qcw/+1gY6kuRoD0okbZNV6O" +
  "XKvmt+Ed15iaabRLG26ERZcVaaU7bBDWS2ZA0Ewo369v4s/0R6YGIiD1EdRYDSn85fKmGt+2CBFs" +
  "X737Wi38oAIuB3OJcf6xg/0iUk/jtaA+mTRBlSfhTJydSDKnQeXMApLBi5GYp5CIJfVs83m8515v" +
  "PMC88OfM4sYBe9sXzRIhaGkEIbsKPaZwVPN0Esr3WEofOK8WYLW8KOfJDz5L45O8Uln3Hk4zfKg3" +
  "yCz1S7rDOMtXAgMBAAECggEAcDhZ+COc+fl0wmIUjEMwM1aBC9sn+ydov1t5PCGEfLktU0J3J1Hr" +
  "chtOOUVd+rXs1YZvsAnqGRurOMLnEn2APp/WHut8ZDgHPzBJ5lE8Q//ewtXrWYaU53iyNqPYUhLI" +
  "3RMaHUJNkJkQCpWd1e/kvQaYFh0MgF9qYJPL+8D6Qp/UpwkciHAULVRP9AjSQQ+LRJecgI+AhJX0" +
  "UtVsDodADFcy/pR34I0Ym9JDGEoUMAdv3EjQPFY2FCZkZFs2+yJpw3tyRzhFz8Egk+5LjH2FQzSY" +
  "9NCxH0mfHlQ7yEydyGySzyAR4Rju8jPJCWs17aMN8bSpwYNe4792VAV74yR+IQKBgQD7x2dcsNY/" +
  "/WxRtTKAgJ1cga/P6T1HSg1dYA6EHp9E4/qiqhfhnXTNRyTGVfjIgUtlL/SezbAXgXAkMB9oDCOx" +
  "W00aPF/hNuj9gFYWCXbuqjqHoclxpelA6RQDnI7x6IIkel1R6kVgRWlTo+/Ef9EcGOz/OF8yOqJm" +
  "IZP1K1TYXQKBgQDlWrerA/0Y4ZCKJYB9bDLvtRqFx2WTO791qhzlQcageVeQwnAyRpwkQtnjfBcy" +
  "eZJd8LffACpIPwVjGKPxkDgVVXnMOXZCiqMRsBjMdVcA7N/JlgtSiJHWmUpkAm9YvU5GjWrueTRG" +
  "4pISwOtNpMTdWQFyvJMT4TVGiF+c0mYnQwKBgCwF4qHHXb7UjdL/jrP/SQR6vIXq70b+wLV57S/W" +
  "ttxxzEoS2ZgeUuTtspVnRNeyG7+2kdwOdOK3RCdfrq4fqUICh8m1ksIrOrPQc7zorL3wT8mVVUak" +
  "ztMFrfUvs6LCl7bPGnAPOVAq8s6oFG1UN/jkttOtRJ/gtrKK3nb4u54VAoGALDQiyAQZyKzYpbd6" +
  "nzG2U3rNJNF8YzcVvIDP1uOpe45HcS/4Xcg8GcUEp5JoCiNiMVbOqV0nyQrUZ/f8yPbpyDrUIadF" +
  "gqejrCoLbYSEAzqkGv8fKYYGzZx3uPS7Lxg1OOXSoSmdCLhsPM8PysQh6SNZYxqzIha6pOBtxRTL" +
  "+W8CgYEAj99EqehVRcg8JoYcphcDEgvSp9L6Zdj7IJZmvWbsvQzn0za6vRUEDZrQWNtA7aLVg0FD" +
  "a6QR0WjVVFc84ljvw+7guS7wD5DP5lZAGi+E7QyOXzj2cTS9d3nn4cOOXAJ4XKFZk3xmCP2Jh9zh" +
  "eKPUHImj8gucQhypDfV+OBorObE=",
  "base64",
);
const otherKey = Buffer.from(
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDWPqTrDno9qBfApnpJhptEp8V4" +
  "8BUW0131xz/qCEXFp1TFTbEW0ZBOgh6vs7sWbgKoLeYRCtDoLFydRp7eYHwMrm7CxyCI/bI7Ye0z" +
  "7v9ZDPhRuDeQubprPhOn1Z00wEx412TYmHa0AcgAhqh8TrSyqxn0OJzEEFIlpUG966IJxr2PKe74" +
  "G+7x75Jnoyj1vDXE0Yvw6aCtwCIOAznF4J7aC6oqTvomYNpAQ7wWA9GtPGYl+bLTvsCXR5JmZpIg" +
  "njM4Q/PGVt9MTrwmEz4fcupF+pcvM1NFAX6dFI0zydy91ruI0BHZ5/iynQCEC6KsJaRhLmtdGiNU" +
  "rp+usj2GuTwDAgMBAAECggEAARq55ej2sgUA+QIYBPNX2eRALS3rpej5WzAnlltsOfxxVZe0xH3Y" +
  "ZRc1n56TuyYJByM+xDK5PfZ7PxJN9QPWpTLBqRO2tA4UEktLGjvuqV+wPgJEQw+PXvMnIx6DnMcq" +
  "/b/P1MVVw1AeXvuoDa/9gs2aqNAhOr+CH5COWgjHa+PNzHeddJByt1Ma8VI5aN4/jiFmaLymcjaP" +
  "2BhNYDYIsZL+UK8LdBpO06dF/av9SxLRC6oO6NxFFYV5zWn/ZStiwZ95URJyl0XiMRHHfd34Hf7g" +
  "14e068hISRp5Fa2dmrIMTToEU6uQURLktLq0+4mw7A1BXHu80N/ll5LDvSNeXQKBgQDuhaFpRlV7" +
  "JMx5KitVPBx77bBjm4jWfCTWMvdRtwUukitn1VR1HxgDzkyMTqBbdJ3KQ5VXnMuxkdUaNfuc+i+E" +
  "GqFXkjY8P3gd97okMjnNxF/Qq9FS2qX5WjB74UQjFripdY9w4Of9CMajkcFbjFpyNGlFDBwa0M0M" +
  "8/ItbcWBtQKBgQDl8ZpDIJvuWnhl1KSc+CWHywoD+6nm92DnlbnWPYdFoyv+YJPdMmfVVnvQNwxY" +
  "Pdc5pC0cAKIE8xbJWqAlZPzyzaRsjjpnZeVLflCX27KefZEMK9LR8nnHpxl5ZrQ9hYiqbnLajDdv" +
  "wCifKIlkHOI2SOz/nZQY+Y2curuIRxg51wKBgG4cBk2BCIkWjcYJb4Ojgkq7iUgSTvMk0CSJ1p5E" +
  "bQH4vEzssFZ5Ci8Hl1LWITTW+tiapmCRo37PoZ69+O+Yl0LWwFCa0KqzahH7gFShUwnoc4rzJmin" +
  "QyN/PQ6TCU9hd9HS0Wr8iFvJJ1nvOWG3wzEhfM9BLeA7L82g99V87UZZAoGBAN2beDmDnuQbSveQ" +
  "9UjWmo0BsFhgXcFb3oeytBR23fzOImMZPsgqgQmJPPBRbVNJ3jgOMu9O6NbuVKKf9cG0T1fNus5o" +
  "UH9AI7kbNp70PHQkvfrF7XsrPhSdxZ5Lzh+Qp0LiCUz5X6ASyNODJM5YS+dXZxl/C7D6KXHIQV44" +
  "bm+nAoGAXL5/yurHpKCmBL6mEtgUnPnRP7ZpKw2XrCaTBYzIQ+NO5J18KyrxbDmEzr/Z1lFBXASq" +
  "mJxDrpgvJ9HPEYZs1uMUtFZK6tPTp8ohwzYi+BNnYMEcGnT8n0rhaZ3pWqsjQuHOhkfg8rYpo1Xl" +
  "2SqH62es8iHctb1xced5Hf00E+M=",
  "base64",
);
// Public keys (SubjectPublicKeyInfo) the apps refuse to wrap the user key to.
const rsa1024 = Buffer.from(
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCdt3PGPXBaOC0ZdQaX0jLN55705gp4drjkmeeX" +
  "V64AqRXLACwFtDsahyCILvwzb7xtSdaHWKJFYmlQNJYwVbhKxOfqC/v3eoPdN1UA4CiUQh6AZd/U" +
  "qAD2ZLYUPGbyyLzY+yjn5uq5D0k0QteqykKyq46scNAPB31pcgRJTvDkhwIDAQAB",
  "base64",
);
const rsa4096 = Buffer.from(
  "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAjK2coUVAoFSosbDCJu9mcRGLZWoN/cH+" +
  "aUM2ZeMvJIaFCbflG3/Jf0KTNRN7vb0hi4gpRIC8bscflwOf1zwfbEEFagT3rDvOtNHXalk7oa+n" +
  "Ywg42U7RSaO6JI7yWJQcpr+DylmVW6Tb32ECjdHL/HhTGtNq4+9SY+jkZYEp9e0xtKD2ogvJTQWK" +
  "+xHOKp3f1r5Ix4YckXC58XJctHGO5LKIgXxabfPfK9XNr8enNp1caeyneH14Y5wV3RclusFpOj7Y" +
  "dhLvvpirDki6r8eX3faUpzj2xK9ZHzr6Hd4bOjWpFBY08OCybawq86VSHI+aOb/u0qAta5gjRwdX" +
  "foYY6AyqswRcKPg8+up9CDckDYOYqhQ5N9ZI1lJGXy4RTast1+gbYLlGy2rY7jVUw9NY5Us64G0X" +
  "zgBSJBa+3djFpF4LdA8w+MKdoNwG/rtRXgjPwsRjA3itciP3ZgMzbMT4PTJ9tyEvM3FfgaTbsLB0" +
  "pHwr0WX6+zUUxFkyaSZ2kWcirfG/xMGhub8UIoEakMdqtSjmaHxqwlMDw7UwMK6xss1xhaKAMi98" +
  "JPCzCnXYK/rLmwChZAFaWXHuWCb3QJwIW4FRctHPszTaJFsyDwy3wOGnyfPFW4vCtlfA1Mt+rr1v" +
  "a4z1kC4aoBBwWht0RzKlfAbJrpms4Tfw9x/5Hw+x13MCAwEAAQ==",
  "base64",
);
const rsaExponent3 = Buffer.from(
  "MIIBIDANBgkqhkiG9w0BAQEFAAOCAQ0AMIIBCAKCAQEAyReGwbpdZbGshlNFjlbz44aMj7r44hnF" +
  "rYhEaqcfQF3fI7N7BKk9a9EbEAXvtCIYAxaZ/tgpDnCKu0zsym/+LsjpRvoJarQH7GqsSNFQUyuN" +
  "rpDnuXc4itsi6Lix77gYYGEYhidGiulNIDqE1x7Qqkje8rly/BWamkFI+MIe0dKOe/3vFapP62PM" +
  "oRXC+NeofORGyzTfuhbWc6HX4jf6NE7qv5UwOD3ZquTUsk9ptrLgo3023w3xzxY7P5C0Xt6yicoo" +
  "W5vWIamEzyR8X5FLugMWDHvdEnT0t3Yq1Oj27UaXoErozS4AY3tiAZyS9RPQ4ZSUOw8uqiaHzFMq" +
  "w5AadQIBAw==",
  "base64",
);
const p256 = Buffer.from(
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEvodc/Bs1oJYYfc9d3uCa9KJaD5YKC7ikzd2UUmSl" +
  "3DQYP4TCtUPTbIM+7UVxSxkoD9QOo5Jr/wt40A+OFqIh/Q==",
  "base64",
);

const spki = (pkcs8) =>
  createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" });
const requestPublic = spki(requestKey);
const otherPublic = spki(otherKey);

// The account's user key, and the seed of its one wrap here.
const userKey = bytes(0x40, 64);
const seed = bytes(0xa0, 20);
const wrapped = oaepSha1(requestPublic, userKey, seed);
// Node's own OAEP opens it, or this file is wrong.
const opened = privateDecrypt(
  { key: requestKey, format: "der", type: "pkcs8", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
  wrapped,
);
if (!opened.equals(userKey)) {
  throw new Error("the wrap doesn't open with Node's OAEP");
}

const vectors = {
  description:
    "Approving a sign-in from another device, version 1: DESIGN.md, \"Approving a sign-in from another device\". Made by docs/vectors/make-device-approval-v1.mjs with Node's crypto and EFF's long word list.",
  request: {
    privateKey: b64(requestKey),
    publicKey: b64(requestPublic),
  },
  // The phrase each side shows: for the account's email (in lower case,
  // whatever case it was typed in) and the requesting device's public key.
  fingerprints: [
    { why: "the account and the requesting device", ...fingerprint("dana@example.test", requestPublic) },
    {
      why: "the same email typed with capitals: the same phrase",
      ...fingerprint("Dana@Example.TEST", requestPublic),
    },
    { why: "another account, the same key: another phrase", ...fingerprint("lee@example.test", requestPublic) },
    { why: "another device's key: another phrase", ...fingerprint("dana@example.test", otherPublic) },
  ],
  approval: {
    userKey: b64(userKey),
    seed: b64(seed),
    // The user key, RSA-2048 OAEP with SHA-1 to the request's public key, as
    // an encrypted string of type 4: what the approving device sends.
    key: `4.${b64(wrapped)}`,
  },
  // Public keys the apps refuse to wrap the user key to, with nothing sent.
  refusedPublicKeys: [
    { why: "an RSA key shorter than 2048 bits", publicKey: b64(rsa1024) },
    { why: "an RSA key longer than 2048 bits", publicKey: b64(rsa4096) },
    { why: "an RSA key whose exponent isn't 65537", publicKey: b64(rsaExponent3) },
    { why: "not an RSA key (P-256)", publicKey: b64(p256) },
    { why: "not a public key", publicKey: b64(bytes(0, 64)) },
    { why: "not base64", publicKey: "not base64!" },
    { why: "empty", publicKey: "" },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

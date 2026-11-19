// Makes docs/vectors/security-key-pin-v1.json:
//
//   node docs/vectors/make-security-key-pin-v1.mjs > docs/vectors/security-key-pin-v1.json
//
// Sending a security key its PIN (DESIGN.md, "A security key's PIN"): CTAP
// 2.1's authenticatorClientPIN with PIN/UV auth protocols 1 and 2 (FIDO
// Alliance, "Client to Authenticator Protocol (CTAP)" 2.1, "PIN/UV Auth
// Protocol One" and "Two"), and getAssertion's pinUvAuthParam.
//
// Plain Node only (node:crypto, and String.prototype.normalize for Unicode
// Normalization Form C), independently of the core (Rust), which is checked
// against it. Every input is fixed (bytes counted up from a start), so this
// file comes out the same every time; the core uses a new key-agreement key
// and new IVs for each try, and is tested by making exactly these values
// from the same inputs and by opening what a key sends.
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const sha256 = (data) => createHash("sha256").update(data).digest();

// The little CBOR CTAP2 speaks (RFC 8949), in CTAP2's canonical form:
// shortest lengths, and a map's keys sorted by their encoding, shorter
// first, then bytewise. Integers, byte and text strings, arrays, maps, and
// true and false.
const head = (major, n) => {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) return Buffer.from([m | 25, n >> 8, n & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = m | 26;
  out.writeUInt32BE(n, 1);
  return out;
};
const cbor = (value) => {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "boolean") return Buffer.from([value ? 0xf5 : 0xf4]);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) {
    const pairs = [...value].map(([k, v]) => [cbor(k), cbor(v)]);
    pairs.sort(([a], [b]) => a.length - b.length || Buffer.compare(a, b));
    return Buffer.concat([head(5, pairs.length), ...pairs.flat()]);
  }
  throw new Error(`no CBOR for ${value}`);
};

// A P-256 public key as CTAP2's key agreement carries it: a COSE_Key of
// type EC2 (1: 2), alg -25 (3: ECDH-ES+HKDF-256, which the specification
// names though neither protocol uses it), curve P-256 (-1: 1), x (-2), y (-3).
const coseKey = (uncompressed) =>
  new Map([
    [1, 2],
    [3, -25],
    [-1, 1],
    [-2, uncompressed.subarray(1, 33)],
    [-3, uncompressed.subarray(33, 65)],
  ]);

const ecdhKey = (privateKey) => {
  const key = createECDH("prime256v1");
  key.setPrivateKey(privateKey);
  return key;
};

const aesCbc = (encrypt, key, iv, data) => {
  const cipher = (encrypt ? createCipheriv : createDecipheriv)("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

// PIN/UV auth protocol 1: the shared secret is SHA-256(Z); AES-256-CBC with
// an all-zero IV and no padding; the first 16 bytes of HMAC-SHA-256.
const one = {
  number: 1,
  kdf: (z) => sha256(z),
  encrypt: (secret, plain) => aesCbc(true, secret, Buffer.alloc(16), plain),
  decrypt: (secret, data) => aesCbc(false, secret, Buffer.alloc(16), data),
  authenticate: (key, message) => createHmac("sha256", key).update(message).digest().subarray(0, 16),
};

// PIN/UV auth protocol 2: the shared secret is two HKDF-SHA-256 calls with a
// salt of 32 zero bytes (an HMAC key, "CTAP2 HMAC key", then an AES key,
// "CTAP2 AES key"); AES-256-CBC under the AES key with a random IV in front
// and no padding; the whole HMAC-SHA-256 under the key's first 32 bytes.
const two = {
  number: 2,
  kdf: (z) =>
    Buffer.concat([
      Buffer.from(hkdfSync("sha256", z, Buffer.alloc(32), "CTAP2 HMAC key", 32)),
      Buffer.from(hkdfSync("sha256", z, Buffer.alloc(32), "CTAP2 AES key", 32)),
    ]),
  encrypt: (secret, plain, iv) => Buffer.concat([iv, aesCbc(true, secret.subarray(32), iv, plain)]),
  decrypt: (secret, data) => aesCbc(false, secret.subarray(32), data.subarray(0, 16), data.subarray(16)),
  authenticate: (key, message) => createHmac("sha256", key.subarray(0, 32)).update(message).digest(),
};

// What the core asks: the site, the client data's hash, and the account's
// credential (getAssertion), as webauthn.rs makes them.
const rpId = "vault.example.test";
const clientData =
  '{"type":"webauthn.get","challenge":"dGhlIHNlcnZlcidzIGNoYWxsZW5nZSE","origin":"https://vault.example.test","crossOrigin":false}';
const clientDataHash = sha256(Buffer.from(clientData, "utf8"));
const credentialId = bytes(0x70, 48);

// The PIN as CTAP 2.1 has the platform send it ("PIN Composition
// Requirements"): in Unicode Normalization Form C, as UTF-8; at least 4
// characters (code points) and at most 63 bytes, not ending in a zero byte.
// Nothing trimmed or folded.
const pinOf = (typed) => {
  const nfc = typed.normalize("NFC");
  const utf8 = Buffer.from(nfc, "utf8");
  if ([...nfc].length < 4) return { why: "tooShort" };
  if (utf8.length > 63) return { why: "tooLong" };
  if (utf8[utf8.length - 1] === 0) return { why: "notAPin" };
  return { nfc, utf8 };
};

const vectorsFor = (protocol, start, typedPin, ivs) => {
  const keyPrivate = bytes(start, 32);
  const platformPrivate = bytes(start + 0x20, 32);
  const key = ecdhKey(keyPrivate);
  const platform = ecdhKey(platformPrivate);
  const z = platform.computeSecret(key.getPublicKey());
  if (!z.equals(key.computeSecret(platform.getPublicKey()))) throw new Error("the agreement doesn't agree");
  const secret = protocol.kdf(z);
  // What the key works out on its side is the same.
  if (!secret.equals(protocol.kdf(key.computeSecret(platform.getPublicKey())))) throw new Error("secrets differ");

  const pin = pinOf(typedPin);
  if (!pin.utf8) throw new Error(`${typedPin} isn't a PIN`);
  const pinHash = sha256(pin.utf8).subarray(0, 16);
  const pinHashEnc = protocol.encrypt(secret, pinHash, ivs?.pinHash);
  if (!protocol.decrypt(secret, pinHashEnc).equals(pinHash)) throw new Error("pinHashEnc doesn't open");

  // The key's token, as it sends it (encrypted with the shared secret).
  const token = bytes(start + 0x40, 32);
  const tokenEnc = protocol.encrypt(secret, token, ivs?.token);
  if (!protocol.decrypt(secret, tokenEnc).equals(token)) throw new Error("the token doesn't open");
  const pinUvAuthParam = protocol.authenticate(token, clientDataHash);

  const platformCose = coseKey(platform.getPublicKey());
  const keyCose = coseKey(key.getPublicKey());
  const clientPin = (members) => Buffer.concat([Buffer.from([0x06]), cbor(new Map(members))]);
  const ok = (members) => Buffer.concat([Buffer.from([0x00]), cbor(new Map(members))]);
  const out = {
    protocol: protocol.number,
    keyPrivateKey: b64(keyPrivate),
    keyPublicKey: b64(key.getPublicKey()),
    platformPrivateKey: b64(platformPrivate),
    platformPublicKey: b64(platform.getPublicKey()),
    platformCoseKey: b64(cbor(platformCose)),
    z: b64(z),
    sharedSecret: b64(secret),
    pinTyped: typedPin,
    pin: pin.nfc,
    pinUtf8: b64(pin.utf8),
    pinHash: b64(pinHash),
    pinHashEnc: b64(pinHashEnc),
    token: b64(token),
    tokenEnc: b64(tokenEnc),
    rpId,
    clientDataHash: b64(clientDataHash),
    credentialId: b64(credentialId),
    pinUvAuthParam: b64(pinUvAuthParam),
    requests: {
      getPinRetries: b64(clientPin([[1, protocol.number], [2, 0x01]])),
      getKeyAgreement: b64(clientPin([[1, protocol.number], [2, 0x02]])),
      getPinToken: b64(
        clientPin([
          [1, protocol.number],
          [2, 0x05],
          [3, platformCose],
          [6, pinHashEnc],
        ]),
      ),
      getPinUvAuthTokenUsingPinWithPermissions: b64(
        clientPin([
          [1, protocol.number],
          [2, 0x09],
          [3, platformCose],
          [6, pinHashEnc],
          [9, 0x02],
          [10, rpId],
        ]),
      ),
      getAssertion: b64(
        Buffer.concat([
          Buffer.from([0x02]),
          cbor(
            new Map([
              [1, rpId],
              [2, clientDataHash],
              [3, [new Map([["id", credentialId], ["type", "public-key"]])]],
              [5, new Map([["up", true]])],
              [6, pinUvAuthParam],
              [7, protocol.number],
            ]),
          ),
        ]),
      ),
    },
    answers: {
      getPinRetries: b64(ok([[3, 7], [4, false]])),
      getKeyAgreement: b64(ok([[1, keyCose]])),
      token: b64(ok([[2, tokenEnc]])),
    },
  };
  if (ivs) {
    out.pinHashIv = b64(ivs.pinHash);
    out.tokenIv = b64(ivs.token);
  }
  return { out, secret };
};

const p1 = vectorsFor(one, 0x11, "2580", null);
// A CTAP 2.0 key's token can be 16 bytes under protocol 1.
const token16 = bytes(0xb1, 16);
const token16Enc = one.encrypt(p1.secret, token16);
p1.out.token16 = b64(token16);
p1.out.token16Enc = b64(token16Enc);
p1.out.pinUvAuthParam16 = b64(one.authenticate(token16, clientDataHash));
// Typed with a combining diaeresis (u, U+0308): sent precomposed (U+00FC).
const p2 = vectorsFor(two, 0x41, "Grüße 2580", { pinHash: bytes(0xc1, 16), token: bytes(0xd1, 16) });

// PINs as typed, and what's sent, or why nothing is.
const typedPins = [
  ["1234", "digits"],
  [" 12 34 ", "spaces kept, nothing trimmed"],
  ["Grüße", "u and a combining diaeresis become one character, U+00FC; the sharp s stays"],
  ["Ω123", "the ohm sign becomes the Greek capital omega, U+03A9"],
  ["한글12", "Hangul jamo become two syllables, so 4 characters"],
  ["é".repeat(31) + "a", "94 bytes typed, 63 once normalized: taken"],
  ["a".repeat(63), "63 bytes: the most"],
  ["é".repeat(31) + "a", "63 bytes, the e's precomposed"],
  ["123", "3 characters"],
  ["é́́", "4 code points typed, 3 once normalized (the first accent joins the e)"],
  ["a".repeat(64), "64 bytes"],
  ["é".repeat(32), "64 bytes"],
  ["1234\u0000", "ends in a zero byte"],
];
const pins = typedPins.map(([typed, about]) => {
  const pin = pinOf(typed);
  return pin.utf8
    ? { about, typed, ok: true, utf8: b64(pin.utf8) }
    : { about, typed, ok: false, why: pin.why };
});

// Refused: a key-agreement key off the curve (y one more), and tokens of the
// wrong length (protocol 1 takes 16 or 32 bytes; protocol 2, 32), each
// encrypted as the key would.
const keyPublic = ecdhKey(bytes(0x11, 32)).getPublicKey();
const offCurve = Buffer.from(keyPublic);
offCurve[64] ^= 1;
let refusedByNode = false;
try {
  ecdhKey(bytes(0x31, 32)).computeSecret(offCurve);
} catch {
  refusedByNode = true;
}
if (!refusedByNode) throw new Error("the point off the curve was taken");

const vectors = {
  about:
    "Sending a security key its PIN: CTAP 2.1's authenticatorClientPIN with PIN/UV auth protocols 1 and 2, and getAssertion's pinUvAuthParam (DESIGN.md, \"A security key's PIN\"). Made by make-security-key-pin-v1.mjs with Node's own crypto. All binary values are base64; keys are uncompressed SEC1 points (04 || x || y).",
  protocol1: {
    about:
      "z is the x-coordinate of ECDH(platformPrivateKey, keyPublicKey). sharedSecret = SHA-256(z). pinHash is the first 16 bytes of SHA-256(pinUtf8); pinHashEnc = AES-256-CBC(sharedSecret, all-zero IV, no padding) of it. The key sends its token encrypted the same way (tokenEnc). pinUvAuthParam = the first 16 bytes of HMAC-SHA-256(token, clientDataHash). requests are what the core sends (the command byte, then canonical CBOR), and answers what a key sends back (status 00, then CBOR). token16 is a CTAP 2.0 key's 16-byte token, with its own pinUvAuthParam16.",
    ...p1.out,
  },
  protocol2: {
    about:
      "z as for protocol 1. sharedSecret = HKDF-SHA-256(z, salt 32 zero bytes, info \"CTAP2 HMAC key\", 32) || HKDF-SHA-256(z, the same salt, info \"CTAP2 AES key\", 32): the HMAC key, then the AES key. pinHashEnc = pinHashIv || AES-256-CBC(the AES key, pinHashIv, no padding) of pinHash; the key's tokenEnc = tokenIv || the same of the token. pinUvAuthParam = HMAC-SHA-256(token, clientDataHash), all 32 bytes. The PIN was typed with a combining diaeresis (pinTyped) and is sent in Normalization Form C (pin).",
    ...p2.out,
  },
  pins: {
    about:
      "PINs as typed. Each that's ok is sent as utf8: Unicode Normalization Form C, as UTF-8. The others are refused before a key is asked: tooShort (fewer than 4 characters, counted once normalized), tooLong (more than 63 bytes once normalized), notAPin (ends in a zero byte).",
    pins,
  },
  refused: {
    about:
      "Each must be refused. offCurveKey is protocol 1's keyPublicKey with its last byte changed, so it's no point on P-256 (as a COSE key: offCurveCoseKey, in a getKeyAgreement answer: offCurveAnswer). The tokens are protocol 1's 48 bytes (only 16 or 32 are a token), protocol 2's 16 bytes (only 32 are), and protocol 2's 15 bytes (shorter than its IV), each under that protocol's sharedSecret as tokenEnc is.",
    offCurveKey: b64(offCurve),
    offCurveCoseKey: b64(cbor(coseKey(offCurve))),
    offCurveAnswer: b64(Buffer.concat([Buffer.from([0x00]), cbor(new Map([[1, coseKey(offCurve)]]))])),
    protocol1Token48Enc: b64(one.encrypt(p1.secret, bytes(0xe1, 48))),
    protocol2Token16Enc: b64(two.encrypt(p2.secret, bytes(0xe1, 16), bytes(0xf1, 16))),
    protocol2Short: b64(bytes(0xf1, 15)),
  },
};
process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

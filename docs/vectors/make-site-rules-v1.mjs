// Makes docs/vectors/site-rules-v1.json (node docs/vectors/make-site-rules-v1.mjs > docs/vectors/site-rules-v1.json):
// a fixed Ed25519 test key, site rules feeds signed with it as
// tools/site-rules/sign.mjs signs them, and each change the extension's feed
// reader must refuse or skip (DESIGN.md, "Fill rules for everyone",
// "Shipping: a signed feed"). Uses only Node's crypto, independently of the
// extension's code; the clients' jest test (passbundle-clients,
// apps/browser/src/autofill/keykeeper/site-rules-feed.spec.ts) checks the
// reader against a copy. Ed25519 signatures are deterministic, so the output
// is the same every run.
//
// TEST ONLY: both keys here are made from fixed, published seeds. Nothing may
// ever trust them outside tests: the extension's built-in list for
// PassBundle's feed (site-rules-keys.ts) ships empty, and tests inject this
// key themselves.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const hex = (buffer) => Buffer.from(buffer).toString("hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** What's signed: this, then the manifest's exact bytes. */
const prefix = "PassBundle site rules v1\n";
/** The desktop updates' prefix, which must never pass for a feed's. */
const desktopPrefix = "PassBundle desktop release v1\n";

/** An Ed25519 key from its 32-byte seed (PKCS #8, RFC 8410). */
const keyFrom = (seed) => {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { seed, privateKey, publicKey };
};

const key = keyFrom(bytes(0x30, 32));
const otherKey = keyFrom(bytes(0x80, 32));

const signBytes = (k, manifest, signedPrefix = prefix) =>
  sign(null, Buffer.concat([Buffer.from(signedPrefix, "utf8"), Buffer.from(manifest, "utf8")]), k.privateKey);
/** The signature file: base64 and a line end, as sign.mjs writes it. */
const sigFile = (signature) => `${Buffer.from(signature).toString("base64")}\n`;
const signWith = (k, manifest, signedPrefix = prefix) => sigFile(signBytes(k, manifest, signedPrefix));

// Ed25519's numbers, for the signatures a lax check would take.
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const fromLE = (buffer) => BigInt(`0x${hex(Buffer.from(buffer).reverse()) || "0"}`);
const toLE32 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();
const mod = (a, m) => ((a % m) + m) % m;
/** The neutral point's encoding (x = 0, y = 1), which has order 1. */
const NEUTRAL = toLE32(1n);

/**
 * A signature whose R is the neutral point, made with the key's own secret
 * scalar: R + [k]A = [S]B holds, so a check that doesn't refuse a small-order
 * R takes it (TweetNaCl's, and node-forge's, which is TweetNaCl's), and a
 * strict one (ed25519-dalek's verify_strict) doesn't.
 */
const smallOrderR = (k, manifest) => {
  const h = createHash("sha512").update(k.seed).digest();
  const a = Buffer.from(h.subarray(0, 32));
  a[0] &= 248;
  a[31] &= 127;
  a[31] |= 64;
  const message = Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.from(manifest, "utf8")]);
  const kHash = createHash("sha512").update(Buffer.concat([NEUTRAL, k.publicKey, message])).digest();
  const s = mod(fromLE(kHash) * fromLE(a), L);
  return Buffer.concat([NEUTRAL, toLE32(s)]);
};

/** The same signature with S + L in place of S: the same point, a malleable encoding. */
const unreducedS = (signature) => {
  const s = fromLE(signature.subarray(32)) + L;
  return Buffer.concat([signature.subarray(0, 32), toLE32(s)]);
};

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const NOW = Date.parse("2026-11-19T12:00:00Z");
const ISSUED = Date.parse("2026-11-18T00:00:00Z");

/** The rules file's name for its bytes, as sign.mjs names it. */
const fileFor = (rulesText) => `forms-${sha256(rulesText).slice(0, 16)}.json`;

/** A manifest as sign.mjs writes it: compact JSON, in this key order. */
const manifestFor = (
  rulesText,
  { sequence = 42, issued = ISSUED, expires = ISSUED + 14 * DAY, filename = fileFor(rulesText), hash = sha256(rulesText) } = {},
) =>
  JSON.stringify({
    maps: { forms: { v1: { filename, cid: hash, sha256: hash } } },
    passbundle: { sequence, issued: iso(issued), expires: iso(expires) },
  });

const form = (id, verified, fields, category = "account-login") => ({
  category,
  fields,
  passbundle: { id, verified },
});

// The good feed: a sign-in inside a shadow root, a bank's page by path whose
// username box is its email field, a rule last verified more than 90 days ago
// (dropped), a kind of form the engine doesn't fill yet (not taken), and
// field kinds it doesn't fill yet beside ones it does.
const goodRules = {
  schemaVersion: "1.0.0",
  hosts: {
    "login.example.test": {
      forms: [
        form("login-shadow", "2026-11-15", {
          username: ["#signin-box >>> #member-number"],
          password: ["#signin-box >>> #secret"],
        }),
      ],
    },
    "bank.example.test": {
      pathnames: {
        "/sign-in/": {
          forms: [
            form("bank-sign-in", "2026-10-01", {
              email: ['input[name="customer"]'],
              phone: ["#phone"],
              password: ["#pin", "#password"],
              oneTimeCode: ["#code"],
              newPassword: ["#new-pin"],
            }),
          ],
        },
      },
    },
    "change.example.test": {
      forms: [
        form(
          "change-current",
          "2026-11-10",
          { password: ["#current"], newPassword: ["#new"], oneTimeCode: [["#d1", "#d2", "#d3"], "#code"] },
          "account-update",
        ),
      ],
    },
    "stale.example.test": { forms: [form("stale", "2026-08-21", { username: ["#u"] })] },
    "cards.example.test": { forms: [form("card", "2026-11-15", { cardNumber: ["#cc"] }, "payment-card")] },
  },
};
const goodText = JSON.stringify(goodRules);
const good = manifestFor(goodText);
const goodSignature = signBytes(key, good);

/** What the reader keeps of the good feed. */
const goodTaken = {
  sequence: 42,
  issued: "2026-11-18T00:00:00Z",
  expires: "2026-12-02T00:00:00Z",
  sha256: sha256(goodText),
  hosts: {
    "login.example.test": [
      {
        id: "login-shadow",
        path: null,
        verified: "2026-11-15",
        fields: { username: ["#signin-box >>> #member-number"], password: ["#signin-box >>> #secret"] },
      },
    ],
    "bank.example.test": [
      {
        id: "bank-sign-in",
        path: "/sign-in",
        verified: "2026-10-01",
        fields: { username: ['input[name="customer"]'], password: ["#pin", "#password"], totp: ["#code"] },
      },
    ],
    "change.example.test": [
      { id: "change-current", path: null, verified: "2026-11-10", fields: { password: ["#current"], totp: ["#code"] } },
    ],
  },
};

/** A feed of its own for one skipping case: its rules, signed as sign.mjs signs them. */
const feedOf = (rules, options) => {
  const rulesText = JSON.stringify(rules);
  const manifest = manifestFor(rulesText, options);
  return { manifest, signature: signWith(key, manifest), rules: rulesText };
};

const takenOf = (rulesText, hosts, { sequence = 42 } = {}) => ({
  sequence,
  issued: "2026-11-18T00:00:00Z",
  expires: "2026-12-02T00:00:00Z",
  sha256: sha256(rulesText),
  hosts,
});

const ok = (id, fields, path = null, verified = "2026-11-15") => ({ id, path, verified, fields });

// A selector of exactly 500 characters is taken; one of 501 isn't.
const longSelector = (length) => `#${"a".repeat(length - 1)}`;
const lengths = feedOf({
  schemaVersion: "1.0.0",
  hosts: {
    "fits.example.test": { forms: [form("fits", "2026-11-15", { username: [longSelector(500)] })] },
    "long.example.test": {
      forms: [form("too-long", "2026-11-15", { username: ["#u"], password: [longSelector(501)] })],
    },
  },
});

const frames = feedOf({
  schemaVersion: "1.0.0",
  hosts: {
    "shadow.example.test": {
      forms: [form("into-shadow", "2026-11-15", { username: ["login-box >>> #username"] })],
    },
    "frame.example.test": {
      forms: [form("into-frame", "2026-11-15", { username: ["iframe#login >>> #username"] })],
    },
    "frame-two.example.test": {
      forms: [form("into-frame-later", "2026-11-15", { password: ["#outer >>> div > IFRAME.box >>> #password"] })],
    },
  },
});

const manyForms = Array.from({ length: 21 }, (_, i) => form(`many-${i}`, "2026-11-15", { username: [`#u${i}`] }));
const twenty = feedOf({
  schemaVersion: "1.0.0",
  hosts: {
    "twenty.example.test": { forms: manyForms.slice(0, 20) },
    "too-many.example.test": { forms: manyForms.slice(0, 11), pathnames: { "/in": { forms: manyForms.slice(11) } } },
  },
});

const verifiedDates = feedOf({
  schemaVersion: "1.0.0",
  hosts: {
    "kept.example.test": { forms: [form("kept", "2026-08-22", { username: ["#u"] })] },
    "dropped.example.test": { forms: [form("dropped", "2026-08-21", { username: ["#u"] })] },
    "future.example.test": { forms: [form("future", "2026-11-21", { username: ["#u"] })] },
  },
});

const badEntries = feedOf({
  schemaVersion: "1.0.0",
  hosts: {
    "good.example.test": { forms: [form("good", "2026-11-15", { username: ["#u"], password: ["#p"] })] },
    "Upper.Example.test": { forms: [form("upper", "2026-11-15", { username: ["#u"] })] },
    "bad host.example.test": { forms: [form("space", "2026-11-15", { username: ["#u"] })] },
    "port.example.test:8443": { forms: [form("port", "2026-11-15", { username: ["#u"] })] },
    "null.example.test": null,
    "mixed.example.test": {
      forms: [
        { category: "account-login", fields: { username: ["#no-id"] } },
        form("bad id", "2026-11-15", { username: ["#u"] }),
        form("not-a-date", "15 November 2026", { username: ["#u"] }),
        form("no-fields", "2026-11-15", "#u"),
        form("empty-selector", "2026-11-15", { username: [""] }),
        form("number-selector", "2026-11-15", { username: [7] }),
        form("still-good", "2026-11-15", { password: ["#p"] }),
      ],
      pathnames: { "no-slash": { forms: [form("path-without-slash", "2026-11-15", { username: ["#u"] })] } },
    },
  },
});

const rollback = manifestFor(goodText, { sequence: 41 });
const sameSequence = good;
const tooLong = manifestFor(goodText, { expires: ISSUED + 14 * DAY + 1000 });
const issuedAhead = manifestFor(goodText, { issued: NOW + DAY + 1000, expires: NOW + 3 * DAY });
const otherRulesText = JSON.stringify({ ...goodRules, hosts: { "login.example.test": goodRules.hosts["login.example.test"] } });
const wrongHash = good; // the manifest names goodText's hash; the file served is otherRulesText
const noRulesFile = JSON.stringify({ passbundle: { sequence: 42, issued: iso(ISSUED), expires: iso(ISSUED + 14 * DAY) } });
const slashName = manifestFor(goodText, { filename: "../forms.json" });
// One byte of the manifest changed after signing: the sequence 42 becomes 43.
const changedByte = good.replace('"sequence":42', '"sequence":43');

/** The good signature file with a bit set past the end of its 64 bytes, which a lax decoder drops. */
const looseBase64 = (() => {
  const text = Buffer.from(goodSignature).toString("base64");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = text.at(-3);
  const loose = alphabet[alphabet.indexOf(last) ^ 1];
  return `${text.slice(0, -3)}${loose}==\n`;
})();

const flippedSignature = (() => {
  const signature = Buffer.from(goodSignature);
  signature[10] ^= 0x01;
  return sigFile(signature);
})();

const vectors = {
  version: 1,
  testOnly:
    "Every key here is made from a fixed, published seed, for tests only. Nothing may trust them outside tests: the extension's built-in key list ships empty.",
  prefix,
  // When each case is read, unless it says otherwise.
  now: iso(NOW),
  key: { testOnly: true, seed: hex(key.seed), public: hex(key.publicKey) },
  otherKey: { testOnly: true, seed: hex(otherKey.seed), public: hex(otherKey.publicKey) },
  // Each: the manifest and its signature file as served, the rules file as
  // served (when the reader gets that far), the keys it trusts (`key` when
  // not given), the sequence of the copy it kept (`lastSequence`, none when
  // not given), and either what it takes (`taken`) or why it refuses:
  // "signature" (no trusted key signed the prefix and these bytes, checked
  // strictly), "malformed", "rollback" (an older sequence than the copy
  // kept), "expired", "lifetime" (more than 14 days from issued to expires,
  // or issued more than a day ahead of the clock), or "hash" (the rules file
  // isn't the one the manifest names).
  cases: [
    { name: "as signed", manifest: good, signature: sigFile(goodSignature), rules: goodText, lastSequence: 41, taken: goodTaken },
    {
      name: "the same sequence as the copy kept, taken again",
      manifest: sameSequence,
      signature: sigFile(goodSignature),
      rules: goodText,
      lastSequence: 42,
      taken: goodTaken,
    },
    { name: "a bad signature (one bit of it changed)", manifest: good, signature: flippedSignature, refused: "signature" },
    {
      name: "one byte of the manifest changed after signing",
      manifest: changedByte,
      signature: sigFile(goodSignature),
      rules: goodText,
      refused: "signature",
    },
    { name: "signed with another key", manifest: good, signature: signWith(otherKey, good), refused: "signature" },
    {
      name: "signed with another key that's trusted too",
      manifest: good,
      signature: signWith(otherKey, good),
      rules: goodText,
      keys: [hex(key.publicKey), hex(otherKey.publicKey)],
      taken: goodTaken,
    },
    { name: "signed without the prefix", manifest: good, signature: signWith(key, good, ""), refused: "signature" },
    {
      name: "signed with the desktop updates' prefix",
      manifest: good,
      signature: signWith(key, good, desktopPrefix),
      refused: "signature",
    },
    {
      name: "S isn't reduced (S + L, the same signature written another way)",
      manifest: good,
      signature: sigFile(unreducedS(goodSignature)),
      refused: "signature",
    },
    {
      name: "R is a small-order point (the neutral point), signed with the key's own secret",
      manifest: good,
      signature: sigFile(smallOrderR(key, good)),
      refused: "signature",
    },
    {
      name: "a small-order key (the neutral point), whose neutral R and zero S any message passes",
      manifest: good,
      signature: sigFile(Buffer.concat([NEUTRAL, Buffer.alloc(32)])),
      keys: [hex(NEUTRAL)],
      refused: "signature",
    },
    {
      name: "a key that isn't a canonical encoding (y = p + 3)",
      manifest: good,
      signature: sigFile(goodSignature),
      keys: [hex(toLE32(P + 3n))],
      refused: "signature",
    },
    {
      name: "a signature file that isn't strict base64 (a bit set past its 64 bytes)",
      manifest: good,
      signature: looseBase64,
      refused: "signature",
    },
    {
      name: "no keys trusted (as PassBundle's feed in a build before the owner adds one)",
      manifest: good,
      signature: sigFile(goodSignature),
      keys: [],
      refused: "signature",
    },
    {
      name: "an older sequence than the copy kept (a rollback)",
      manifest: rollback,
      signature: signWith(key, rollback),
      lastSequence: 42,
      refused: "rollback",
    },
    {
      name: "expired",
      manifest: good,
      signature: sigFile(goodSignature),
      now: "2026-12-02T00:00:00Z",
      refused: "expired",
    },
    {
      name: "a second before it expires",
      manifest: good,
      signature: sigFile(goodSignature),
      rules: goodText,
      now: "2026-12-01T23:59:59Z",
      taken: goodTaken,
    },
    {
      name: "more than 14 days from issued to expires",
      manifest: tooLong,
      signature: signWith(key, tooLong),
      refused: "lifetime",
    },
    {
      name: "issued more than a day ahead of the clock",
      manifest: issuedAhead,
      signature: signWith(key, issuedAhead),
      refused: "lifetime",
    },
    {
      name: "the rules file isn't the one the manifest names (another SHA-256)",
      manifest: wrongHash,
      signature: sigFile(goodSignature),
      rules: otherRulesText,
      refused: "hash",
    },
    {
      name: "signed, but naming no rules file",
      manifest: noRulesFile,
      signature: signWith(key, noRulesFile),
      refused: "malformed",
    },
    {
      name: "signed, but its rules file's name has a slash",
      manifest: slashName,
      signature: signWith(key, slashName),
      refused: "malformed",
    },
    {
      name: "a selector longer than 500 characters is skipped with its rule, one of 500 taken",
      ...lengths,
      taken: takenOf(lengths.rules, { "fits.example.test": [ok("fits", { username: [longSelector(500)] })] }),
    },
    {
      name: "a >>> into a frame is skipped with its rule; one into a shadow root is taken",
      ...frames,
      taken: takenOf(frames.rules, { "shadow.example.test": [ok("into-shadow", { username: ["login-box >>> #username"] })] }),
    },
    {
      name: "a host with more than 20 forms (its pages' forms counted too) is skipped; one with 20 taken",
      ...twenty,
      taken: takenOf(twenty.rules, {
        "twenty.example.test": manyForms.slice(0, 20).map((f) => ok(f.passbundle.id, { username: [f.fields.username[0]] })),
      }),
    },
    {
      name: "a rule verified more than 90 days ago is dropped, and one verified ahead of the clock skipped",
      ...verifiedDates,
      taken: takenOf(verifiedDates.rules, { "kept.example.test": [ok("kept", { username: ["#u"] }, null, "2026-08-22")] }),
    },
    {
      name: "bad entries are skipped one by one, and the rest taken",
      ...badEntries,
      taken: takenOf(badEntries.rules, {
        "good.example.test": [ok("good", { username: ["#u"], password: ["#p"] })],
        "port.example.test:8443": [ok("port", { username: ["#u"] })],
        "mixed.example.test": [ok("still-good", { password: ["#p"] })],
      }),
    },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

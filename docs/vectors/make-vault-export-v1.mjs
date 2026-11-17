// Makes docs/vectors/vault-export-v1.json:
//
//   node docs/vectors/make-vault-export-v1.mjs > docs/vectors/vault-export-v1.json
//
// The password-protected export (DESIGN.md, "Archive, export, and import
// in the apps"): the web vault's file format, which the apps make and open byte
// for byte. A key from the file password and a salt with the account's own
// KDF settings, stretched as the master key is; a random UUID under it, so
// a wrong password is known before anything else is opened; and the plain
// .json export under it. The file is laid out as JSON.stringify(doc, null,
// "  ") lays out the web vault's (`buildPasswordExport`), Argon2id's memory
// and parallelism after the rest.
//
// Plain Node only (24.7 or later, for Argon2 in node:crypto), independently
// of the core (Rust) and of upstream, so both are checked against it
// (check-vault-export-vectors.mjs opens it with upstream's own crypto).
// Every input is fixed (bytes counted up from a start), so this file comes
// out the same every time; the apps use a random salt, UUID, and IVs, and
// are tested by opening what's here and by making exactly it from the same
// inputs.
import { argon2Sync, createCipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");

// HKDF-Expand alone (RFC 5869, 2.3): Node's hkdf always extracts first.
const hkdfExpand = (prk, info, length) => {
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  for (let i = 1; out.length < length; i++) {
    t = createHmac("sha256", prk).update(Buffer.concat([t, Buffer.from(info), Buffer.from([i])])).digest();
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

// The KDF, as for the master key, over the salt's text as the file writes
// it (its base64, as UTF-8), not the bytes the base64 encodes. Argon2id
// takes the salt's SHA-256, as upstream's master key does.
const kdfOutput = (password, salt, kdf) =>
  kdf.kdfType === 0
    ? pbkdf2Sync(Buffer.from(password, "utf8"), Buffer.from(salt, "utf8"), kdf.kdfIterations, 32, "sha256")
    : argon2Sync("argon2id", {
        message: Buffer.from(password, "utf8"),
        nonce: createHash("sha256").update(Buffer.from(salt, "utf8")).digest(),
        parallelism: kdf.kdfParallelism,
        tagLength: 32,
        memory: kdf.kdfMemory * 1024,
        passes: kdf.kdfIterations,
      });

// Stretched with HKDF-Expand "enc" then "mac" (upstream's stretchKey).
const stretch = (material) => Buffer.concat([hkdfExpand(material, "enc", 32), hkdfExpand(material, "mac", 32)]);

// A small plain export, as the web vault's .json lays one out: a folder, a
// login with a website, a one-time code secret, a hidden field, and an
// earlier password, an archived note, and a card.
const plain = JSON.stringify(
  {
    encrypted: false,
    folders: [{ id: "f01de000-0000-4000-8000-000000000001", name: "Work" }],
    items: [
      {
        passwordHistory: [{ lastUsedDate: "2026-10-01T09:00:00.000Z", password: "old-made-up-password-1" }],
        revisionDate: "2026-11-02T10:00:00.000Z",
        creationDate: "2026-10-01T09:00:00.000Z",
        deletedDate: null,
        archivedDate: null,
        id: "00000000-0000-4000-8000-000000000001",
        organizationId: null,
        folderId: "f01de000-0000-4000-8000-000000000001",
        type: 1,
        reprompt: 0,
        name: "Example Mail",
        notes: "Recovery codes are in the made-up safe.",
        favorite: true,
        fields: [{ name: "PIN", value: "8642", type: 1, linkedId: null }],
        login: {
          fido2Credentials: [],
          uris: [{ match: null, uri: "https://mail.example.test/login" }],
          username: "ana@example.test",
          password: "made-up-mail-password-2",
          totp: "JBSWY3DPEHPK3PXP",
        },
        collectionIds: null,
      },
      {
        passwordHistory: null,
        revisionDate: "2026-11-03T10:00:00.000Z",
        creationDate: "2026-11-03T10:00:00.000Z",
        deletedDate: null,
        archivedDate: "2026-11-04T08:30:00.000Z",
        id: "00000000-0000-4000-8000-000000000002",
        organizationId: null,
        folderId: null,
        type: 2,
        reprompt: 0,
        name: "Old router",
        notes: "Ünïcödé, \"quotes\", and a\nsecond line.",
        favorite: false,
        secureNote: { type: 0 },
        collectionIds: null,
      },
      {
        passwordHistory: null,
        revisionDate: "2026-11-05T10:00:00.000Z",
        creationDate: "2026-11-05T10:00:00.000Z",
        deletedDate: null,
        archivedDate: null,
        id: "00000000-0000-4000-8000-000000000003",
        organizationId: null,
        folderId: null,
        type: 3,
        reprompt: 1,
        name: "Test card",
        notes: null,
        favorite: false,
        card: {
          cardholderName: "Test Person",
          brand: "Visa",
          number: "4111111111111111",
          expMonth: "7",
          expYear: "2029",
          code: "123",
        },
        collectionIds: null,
      },
    ],
  },
  null,
  "  ",
);

const password = "made-up file password: correct horse battery staple";

/** One password-protected file, every input given. */
const made = (kdf, salt, validation, validationIv, dataIv, plaintext = plain) => {
  const material = kdfOutput(password, salt, kdf);
  const key = stretch(material);
  // As the web vault builds it: the object's own order, then Argon2id's
  // memory and parallelism added after.
  const doc = {
    encrypted: true,
    passwordProtected: true,
    salt,
    kdfType: kdf.kdfType,
    kdfIterations: kdf.kdfIterations,
    encKeyValidation_DO_NOT_EDIT: type2(key, validationIv, Buffer.from(validation, "utf8")),
    data: type2(key, dataIv, Buffer.from(plaintext, "utf8")),
  };
  if (kdf.kdfType === 1) {
    doc.kdfMemory = kdf.kdfMemory;
    doc.kdfParallelism = kdf.kdfParallelism;
  }
  return {
    kdf,
    salt,
    kdfOutput: b64(material),
    key: b64(key),
    validation,
    validationIv: b64(validationIv),
    dataIv: b64(dataIv),
    file: JSON.stringify(doc, null, "  "),
  };
};

const pbkdf2 = made(
  { kdfType: 0, kdfIterations: 600000 },
  b64(bytes(0x21, 16)),
  "3e8a1f5c-9b2d-4c6e-8f0a-1b2c3d4e5f60",
  bytes(0x41, 16),
  bytes(0x61, 16),
);
const argon2id = made(
  { kdfType: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 },
  b64(bytes(0x81, 16)),
  "7c6b5a49-3827-4615-a4b3-c2d1e0f9e8d7",
  bytes(0xa1, 16),
  bytes(0xc1, 16),
);

// Files that mustn't open, each changed from the PBKDF2 one.
const file = JSON.parse(pbkdf2.file);
const changed = (edit) => JSON.stringify(edit(structuredClone(file)), null, "  ");
const flipMac = (enc) => {
  const [iv, data, mac] = enc.slice(2).split("|");
  const bad = Buffer.from(mac, "base64");
  bad[0] ^= 1;
  return `2.${iv}|${data}|${b64(bad)}`;
};
const flipData = (enc) => {
  const [iv, data, mac] = enc.slice(2).split("|");
  const bad = Buffer.from(data, "base64");
  bad[0] ^= 1;
  return `2.${iv}|${b64(bad)}|${mac}`;
};

const vectors = {
  about:
    "The password-protected .json export (DESIGN.md, 'Archive, export, and import in the apps'), the web vault's format. " +
    "kdfOutput = the KDF over the password with the salt's base64 text as UTF-8 (Argon2id over its SHA-256); " +
    "key = HKDF-Expand-SHA256(kdfOutput, 'enc', 32) || HKDF-Expand-SHA256(kdfOutput, 'mac', 32); " +
    "encKeyValidation_DO_NOT_EDIT = type 2 of the validation UUID; data = type 2 of the plain export; " +
    "the file is JSON.stringify(doc, null, '  '). Inputs fixed so the file is stable.",
  password,
  plain,
  pbkdf2,
  argon2id,
  refused: {
    wrongPassword: "made-up file password: not the right one",
    badValidationMac: changed((f) => ({ ...f, encKeyValidation_DO_NOT_EDIT: flipMac(f.encKeyValidation_DO_NOT_EDIT) })),
    badDataMac: changed((f) => ({ ...f, data: flipMac(f.data) })),
    badDataCiphertext: changed((f) => ({ ...f, data: flipData(f.data) })),
    tooFewIterations: changed((f) => ({ ...f, kdfIterations: 4999 })),
    tooManyIterations: changed((f) => ({ ...f, kdfIterations: 2000001 })),
    tooMuchMemory: JSON.stringify({ ...JSON.parse(argon2id.file), kdfMemory: 1025 }, null, "  "),
    unknownKdf: changed((f) => ({ ...f, kdfType: 2 })),
    noData: changed((f) => {
      delete f.data;
      return f;
    }),
  },
};

process.stdout.write(JSON.stringify(vectors, null, 2) + "\n");

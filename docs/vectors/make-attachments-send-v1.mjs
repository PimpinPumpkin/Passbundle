// Makes docs/vectors/attachments-send-v1.json
// (node docs/vectors/make-attachments-send-v1.mjs > docs/vectors/attachments-send-v1.json):
// fixed inputs and the values the core must make and open when it attaches a
// file to an item and when it makes a Send (DESIGN.md, "Attachments in the
// apps" and "Send in the apps"). The formats are the ones the web vault and
// the server already use. Uses only Node's crypto, independently of the core
// and of upstream, so both are checked against it. The keys, seeds and IVs
// are fixed only so the file is stable: the core makes each from the
// operating system's random source, once, and its tests hand it these to
// compare byte for byte.
import { createCipheriv, createHmac, hkdfSync, pbkdf2Sync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

/** AES-256-CBC with PKCS#7, and HMAC-SHA256 over IV and ciphertext. */
function sealed(key64, plaintext, iv) {
  const cipher = createCipheriv("aes-256-cbc", key64.subarray(0, 32), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", key64.subarray(32, 64)).update(Buffer.concat([iv, ct])).digest();
  return { ct, mac };
}

/** EncString type 2: "2.<IV>|<ciphertext>|<MAC>", each in base64. */
function enc2(key64, plaintext, iv) {
  const { ct, mac } = sealed(key64, plaintext, iv);
  return `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
}

/** An encrypted file: the type byte 2, the IV, the MAC, then the ciphertext. */
function encFile(key64, plaintext, iv) {
  const { ct, mac } = sealed(key64, plaintext, iv);
  return Buffer.concat([Buffer.from([2]), iv, mac, ct]);
}

/** A fixed, distinct IV for each value. */
let ivCounter = 0;
const nextIv = () => bytes(0x11 + 0x1d * ivCounter++, 16);

// Attachments. The attachment's own key and its file name go under the key
// that encrypts the item's fields: the item's own key when it has one, else
// the organization's key, else the user key.
const userKey = bytes(0x01, 64);
const organizationKey = bytes(0x41, 64);
const itemKey = bytes(0x81, 64);
const attachmentKey = bytes(0xc1, 64);

const wrap = (name, wrappingKey, fileName) => {
  const keyIv = nextIv();
  const nameIv = nextIv();
  return {
    name,
    wrappingKey: b64(wrappingKey),
    keyIv: b64(keyIv),
    wrappedKey: enc2(wrappingKey, attachmentKey, keyIv),
    fileName,
    nameIv: b64(nameIv),
    encryptedName: enc2(wrappingKey, Buffer.from(fileName, "utf8"), nameIv),
  };
};

const file = (name, plaintext, key64) => {
  const iv = nextIv();
  const encrypted = encFile(key64, plaintext, iv);
  return { name, plaintext: b64(plaintext), iv: b64(iv), encrypted: b64(encrypted), encryptedLength: encrypted.length };
};

const plaintexts = [
  ["an empty file", Buffer.alloc(0)],
  ["one byte", Buffer.from([0x50])],
  ["15 bytes, one block with padding", bytes(0x30, 15)],
  ["16 bytes, a whole block of padding added", bytes(0x30, 16)],
  ["17 bytes", bytes(0x30, 17)],
  ["text", Buffer.from("Recovery codes:\n1234-5678\n8765-4321\n", "utf8")],
  ["1000 bytes", bytes(0x00, 1000)],
];

const attachment = {
  key: b64(attachmentKey),
  wrapped: [
    wrap("an item with a key of its own", itemKey, "plan.pdf"),
    wrap("a personal item without one, under the user key", userKey, "Führerschein (Kopie).jpg"),
    wrap("an organization's item without one, under the organization's key", organizationKey, "合同 final.docx"),
  ],
  files: plaintexts.map(([name, plaintext]) => file(name, plaintext, attachmentKey)),
};
const flipped = Buffer.from(attachment.files[5].encrypted, "base64");
flipped[flipped.length - 1] ^= 1;
attachment.refused = [{ why: "the last byte changed", encrypted: b64(flipped) }];

// Sends. The seed is 16 random bytes; the Send's key is HKDF-SHA256 of it
// (extract, then expand to 64 bytes) with the protocol's salt and info. The
// server gets the seed only wrapped under the user key; the link carries it.
const sendUserKey = bytes(0x05, 64);
const seed = bytes(0xa0, 16);
const sendKey = Buffer.from(hkdfSync("sha256", seed, Buffer.from("bitwarden-send", "utf8"), Buffer.from("send", "utf8"), 64));

const field = (plain) => {
  const iv = nextIv();
  return { plain, iv: b64(iv), encrypted: enc2(sendKey, Buffer.from(plain, "utf8"), iv) };
};
const seedIv = nextIv();

/** What the server is sent for a password: PBKDF2-HMAC-SHA256, the seed as salt. */
const proof = (password) => ({
  password,
  proof: b64(pbkdf2Sync(Buffer.from(password, "utf8"), seed, 100000, 32, "sha256")),
});

const accessId = "ESIzRFVmd4iZqrvM3e7_AA";
const link = (server) => ({ server, accessId, link: `${server}/#/send/${accessId}/${b64url(seed)}` });

const send = {
  userKey: b64(sendUserKey),
  seed: b64(seed),
  seedInLink: b64url(seed),
  salt: "bitwarden-send",
  info: "send",
  key: b64(sendKey),
  wrappedSeed: { iv: b64(seedIv), encrypted: enc2(sendUserKey, seed, seedIv) },
  fields: {
    name: field("Door code for Saturday"),
    notes: field("For Malia. Delete after the party."),
    text: field("4417# then the green button.\nDon't share it. Ünïcödé ✓"),
    fileName: field("floor plan (2).pdf"),
  },
  files: [file("a file Send's file", Buffer.from("%PDF-1.7\nnot really a PDF\n", "utf8"), sendKey)],
  passwords: [proof("open sesame"), proof("pässwörd 密码"), proof(" ")],
  passwordRounds: 100000,
  links: [link("https://vault.example.test"), link("https://example.test/vault")],
};

// Other seeds and the keys they give, RFC 5869's way.
send.keys = [bytes(0x00, 16), Buffer.alloc(16, 0xff), bytes(0x5a, 16)].map((s) => ({
  seed: b64(s),
  key: b64(Buffer.from(hkdfSync("sha256", s, Buffer.from("bitwarden-send", "utf8"), Buffer.from("send", "utf8"), 64))),
}));

process.stdout.write(`${JSON.stringify({ version: 1, attachment, send }, null, 2)}\n`);

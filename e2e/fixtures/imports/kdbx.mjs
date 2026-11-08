// A small KeePass database writer (KDBX 4.0), for tests that import a .kdbx
// file: the format KeePass 2, KeePassXC, and KeePassDX save in, which the web
// vault reads with upstream's SDK. Written from KeePass's published format
// (keepass.info/help/kb/kdbx_4.html): the AES-KDF key, AES-256-CBC, the
// HMAC-SHA-256 block stream, no compression, and ChaCha20 for protected
// values. Only what a test database needs: one group of entries, each a set
// of strings. No dependencies.
import crypto from "node:crypto";

const sha256 = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
const sha512 = (...parts) => crypto.createHash("sha512").update(Buffer.concat(parts)).digest();
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const uuid = (hex) => Buffer.from(hex.replace(/-/g, ""), "hex");

const AES256_CBC = uuid("31c1f2e6-bf71-4350-be58-05216afc5aff");
const AES_KDF = uuid("c9d9f39a-628a-4460-bf74-0d08c18a4fea");
const CHACHA20 = 3;

/** A header field: its id, its length, and its data. */
const field = (id, data) => Buffer.concat([Buffer.from([id]), u32(data.length), data]);

/** KeePass's typed key-value list (VariantDictionary), as the KDF parameters use it. */
function variantDictionary(entries) {
  const parts = [u16(0x0100)];
  for (const [type, key, value] of entries) {
    const name = Buffer.from(key, "utf8");
    parts.push(Buffer.from([type]), u32(name.length), name, u32(value.length), value);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** AES-KDF: the composite key encrypted with AES-256-ECB `rounds` times, then hashed. */
function aesKdf(compositeKey, seed, rounds) {
  let key = compositeKey;
  for (let i = 0; i < rounds; i++) {
    const cipher = crypto.createCipheriv("aes-256-ecb", seed, null).setAutoPadding(false);
    key = Buffer.concat([cipher.update(key), cipher.final()]);
  }
  return sha256(key);
}

const xmlText = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A .kdbx file. `entries` is a list of { title, strings: { name: value },
 * protected: [names] }: Title is set from `title`; protected strings come in
 * as hidden fields, the way KeePass keeps passwords.
 */
export function kdbx({ password, name = "Test database", entries, rounds = 1000, random = crypto.randomBytes }) {
  const masterSeed = random(32);
  const iv = random(16);
  const kdfSeed = random(32);
  const streamKey = random(64);

  const header = Buffer.concat([
    u32(0x9aa2d903),
    u32(0xb54bfb67),
    u16(0), // minor version
    u16(4), // major version
    field(2, AES256_CBC),
    field(3, u32(0)), // no compression
    field(4, masterSeed),
    field(7, iv),
    field(11, variantDictionary([
      [0x42, "$UUID", AES_KDF],
      [0x05, "R", u64(rounds)],
      [0x42, "S", kdfSeed],
    ])),
    field(0, Buffer.from("\r\n\r\n")),
  ]);

  const transformed = aesKdf(sha256(sha256(Buffer.from(password, "utf8"))), kdfSeed, rounds);
  const encryptionKey = sha256(masterSeed, transformed);
  const hmacBase = sha512(masterSeed, transformed, Buffer.from([1]));
  const blockKey = (index) => sha512(u64(index), hmacBase);
  const hmac = (index, ...parts) =>
    crypto.createHmac("sha256", blockKey(index)).update(Buffer.concat(parts)).digest();

  // Protected values: XORed with one ChaCha20 stream, in the order they appear.
  const streamHash = sha512(streamKey);
  const stream = crypto.createCipheriv("chacha20", streamHash.subarray(0, 32), Buffer.concat([u32(0), streamHash.subarray(32, 44)]));
  const groupUuid = Buffer.alloc(16, 1).toString("base64");
  const strings = (entry) =>
    Object.entries({ Title: entry.title, ...entry.strings })
      .map(([key, value]) => {
        if ((entry.protected ?? []).includes(key)) {
          const hidden = stream.update(Buffer.from(String(value), "utf8")).toString("base64");
          return `<String><Key>${xmlText(key)}</Key><Value Protected="True">${hidden}</Value></String>`;
        }
        return `<String><Key>${xmlText(key)}</Key><Value>${xmlText(value)}</Value></String>`;
      })
      .join("");
  const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile><Meta><Generator>PassBundle tests</Generator><DatabaseName>${xmlText(name)}</DatabaseName></Meta><Root><Group><UUID>${groupUuid}</UUID><Name>${xmlText(name)}</Name>${entries
    .map((entry, i) => `<Entry><UUID>${Buffer.alloc(16, i + 2).toString("base64")}</UUID>${strings(entry)}</Entry>`)
    .join("")}</Group></Root></KeePassFile>`;

  const innerHeader = Buffer.concat([field(1, u32(CHACHA20)), field(2, streamKey), field(0, Buffer.alloc(0))]);
  const cipher = crypto.createCipheriv("aes-256-cbc", encryptionKey, iv);
  const payload = Buffer.concat([cipher.update(Buffer.concat([innerHeader, Buffer.from(xml, "utf8")])), cipher.final()]);

  // The payload in HMAC-checked blocks, then an empty one to end it.
  const blocks = [];
  const blockSize = 1024 * 1024;
  let index = 0;
  for (let at = 0; at < payload.length; at += blockSize, index++) {
    const data = payload.subarray(at, at + blockSize);
    blocks.push(hmac(index, u64(index), u32(data.length), data), u32(data.length), data);
  }
  blocks.push(hmac(index, u64(index), u32(0)), u32(0));

  return Buffer.concat([header, sha256(header), hmac(2n ** 64n - 1n, header), ...blocks]);
}

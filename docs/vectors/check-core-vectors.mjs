// Checks docs/vectors/core-v1.json (the core's vectors, docs/core.md) with
// upstream's own crypto, the SDK's public PureCrypto API, from a checkout of
// the clients repo: the master keys derive, the user key, private key,
// organization keys, and item key open, every item's strings open to what the
// vectors say (a card's and an identity's details too), and the refused
// strings are refused. Tier 1 runs it with this repo checked out in meta/:
//
//   node meta/docs/vectors/check-core-vectors.mjs meta/docs/vectors/core-v1.json .
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [vectorsPath, clientsRoot] = process.argv.slice(2);
// createRequire wants an absolute path.
const require = createRequire(path.resolve(clientsRoot, "package.json"));
const { PureCrypto } = require("@bitwarden/sdk-internal");
const v = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
const bytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
const same = (a, b64) => Buffer.from(a).equals(Buffer.from(b64, "base64"));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) {
    failures++;
  }
};
const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

const { account, keys } = v;
const utf8 = (text) => new Uint8Array(Buffer.from(text, "utf8"));
const kdfs = {
  pbkdf2: (p) => ({ pBKDF2: { iterations: p.kdfIterations } }),
  argon2id: (p) => ({
    argon2id: { iterations: p.kdfIterations, memory: p.kdfMemory, parallelism: p.kdfParallelism },
  }),
};
for (const [name, toKdf] of Object.entries(kdfs)) {
  const a = account[name];
  const kdf = toKdf(a.prelogin);
  const masterKey = attempt(() => PureCrypto.derive_kdf_material(utf8(account.password), utf8(account.salt), kdf));
  check(masterKey != null && same(masterKey, a.masterKey), `${name}: the master key derives`);
  const fromKey = attempt(() =>
    PureCrypto.decrypt_user_key_with_master_key(a.protectedUserKey, bytes(a.masterKey)),
  );
  check(fromKey != null && same(fromKey, keys.userKey), `${name}: the user key opens with the master key`);
  const fromPassword = attempt(() =>
    PureCrypto.decrypt_user_key_with_master_password(a.protectedUserKey, account.password, account.salt, kdf),
  );
  check(
    fromPassword != null && same(fromPassword, keys.userKey),
    `${name}: the user key opens with the master password`,
  );
}

const userKey = bytes(keys.userKey);
const privateKey = attempt(() => PureCrypto.unwrap_decapsulation_key(keys.encryptedPrivateKey, userKey));
check(privateKey != null && same(privateKey, keys.privateKey), "the private key opens with the user key");
const publicKey = attempt(() => PureCrypto.rsa_extract_public_key(bytes(keys.privateKey)));
check(publicKey != null && same(publicKey, keys.publicKey), "the public key is the private key's");
for (const [label, wrapped] of [
  ["type 4 (OAEP, SHA-1)", keys.encryptedOrganizationKey],
  ["type 3 (OAEP, SHA-256)", keys.encryptedOrganizationKeySha256],
]) {
  const orgKey = attempt(() => PureCrypto.decapsulate_key_unsigned(wrapped, bytes(keys.privateKey)));
  check(orgKey != null && same(orgKey, keys.organizationKey), `the organization key opens with the private key, ${label}`);
}
const itemKey = attempt(() => PureCrypto.unwrap_symmetric_key(keys.encryptedItemKey, userKey));
check(itemKey != null && same(itemKey, keys.itemKey), "the item key opens with the user key");

// Every string in the sync opens with the right key to what the vectors say.
const keyFor = (cipher) =>
  cipher.key != null ? bytes(keys.itemKey) : cipher.organizationId != null ? bytes(keys.organizationKey) : userKey;
const open = (encString, key) => (encString == null ? null : attempt(() => PureCrypto.symmetric_decrypt_string(encString, key)));
for (const folder of v.sync.folders) {
  check(open(folder.name, userKey) === v.opened.folders[folder.id], `folder ${folder.id} opens`);
}
for (const collection of v.sync.collections) {
  check(
    open(collection.name, bytes(keys.organizationKey)) === v.opened.collections[collection.id],
    `collection ${collection.id} opens`,
  );
}
for (const c of v.sync.ciphers) {
  const key = keyFor(c);
  const want = v.opened.items[c.id];
  const seen = { name: open(c.name, key), notes: open(c.notes, key) };
  if (c.login) {
    Object.assign(seen, {
      username: open(c.login.username, key),
      password: open(c.login.password, key),
      totp: open(c.login.totp, key),
      uris: c.login.uris.map((u) => open(u.uri, key)),
      fields: c.fields.map((f) => ({ name: open(f.name, key), value: open(f.value, key), type: f.type })),
    });
  }
  // A card's or an identity's own details, each string opened.
  for (const kind of ["card", "identity"]) {
    if (c[kind]) {
      seen[kind] = Object.fromEntries(Object.entries(c[kind]).map(([k, text]) => [k, open(text, key)]));
    }
  }
  const expected = Object.fromEntries(Object.keys(seen).map((k) => [k, want[k]]));
  check(JSON.stringify(seen) === JSON.stringify(expected), `item ${want.name} opens`);
}

for (const r of v.refused) {
  check(open(r.encString, bytes(keys[r.key])) === null, `refused: ${r.why}`);
}

process.exit(failures ? 1 : 0);

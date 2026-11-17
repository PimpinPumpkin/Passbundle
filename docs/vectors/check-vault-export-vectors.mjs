// Checks docs/vectors/vault-export-v1.json (the password-protected export,
// DESIGN.md, "Archive, export, and import in the apps") with upstream's own crypto,
// the SDK's public PureCrypto API, from a checkout of the clients repo: the
// KDF over the file password and the salt's text gives the vectors' output
// (upstream's `deriveKeyFromPassword`, which the web vault's export uses),
// the stretched key opens the validation value and the export inside, a
// wrong password's key opens neither, changed values are refused, and what
// upstream encrypts under the key opens back. Tier 1 runs it with this repo
// checked out in meta/:
//
//   node meta/docs/vectors/check-vault-export-vectors.mjs meta/docs/vectors/vault-export-v1.json .
import { createHmac } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [vectorsPath, clientsRoot] = process.argv.slice(2);
// createRequire wants an absolute path.
const require = createRequire(path.resolve(clientsRoot, "package.json"));
const { PureCrypto } = require("@bitwarden/sdk-internal");
const v = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
const utf8 = (text) => new Uint8Array(Buffer.from(text, "utf8"));
const same = (a, b64) => a != null && Buffer.from(a).equals(Buffer.from(b64, "base64"));

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

// The web vault's stretchKey: HKDF-Expand-SHA256 with "enc", then "mac".
const expand = (prk, info) =>
  createHmac("sha256", Buffer.from(prk)).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
const stretch = (material) => new Uint8Array(Buffer.concat([expand(material, "enc"), expand(material, "mac")]));

const sdkKdf = (kdf) =>
  kdf.kdfType === 0
    ? { pBKDF2: { iterations: kdf.kdfIterations } }
    : { argon2id: { iterations: kdf.kdfIterations, memory: kdf.kdfMemory, parallelism: kdf.kdfParallelism } };

for (const name of ["pbkdf2", "argon2id"]) {
  const vector = v[name];
  const file = JSON.parse(vector.file);
  const material = attempt(() =>
    PureCrypto.derive_kdf_material(utf8(v.password), utf8(file.salt), sdkKdf(vector.kdf)),
  );
  check(same(material, vector.kdfOutput), `${name}: upstream's KDF over the password and the salt's text gives kdfOutput`);
  const key = material && stretch(material);
  check(key != null && same(key, vector.key), `${name}: stretched, it's the vectors' key`);
  check(
    attempt(() => PureCrypto.symmetric_decrypt_string(file.encKeyValidation_DO_NOT_EDIT, key)) === vector.validation,
    `${name}: upstream opens the validation value`,
  );
  check(attempt(() => PureCrypto.symmetric_decrypt_string(file.data, key)) === v.plain, `${name}: upstream opens the export inside`);
  const again = attempt(() => PureCrypto.symmetric_encrypt_string(v.plain, key));
  check(
    again != null && attempt(() => PureCrypto.symmetric_decrypt_string(again, key)) === v.plain,
    `${name}: what upstream encrypts under the key opens back`,
  );
  const wrong = attempt(() =>
    stretch(PureCrypto.derive_kdf_material(utf8(v.refused.wrongPassword), utf8(file.salt), sdkKdf(vector.kdf))),
  );
  check(
    wrong != null && attempt(() => PureCrypto.symmetric_decrypt_string(file.encKeyValidation_DO_NOT_EDIT, wrong)) == null,
    `${name}: a wrong password's key doesn't open the validation value`,
  );
}

const key = new Uint8Array(Buffer.from(v.pbkdf2.key, "base64"));
for (const [name, what] of [
  ["badValidationMac", "encKeyValidation_DO_NOT_EDIT"],
  ["badDataMac", "data"],
  ["badDataCiphertext", "data"],
]) {
  const file = JSON.parse(v.refused[name]);
  check(attempt(() => PureCrypto.symmetric_decrypt_string(file[what], key)) == null, `upstream refuses ${name}`);
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}

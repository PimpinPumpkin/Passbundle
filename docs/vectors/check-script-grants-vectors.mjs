// Checks docs/vectors/script-grants-v2.json (the version 2 seals an app opens
// before it refreshes a script token's copy, docs/script-access.md) with
// upstream's own crypto, the SDK's public PureCrypto API, from a checkout of
// the clients repo: the sealed token key and spec open with the organization
// key to what they say, and every refused pair either doesn't open with the
// organization key or opens to something that isn't version 2 or names
// another token or item. Tier 1 runs it with this repo checked out in meta/:
//
//   node meta/docs/vectors/check-script-grants-vectors.mjs meta/docs/vectors/script-grants-v2.json .
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [vectorsPath, clientsRoot] = process.argv.slice(2);
// createRequire wants an absolute path.
const require = createRequire(path.resolve(clientsRoot, "package.json"));
const { PureCrypto } = require("@bitwarden/sdk-internal");
const v = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
const orgKey = Buffer.from(v.inputs.organizationKey, "base64");

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) {
    failures++;
  }
};
const opens = (encString) => {
  try {
    return PureCrypto.symmetric_decrypt_string(encString, orgKey);
  } catch {
    return null;
  }
};
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const { tokenId, itemId } = v.inputs;
check(opens(v.sealedTokenKey.encString) === v.sealedTokenKey.plaintext, "the sealed token key opens with the organization key");
check(opens(v.sealedSpec.encString) === v.sealedSpec.plaintext, "the sealed spec opens with the organization key");

const key = json(v.sealedTokenKey.plaintext);
const spec = json(v.sealedSpec.plaintext);
check(key?.v === 2 && key.token === tokenId && key.key === v.tokenKey, "the token key names its token");
check(spec?.v === 2 && spec.token === tokenId && spec.item === itemId, "the spec names its token and item");

/** What an app accepts for this token and item: both open, both version 2, both naming them. */
const accepted = (sealedKey, sealedSpec) => {
  const k = json(opens(sealedKey));
  const s = json(opens(sealedSpec));
  return k?.v === 2 && k.token === tokenId && s?.v === 2 && s.token === tokenId && s.item === itemId;
};
check(accepted(v.sealedTokenKey.encString, v.sealedSpec.encString), "the pair is accepted for its token and item");
for (const r of v.refused) {
  check(!accepted(r.sealedKey, r.sealedSpec), `refused: ${r.why}`);
}

process.exit(failures ? 1 : 0);

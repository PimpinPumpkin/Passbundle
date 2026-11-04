// Checks docs/vectors/script-grants-v3.json (the version 3 seals an app opens
// before it refreshes a script token's copy, docs/script-access.md) with
// upstream's own crypto, the SDK's public PureCrypto API, from a checkout of
// the clients repo: the sealed token key and spec open with the organization
// key to what they say, and each check refreshes only if both open with the
// organization key to version 3 seals naming this token (and the spec this
// item) that end at the same time, before the check's time, and no further
// ahead than any token lasts. Tier 1 runs it with this repo checked out in meta/:
//
//   node meta/docs/vectors/check-script-grants-v3-vectors.mjs meta/docs/vectors/script-grants-v3.json .
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
check(
  key?.v === 3 && key.token === tokenId && key.key === v.tokenKey && key.expires === v.expires,
  "the token key names its token and when it ends",
);
check(
  spec?.v === 3 && spec.token === tokenId && spec.item === itemId && spec.expires === v.expires,
  "the spec names its token and item, and when the token ends",
);

/** What an app refreshes with, at `at`, for this token and item. */
const refreshes = (sealedKey, sealedSpec, at) => {
  const k = json(opens(sealedKey));
  const s = json(opens(sealedSpec));
  return (
    k?.v === 3 &&
    s?.v === 3 &&
    k.token === tokenId &&
    s.token === tokenId &&
    s.item === itemId &&
    Number.isInteger(k.expires) &&
    k.expires === s.expires &&
    at < k.expires &&
    k.expires <= at + v.maxAheadSeconds
  );
};
for (const c of v.checks) {
  check(refreshes(c.sealedKey, c.sealedSpec, c.at) === c.refreshes, `${c.refreshes ? "refreshes" : "refused"}: ${c.why}`);
}

process.exit(failures ? 1 : 0);

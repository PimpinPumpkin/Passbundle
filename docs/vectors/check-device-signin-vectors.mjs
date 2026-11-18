// Checks docs/vectors/device-signin-v1.json (DESIGN.md, "Approving a sign-in
// from another device", "Our apps asking") with upstream's own crypto, the
// SDK's public PureCrypto API that the web vault and the extension use for
// these exact operations when they ask to sign in with a device, from a
// checkout of the clients repo: the request's private key gives its public
// key, the approval's wrap opens with it to the user key (as upstream's
// asking side opens it), the user key opens the account's private key and
// another account's user key doesn't, and a wrap to another device's key or a
// changed wrap doesn't open. The fingerprint phrase is the approving side's
// own, checked with upstream's code by the clients' unit test for
// device-approval-v1.json. Tier 1 runs it with this repo checked out in meta/:
//
//   node meta/docs/vectors/check-device-signin-vectors.mjs meta/docs/vectors/device-signin-v1.json .
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [vectorsPath, clientsRoot] = process.argv.slice(2);
// createRequire wants an absolute path.
const require = createRequire(path.resolve(clientsRoot, "package.json"));
const { PureCrypto } = require("@bitwarden/sdk-internal");
const v = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
const bytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
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

const privateKey = bytes(v.request.privateKey);
check(
  same(attempt(() => PureCrypto.rsa_extract_public_key(privateKey)), v.request.publicKey),
  "the request's public key is its private key's",
);
check(
  same(attempt(() => PureCrypto.decapsulate_key_unsigned(v.approval.key, privateKey)), v.approval.userKey),
  "the approval opens with the request's private key to the user key",
);
check(
  same(attempt(() => PureCrypto.decapsulate_key_unsigned(v.notTheAccount.key, privateKey)), v.notTheAccount.userKey),
  "another account's user key, wrapped to the request, opens too",
);

// The account's private key, as the sign-in answer carries it, opens with
// the user key, and not with another account's.
const accountKey = attempt(() =>
  PureCrypto.unwrap_decapsulation_key(v.account.privateKey, bytes(v.approval.userKey)),
);
check(
  same(attempt(() => PureCrypto.rsa_extract_public_key(accountKey)), v.account.publicKey),
  "the user key opens the account's private key",
);
check(
  attempt(() => PureCrypto.unwrap_decapsulation_key(v.account.privateKey, bytes(v.notTheAccount.userKey))) === null,
  "another account's user key doesn't open the account's private key",
);

const refused = (why) => v.refused.find((r) => r.why === why).key;
for (const why of ["wrapped to another device's key", "the wrap, changed"]) {
  check(attempt(() => PureCrypto.decapsulate_key_unsigned(refused(why), privateKey)) === null, `refused: ${why}`);
}

process.exit(failures ? 1 : 0);

// Checks docs/vectors/device-approval-v1.json (DESIGN.md, "Approving a
// sign-in from another device") with upstream's own crypto, the SDK's public
// PureCrypto API that the web vault and the extension use for these exact
// operations, from a checkout of the clients repo: the request's private key
// gives its public key, the wrapped user key opens with the request's
// private key, and what upstream wraps opens with Node's OAEP (SHA-1) and the
// vectors' key, so upstream and the apps wrap the same way. The fingerprint
// phrase is checked by the clients' own unit test, with upstream's code
// (libs/auth/src/common/services/auth-request/keykeeper-device-approval.spec.ts).
// Tier 1 runs it with this repo checked out in meta/:
//
//   node meta/docs/vectors/check-device-approval-vectors.mjs meta/docs/vectors/device-approval-v1.json .
import { constants, privateDecrypt } from "node:crypto";
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
const userKey = bytes(v.approval.userKey);
check(
  same(attempt(() => PureCrypto.rsa_extract_public_key(privateKey)), v.request.publicKey),
  "the request's public key is its private key's",
);
check(
  same(attempt(() => PureCrypto.decapsulate_key_unsigned(v.approval.key, privateKey)), v.approval.userKey),
  "the approval's wrapped user key opens with the request's private key",
);

// Upstream's own wrap, as its approval dialog makes it.
const upstream = attempt(() => PureCrypto.encapsulate_key_unsigned(userKey, bytes(v.request.publicKey)));
check(typeof upstream === "string" && upstream.startsWith("4."), "upstream wraps the user key as type 4");
const byNode = attempt(() =>
  privateDecrypt(
    {
      key: Buffer.from(privateKey),
      format: "der",
      type: "pkcs8",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from(upstream.slice(2), "base64"),
  ),
);
check(same(byNode, v.approval.userKey), "upstream's wrap is RSA-OAEP with SHA-1 of the 64-byte user key");

// A changed wrap doesn't open.
const changed = Buffer.from(v.approval.key.slice(2), "base64");
changed[changed.length - 1] ^= 1;
check(
  attempt(() => PureCrypto.decapsulate_key_unsigned(`4.${changed.toString("base64")}`, privateKey)) === null,
  "a changed wrap is refused",
);

process.exit(failures ? 1 : 0);

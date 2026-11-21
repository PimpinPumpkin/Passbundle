// Checks docs/vectors/recovery-at-unlock-v1.json (DESIGN.md, "Enrolling at
// unlock", "Our apps") with upstream's own crypto, the SDK's public
// PureCrypto API that upstream's enrollment uses for this exact operation
// (encapsulateKeyUnsigned), from a checkout of the clients repo: the
// organization's private key gives its public key, the wrapped user key
// opens with the organization's private key, and what upstream wraps to the
// organization's public key opens with Node's OAEP (SHA-1) and the vectors'
// private key, so upstream and the apps wrap the same way. Tier 1 runs it
// with this repo checked out in meta/:
//
//   node meta/docs/vectors/check-recovery-at-unlock-vectors.mjs meta/docs/vectors/recovery-at-unlock-v1.json .
import { constants, createHash, privateDecrypt } from "node:crypto";
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

const privateKey = bytes(v.organization.privateKey);
const userKey = bytes(v.enrollment.userKey);
check(
  same(attempt(() => PureCrypto.rsa_extract_public_key(privateKey)), v.organization.publicKey),
  "the organization's public key is its private key's",
);
check(
  createHash("sha256").update(Buffer.from(v.organization.publicKey, "base64")).digest("base64url") ===
    v.organization.fingerprint,
  "the fingerprint is the SHA-256 of the public key's SPKI, base64url without padding",
);
check(
  same(attempt(() => PureCrypto.decapsulate_key_unsigned(v.enrollment.resetPasswordKey, privateKey)), v.enrollment.userKey),
  "the wrapped user key opens with the organization's private key",
);

// Upstream's own wrap, as its enrollment makes it.
const upstream = attempt(() => PureCrypto.encapsulate_key_unsigned(userKey, bytes(v.organization.publicKey)));
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
check(same(byNode, v.enrollment.userKey), "upstream's wrap is RSA-OAEP with SHA-1 of the 64-byte user key");

// A changed wrap doesn't open.
const changed = Buffer.from(v.enrollment.resetPasswordKey.slice(2), "base64");
changed[changed.length - 1] ^= 1;
check(
  attempt(() => PureCrypto.decapsulate_key_unsigned(`4.${changed.toString("base64")}`, privateKey)) === null,
  "a changed wrap is refused",
);

process.exit(failures ? 1 : 0);

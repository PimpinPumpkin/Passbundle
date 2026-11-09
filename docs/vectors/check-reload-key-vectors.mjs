// Checks docs/vectors/reload-key-v1.json (the web vault's reload key wrap,
// DESIGN.md, "Staying unlocked across a reload") with upstream's own crypto,
// the SDK's public PureCrypto API, from a checkout of the clients repo: the
// wrapped user key opens with R to the user key, upstream's own wrap of it
// opens back the same way, and the wrong R, a changed MAC, and a changed
// ciphertext are refused. Tier 1 runs it with this repo checked out in meta/:
//
//   node meta/docs/vectors/check-reload-key-vectors.mjs meta/docs/vectors/reload-key-v1.json .
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

const { wrap, refused } = v;
const opened = attempt(() => PureCrypto.unwrap_symmetric_key(wrap.wrappedUserKey, bytes(wrap.wrappingKey)));
check(same(opened, wrap.userKey), "the wrapped user key opens with R to the user key");

const rewrapped = attempt(() => PureCrypto.wrap_symmetric_key(bytes(wrap.userKey), bytes(wrap.wrappingKey)));
check(rewrapped != null && rewrapped.startsWith("2."), "upstream wraps it as an EncString of type 2");
check(rewrapped !== wrap.wrappedUserKey, "upstream's wrap has its own random IV");
const reopened = attempt(() => PureCrypto.unwrap_symmetric_key(rewrapped, bytes(wrap.wrappingKey)));
check(same(reopened, wrap.userKey), "upstream's own wrap opens the same way");

check(
  attempt(() => PureCrypto.unwrap_symmetric_key(wrap.wrappedUserKey, bytes(refused.otherWrappingKey))) == null,
  "another tab's R is refused",
);
check(
  attempt(() => PureCrypto.unwrap_symmetric_key(refused.badMac, bytes(wrap.wrappingKey))) == null,
  "a changed MAC is refused",
);
check(
  attempt(() => PureCrypto.unwrap_symmetric_key(refused.badCiphertext, bytes(wrap.wrappingKey))) == null,
  "a changed ciphertext is refused",
);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}

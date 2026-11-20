// Signs a site rules feed (DESIGN.md, "Fill rules for everyone", "Shipping: a
// signed feed"): from a rules source (upstream's forms map, unsigned JSON, as
// rules.json here), it writes the feed's three files into a folder:
//
//   forms-<first 16 hex digits of its SHA-256>.json  the rules, compact JSON
//   manifest.json      names that file and its SHA-256, and adds
//                      passbundle: { sequence, issued, expires }
//   manifest.json.sig  base64 of an Ed25519 signature over
//                      "PassBundle site rules v1\n" and manifest.json's exact bytes
//
//   node tools/site-rules/sign.mjs --key <private key file> --rules <source.json> --out <folder> \
//     --sequence <n> [--issued <2026-11-18T00:00:00Z>] [--days <1 to 14>] [--public-key <64 hex digits>]
//
// The key is the caller's: an Ed25519 private key file (PKCS #8 PEM, as
// `openssl genpkey -algorithm ed25519` writes it). This script never makes,
// stores, copies, or prints a key; it reads the file, signs, checks the
// signature with the key's public half, and forgets it. With --public-key it
// first checks the file holds that key, as the desktop release jobs check
// theirs. Tests sign only with the test vectors' key
// (docs/vectors/site-rules-v1.json), which nothing outside tests trusts.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** What's signed: this, then the manifest's exact bytes. */
export const PREFIX = "PassBundle site rules v1\n";
const DAY = 24 * 60 * 60 * 1000;
const RULE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function fail(message) {
  console.error(`sign.mjs: ${message}`);
  process.exit(1);
}

/** The source's own checks: the shape the extension takes, and every form with an id and a verified date. */
export function checkSource(source) {
  if (typeof source !== "object" || source == null || typeof source.hosts !== "object" || source.hosts == null) {
    return "the rules source has no hosts";
  }
  for (const [host, entry] of Object.entries(source.hosts)) {
    if (entry == null) continue;
    const forms = [
      ...(entry.forms ?? []),
      ...Object.values(entry.pathnames ?? {}).flatMap((page) => page?.forms ?? []),
    ];
    if (forms.length > 20) return `${host} has more than 20 forms`;
    for (const form of forms) {
      const { id, verified } = form?.passbundle ?? {};
      if (!RULE_ID.test(id ?? "")) return `a form for ${host} has no id (passbundle.id)`;
      if (!DATE.test(verified ?? "")) return `${id} has no verified date (passbundle.verified, 2026-11-18)`;
      for (const alternatives of Object.values(form.fields ?? {})) {
        for (const selector of [alternatives].flat(2)) {
          if (typeof selector !== "string" || selector.length > 500) {
            return `${id} has a selector that isn't text of at most 500 characters`;
          }
        }
      }
    }
  }
  return null;
}

/**
 * The feed's files for a rules source, signed with `privateKey` (a KeyObject
 * the caller read from its own file): their names and exact contents.
 */
export function feedFiles(source, privateKey, { sequence, issued, days = 14 }) {
  const rules = JSON.stringify(source);
  const sha256 = createHash("sha256").update(rules).digest("hex");
  const filename = `forms-${sha256.slice(0, 16)}.json`;
  const manifest = JSON.stringify({
    maps: { forms: { v1: { filename, cid: sha256, sha256 } } },
    passbundle: { sequence, issued: iso(issued), expires: iso(issued + days * DAY) },
  });
  const signed = Buffer.from(PREFIX + manifest, "utf8");
  const signature = sign(null, signed, privateKey);
  if (!verify(null, signed, createPublicKey(privateKey), signature)) {
    throw new Error("the signature doesn't check with the key's own public half");
  }
  return {
    [filename]: rules,
    "manifest.json": manifest,
    "manifest.json.sig": `${signature.toString("base64")}\n`,
  };
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!name?.startsWith("--") || argv[i + 1] == null) fail(`expected --name value, got ${name}`);
    args[name.slice(2)] = argv[i + 1];
  }
  for (const needed of ["key", "rules", "out", "sequence"]) {
    if (args[needed] == null) fail(`--${needed} is needed`);
  }
  const sequence = Number(args.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail("--sequence must be a whole number, one more than the last feed's");
  const issued = args.issued == null ? Date.now() : Date.parse(args.issued);
  if (Number.isNaN(issued)) fail("--issued must be a time, such as 2026-11-18T00:00:00Z");
  const days = args.days == null ? 14 : Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 14) fail("--days must be 1 to 14: the extension refuses a feed that lives longer");

  const source = JSON.parse(fs.readFileSync(args.rules, "utf8"));
  const problem = checkSource(source);
  if (problem) fail(problem);

  let privateKey;
  try {
    privateKey = createPrivateKey(fs.readFileSync(args.key));
  } catch {
    fail("the key file isn't a private key this script can read (PKCS #8 PEM)");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("the key isn't an Ed25519 key");
  if (args["public-key"] != null) {
    const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    if (raw !== args["public-key"]) fail("the key file doesn't hold the public key --public-key names");
  }

  const files = feedFiles(source, privateKey, { sequence, issued, days });
  privateKey = null;
  fs.mkdirSync(args.out, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(args.out, name), contents);
  }
  const rulesFile = Object.keys(files).find((name) => name.startsWith("forms-"));
  console.log(`Signed feed ${sequence}: ${rulesFile}, expires ${JSON.parse(files["manifest.json"]).passbundle.expires}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

// Makes docs/vectors/cli-update-v1.json (node docs/vectors/make-cli-update-v1.mjs > docs/vectors/cli-update-v1.json):
// a fixed Ed25519 key, command-line tool release manifests signed with it as
// cli-release.yml signs them, and changes to each that `passbundle update`
// must refuse (DESIGN.md, "Command-line tool", "Updating itself"). Uses only
// Node's crypto, independently of the tool's code; the clients' jest test
// (passbundle-clients, apps/cli/src/keykeeper/self-update.spec.ts) checks the
// tool's reading against a copy. Ed25519 signatures are deterministic, so the
// output is the same every run.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const hex = (buffer) => Buffer.from(buffer).toString("hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** What's signed: this, then the manifest's exact bytes. */
const prefix = "PassBundle CLI release v1\n";
/** The desktop apps' prefix, which must never pass for the tool's. */
const desktopPrefix = "PassBundle desktop release v1\n";

/** An Ed25519 key from its 32-byte seed (PKCS #8, RFC 8410). */
const keyFrom = (seed) => {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { seed, privateKey, publicKey };
};

const key = keyFrom(bytes(0x20, 32));
const otherKey = keyFrom(bytes(0x70, 32));

const signWith = (k, manifest, signedPrefix = prefix) =>
  sign(null, Buffer.concat([Buffer.from(signedPrefix, "utf8"), Buffer.from(manifest, "utf8")]), k.privateKey).toString(
    "base64",
  );

const PLATFORMS = ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "windows-x64"];
const SIZES = {
  "macos-arm64": 31457280,
  "macos-x64": 32505856,
  "linux-x64": 33554432,
  "linux-arm64": 32505856,
  "windows-x64": 30408704,
};

const file = (version, platform, size = SIZES[platform]) => ({
  name: `passbundle-${version}-${platform}.${platform === "windows-x64" ? "zip" : "tar.gz"}`,
  platform,
  size,
  sha256: sha256(`passbundle ${version} for ${platform}`),
});

/** A manifest as cli-release.yml writes it (jq's compact output, in this key order). */
const manifest = (version, files = PLATFORMS.map((p) => file(version, p)), tag = `cli-v${version}`, { format = 1, app = "com.passbundle.cli" } = {}) =>
  JSON.stringify({
    format,
    app,
    tag,
    version,
    commit: "0123456789abcdef0123456789abcdef01234567",
    notes: "What's new since 0.1.4:\n\n- `passbundle update` updates the tool\n- Signing in with a device's approval",
    files,
  });

const release = manifest("0.1.5");
const expect = (platform, running = "0.1.4") => ({ tag: "cli-v0.1.5", platform, running });

const tooLarge = manifest("0.1.5", [file("0.1.5", "macos-arm64", 200 * 1024 * 1024 + 1)]);
const otherTag = manifest("0.1.6");
const otherVersion = manifest("0.1.6", undefined, "cli-v0.1.5");
const paddedVersion = manifest("0.1.05", undefined, "cli-v0.1.5");
const linuxX64Only = manifest("0.1.5", [file("0.1.5", "linux-x64")]);
const twoForOne = manifest("0.1.5", [file("0.1.5", "linux-x64"), { ...file("0.1.5", "linux-x64"), sha256: sha256("another") }]);
const otherApp = manifest("0.1.5", undefined, undefined, { app: "com.passbundle.app" });
const otherFormat = manifest("0.1.5", undefined, undefined, { format: 2 });
const otherName = manifest("0.1.5", [{ ...file("0.1.5", "macos-arm64"), name: "passbundle-0.1.4-macos-arm64.tar.gz" }]);
const zipForLinux = manifest("0.1.5", [{ ...file("0.1.5", "linux-x64"), name: "passbundle-0.1.5-linux-x64.zip" }]);

const vectors = {
  version: 1,
  prefix,
  key: { seed: hex(key.seed), public: hex(key.publicKey) },
  otherKey: { seed: hex(otherKey.seed), public: hex(otherKey.publicKey) },
  // Each: a manifest, a signature, what the tool expects (the tag it found
  // it on, its platform, and its own version), and either the file it takes
  // or why it refuses, the first that applies in this order: "signature"
  // (not the key's, over the prefix and these bytes), "malformed" (not
  // format 1, or not a manifest's shape), "app", "tag", "version",
  // "notNewer", "noFile" (not exactly one for its platform), "name", or
  // "tooLarge".
  cases: [
    {
      name: "macOS on Apple silicon, as signed",
      manifest: release,
      signature: signWith(key, release),
      expect: expect("macos-arm64"),
      file: file("0.1.5", "macos-arm64"),
    },
    {
      name: "Windows, as signed",
      manifest: release,
      signature: signWith(key, release),
      expect: expect("windows-x64"),
      file: file("0.1.5", "windows-x64"),
    },
    {
      name: "Linux on arm64, as signed, by a copy two builds behind",
      manifest: release,
      signature: signWith(key, release),
      expect: expect("linux-arm64", "0.1.3"),
      file: file("0.1.5", "linux-arm64"),
    },
    {
      name: "a newer minor version with a lower build number than the running copy's",
      manifest: release,
      signature: signWith(key, release),
      expect: expect("linux-x64", "0.0.99"),
      file: file("0.1.5", "linux-x64"),
    },
    {
      name: "signed with another key",
      manifest: release,
      signature: signWith(otherKey, release),
      expect: expect("macos-arm64"),
      refused: "signature",
    },
    {
      name: "its size changed after signing",
      manifest: release.replace('"size":31457280', '"size":31457281'),
      signature: signWith(key, release),
      expect: expect("macos-arm64"),
      refused: "signature",
    },
    {
      name: "its SHA-256 changed after signing",
      manifest: release.replace(sha256("passbundle 0.1.5 for macos-arm64"), sha256("something else")),
      signature: signWith(key, release),
      expect: expect("macos-arm64"),
      refused: "signature",
    },
    {
      name: "signed without the prefix",
      manifest: release,
      signature: signWith(key, release, ""),
      expect: expect("macos-arm64"),
      refused: "signature",
    },
    {
      name: "signed with the desktop apps' prefix",
      manifest: release,
      signature: signWith(key, release, desktopPrefix),
      expect: expect("macos-arm64"),
      refused: "signature",
    },
    {
      name: "signed, but in a format the tool doesn't read",
      manifest: otherFormat,
      signature: signWith(key, otherFormat),
      expect: expect("macos-arm64"),
      refused: "malformed",
    },
    {
      name: "signed, but for the desktop app",
      manifest: otherApp,
      signature: signWith(key, otherApp),
      expect: expect("macos-arm64"),
      refused: "app",
    },
    {
      name: "signed, but another release's manifest on this tag",
      manifest: otherTag,
      signature: signWith(key, otherTag),
      expect: expect("macos-arm64"),
      refused: "tag",
    },
    {
      name: "signed, but its version isn't its tag's",
      manifest: otherVersion,
      signature: signWith(key, otherVersion),
      expect: expect("macos-arm64"),
      refused: "version",
    },
    {
      name: "signed, but its version is written with a leading zero (0.1.05 for 0.1.5)",
      manifest: paddedVersion,
      signature: signWith(key, paddedVersion),
      expect: expect("macos-arm64"),
      refused: "version",
    },
    {
      name: "signed, but the same version as the running copy",
      manifest: release,
      signature: signWith(key, release),
      expect: expect("macos-arm64", "0.1.5"),
      refused: "notNewer",
    },
    {
      name: "signed, but older than the running copy (a downgrade)",
      manifest: release,
      signature: signWith(key, release),
      expect: expect("macos-arm64", "0.2.1"),
      refused: "notNewer",
    },
    {
      name: "a manifest with only the Linux x64 file, read by an arm64 copy",
      manifest: linuxX64Only,
      signature: signWith(key, linuxX64Only),
      expect: expect("linux-arm64"),
      refused: "noFile",
    },
    {
      name: "two files for the same platform",
      manifest: twoForOne,
      signature: signWith(key, twoForOne),
      expect: expect("linux-x64"),
      refused: "noFile",
    },
    {
      name: "signed, but naming another release's file",
      manifest: otherName,
      signature: signWith(key, otherName),
      expect: expect("macos-arm64"),
      refused: "name",
    },
    {
      name: "a .zip for Linux",
      manifest: zipForLinux,
      signature: signWith(key, zipForLinux),
      expect: expect("linux-x64"),
      refused: "name",
    },
    {
      name: "signed, but its file is larger than any release of the tool (200 MB)",
      manifest: tooLarge,
      signature: signWith(key, tooLarge),
      expect: expect("macos-arm64"),
      refused: "tooLarge",
    },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

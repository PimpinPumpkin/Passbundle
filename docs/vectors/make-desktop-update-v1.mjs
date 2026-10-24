// Makes docs/vectors/desktop-update-v1.json (node docs/vectors/make-desktop-update-v1.mjs > docs/vectors/desktop-update-v1.json):
// a fixed Ed25519 key, Windows and Linux release manifests signed with it as
// the release workflows sign them, and changes each that the apps must refuse
// ("Desktop updates" in DESIGN.md). Uses only Node's crypto, independently of
// the apps' code; the core's tests (passbundle-apps, core/tests/desktop_update.rs)
// check its own reading against a copy. Ed25519 signatures are deterministic,
// so the output is the same every run.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const hex = (buffer) => Buffer.from(buffer).toString("hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** What's signed: this, then the manifest's exact bytes. */
const prefix = "PassBundle desktop release v1\n";

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

const key = keyFrom(bytes(0x10, 32));
const otherKey = keyFrom(bytes(0x60, 32));

const signWith = (k, manifest, withPrefix = true) =>
  sign(null, Buffer.concat([Buffer.from(withPrefix ? prefix : "", "utf8"), Buffer.from(manifest, "utf8")]), k.privateKey).toString(
    "base64",
  );

const file = (version, platform, size) => ({
  name: `PassBundle-${version}-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
  platform,
  size,
  sha256: sha256(`PassBundle ${version} for ${platform}`),
});

/** A manifest as the release workflows write it (jq's compact output, in this key order). */
const manifest = (os, version, files, tag = `${os}-v${version}`) =>
  JSON.stringify({
    format: 1,
    app: "com.passbundle.app",
    tag,
    version,
    commit: "0123456789abcdef0123456789abcdef01234567",
    notes: `What's new since 0.1.4:\n\n- Faster sync\n- Updates on ${os === "windows" ? "Windows" : "Linux"}`,
    files,
  });

const windows = manifest("windows", "0.1.5", [file("0.1.5", "windows-x64", 15728640)]);
const linux = manifest("linux", "0.1.5", [file("0.1.5", "linux-x64", 11534336), file("0.1.5", "linux-arm64", 11010048)]);
const forWindows = { tag: "windows-v0.1.5", os: "windows", platform: "windows-x64", runningBuild: 4 };

const tooLarge = manifest("windows", "0.1.5", [file("0.1.5", "windows-x64", 200 * 1024 * 1024 + 1)]);
const otherTag = manifest("windows", "0.1.6", [file("0.1.6", "windows-x64", 15728640)]);
const otherVersion = manifest("windows", "0.1.6", [file("0.1.6", "windows-x64", 15728640)], "windows-v0.1.5");

const vectors = {
  version: 1,
  prefix,
  key: { seed: hex(key.seed), public: hex(key.publicKey) },
  otherKey: { seed: hex(otherKey.seed), public: hex(otherKey.publicKey) },
  // Each: a manifest, a signature, what the app expects (the tag it found it
  // on, its OS and platform, and its own build number), and either the file
  // it takes or why it refuses: "signature" (not the key's, over the prefix
  // and these bytes), "tag", "version", "notNewer", or "tooLarge".
  cases: [
    {
      name: "Windows, as signed",
      manifest: windows,
      signature: signWith(key, windows),
      expect: forWindows,
      file: file("0.1.5", "windows-x64", 15728640),
    },
    {
      name: "Linux on arm64, as signed (one manifest for both of Linux's files)",
      manifest: linux,
      signature: signWith(key, linux),
      expect: { tag: "linux-v0.1.5", os: "linux", platform: "linux-arm64", runningBuild: 4 },
      file: file("0.1.5", "linux-arm64", 11010048),
    },
    {
      name: "signed with another key",
      manifest: windows,
      signature: signWith(otherKey, windows),
      expect: forWindows,
      refused: "signature",
    },
    {
      name: "its size changed after signing",
      manifest: windows.replace('"size":15728640', '"size":15728641'),
      signature: signWith(key, windows),
      expect: forWindows,
      refused: "signature",
    },
    {
      name: "its SHA-256 changed after signing",
      manifest: windows.replace(sha256("PassBundle 0.1.5 for windows-x64"), sha256("something else")),
      signature: signWith(key, windows),
      expect: forWindows,
      refused: "signature",
    },
    {
      name: "signed without the prefix",
      manifest: windows,
      signature: signWith(key, windows, false),
      expect: forWindows,
      refused: "signature",
    },
    {
      name: "signed, but another release's manifest on this tag",
      manifest: otherTag,
      signature: signWith(key, otherTag),
      expect: forWindows,
      refused: "tag",
    },
    {
      name: "signed, but its version isn't its tag's",
      manifest: otherVersion,
      signature: signWith(key, otherVersion),
      expect: forWindows,
      refused: "version",
    },
    {
      name: "signed, but not newer than the running copy (a downgrade, or the same)",
      manifest: windows,
      signature: signWith(key, windows),
      expect: { ...forWindows, runningBuild: 5 },
      refused: "notNewer",
    },
    {
      name: "signed, but its file is larger than any PassBundle (200 MB)",
      manifest: tooLarge,
      signature: signWith(key, tooLarge),
      expect: forWindows,
      refused: "tooLarge",
    },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

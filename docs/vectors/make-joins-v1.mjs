// Makes docs/vectors/joins-v1.json (node docs/vectors/make-joins-v1.mjs > docs/vectors/joins-v1.json): fixed inputs and the values every client
// must compute from them for "Joins a hacked server can't forge" (DESIGN.md).
// Uses only Node's crypto, independently of the apps' code, so the apps' unit
// tests check their own computations against it.
import { createHash, createHmac, hkdfSync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();
const hmac = (key, ...parts) => createHmac("sha256", key).update(join(parts)).digest();
/** Parts joined with a zero byte between them, as UTF-8. */
const join = (parts) =>
  Buffer.concat(parts.flatMap((p, i) => [i ? Buffer.from([0]) : Buffer.alloc(0), Buffer.isBuffer(p) ? p : Buffer.from(p, "utf8")]));

const organizationId = "8f9a7c1e-3b2d-4e5f-9a8b-7c6d5e4f3a2b";
const organizationKey = bytes(0x00, 64);
const organizationPublicKey = bytes(0x80, 48);
const userId = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const userPublicKey = bytes(0xa0, 48);
const joinSecret = bytes(0x40, 32);

const joinKey = Buffer.from(hkdfSync("sha256", organizationKey, Buffer.alloc(0), "passbundle join key v1", 32));

const vectors = {
  version: 1,
  inputs: {
    organizationId,
    organizationKey: b64(organizationKey),
    organizationPublicKey: b64(organizationPublicKey),
    userId,
    userPublicKey: b64(userPublicKey),
    joinSecret: b64url(joinSecret),
  },
  joinKey: b64(joinKey),
  organizationKeyFingerprint: b64url(sha256(organizationPublicKey)),
  joinProof: b64(hmac(joinSecret, "passbundle join v1", organizationId, userId, sha256(userPublicKey))),
  inviteSeals: ["Ana@AcmeDental.example", "ana@acmedental.example", "ben@acmedental.example"].map((email) => ({
    email,
    seal: b64(hmac(joinKey, "passbundle invite v1", organizationId, email.toLowerCase())),
  })),
  staffSeal: {
    email: "Tech@Northwind.example",
    seal: b64(hmac(joinKey, "passbundle staff v1", organizationId, "tech@northwind.example")),
  },
  joiningSeals: [
    { autoConfirm: true, domains: [] },
    { autoConfirm: false, domains: [] },
    { autoConfirm: true, domains: ["branch.acmedental.example", "acmedental.example"] },
  ].map((joining) => ({
    ...joining,
    seal: b64(
      hmac(joinKey, "passbundle joining v1", organizationId, joining.autoConfirm ? "1" : "0", [...joining.domains].sort().join(",")),
    ),
  })),
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

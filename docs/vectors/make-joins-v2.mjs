// Makes docs/vectors/joins-v2.json (node docs/vectors/make-joins-v2.mjs > docs/vectors/joins-v2.json):
// version 2 of the seals in "Joins a hacked server can't forge" (DESIGN.md).
// Invitation and staff seals now carry when they stop vouching and a nonce,
// and a client seal says an organization is an MSP's client. The join key,
// joining seals, and join proofs stay as in joins-v1.json. Uses only Node's
// crypto, independently of the apps' code, so the apps' unit tests check
// their own computations against it.
import { createHmac, hkdfSync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
/** Parts joined with a zero byte between them, as UTF-8. */
const join = (parts) =>
  Buffer.concat(parts.flatMap((p, i) => [i ? Buffer.from([0]) : Buffer.alloc(0), Buffer.from(p, "utf8")]));
const hmac = (key, ...parts) => createHmac("sha256", key).update(join(parts)).digest();

// The same organization and key as joins-v1.json.
const organizationId = "8f9a7c1e-3b2d-4e5f-9a8b-7c6d5e4f3a2b";
const organizationKey = bytes(0x00, 64);
const otherOrganizationId = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const mspId = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
const otherMspId = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";

const joinKey = Buffer.from(hkdfSync("sha256", organizationKey, Buffer.alloc(0), "passbundle join key v1", 32));

/** How long a seal vouches, and how far ahead an app accepts its end (for clocks that disagree). */
const DAY = 86_400;
const lifetimeSeconds = 14 * DAY;
const maxAheadSeconds = 30 * DAY;
/** When the seals below were made: 2026-10-27T00:00:00Z. */
const madeAt = 1_793_059_200;

/** An expiring seal: `v2.<expires>.<nonce>.<mac>`, the nonce and MAC in base64url. */
function expiring(kind, email, expires, nonce, org = organizationId) {
  const n = b64url(nonce);
  const mac = hmac(joinKey, `passbundle ${kind} v2`, org, email.toLowerCase(), String(expires), n);
  return `v2.${expires}.${n}.${b64url(mac)}`;
}

const expires = madeAt + lifetimeSeconds;
const inviteNonce = bytes(0x30, 16);
const staffNonce = bytes(0x50, 16);
const invite = expiring("invite", "Ana@AcmeDental.example", expires, inviteNonce);
const staff = expiring("staff", "Tech@Northwind.example", expires, staffNonce);

/** The seal with the first character of its MAC changed (the last one has bits base64 ignores). */
function tampered(seal) {
  const at = seal.lastIndexOf(".") + 1;
  return `${seal.slice(0, at)}${seal[at] === "A" ? "B" : "A"}${seal.slice(at + 1)}`;
}

const vectors = {
  version: 2,
  inputs: {
    organizationId,
    organizationKey: b64(organizationKey),
    mspId,
    madeAt,
  },
  lifetimeSeconds,
  maxAheadSeconds,
  joinKey: b64(joinKey),
  inviteSeal: {
    note: "HMAC-SHA256(joinKey, 'passbundle invite v2' 0 organization id 0 lowercased email 0 expires 0 nonce), as v2.<expires>.<nonce>.<mac>.",
    email: "Ana@AcmeDental.example",
    expires,
    nonce: b64url(inviteNonce),
    seal: invite,
  },
  staffSeal: {
    note: "The same with 'passbundle staff v2'.",
    email: "Tech@Northwind.example",
    expires,
    nonce: b64url(staffNonce),
    seal: staff,
  },
  clientSeal: {
    note: "HMAC-SHA256(joinKey, 'passbundle msp client v1' 0 organization id 0 MSP id), standard base64: the organization is this MSP's client.",
    mspId,
    seal: b64(hmac(joinKey, "passbundle msp client v1", organizationId, mspId)),
  },
  // Each of these must vouch (or not) for the invitation of `email` to the
  // organization, checked at `at` (Unix seconds).
  inviteChecks: [
    { why: "the seal, when it's made", email: "ana@acmedental.example", seal: invite, at: madeAt, vouches: true },
    { why: "the seal, a second before it ends", email: "ANA@acmedental.example", seal: invite, at: expires - 1, vouches: true },
    { why: "the seal, once it has ended", email: "ana@acmedental.example", seal: invite, at: expires, vouches: false },
    { why: "another email", email: "ben@acmedental.example", seal: invite, at: madeAt, vouches: false },
    { why: "a staff seal presented as an invitation's", email: "tech@northwind.example", seal: staff, at: madeAt, vouches: false },
    {
      why: "a seal for another organization",
      email: "ana@acmedental.example",
      seal: expiring("invite", "ana@acmedental.example", expires, inviteNonce, otherOrganizationId),
      at: madeAt,
      vouches: false,
    },
    {
      why: "a seal that says it lasts longer than any seal is made for",
      email: "ana@acmedental.example",
      seal: expiring("invite", "ana@acmedental.example", madeAt + maxAheadSeconds + 1, inviteNonce),
      at: madeAt,
      vouches: false,
    },
    {
      why: "the end changed after sealing",
      email: "ana@acmedental.example",
      seal: invite.replace(`v2.${expires}.`, `v2.${expires + DAY}.`),
      at: madeAt,
      vouches: false,
    },
    {
      why: "the nonce changed after sealing",
      email: "ana@acmedental.example",
      seal: invite.replace(`.${b64url(inviteNonce)}.`, `.${b64url(bytes(0x31, 16))}.`),
      at: madeAt,
      vouches: false,
    },
    { why: "the MAC changed", email: "ana@acmedental.example", seal: tampered(invite), at: madeAt, vouches: false },
    {
      why: "a version 1 seal, which never ends",
      email: "ana@acmedental.example",
      seal: b64(hmac(joinKey, "passbundle invite v1", organizationId, "ana@acmedental.example")),
      at: madeAt,
      vouches: false,
    },
  ],
  staffChecks: [
    { why: "the seal", email: "tech@northwind.example", seal: staff, at: madeAt, vouches: true },
    { why: "an invitation's seal presented as a staff seal", email: "ana@acmedental.example", seal: invite, at: madeAt, vouches: false },
    { why: "the seal, once it has ended", email: "tech@northwind.example", seal: staff, at: expires, vouches: false },
  ],
  clientChecks: [
    { why: "the seal", mspId, seal: b64(hmac(joinKey, "passbundle msp client v1", organizationId, mspId)), vouches: true },
    { why: "another MSP", mspId: otherMspId, seal: b64(hmac(joinKey, "passbundle msp client v1", organizationId, mspId)), vouches: false },
    {
      why: "a seal for another organization",
      mspId,
      seal: b64(hmac(joinKey, "passbundle msp client v1", otherOrganizationId, mspId)),
      vouches: false,
    },
    { why: "no seal", mspId, seal: null, vouches: false },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

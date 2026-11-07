// Makes docs/vectors/joining-v3.json
// (node docs/vectors/make-joining-v3.mjs > docs/vectors/joining-v3.json):
// version 3 of the joining seal in "Joins a hacked server can't forge"
// (DESIGN.md). Version 2 said what an organization's joining setting is (let
// people in or not, and its email domains) and where it comes from (its own
// setting, or a default it follows), but not when, so the seal of a setting
// the organization once had stayed good forever, and a hacked server could
// show it again after the organization chose otherwise. Version 3 adds when
// it was sealed and a nonce, as `v3.<source>.<sealedAt>.<nonce>.<mac>`, all
// inside the MAC, and an app never takes an older seal than the newest it
// has seen for that organization. The join key is as in joins-v1.json. Uses
// only Node's crypto, independently of the apps' and the server's code, so
// their tests check themselves against it.
import { createHmac, hkdfSync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
/** Parts joined with a zero byte between them, as UTF-8. */
const join = (parts) =>
  Buffer.concat(parts.flatMap((p, i) => [i ? Buffer.from([0]) : Buffer.alloc(0), Buffer.from(p, "utf8")]));
const hmac = (key, ...parts) => createHmac("sha256", key).update(join(parts)).digest();

// The same organization and key as joins-v1.json, joins-v2.json, and joining-v2.json.
const organizationId = "8f9a7c1e-3b2d-4e5f-9a8b-7c6d5e4f3a2b";
const organizationKey = bytes(0x00, 64);
const otherOrganizationId = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const joinKey = Buffer.from(hkdfSync("sha256", organizationKey, Buffer.alloc(0), "passbundle join key v1", 32));

/**
 * The MAC over a setting, its domains (sorted, joined with ","), where it
 * comes from, when it was sealed (as written), and the nonce (as written).
 */
const mac = (autoConfirm, domains, source, sealedAt, nonce, org = organizationId) =>
  hmac(
    joinKey,
    "passbundle joining v3",
    org,
    autoConfirm ? "1" : "0",
    [...domains].sort().join(","),
    source,
    String(sealedAt),
    nonce,
  );

/** A joining seal, version 3: `v3.<source>.<sealedAt>.<nonce>.<mac>`, nonce and MAC in base64url without padding. */
const joiningSeal = (autoConfirm, domains, source, sealedAt, nonce, org = organizationId) =>
  `v3.${source}.${sealedAt}.${nonce}.${b64url(mac(autoConfirm, domains, source, sealedAt, nonce, org))}`;

/** A 16-byte nonce, base64url without padding (22 characters). */
const nonce = (start) => b64url(bytes(start, 16));

// November 1, 2026, and the days after it.
const day = 86_400;
const t0 = 1_793_059_200;

const firstNonce = nonce(0x10);
const secondNonce = nonce(0x20);
const thirdNonce = nonce(0x30);
const domains = ["contoso.example", "acme.example"];

// An organization that followed a default letting people in, then chose
// approval as its own setting, then let people in again with email domains.
const followsLetIn = joiningSeal(true, [], "default", t0, firstNonce);
const ownApproval = joiningSeal(false, [], "own", t0 + day, secondNonce);
const ownWithDomains = joiningSeal(true, domains, "own", t0 + 2 * day, thirdNonce);
const followsApproval = joiningSeal(false, [], "default", t0 + day, thirdNonce);

/** The seal with the first character of its MAC changed (the last one has bits base64 ignores). */
function tampered(seal) {
  const at = seal.lastIndexOf(".") + 1;
  return `${seal.slice(0, at)}${seal[at] === "A" ? "B" : "A"}${seal.slice(at + 1)}`;
}

/** The seal with one of its dot-separated parts replaced, MAC kept. */
function withPart(seal, index, value) {
  const parts = seal.split(".");
  parts[index] = value;
  return parts.join(".");
}

/** A seal-shaped string with a real MAC over exactly what it says, in any form. */
const raw = (source, sealedAt, nonceText, autoConfirm = true, theDomains = []) =>
  `v3.${source}.${sealedAt}.${nonceText}.${b64url(mac(autoConfirm, theDomains, source, sealedAt, nonceText))}`;

const mark = (sealedAt, nonceText) => ({ sealedAt, nonce: nonceText });

const vectors = {
  version: 3,
  inputs: {
    organizationId,
    organizationKey: b64(organizationKey),
  },
  joinKey: b64(joinKey),
  sources: ["own", "default"],
  seals: [
    {
      note: "HMAC-SHA256(joinKey, 'passbundle joining v3' 0 organization id 0 '1' or '0' 0 domains sorted and joined with ',' 0 source 0 sealedAt 0 nonce), as v3.<source>.<sealedAt>.<nonce>.<mac>: follows a default that lets people in.",
      autoConfirm: true,
      domains: [],
      source: "default",
      sealedAt: t0,
      nonce: firstNonce,
      seal: followsLetIn,
    },
    {
      note: "A day later, the organization's own setting: approval.",
      autoConfirm: false,
      domains: [],
      source: "own",
      sealedAt: t0 + day,
      nonce: secondNonce,
      seal: ownApproval,
    },
    {
      note: "Its own setting, letting people in, with email domains (sorted inside the MAC).",
      autoConfirm: true,
      domains,
      source: "own",
      sealedAt: t0 + 2 * day,
      nonce: thirdNonce,
      seal: ownWithDomains,
    },
    {
      note: "Follows a default of approval.",
      autoConfirm: false,
      domains: [],
      source: "default",
      sealedAt: t0 + day,
      nonce: thirdNonce,
      seal: followsApproval,
    },
  ],
  // Each of these must vouch (or not) that the organization's setting is
  // `autoConfirm` with `domains`, and, where `source` isn't null, that it
  // comes from there: the seal alone, before anything a device remembers.
  checks: [
    { why: "a seal that follows the default", seal: followsLetIn, autoConfirm: true, domains: [], source: "default", vouches: true },
    { why: "the same, from either source", seal: followsLetIn, autoConfirm: true, domains: [], source: null, vouches: true },
    { why: "its own setting", seal: ownApproval, autoConfirm: false, domains: [], source: "own", vouches: true },
    {
      why: "the domains in another order",
      seal: ownWithDomains,
      autoConfirm: true,
      domains: [...domains].reverse(),
      source: null,
      vouches: true,
    },
    {
      why: "an own setting of approval presented as following a default",
      seal: ownApproval,
      autoConfirm: false,
      domains: [],
      source: "default",
      vouches: false,
    },
    { why: "following the default presented as its own setting", seal: followsLetIn, autoConfirm: true, domains: [], source: "own", vouches: false },
    { why: "approval presented as letting people in", seal: ownApproval, autoConfirm: true, domains: [], source: null, vouches: false },
    { why: "another domain", seal: ownWithDomains, autoConfirm: true, domains: ["contoso.example"], source: null, vouches: false },
    { why: "the domains left out", seal: ownWithDomains, autoConfirm: true, domains: [], source: null, vouches: false },
    {
      why: "the source changed in the seal's text",
      seal: withPart(ownApproval, 1, "default"),
      autoConfirm: false,
      domains: [],
      source: null,
      vouches: false,
    },
    {
      why: "an old seal made to look newer: the time changed in its text",
      seal: withPart(followsLetIn, 2, String(t0 + 3 * day)),
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
    {
      why: "the nonce changed in the seal's text",
      seal: withPart(followsLetIn, 3, nonce(0x40)),
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
    {
      why: "a seal for another organization",
      seal: joiningSeal(true, [], "default", t0, firstNonce, otherOrganizationId),
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
    { why: "the MAC changed", seal: tampered(followsLetIn), autoConfirm: true, domains: [], source: null, vouches: false },
    {
      why: "a version 2 seal, which says nothing of when it was sealed",
      seal: `v2.default.${b64url(hmac(joinKey, "passbundle joining v2", organizationId, "1", "", "default"))}`,
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
    {
      why: "a version 1 seal",
      seal: b64(hmac(joinKey, "passbundle joining v1", organizationId, "1", "")),
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
    {
      why: "a version 3 MAC under version 2's label",
      seal: `v3.default.${t0}.${firstNonce}.${b64url(
        hmac(joinKey, "passbundle joining v2", organizationId, "1", "", "default", String(t0), firstNonce),
      )}`,
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
    { why: "a source the apps don't know", seal: raw("msp", t0, firstNonce), autoConfirm: true, domains: [], source: null, vouches: false },
    { why: "a time with a leading zero", seal: raw("default", `0${t0}`, firstNonce), autoConfirm: true, domains: [], source: null, vouches: false },
    { why: "a time of 13 digits", seal: raw("default", "1000000000000", firstNonce), autoConfirm: true, domains: [], source: null, vouches: false },
    { why: "a time that isn't a number", seal: raw("default", "17930592O0", firstNonce), autoConfirm: true, domains: [], source: null, vouches: false },
    { why: "a nonce of 15 bytes", seal: raw("default", t0, b64url(bytes(0x10, 15))), autoConfirm: true, domains: [], source: null, vouches: false },
    { why: "a nonce in standard base64", seal: raw("default", t0, "+/+/+/+/+/+/+/+/+/+/+/"), autoConfirm: true, domains: [], source: null, vouches: false },
    { why: "a part too many", seal: `${followsLetIn}.x`, autoConfirm: true, domains: [], source: null, vouches: false },
  ],
  // Whether a seal that checks out is current on a device, given the newest
  // joining seal that device has seen for the organization (null: none yet).
  // Newer means a later sealedAt, or the same second and a greater nonce,
  // compared as text. A seal that's current and newer becomes the newest.
  current: [
    { why: "nothing seen yet", newestSeen: null, seal: mark(t0, firstNonce), current: true },
    { why: "the seal it has seen", newestSeen: mark(t0 + day, secondNonce), seal: mark(t0 + day, secondNonce), current: true },
    { why: "a newer seal", newestSeen: mark(t0, firstNonce), seal: mark(t0 + day, secondNonce), current: true },
    {
      why: "an older seal: the setting the organization had before it chose approval, shown again",
      newestSeen: mark(t0 + day, secondNonce),
      seal: mark(t0, firstNonce),
      current: false,
    },
    { why: "a second older, with a greater nonce", newestSeen: mark(t0 + day, firstNonce), seal: mark(t0 + day - 1, thirdNonce), current: false },
    { why: "the same second, a smaller nonce", newestSeen: mark(t0 + day, thirdNonce), seal: mark(t0 + day, secondNonce), current: false },
    { why: "the same second, a greater nonce", newestSeen: mark(t0 + day, secondNonce), seal: mark(t0 + day, thirdNonce), current: true },
    {
      why: "nonces compare as text, by character code: '-' before digits before capitals before '_' before lower case",
      newestSeen: mark(t0, "zzzzzzzzzzzzzzzzzzzzzw"),
      seal: mark(t0, "_AAAAAAAAAAAAAAAAAAAAA"),
      current: false,
    },
  ],
  // When a browser seals a change: at its clock's now (Unix seconds), or one
  // second after the newest seal it has seen for the organization if that's
  // later, so a new seal is newer than the one it replaces.
  sealedAt: [
    { why: "nothing seen yet", now: t0, newestSeen: null, sealedAt: t0 },
    { why: "the newest seen is older", now: t0 + day, newestSeen: t0, sealedAt: t0 + day },
    { why: "the newest seen is from this same second", now: t0, newestSeen: t0, sealedAt: t0 + 1 },
    { why: "this device's clock is behind the one that sealed last", now: t0, newestSeen: t0 + 3_600, sealedAt: t0 + 3_601 },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

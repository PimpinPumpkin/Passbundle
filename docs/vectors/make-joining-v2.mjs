// Makes docs/vectors/joining-v2.json
// (node docs/vectors/make-joining-v2.mjs > docs/vectors/joining-v2.json):
// version 2 of the joining seal in "Joins a hacked server can't forge"
// (DESIGN.md). Version 1 said what an organization's joining setting is (let
// people in or not, and its email domains), not where it comes from, so a
// client that chose approval while its MSP's default was approval too looked
// like one that follows the default, and an MSP admin's browser could be led
// to reseal it with "let people in" when the default changed. Version 2 says
// where it comes from: the organization's own setting ("own") or a default it
// follows ("default", its MSP's or the server's), as `v2.<source>.<mac>`, with
// the source inside the MAC. The join key is as in joins-v1.json. Uses only
// Node's crypto, independently of the apps' and the server's code, so their
// tests check themselves against it.
import { createHmac, hkdfSync } from "node:crypto";

const bytes = (start, length) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff));
const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
/** Parts joined with a zero byte between them, as UTF-8. */
const join = (parts) =>
  Buffer.concat(parts.flatMap((p, i) => [i ? Buffer.from([0]) : Buffer.alloc(0), Buffer.from(p, "utf8")]));
const hmac = (key, ...parts) => createHmac("sha256", key).update(join(parts)).digest();

// The same organization and key as joins-v1.json and joins-v2.json.
const organizationId = "8f9a7c1e-3b2d-4e5f-9a8b-7c6d5e4f3a2b";
const organizationKey = bytes(0x00, 64);
const otherOrganizationId = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const joinKey = Buffer.from(hkdfSync("sha256", organizationKey, Buffer.alloc(0), "passbundle join key v1", 32));

/** The MAC over a setting, its domains (sorted, joined with ","), and where it comes from. */
const mac = (autoConfirm, domains, source, org = organizationId) =>
  hmac(joinKey, "passbundle joining v2", org, autoConfirm ? "1" : "0", [...domains].sort().join(","), source);

/** A joining seal, version 2: `v2.<source>.<mac>`, the MAC in base64url without padding. */
const joiningSeal = (autoConfirm, domains, source, org = organizationId) =>
  `v2.${source}.${b64url(mac(autoConfirm, domains, source, org))}`;

const followsLetIn = joiningSeal(true, [], "default");
const followsApproval = joiningSeal(false, [], "default");
const ownApproval = joiningSeal(false, [], "own");
const domains = ["contoso.example", "acme.example"];
const ownWithDomains = joiningSeal(true, domains, "own");

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
  },
  joinKey: b64(joinKey),
  sources: ["own", "default"],
  seals: [
    {
      note: "HMAC-SHA256(joinKey, 'passbundle joining v2' 0 organization id 0 '1' or '0' 0 domains sorted and joined with ',' 0 source), as v2.<source>.<mac>: follows a default that lets people in.",
      autoConfirm: true,
      domains: [],
      source: "default",
      seal: followsLetIn,
    },
    { note: "Follows a default of approval.", autoConfirm: false, domains: [], source: "default", seal: followsApproval },
    { note: "The organization's own setting: approval.", autoConfirm: false, domains: [], source: "own", seal: ownApproval },
    {
      note: "Its own setting, letting people in, with email domains (sorted inside the MAC).",
      autoConfirm: true,
      domains,
      source: "own",
      seal: ownWithDomains,
    },
  ],
  // Each of these must vouch (or not) that the organization's setting is
  // `autoConfirm` with `domains`, and, where `source` isn't null, that it
  // comes from there. An MSP admin's browser reseals a client when its
  // default changes only with a seal that vouches with source "default".
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
      why: "an own setting of approval presented as following a default of approval",
      seal: ownApproval,
      autoConfirm: false,
      domains: [],
      source: "default",
      vouches: false,
    },
    { why: "following the default presented as its own setting", seal: followsApproval, autoConfirm: false, domains: [], source: "own", vouches: false },
    { why: "approval presented as letting people in", seal: ownApproval, autoConfirm: true, domains: [], source: null, vouches: false },
    { why: "another domain", seal: ownWithDomains, autoConfirm: true, domains: ["contoso.example"], source: null, vouches: false },
    {
      why: "the source changed in the seal's text",
      seal: ownApproval.replace("v2.own.", "v2.default."),
      autoConfirm: false,
      domains: [],
      source: null,
      vouches: false,
    },
    {
      why: "a seal for another organization",
      seal: joiningSeal(true, [], "default", otherOrganizationId),
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
    { why: "the MAC changed", seal: tampered(followsLetIn), autoConfirm: true, domains: [], source: null, vouches: false },
    {
      why: "a version 1 seal, which says nothing of where the setting comes from",
      seal: b64(hmac(joinKey, "passbundle joining v1", organizationId, "1", "")),
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
    {
      why: "a source the apps don't know",
      seal: `v2.msp.${b64url(mac(true, [], "msp"))}`,
      autoConfirm: true,
      domains: [],
      source: null,
      vouches: false,
    },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

// Makes docs/vectors/billing-webhook-v1.json
// (node docs/vectors/make-billing-webhook-v1.mjs > docs/vectors/billing-webhook-v1.json):
// headers and bodies, and whether the server must take each, for how it checks
// that a payment provider's webhook is really the provider's (DESIGN.md, "Plans
// and billing", "Checking a webhook"). The scheme is Stripe's published one
// (docs.stripe.com, "Verify webhook signatures manually"):
//
// - The header is entries separated by commas, each a name, "=", and a value.
//   `t` is the time it was signed, in seconds since 1970. Each `v1` is a
//   signature, and there's one for each signing secret in use, so two while a
//   secret is being replaced. Every other entry (`v0`, and debugging ones such
//   as `secret`, `destination`, and `payload`) is ignored, in any order.
// - A signature is the hex of HMAC-SHA256, keyed with the signing secret as it's
//   written, over the timestamp as the header writes it, a period, and the body
//   byte for byte.
// - The header is taken when one of its `v1` signatures matches one made with a
//   secret in use, and its timestamp is no more than five minutes (300 seconds)
//   from the server's clock, either way.
//
// Uses only Node's crypto, independently of the server's code (ring), whose unit
// tests check their own results against a copy of the file (passbundle-server,
// src/keykeeper_billing/vectors/billing-webhook-v1.json). The secrets are made up
// for these vectors and sign nothing real.
import { createHmac } from "node:crypto";

const secrets = {
  current: "whsec_vectors_only_current_7c1e5a",
  old: "whsec_vectors_only_old_2b9d40",
  other: "whsec_vectors_only_someone_else_8e3f11",
};
const tolerance = 300;
const t = 1800000000;
const body = '{"id":"evt_vector_1","object":"event","livemode":false,"customer":"cus_vector_1"}';
// The same body with one byte changed: the customer's last digit.
const changed = body.replace("cus_vector_1", "cus_vector_2");
if (changed.length !== body.length || changed === body) {
  throw new Error("The changed body must differ from the body in one byte");
}

/** The signature of `payload` signed at `timestamp` (as the header writes it) with `secret`. */
const sign = (secret, timestamp, payload) =>
  createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), Buffer.from(payload, "utf8")]))
    .digest("hex");

const current = sign(secrets.current, t, body);
const old = sign(secrets.old, t, body);
const other = sign(secrets.other, t, body);
// The last hex digit changed, and the first.
const flip = (hex, at) => hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);

const cases = [
  // Taken.
  { name: "one signature with the secret in use", header: `t=${t},v1=${current}`, now: t, secrets: ["current"], valid: true },
  { name: "the timestamp five minutes behind the clock", header: `t=${t},v1=${current}`, now: t + tolerance, secrets: ["current"], valid: true },
  { name: "the timestamp five minutes ahead of the clock", header: `t=${t},v1=${current}`, now: t - tolerance, secrets: ["current"], valid: true },
  { name: "the old secret while it's being replaced", header: `t=${t},v1=${old}`, now: t, secrets: ["current", "old"], valid: true },
  { name: "one signature for each secret, with only the new one in use", header: `t=${t},v1=${old},v1=${current}`, now: t, secrets: ["current"], valid: true },
  { name: "one signature for each secret, with only the old one in use", header: `t=${t},v1=${old},v1=${current}`, now: t, secrets: ["old"], valid: true },
  { name: "entries in another order", header: `v1=${current},t=${t}`, now: t, secrets: ["current"], valid: true },
  {
    name: "a test signature and debugging entries beside it, which are ignored",
    header: `t=${t},v1=${current},v0=${sign(secrets.other, t, body)},secret=whsec_****7c1e5a,destination=we_vector,payload=ab12cd34`,
    now: t,
    secrets: ["current"],
    valid: true,
  },
  // Refused.
  { name: "a timestamp a second more than five minutes behind", header: `t=${t},v1=${current}`, now: t + tolerance + 1, secrets: ["current"], valid: false },
  { name: "a timestamp a second more than five minutes ahead", header: `t=${t},v1=${current}`, now: t - tolerance - 1, secrets: ["current"], valid: false },
  { name: "a secret not in use", header: `t=${t},v1=${other}`, now: t, secrets: ["current", "old"], valid: false },
  { name: "the old secret once it's no longer in use", header: `t=${t},v1=${old}`, now: t, secrets: ["current"], valid: false },
  { name: "the body changed by one byte", header: `t=${t},v1=${current}`, body: changed, now: t, secrets: ["current"], valid: false },
  { name: "a signature changed in its last digit", header: `t=${t},v1=${flip(current, 63)}`, now: t, secrets: ["current"], valid: false },
  { name: "a signature changed in its first digit", header: `t=${t},v1=${flip(current, 0)}`, now: t, secrets: ["current"], valid: false },
  { name: "a signature cut short by a byte", header: `t=${t},v1=${current.slice(0, 62)}`, now: t, secrets: ["current"], valid: false },
  { name: "a signature a byte too long", header: `t=${t},v1=${current}00`, now: t, secrets: ["current"], valid: false },
  { name: "a signature that isn't hex", header: `t=${t},v1=${"z".repeat(64)}`, now: t, secrets: ["current"], valid: false },
  {
    name: "a good signature under another scheme only",
    header: `t=${t},v0=${current},v2=${current}`,
    now: t,
    secrets: ["current"],
    valid: false,
  },
  {
    name: "a signature for another timestamp",
    header: `t=${t + 60},v1=${current}`,
    now: t + 60,
    secrets: ["current"],
    valid: false,
  },
  { name: "the timestamp written another way", header: `t=0${t},v1=${current}`, now: t, secrets: ["current"], valid: false },
  { name: "no timestamp", header: `v1=${current}`, now: t, secrets: ["current"], valid: false },
  { name: "two timestamps", header: `t=${t},t=${t},v1=${current}`, now: t, secrets: ["current"], valid: false },
  { name: "a timestamp that isn't a number", header: `t=soon,v1=${current}`, now: t, secrets: ["current"], valid: false },
  { name: "a negative timestamp", header: `t=-${t},v1=${current}`, now: t, secrets: ["current"], valid: false },
  { name: "no signature", header: `t=${t}`, now: t, secrets: ["current"], valid: false },
  { name: "an empty header", header: "", now: t, secrets: ["current"], valid: false },
  { name: "spaces around the entries", header: `t=${t}, v1=${current}`, now: t, secrets: ["current"], valid: false },
];

console.log(
  JSON.stringify(
    {
      description:
        "Stripe's published webhook signature scheme, as the server checks it (DESIGN.md, \"Checking a webhook\"). Each case is taken (valid) or refused, at `now`, with the named secrets in use, for `body` unless the case gives its own. Made with make-billing-webhook-v1.mjs and Node's crypto alone. The secrets are made up for these vectors.",
      tolerance,
      secrets,
      body,
      cases: cases.map(({ name, header, body: own, now, secrets: inUse, valid }) => ({
        name,
        header,
        ...(own ? { body: own } : {}),
        now,
        secrets: inUse,
        valid,
      })),
    },
    null,
    2,
  ),
);

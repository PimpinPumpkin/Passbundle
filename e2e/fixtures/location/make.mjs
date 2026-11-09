// A tiny IP-to-location database for the new-device check's tests (DESIGN.md,
// "New-device check", "Where a sign-in comes from"), in the MaxMind DB
// format (its published specification, version 2.0) with GeoLite2's layout,
// as DB-IP's free databases are. Its places are made up, on documentation
// addresses no real database has (RFC 5737, RFC 3849), so a test that sees
// "Fixture City, Germany" knows the server read this file and nothing else.
//
//   node e2e/fixtures/location/make.mjs <output.mmdb>
//
// Plain Node, no packages: the test server's own reader is checked against
// a database this independent writer makes.
import fs from "node:fs";
import net from "node:net";

export const PLACES = [
  { network: "203.0.113.0/24", country: "Germany", iso: "DE", city: "Fixture City" },
  { network: "198.51.100.0/25", country: "Canada", iso: "CA", city: null },
  { network: "2001:db8:5::/48", country: "Japan", iso: "JP", city: "Fixture Bay" },
];

const MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]);

/** A value's control byte(s) for a type and size. */
function control(type, size) {
  let first;
  let extra = [];
  if (size < 29) {
    first = size;
  } else if (size < 285) {
    first = 29;
    extra = [size - 29];
  } else {
    first = 30;
    extra = [(size - 285) >> 8, (size - 285) & 0xff];
  }
  const head = type <= 7 ? [(type << 5) | first] : [first, type - 7];
  return Buffer.from([...head, ...extra]);
}

const string = (s) => {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([control(2, bytes.length), bytes]);
};

const uint = (type, n) => {
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) {
    bytes.unshift(v & 0xff);
  }
  return Buffer.concat([control(type, bytes.length), Buffer.from(bytes)]);
};

const map = (pairs) =>
  Buffer.concat([control(7, pairs.length), ...pairs.flatMap(([k, v]) => [string(k), v])]);

const names = (name) => map([["en", string(name)]]);

function record(place) {
  const pairs = [];
  if (place.city) {
    pairs.push(["city", map([["names", names(place.city)]])]);
  }
  pairs.push([
    "country",
    map([
      ["iso_code", string(place.iso)],
      ["names", names(place.country)],
    ]),
  ]);
  return map(pairs);
}

/** The address as 128 bits, IPv4 in IPv6's ::/96. */
function bits(address) {
  if (net.isIPv4(address)) {
    return address.split(".").reduce((acc, part) => (acc << 8n) | BigInt(part), 0n);
  }
  const [head, tail = ""] = address.split("::");
  const groups = (s) => (s ? s.split(":") : []);
  const h = groups(head);
  const t = groups(tail);
  const all = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return all.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export function build(places = PLACES) {
  const data = [];
  let size = 0;
  const offsets = places.map((p) => {
    const bytes = record(p);
    data.push(bytes);
    const at = size;
    size += bytes.length;
    return at;
  });

  // nodes[i] = [left, right], each { node } or { record } or null.
  const nodes = [[null, null]];
  places.forEach((p, i) => {
    const [address, length] = p.network.split("/");
    const prefix = Number(length) + (net.isIPv4(address) ? 96 : 0);
    const value = bits(address);
    let node = 0;
    for (let depth = 0; depth < prefix; depth++) {
      const bit = Number((value >> BigInt(127 - depth)) & 1n);
      if (depth === prefix - 1) {
        nodes[node][bit] = { record: i };
      } else {
        if (nodes[node][bit] == null) {
          nodes.push([null, null]);
          nodes[node][bit] = { node: nodes.length - 1 };
        }
        node = nodes[node][bit].node;
      }
    }
  });
  const count = nodes.length;
  const valueOf = (c) =>
    c == null ? count : c.node != null ? c.node : count + 16 + offsets[c.record];
  // Record size 24: each node is two 3-byte records.
  const tree = Buffer.alloc(count * 6);
  nodes.forEach(([l, r], i) => {
    tree.writeUIntBE(valueOf(l), i * 6, 3);
    tree.writeUIntBE(valueOf(r), i * 6 + 3, 3);
  });

  const metadata = map([
    ["binary_format_major_version", uint(5, 2)],
    ["binary_format_minor_version", uint(5, 0)],
    ["build_epoch", uint(9, 1_762_560_000)],
    ["database_type", string("PassBundle-Test-Location")],
    ["description", map([["en", string("Made-up places for PassBundle's tests")]])],
    ["ip_version", uint(5, 6)],
    ["languages", Buffer.concat([control(11, 1), string("en")])],
    ["node_count", uint(6, count)],
    ["record_size", uint(5, 24)],
  ]);
  return Buffer.concat([tree, Buffer.alloc(16), ...data, MARKER, metadata]);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node e2e/fixtures/location/make.mjs <output.mmdb>");
    process.exit(2);
  }
  fs.writeFileSync(out, build());
}

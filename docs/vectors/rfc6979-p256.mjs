// ECDSA on P-256 with SHA-256 and RFC 6979's deterministic nonces, in plain
// BigInt arithmetic: the vectors' own signer, independent of the core's
// (RustCrypto) and of OpenSSL, which checks the result.
import { createHmac, createHash } from "node:crypto";

const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const a = p - 3n;
const G = [
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
];

const mod = (x, m) => ((x % m) + m) % m;
const inverse = (x, m) => {
  let [r0, r1, s0, s1] = [mod(x, m), m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
};

function add(P, Q) {
  if (P === null) return Q;
  if (Q === null) return P;
  const [x1, y1] = P;
  const [x2, y2] = Q;
  if (x1 === x2 && mod(y1 + y2, p) === 0n) return null;
  const l =
    x1 === x2 && y1 === y2
      ? mod((3n * x1 * x1 + a) * inverse(2n * y1, p), p)
      : mod((y2 - y1) * inverse(x2 - x1, p), p);
  const x3 = mod(l * l - x1 - x2, p);
  return [x3, mod(l * (x1 - x3) - y1, p)];
}

export function multiply(k, P = G) {
  let result = null;
  let addend = P;
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}

const toBig = (buffer) => BigInt(`0x${Buffer.from(buffer).toString("hex") || "0"}`);
const to32 = (x) => Buffer.from(x.toString(16).padStart(64, "0"), "hex");
const hmac = (key, ...parts) => {
  const h = createHmac("sha256", key);
  for (const part of parts) h.update(part);
  return h.digest();
};

// RFC 6979, 3.2: k from the private key and the message's hash.
function nonce(d, hash) {
  const x = to32(d);
  const h = to32(mod(toBig(hash), n));
  let v = Buffer.alloc(32, 1);
  let k = Buffer.alloc(32, 0);
  k = hmac(k, v, Buffer.from([0]), x, h);
  v = hmac(k, v);
  k = hmac(k, v, Buffer.from([1]), x, h);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const candidate = toBig(v);
    if (candidate >= 1n && candidate < n) return candidate;
    k = hmac(k, v, Buffer.from([0]));
    v = hmac(k, v);
  }
}

/** Signs `message` (hashed with SHA-256): { r, s } as 32-byte buffers, and DER. */
export function sign(privateKey, message) {
  const d = toBig(privateKey);
  const hash = createHash("sha256").update(message).digest();
  const e = mod(toBig(hash), n);
  const k = nonce(d, hash);
  const r = mod(multiply(k)[0], n);
  const s = mod(inverse(k, n) * (e + r * d), n);
  return { r: to32(r), s: to32(s), der: der(r, s) };
}

/** The public key's coordinates. */
export function publicKey(privateKey) {
  const [x, y] = multiply(toBig(privateKey));
  return { x: to32(x), y: to32(y) };
}

function der(r, s) {
  const integer = (x) => {
    let bytes = Buffer.from(x.toString(16).padStart(64, "0"), "hex");
    while (bytes.length > 1 && bytes[0] === 0 && bytes[1] < 0x80) bytes = bytes.subarray(1);
    if (bytes[0] >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([integer(r), integer(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

// Makes docs/vectors/event-streaming-secrets-v1.json
// (node docs/vectors/make-event-streaming-secrets-v1.mjs > docs/vectors/event-streaming-secrets-v1.json):
// fixed inputs and what the server must compute from them to keep event
// destinations' secrets at rest (DESIGN.md, "Sending events to security
// tools", "Secrets at rest"). Uses only Node's crypto, independently of the
// server's code (ring and OpenSSL), whose unit tests check their own results
// against a copy of the file (passbundle-server,
// src/keykeeper_streaming/vectors/event-streaming-secrets-v1.json).
//
// The RSA key below was made for these vectors only and protects nothing.
import { createCipheriv, createHmac, createPrivateKey } from "node:crypto";

const rsaPkcs1Pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAjbgs5xJqgE/ETAZxoclSM2YNg0G9pbkL3GLUDsI7G5wf2EUV
iYYdMtxLUI7sp83klRu7ochUgm3+5DN/7VA4p9wrQcQERJfvJ9vbASz545XaJ3Ot
ppwXxNxrr8glj2KCB1xtp7dHsHIvLQzZxem/NokCUBw3wB0VOtvqAXaXW0hpQNhW
60uDeFzavb8WVtO60LhlLMfkMqYu8c56h99Z+mIPKkR84Pybj6EYbMpxs48kBa0D
vAXqfgzFJUX5kNwsYJcf2Iuf0q2mMVL9XzSOJgq40Zz4d0ww4KS90SQwK1F/EVDz
rGL7+wdSq21/8iX8Dc/u9zGCnq+0J0kNwr+0AQIDAQABAoIBAAHuG4Xy4DKSy4oL
xyvIeLMwoU/bowolE9hWu/u+uVR8Hwqob7V3lzGWcpvkc2yKY0Hk3pyCpISBfCCG
Y0hTkK74Epp+4X4/6brbrZ8VqkpXQ9EoXBnGG9SDej+60IikM0BHieqIJmy8tF/n
Ijbl4uPasDZwOPHnz36FiNmH4II2rEAZopsyCrwS1ag9LyVf68MPc2kAHEXA/XYy
cDn9n5QV6CaNRgF8Lkk9A6Bc9VI7+noHZ9rQeL+Ccv3qsLYnWCum7NrHycheGK7T
m1kQmZjgV8vvQA8LtgLqqgzK9Ydljjtpg/R6JBxIL67RlX5U0XNnOP7p0iPAt+Xi
VrGnxwECgYEAw8aFG6fkqxGUmMY+tG5rwrawAaOmqE3sTlu/EELG+8Uvc6HnJqa8
HM3hwaxyM6NEC5ZkJST7XcbC/yRkPBCKGU9fAixrNABMefJDr04OvMw9NUW/Lk7d
76BlGAA+BkbC/3Bl5Bc7lfiBQNJCRJ4GgQpjEofPY7TdpkNGiGAQ48ECgYEAuVCy
t6n3mWUGCTE29H01N7C19LtMbcjLPUyTHu4AGCpEYEgM3miE28eYQ2ib4LjRjQ8A
oCUL27iKSdVOMOrNa1p5D0E2HII7TH/L+pvEDqDcQMzexwsm6UmpwsLAv+cBlPOl
otQHRJ42/ZvJJCgiDXnwAAz8m+hWaW1FvR5t4EECgYAkGRKqCscLE+7GTKd7NXEB
MhY59ybfmZ6cxCXypZ1zBuS8+XlZkxzUYtHhmB5mjxAY4t4MS0ld/SwvR1KEELil
+hCWogISUIvJYHZCeK4W+cG/dODPdRNO/9AkIMdO+PUzjFH9QJtoB64teZdmd4zT
dkrWO9xtkgfchEMZGj2DAQKBgQCkSIEXR0ukJiYSshmI5xLtmu/D1ONtlAtw/ViT
m+Rjh9z0Cgu2g6v8dtZqM+u0bcP/rCQe1JjNoayexcW6of2XxS37MxF4do+BQu4e
7kYBveNkYvrANAe72rzvVt2vgmgpl1HoptUGpMgVTi0jq5x8m/QC54Bt6qvobKHd
hYNcwQKBgAqSgdwya4mkNYmsnym7+buTQPbGwyaWJGeXCq3F9TQcT/7f5M4eownO
wr2QaV7O89lZyYztUGkjpjw47uX1CtCBgXBq/CXZ9zobKcFI5ZAop+dat8BWB7cU
EenmRTTp5XZ70AxOnIUhHkT5dMZnSgc1zCQksat8ELYxczJQRQ8C
-----END RSA PRIVATE KEY-----`;
const rsaPkcs8Pem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCNuCznEmqAT8RM
BnGhyVIzZg2DQb2luQvcYtQOwjsbnB/YRRWJhh0y3EtQjuynzeSVG7uhyFSCbf7k
M3/tUDin3CtBxAREl+8n29sBLPnjldonc62mnBfE3GuvyCWPYoIHXG2nt0ewci8t
DNnF6b82iQJQHDfAHRU62+oBdpdbSGlA2FbrS4N4XNq9vxZW07rQuGUsx+Qypi7x
znqH31n6Yg8qRHzg/JuPoRhsynGzjyQFrQO8Bep+DMUlRfmQ3Cxglx/Yi5/SraYx
Uv1fNI4mCrjRnPh3TDDgpL3RJDArUX8RUPOsYvv7B1KrbX/yJfwNz+73MYKer7Qn
SQ3Cv7QBAgMBAAECggEAAe4bhfLgMpLLigvHK8h4szChT9ujCiUT2Fa7+765VHwf
CqhvtXeXMZZym+RzbIpjQeTenIKkhIF8IIZjSFOQrvgSmn7hfj/pututnxWqSldD
0ShcGcYb1IN6P7rQiKQzQEeJ6ogmbLy0X+ciNuXi49qwNnA48efPfoWI2Yfggjas
QBmimzIKvBLVqD0vJV/rww9zaQAcRcD9djJwOf2flBXoJo1GAXwuST0DoFz1Ujv6
egdn2tB4v4Jy/eqwtidYK6bs2sfJyF4YrtObWRCZmOBXy+9ADwu2AuqqDMr1h2WO
O2mD9HokHEgvrtGVflTRc2c4/unSI8C35eJWsafHAQKBgQDDxoUbp+SrEZSYxj60
bmvCtrABo6aoTexOW78QQsb7xS9zoecmprwczeHBrHIzo0QLlmQlJPtdxsL/JGQ8
EIoZT18CLGs0AEx58kOvTg68zD01Rb8uTt3voGUYAD4GRsL/cGXkFzuV+IFA0kJE
ngaBCmMSh89jtN2mQ0aIYBDjwQKBgQC5ULK3qfeZZQYJMTb0fTU3sLX0u0xtyMs9
TJMe7gAYKkRgSAzeaITbx5hDaJvguNGNDwCgJQvbuIpJ1U4w6s1rWnkPQTYcgjtM
f8v6m8QOoNxAzN7HCybpSanCwsC/5wGU86Wi1AdEnjb9m8kkKCINefAADPyb6FZp
bUW9Hm3gQQKBgCQZEqoKxwsT7sZMp3s1cQEyFjn3Jt+ZnpzEJfKlnXMG5Lz5eVmT
HNRi0eGYHmaPEBji3gxLSV39LC9HUoQQuKX6EJaiAhJQi8lgdkJ4rhb5wb904M91
E07/0CQgx0749TOMUf1Am2gHri15l2Z3jNN2StY73G2SB9yEQxkaPYMBAoGBAKRI
gRdHS6QmJhKyGYjnEu2a78PU422UC3D9WJOb5GOH3PQKC7aDq/x21moz67Rtw/+s
JB7UmM2hrJ7Fxbqh/ZfFLfszEXh2j4FC7h7uRgG942Ri+sA0B7vavO9W3a+CaCmX
Ueim1QakyBVOLSOrnHyb9ALngG3qq+hsod2Fg1zBAoGACpKB3DJriaQ1iayfKbv5
u5NA9sbDJpYkZ5cKrcX1NBxP/t/kzh6jCc7CvZBpXs7z2VnJjO1QaSOmPDju5fUK
0IGBcGr8Jdn3OhspwUjlkCin51q3wFYHtxQR6eZFNOnldnvQDE6chSEeRPl0xmdK
BzXMJCSxq3wQtjFzMlBFDwI=
-----END PRIVATE KEY-----`;

const label = "passbundle event streaming secrets v1";
// The key is derived from the RSA key's PKCS#1 DER, so either PEM form of the
// same key gives the same one.
const der = (pem) => createPrivateKey(pem).export({ type: "pkcs1", format: "der" });
const deriveKey = (pem) => createHmac("sha256", der(pem)).update(label, "utf8").digest();
const key = deriveKey(rsaPkcs1Pem);
if (!key.equals(deriveKey(rsaPkcs8Pem))) {
  throw new Error("Both PEM forms must give the same key");
}

/** What a ciphertext is bound to, as the server writes it. */
const aad = ({ id, owner, kind }) => Buffer.from(`event destination ${id}\u0000owner ${owner}\u0000kind ${kind}`, "utf8");

/** "v1." and base64 of nonce, ciphertext, and the 16-byte tag. */
function seal(binding, nonce, plaintext) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(binding));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([nonce, data, cipher.getAuthTag()]).toString("base64")}`;
}

const binding = { id: "6f1d2c3b-4a59-4687-9e0f-a1b2c3d4e5f6", owner: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", kind: "webhook" };
const cases = [
  {
    binding,
    nonce: Buffer.from("000102030405060708090a0b", "hex"),
    plaintext: JSON.stringify({ url: "https://siem.example.test/hook?token=abc", signingSecret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" }),
  },
  {
    binding: { ...binding, kind: "sentinel" },
    nonce: Buffer.from("f0e1d2c3b4a5968778695a4b", "hex"),
    plaintext: JSON.stringify({ clientSecret: "app-secret-value" }),
  },
];

const vectors = {
  version: 1,
  label,
  rsaPkcs1Pem,
  rsaPkcs8Pem,
  rsaPkcs1Der: der(rsaPkcs1Pem).toString("base64"),
  key: key.toString("hex"),
  cases: cases.map((c) => ({
    binding: c.binding,
    aad: aad(c.binding).toString("utf8"),
    nonce: c.nonce.toString("hex"),
    plaintext: c.plaintext,
    sealed: seal(c.binding, c.nonce, c.plaintext),
  })),
  // The first case's ciphertext must not open with any of these.
  wrongBindings: [
    { ...binding, id: "6f1d2c3b-4a59-4687-9e0f-a1b2c3d4e5f7" },
    { ...binding, owner: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e" },
    { ...binding, kind: "syslog" },
  ],
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

// Script access from the command-line tool (docs/cli.md, "Script access";
// docs/script-access.md): the built program (KK_CLI), as a Mac or Linux
// script runs it, reads a granted field with a token made through the API and
// nothing else: no account, no session, and no data folder. The token comes
// from PASSBUNDLE_SCRIPT_TOKEN or stdin, and from --token only with a warning.
// It refuses a copy made for another item, a field the token wasn't granted,
// and a revoked token. Copies here are made with plain Node, as the vectors
// are; the tool's unit tests check it against the vectors.
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { brand, port } from "../../paths.mjs";
import { Api, encString, withMasterPassword, type Account } from "../api/support";
import { serverCertificate } from "../support/core";

const cliBin = process.env.KK_CLI;
// Tier 1 always builds the tool; only a local run without one skips.
test.skip(!cliBin && !process.env.CI, "KK_CLI isn't set: build the command-line tool first (docs/cli.md)");

// The master password making a token needs is checked the way a sign-in is
// (600,000 rounds of PBKDF2 on the server, slow in its debug build).
test.describe.configure({ timeout: 180_000 });

const command: string = brand.cli.command;
const prefix: string = brand.cli.envPrefix;
const server = `https://127.0.0.1:${port}`;

const hkdf = (seed: Buffer, info: string, length: number) =>
  Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(0), info, length));

/** Upstream's type 2 encrypted string. */
function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32)).update(Buffer.concat([iv, ct])).digest();
  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
}

/** RFC 6238 with SHA-1, 30 seconds, 6 digits, at a given time. */
function totp(base32: string, at: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...base32].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash[hash.length - 1] & 0xf;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

/** A token made through the API, as the web vault makes one, with the copy `copyFor` makes. */
async function makeToken(
  api: Api,
  owner: Account,
  orgId: string,
  itemId: string,
  copyFor: (id: string, key: Buffer) => string,
) {
  const id = randomUUID();
  const seed = randomBytes(32);
  const authSecret = hkdf(seed, "passbundle script auth v1", 32);
  const tokenKey = hkdf(seed, "passbundle script key v1", 64);
  const revision = (await api.call(owner, "GET", `/api/ciphers/${itemId}`)).body.revisionDate;
  const created = await api.call(
    owner,
    "POST",
    `/api/keykeeper/organizations/${orgId}/script-tokens`,
    withMasterPassword(owner, {
      id,
      name: "Mac deploy",
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      authHash: createHash("sha256").update(authSecret).digest("base64"),
      sealedKey: encString("sealed"),
      grants: [{ itemId, copy: copyFor(id, tokenKey), revision, sealedSpec: encString("spec") }],
    }),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { id, tokenString: `pbs1_${id.replace(/-/g, "")}_${seed.toString("base64url")}` };
}

type Run = { status: number | null; stdout: string; stderr: string };

test("a script reads a granted field with a script token alone, writes nothing, and is refused once the token is revoked", async ({
  request,
}) => {
  expect(cliBin, "tier 1 sets KK_CLI").toBeTruthy();
  const api = new Api(request);
  const owner = await api.account("cli-script-owner");
  const orgId = await api.organization(owner, "Contoso");
  const item = await api.orgItem(owner, orgId, await api.collection(owner, orgId));
  const good = await makeToken(api, owner, orgId, item, (id, key) =>
    encrypt(
      key,
      JSON.stringify({
        v: 1,
        token: id,
        item,
        revision: "2026-11-18T18:00:00.000Z",
        name: "Domain admin",
        username: "admin@contoso.example",
        password: "not-a-real-password-1",
        totp: TOTP_SECRET,
        fields: { "API key": "k-123" },
      }),
    ),
  );

  // A computer the tool has never run on: an empty home, no data folder.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-cli-script-"));
  const certificate = await serverCertificate(fs.mkdtempSync(path.join(os.tmpdir(), "pb-cli-cert-")));
  const run = (args: string[], env: Record<string, string> = {}, input?: string): Run => {
    const result = spawnSync(cliBin!, args, {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        [`${prefix}SERVER`]: server,
        NODE_EXTRA_CA_CERTS: certificate,
        ...env,
      },
      input,
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const withToken = { [`${prefix}SCRIPT_TOKEN`]: good.tokenString };

  // Each field, by name or by id; only the value on stdout, nothing on stderr.
  const before = Date.now();
  for (const [args, value] of [
    [["script", "get", "Domain admin", "--field", "username"], "admin@contoso.example"],
    [["script", "get", "Domain admin"], "not-a-real-password-1"],
    [["script", "get", item, "--field", "password"], "not-a-real-password-1"],
    [["script", "get", "Domain admin", "--field", "API key"], "k-123"],
  ] as const) {
    const read = run([...args], withToken);
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe(value);
    expect(read.stderr).toBe("");
  }
  const code = run(["script", "get", item, "--field", "totp"], withToken);
  expect(code.status, code.stderr).toBe(0);
  expect([totp(TOTP_SECRET, before), totp(TOTP_SECRET, Date.now())]).toContain(code.stdout);
  // As JSON for a script that wants it.
  const json = run(["--response", "script", "get", "Domain admin", "--field", "username"], withToken);
  expect(JSON.parse(json.stdout)).toEqual({
    success: true,
    data: { object: "string", data: "admin@contoso.example" },
  });

  // The token on stdin, as `printf '%s\n' "$token" | passbundle script get ...`.
  const piped = run(["script", "get", "Domain admin"], {}, `${good.tokenString}\n`);
  expect(piped.status, piped.stderr).toBe(0);
  expect(piped.stdout).toBe("not-a-real-password-1");
  expect(piped.stderr).toBe("");

  // On the command line it works, and says where it belongs.
  const argued = run(["script", "get", "Domain admin", "--token", good.tokenString]);
  expect(argued.status).toBe(0);
  expect(argued.stdout).toBe("not-a-real-password-1");
  expect(argued.stderr).toContain("the script token is on the command line");
  expect(argued.stderr).toContain(`Set ${prefix}SCRIPT_TOKEN instead`);

  // No token at all: it says where to put one.
  const none = run(["script", "get", "Domain admin"], {}, "");
  expect(none.status).toBe(1);
  expect(none.stderr).toContain(`No script token: set ${prefix}SCRIPT_TOKEN, or give it on stdin.`);

  // Nothing written: no data folder, nor anything else in the home folder.
  expect(fs.readdirSync(home)).toEqual([]);

  // What the token wasn't granted, and an item it can't read.
  const field = run(["script", "get", "Domain admin", "--field", "PIN"], withToken);
  expect(field.status).toBe(1);
  expect(field.stdout).toBe("");
  expect(field.stderr).toContain("This token wasn't granted 'PIN' of Domain admin.");
  const other = run(["script", "get", "Wi-Fi"], withToken);
  expect(other.stderr).toContain("This token can't read an item named 'Wi-Fi'.");

  // A copy made for another item, and one not made with the token's key.
  const swapped = await makeToken(api, owner, orgId, item, (id, key) =>
    encrypt(key, JSON.stringify({ v: 1, token: id, item: randomUUID(), name: "Domain admin", fields: {} })),
  );
  const swappedRead = run(["script", "get", item], { [`${prefix}SCRIPT_TOKEN`]: swapped.tokenString });
  expect(swappedRead.status).toBe(1);
  expect(swappedRead.stderr).toContain("The server sent a copy made for another token or item.");
  const forged = await makeToken(api, owner, orgId, item, () =>
    encrypt(randomBytes(64), JSON.stringify({ v: 1, name: "Domain admin", fields: {} })),
  );
  const forgedRead = run(["script", "get", item], { [`${prefix}SCRIPT_TOKEN`]: forged.tokenString });
  expect(forgedRead.stderr).toContain("integrity check");

  // Revoked: refused, and it says why it may have been.
  const revoked = await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/script-tokens/${good.id}`);
  expect(revoked.status).toBe(200);
  const after = run(["script", "get", "Domain admin"], withToken);
  expect(after.status).toBe(1);
  expect(after.stdout).toBe("");
  expect(after.stderr).toContain("The server refused the token: it was revoked or expired");
  // With --cleanexit, a script that checks the output instead still exits 0.
  expect(run(["--cleanexit", "script", "get", "Domain admin"], withToken).status).toBe(0);

  // Its help names the brand's variable and command.
  const help = run(["script", "get", "--help"]);
  expect(help.stdout).toContain(`${prefix}SCRIPT_TOKEN`);
  expect(help.stdout).toContain(`${command} script get`);
  expect(fs.readdirSync(home)).toEqual([]);
});

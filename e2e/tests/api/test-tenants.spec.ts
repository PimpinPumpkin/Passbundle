// The test tenants tool (tools/test-tenants, README.md), run as a person runs
// it, against a server set up as the hosted test server is while the tool
// seeds it: no email, the new-device check on, sign-up only at the tenants'
// domains. It seeds, and what it made is checked as the apps would see it,
// opened with keys derived from the master passwords it wrote down; the
// server's database holds none of it readable; seeding again changes nothing;
// reset makes it all again; and teardown takes it down.
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { Api, stepOf, totp } from "../../../tools/test-tenants/api.ts";
import type { PersonState, State } from "../../../tools/test-tenants/seed.ts";
import { emailOf, MSP_NAME, ORGS, OWN, PEOPLE, WEAK } from "../../../tools/test-tenants/tenants.ts";
import {
  credentialsPath,
  databaseBytes,
  open,
  openText,
  readState,
  runTool,
  startTenantsServer,
  statePath,
  stopTenantsServer,
  type TenantsServer,
  tenantsServer,
  unseal,
  writeState,
} from "../support/test-tenants";
import { masterKeys } from "../support/vault-crypto";

test.describe.configure({ mode: "serial" });
// The PostgreSQL job runs the API tests again; this one starts a SQLite
// server of its own either way, so once is enough.
test.skip(!!process.env.KK_DATABASE_URL, "Runs on its own SQLite server, in the main API job");

let server: TenantsServer;
let api: Api;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = await startTenantsServer();
  api = await Api.open(tenantsServer, true);
});

test.afterAll(async () => {
  await api?.close();
  await stopTenantsServer(server);
});

/** Someone's vault as their apps open it: signed in, keys from the master password, everything in sync. */
async function vaultOf(state: State, key: string) {
  const who: PersonState = state.people[key];
  const session = await api.signIn(who);
  // As a current app asks: older ones don't get SSH keys.
  const answer = await api.http.get("/api/sync?excludeDomains=true", {
    headers: { Authorization: `Bearer ${session.token}`, "Bitwarden-Client-Version": "2026.10.0" },
  });
  expect(answer.status()).toBe(200);
  const sync = await answer.json();
  const { stretched } = masterKeys(who.email, who.password);
  const userKey = open(stretched, sync.profile.key);
  const privateKey = open(userKey, sync.profile.privateKey);
  const orgKeys = new Map<string, Buffer>();
  for (const o of sync.profile.organizations) {
    if (o.key && o.status === 2) {
      orgKeys.set(o.id, unseal(privateKey, o.key));
    }
  }
  const keyOf = (c: { organizationId: string | null }) => (c.organizationId ? orgKeys.get(c.organizationId)! : userKey);
  const name = (c: { organizationId: string | null; name: string }) => openText(keyOf(c), c.name);
  return { session, sync, userKey, orgKeys, keyOf, name };
}

const orgId = (state: State, key: string) => state.orgs[key].id;

test("seeds every tenant through the API, encrypted on this computer, with the master passwords only in its private files", async () => {
  test.setTimeout(10 * 60_000);
  const run = await runTool(server, "seed");
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toContain(`Seeded ${tenantsServer}`);

  // The files: only this user can read them, and only they hold the passwords.
  expect(fs.statSync(server.outDir).mode & 0o777).toBe(0o700);
  for (const file of [statePath(server), credentialsPath(server)]) {
    expect(fs.statSync(file).mode & 0o777, file).toBe(0o600);
  }
  const state = readState(server);
  expect(state.complete).toBe(true);
  const credentials = fs.readFileSync(credentialsPath(server), "utf8");
  const accounts = PEOPLE.filter((p) => p.account);
  expect(Object.keys(state.people).sort()).toEqual(accounts.map((p) => p.key).sort());
  for (const p of PEOPLE) {
    expect(credentials).toContain(`## ${p.name}`);
    expect(credentials).toContain(emailOf(p));
    expect(emailOf(p)).toMatch(/@[a-z-]+\.test$/);
  }
  for (const st of Object.values(state.people)) {
    expect(st.password.length).toBeGreaterThanOrEqual(24);
    expect(credentials).toContain(st.password);
    expect(run.stdout + run.stderr).not.toContain(st.password);
  }

  // Nothing the people see reached the server readable: no master password,
  // item name, password, or note is anywhere in its database.
  const plain = new Set<string>();
  const names = new Set([...PEOPLE.map((p) => p.name), ...ORGS.map((o) => o.name), MSP_NAME]);
  const groups = new Set(ORGS.flatMap((o) => (o.groups ?? []).map((g) => g.name)));
  for (const item of [...ORGS.flatMap((o) => o.items), ...Object.values(OWN).flatMap((v) => v.items)]) {
    if (item.name.length >= 6 && !names.has(item.name)) {
      plain.add(item.name);
    }
    if (item.notes) {
      plain.add(item.notes);
    }
  }
  for (const folder of ORGS.flatMap((o) => o.folders.map((f) => f.name))) {
    if (!groups.has(folder)) {
      plain.add(folder);
    }
  }
  // What the server keeps readable on purpose (emails, people's and
  // organizations' names) can't count against it.
  const metadata = [...PEOPLE.map(emailOf), ...names].join("\n").toLowerCase();
  for (const value of [...Object.values(WEAK), ...Object.values(state.people).map((s) => s.password)]) {
    if (!metadata.includes(value.toLowerCase())) {
      plain.add(value);
    }
  }
  const database = databaseBytes(server);
  expect(database.length).toBeGreaterThan(0);
  for (const value of plain) {
    expect(database.includes(Buffer.from(value, "utf8")), `"${value}" isn't in the database`).toBe(false);
  }

  // Alex Morgan's own vault opens with his master password, and has
  // everything the tenants list, the passkey and templates included.
  const alex = await vaultOf(state, "alex");
  const own = OWN.alex.items;
  const live = alex.sync.ciphers.filter((c: { deletedDate: string | null }) => !c.deletedDate);
  expect(live.map(alex.name).sort()).toEqual(own.filter((i) => !i.trash).map((i) => i.name).sort());
  const trashed = alex.sync.ciphers.filter((c: { deletedDate: string | null }) => c.deletedDate);
  expect(trashed.map(alex.name)).toEqual(["Old Yahoo account"]);
  expect(alex.sync.folders.map((f: { name: string }) => openText(alex.userKey, f.name)).sort()).toEqual(
    [...OWN.alex.folders!].sort(),
  );
  const byName = (name: string) => alex.sync.ciphers.find((c: any) => alex.name(c) === name);
  const field = (c: any, n: string) =>
    (c.fields ?? []).map((f: any) => ({ name: openText(alex.userKey, f.name), value: openText(alex.userKey, f.value) })).find((f: any) => f.name === n)?.value;
  const passkey = byName("webauthn.io").login.fido2Credentials[0];
  expect(openText(alex.userKey, passkey.rpId)).toBe("webauthn.io");
  const { createPrivateKey } = await import("node:crypto");
  const passkeyKey = createPrivateKey({ key: Buffer.from(openText(alex.userKey, passkey.keyValue)!, "base64url"), format: "der", type: "pkcs8" });
  expect(passkeyKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  const gym = JSON.parse(field(byName("Gym membership"), "keykeeper.template-definition"));
  expect(gym).toMatchObject({ base: "note", v: 1 });
  expect(JSON.parse(field(byName("Riverside Fitness"), "keykeeper.template"))).toEqual({ id: gym.id, name: "Gym membership", v: 1 });
  expect(JSON.parse(field(byName("Home Wi-Fi"), "keykeeper.template"))).toEqual({ id: "wifi", name: "Wi-Fi network", v: 1 });
  expect(field(byName("Passport"), "keykeeper.expires")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(openText(alex.userKey, byName("Visa debit").card.number)).toBe("4242424242424242");
  expect(openText(alex.userKey, byName("Home lab").sshKey.privateKey)).toContain("BEGIN OPENSSH PRIVATE KEY");
  const chase = byName("Chase");
  expect(chase.reprompt).toBe(1);
  expect(chase.passwordHistory).toHaveLength(2);
  const chaseHistory = await api.call(alex.session, "GET", `/api/keykeeper/ciphers/${chase.id}/history`);
  expect(chaseHistory.data).toHaveLength(2);

  // Maya Chen runs Harbor IT: its staff, clients, the invitation nobody
  // accepted, and vault lock required for every client.
  const maya = await vaultOf(state, "maya");
  const msp = await api.call(maya.session, "GET", `/api/keykeeper/msp/${state.mspId}`);
  expect(msp.name).toBe(MSP_NAME);
  expect(msp.clients.map((c: { name: string }) => c.name).sort()).toEqual(
    ORGS.filter((o) => o.kind === "client").map((o) => o.name).sort(),
  );
  const staff = Object.fromEntries(msp.staff.map((s: { email: string; role: string }) => [s.email, s.role]));
  expect(staff).toEqual({
    "maya.chen@harborit.test": "admin",
    "owen.brooks@harborit.test": "admin",
    "theo.ramirez@harborit.test": "technician",
    "priya.shah@harborit.test": "technician",
    "sam.whitfield@harborit.test": "technician",
  });
  expect(msp.invites.map((i: { email: string }) => i.email)).toEqual(["jordan.blake@harborit.test"]);
  const policies = await api.call(maya.session, "GET", `/api/keykeeper/msp/${state.mspId}/policies`);
  expect(policies.defaults.find((d: { type: number }) => d.type === 9)).toMatchObject({ enabled: true, required: true });

  // Every organization Maya is in opens with its key, its folders' names and
  // icons and its items' names as the tenants list them.
  for (const spec of ORGS.filter((o) => o.creator === "maya")) {
    const id = orgId(state, spec.key);
    const key = maya.orgKeys.get(id)!;
    expect(key, spec.name).toBeTruthy();
    const folders = maya.sync.collections.filter((c: { organizationId: string }) => c.organizationId === id);
    const expected = new Set([spec.firstFolder, ...spec.folders.map((f) => f.name)]);
    if (spec.preset === "business") {
      expected.add("Admins");
    }
    expect(folders.map((c: { name: string }) => openText(key, c.name)).sort(), spec.name).toEqual([...expected].sort());
    for (const f of spec.folders.filter((f) => f.icon)) {
      const folder = folders.find((c: { name: string }) => openText(key, c.name) === f.name);
      expect(JSON.parse(openText(key, folder.keykeeperLook)!), f.name).toEqual({ icon: f.icon, tone: f.tone });
    }
    const items = maya.sync.ciphers.filter((c: { organizationId: string; deletedDate: string | null }) => c.organizationId === id && !c.deletedDate);
    expect(items.map(maya.name).sort(), spec.name).toEqual(spec.items.filter((i) => !i.trash).map((i) => i.name).sort());
  }

  // The people in each client, as its members page shows them.
  const membersOf = async (key: string) => {
    const listed = await api.call(maya.session, "GET", `/api/organizations/${orgId(state, key)}/users`);
    return Object.fromEntries(listed.data.map((m: { email: string; status: number; type: number }) => [m.email, { status: m.status, type: m.type }]));
  };
  const northwind = await membersOf("northwind");
  expect(northwind["grace.liu@northwind-dental.test"]).toEqual({ status: 2, type: 0 });
  expect(northwind["marcus.reed@northwind-dental.test"]).toEqual({ status: 2, type: 1 });
  expect(northwind["lena.fischer@northwind-dental.test"]).toEqual({ status: 2, type: 4 });
  expect(northwind["tom.alvarez@northwind-dental.test"]).toEqual({ status: 2, type: 2 });
  expect(northwind["ben.carter@northwind-dental.test"]).toEqual({ status: -1, type: 2 });
  expect(northwind["casey.nguyen@northwind-dental.test"]).toEqual({ status: 0, type: 2 });
  expect(northwind["priya.shah@harborit.test"]).toEqual({ status: 2, type: 4 });
  expect((await membersOf("cedar"))["priya.shah@harborit.test"]).toEqual({ status: 2, type: 1 });
  expect((await membersOf("bluebird"))["liam.walsh@bluebird-law.test"]).toEqual({ status: 1, type: 2 });
  expect((await membersOf("pinecrest"))["greg.hollis@pinecrest-build.test"]).toEqual({ status: -1, type: 2 });
  expect((await membersOf("summit"))["diego.rivera@rivera-family.test"]).toEqual({ status: 2, type: 2 });

  // Each client's own settings.
  const setting = (key: string, what: string) => api.call(maya.session, "GET", `/api/keykeeper/organizations/${orgId(state, key)}/${what}`);
  expect(await setting("bluebird", "admin-two-step")).toMatchObject({ required: true, everyone: true });
  expect(await setting("northwind", "admin-two-step")).toMatchObject({ required: true, everyone: false });
  expect(await setting("cedar", "password-change")).toMatchObject({ allowed: false });
  expect(await setting("pinecrest", "browser-autofill")).toMatchObject({ mode: "offAndImport" });
  expect(await setting("northwind", "member-health-setting")).toMatchObject({ enabled: true });
  expect(await setting("summit", "member-health-setting")).toMatchObject({ enabled: false });
  const lawPolicy = await api.call(maya.session, "GET", `/api/organizations/${orgId(state, "bluebird")}/policies/1`);
  expect(lawPolicy).toMatchObject({ enabled: true, data: { minLength: 16 } });

  // Tom Alvarez, a member: his folders' permissions, passwords hidden where
  // the Front desk group can only view them, and items he can open.
  const tom = await vaultOf(state, "tom");
  const northwindKey = tom.orgKeys.get(orgId(state, "northwind"))!;
  const tomFolder = (n: string) => tom.sync.collections.find((c: { name: string }) => openText(northwindKey, c.name) === n);
  expect(tomFolder("Practice software").keykeeper).toMatchObject({ seePasswords: false, edit: false });
  expect(tomFolder("Vendors").keykeeper).toMatchObject({ seePasswords: true, create: true, edit: true, delete: false });
  expect(tomFolder("Banking and payroll")).toBeUndefined();
  const tomItems = tom.sync.ciphers.map(tom.name);
  expect(tomItems).toContain("Imaging workstation");
  expect(tomItems).toContain("Personal email");
  expect(tomItems).not.toContain("Payroll");

  // Item history across people: Dentrix Ascend was made by Grace, then
  // changed by Marcus, then by Maya.
  const dentrix = maya.sync.ciphers.find((c: any) => maya.name(c) === "Dentrix Ascend");
  const versions = await api.call(maya.session, "GET", `/api/keykeeper/ciphers/${dentrix.id}/history`);
  expect(versions.data).toHaveLength(2);

  // Carmen's legacy contact.
  const carmen = await vaultOf(state, "carmen");
  const trusted = await api.call(carmen.session, "GET", "/api/emergency-access/trusted");
  expect(trusted.data).toEqual([expect.objectContaining({ email: "diego.rivera@rivera-family.test", type: 1, status: 2, waitTimeDays: 7 })]);

  writeState(server, state);
});

test("seeding again changes nothing, and code prints the code the server will take", async () => {
  test.setTimeout(120_000);
  const before = readState(server);
  const run = await runTool(server, "seed");
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toContain("Already seeded");
  const after = readState(server);
  expect(Object.keys(after.people).sort()).toEqual(Object.keys(before.people).sort());
  expect(after.orgs).toEqual(before.orgs);
  expect(after.people.maya.password).toBe(before.people.maya.password);

  const status = await runTool(server, "status");
  expect(status.stdout).toContain("Seeded: Harbor IT: 5 staff, 5 clients");

  const grace = after.people.grace;
  const code = await runTool(server, "code", "grace");
  expect(code.code, code.stderr).toBe(0);
  // This step's, or the next one's if the tool used this one (a step may
  // have ended since it printed).
  const step = stepOf(Date.now());
  expect([step - 1, step, step + 1].map((n) => totp(grace.totpKey!, n * 30_000))).toContain(code.stdout.slice(0, 6));
});

test("refuses servers other than this computer's and the test server, and a folder in a git checkout", async () => {
  const elsewhere = await runTool(server, "seed", "--server", "https://vault.example.com");
  expect(elsewhere.code).toBe(2);
  expect(elsewhere.stderr).toContain("seeds only this computer's servers");
  const testServer = await runTool(server, "status", "--server", "https://test.passbundle.com");
  expect(testServer.code).toBe(2);
  expect(testServer.stderr).toContain("needs --test-server");
  const plain = await runTool(server, "status", "--server", "http://127.0.0.1:1");
  expect(plain.code).toBe(2);
  const inRepo = await runTool(server, "status", "--out", path.resolve("tests"));
  expect(inRepo.code).toBe(2);
  expect(inRepo.stderr).toContain("inside the git checkout");
});

test("reset makes it all again, and teardown leaves only the invitations nobody accepted", async () => {
  test.setTimeout(15 * 60_000);
  const before = readState(server);
  const reset = await runTool(server, "reset");
  expect(reset.code, reset.stderr).toBe(0);
  const after = readState(server);
  expect(after.complete).toBe(true);
  expect(after.people.maya.userId).not.toBe(before.people.maya.userId);
  expect(after.orgs.northwind.id).not.toBe(before.orgs.northwind.id);
  for (const key of Object.keys(before.people)) {
    expect(after.people[key].password).not.toBe(before.people[key].password);
  }
  // The old accounts are gone: their passwords no longer sign in.
  const old = await api.http.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: before.people.alex.email,
      password: before.people.alex.passwordHash,
      scope: "api offline_access",
      client_id: "cli",
      deviceType: "25",
      deviceIdentifier: before.people.alex.device,
      deviceName: "test-tenants",
    },
  });
  expect(old.status()).toBe(400);

  const teardown = await runTool(server, "teardown");
  expect(teardown.code, teardown.stderr).toBe(0);
  expect(fs.existsSync(statePath(server))).toBe(false);
  expect(fs.existsSync(credentialsPath(server))).toBe(false);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(server.dataDir, "db.sqlite3"), { readOnly: true });
  try {
    const count = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? {})[0]);
    expect(count("SELECT count(*) FROM users WHERE akey != ''")).toBe(0);
    expect(count("SELECT count(*) FROM organizations")).toBe(0);
    expect(count("SELECT count(*) FROM ciphers")).toBe(0);
    expect(count("SELECT count(*) FROM msp_staff")).toBe(0);
    const invited = db.prepare("SELECT email FROM users ORDER BY email").all().map((r) => r.email);
    expect(invited).toEqual(["casey.nguyen@northwind-dental.test", "marisol.rivera@rivera-family.test"]);
  } finally {
    db.close();
  }
});

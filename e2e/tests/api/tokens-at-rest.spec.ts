// Tokens that let someone in, at rest (DESIGN.md, "Onboarding through the
// RMM" and "Adding MSP staff"): the database keeps an MSP staff invitation's
// token and an install command's token only as their SHA-256, as it keeps
// SCIM and script tokens, so a copy of the database can't use them. The
// install command's token is also kept sealed with a key the database doesn't
// have, so admins can see the command again. Checked in the SQLite database;
// on PostgreSQL (KK_DATABASE_URL) only the API's side is.
import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";

import { Api, serverDatabase } from "./support";

const sha256 = (token: string) => createHash("sha256").update(token).digest("base64");

test("an MSP staff invitation's token is kept only as its hash, and its link still works", async ({ request }) => {
  const api = new Api(request);
  const admin = await api.account("rest-admin");
  const mspId = await api.msp(admin, "Rest IT");
  const tech = await api.account("rest-tech");
  const invited = await api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/staff`, {
    email: tech.email,
    role: "technician",
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const token = new URL(invited.body.inviteUrl).hash.split("invite=")[1];
  const db = await serverDatabase();
  if (db) {
    expect(db("SELECT COUNT(*) FROM msp_invites WHERE token = ?", token)).toBe(0);
    expect(db("SELECT COUNT(*) FROM msp_invites WHERE token = ?", sha256(token))).toBe(1);
  }
  // A wrong token, or the hash itself, gets nowhere.
  for (const wrong of [sha256(token), `${token}x`]) {
    expect((await api.call(tech, "POST", "/api/keykeeper/msp/invites/info", { token: wrong })).status).toBe(404);
  }
  const accepted = await api.call(tech, "POST", "/api/keykeeper/msp/invites/accept", { token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
});

test("an install command's token is kept hashed and sealed, shown again to admins, and still joins", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("rest-cmd-admin");
  const mspId = await api.msp(admin, "Rest Command IT");
  const orgId = await api.client(admin, mspId, "Rest Dental");
  const path = `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`;
  const first = (await api.call(admin, "GET", path)).body.token as string;
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // The same command each time an admin opens it.
  expect((await api.call(admin, "GET", path)).body.token).toBe(first);
  const replaced = await api.call(admin, "POST", path, {});
  expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
  const token = replaced.body.token as string;
  expect(token).not.toBe(first);
  const db = await serverDatabase();
  if (db) {
    for (const t of [first, token]) {
      expect(db("SELECT COUNT(*) FROM msp_clients WHERE enrollment_token = ? OR instr(enrollment_token, ?) > 0", t, t)).toBe(0);
    }
    expect(db("SELECT COUNT(*) FROM msp_clients WHERE enrollment_token_hash = ? AND enrollment_token LIKE 'v1.%'", sha256(token))).toBe(1);
  }
  // The old one stops working; the new one finds the client.
  const joiner = await api.account("rest-joiner");
  expect((await api.call(joiner, "POST", "/api/keykeeper/enrollment/info", { token: first })).status).not.toBe(200);
  const info = await api.call(joiner, "POST", "/api/keykeeper/enrollment/info", { token });
  expect(info.status, JSON.stringify(info.body)).toBe(200);
});

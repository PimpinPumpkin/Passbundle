// An organization that already uses PassBundle joins an MSP, or moves from
// one MSP to another, with a one-time code the MSP gives its owner (DESIGN.md,
// "An organization that already uses PassBundle"). The organization's own
// owner says yes, never the MSP alone; its MSP's people join waiting for its
// key, which nothing on its side gives them on its own; and every refusal is
// "not found" or a plain 400 that says nothing about anyone else.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { port } from "../../paths.mjs";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { httpsReceiver, throwawayCert, verifyWebhook, waitFor } from "./siem";
import { type Account, Api, encString, withMasterPassword } from "./support";

const INVALID = "That code isn't valid. A code works once, for 7 days: ask your MSP for a new one.";
const OWNERS_ONLY = "Only this organization's own owners can join it to an MSP.";

const codesPath = (mspId: string) => `/api/keykeeper/msp/${mspId}/link-codes`;
const previewPath = (orgId: string) => `/api/keykeeper/organizations/${orgId}/msp/link/preview`;
const linkPath = (orgId: string) => `/api/keykeeper/organizations/${orgId}/msp/link`;

/** A new code from one of the MSP's admins, as it's shown: groups of four. */
async function newCode(api: Api, admin: Account, mspId: string, label?: string): Promise<{ id: string; code: string }> {
  const made = await api.call(admin, "POST", codesPath(mspId), label == null ? {} : { label });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
  return { id: made.body.id, code: made.body.code };
}

/** What the MSP's console lists of its clients. */
async function clientsOf(api: Api, admin: Account, mspId: string) {
  const msp = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(msp.status, JSON.stringify(msp.body)).toBe(200);
  return msp.body.clients as { id: string; name: string; joinedWithCode?: boolean; you: { status: number } | null }[];
}

/** The MSP's Activity, as its admin reads it. */
async function activity(api: Api, admin: Account, mspId: string) {
  const events = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  expect(events.status, JSON.stringify(events.body)).toBe(200);
  return events.body.data as { event: string; organizationId: string | null; actorEmail: string; targetEmail: string | null; detail: string | null }[];
}

/** Ends a code now, in the test server's SQLite database: its clock can't be moved. Null on PostgreSQL. */
async function endCode(code: string): Promise<number | null> {
  if (process.env.KK_DATABASE_URL) {
    return null;
  }
  const data = fs.readFileSync(path.join(os.tmpdir(), `keykeeper-e2e-data-${port}`), "utf8");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(data, "db.sqlite3"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const changed = db
      .prepare("UPDATE msp_link_codes SET expires_at = '2026-01-01 00:00:00' WHERE selector = ?")
      .run(code.replace(/-/g, "").slice(0, 8));
    return Number(changed.changes);
  } finally {
    db.close();
  }
}

const ACTORS = [
  "mspAdmin",
  "technician",
  "otherMspAdmin",
  "ownOwner",
  "ownAdmin",
  "ownUser",
  "clientOwner",
  "stranger",
  "anonymous",
] as const;
type Actor = (typeof ACTORS)[number];
type Context = {
  api: Api;
  mspId: string;
  otherMspId: string;
  admin: Account;
  otherAdmin: Account;
  owner: Account;
  ownAdmin: Account;
  ownUser: Account;
  clientOwner: Account;
  ownOrgId: string;
};
type Row = MatrixRow<Actor, Context>;

/** An organization of the owner's own, with its admin and member: a fresh one, for a change. */
async function freshOwnOrg(ctx: Context): Promise<string> {
  const orgId = await ctx.api.organization(ctx.owner, `Own Company ${Date.now()}`);
  await ctx.api.addMember(ctx.owner, orgId, ctx.ownAdmin, "admin");
  await ctx.api.addMember(ctx.owner, orgId, ctx.ownUser, "user");
  return orgId;
}

/** The MSP the organization has now, as its owner sees it. */
async function mspOf(ctx: Context, orgId: string, owner = ctx.owner): Promise<string | null> {
  const seen = await ctx.api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/msp`);
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  return seen.body.msp?.name ?? null;
}

const rows: Row[] = [
  {
    name: "look up what a code would do for an organization",
    allowed: ["ownOwner"],
    request: async (ctx) => ({
      method: "POST",
      path: previewPath(ctx.ownOrgId),
      data: { code: (await newCode(ctx.api, ctx.admin, ctx.mspId)).code },
    }),
  },
  {
    name: "join an organization to an MSP with a code",
    allowed: ["ownOwner"],
    request: async (ctx) => {
      const orgId = await freshOwnOrg(ctx);
      return {
        method: "POST",
        path: linkPath(orgId),
        data: { code: (await newCode(ctx.api, ctx.admin, ctx.mspId)).code },
        check: async (allowed) => {
          expect(await mspOf(ctx, orgId)).toBe(allowed ? "Link Matrix IT" : null);
        },
      };
    },
  },
  {
    // Another MSP's client: its admin is an owner there through that MSP,
    // and may not move it; only its own owner may.
    name: "move an MSP's client to another MSP with a code",
    allowed: ["clientOwner"],
    request: async (ctx) => {
      const orgId = await ctx.api.client(ctx.otherAdmin, ctx.otherMspId, `Moving Client ${Date.now()}`);
      await ctx.api.addMember(ctx.otherAdmin, orgId, ctx.clientOwner, "owner");
      return {
        method: "POST",
        path: linkPath(orgId),
        data: { code: (await newCode(ctx.api, ctx.admin, ctx.mspId)).code, move: true },
        check: async (allowed) => {
          expect(await mspOf(ctx, orgId, ctx.clientOwner)).toBe(allowed ? "Link Matrix IT" : "Other Link IT");
        },
      };
    },
  },
];

test.describe("Who may use a code to join an organization to an MSP", () => {
  permissionMatrix(
    ACTORS,
    async (api) => {
      const admin = await api.account("link-msp-admin");
      const tech = await api.account("link-tech");
      const otherAdmin = await api.account("link-other-admin");
      const owner = await api.account("link-own-owner");
      const ownAdmin = await api.account("link-own-admin");
      const ownUser = await api.account("link-own-user");
      const clientOwner = await api.account("link-client-owner");
      const mspId = await api.msp(admin, "Link Matrix IT");
      const otherMspId = await api.msp(otherAdmin, "Other Link IT");
      await api.addStaff(admin, mspId, tech, "technician");
      const ctx: Context = {
        api,
        mspId,
        otherMspId,
        admin,
        otherAdmin,
        owner,
        ownAdmin,
        ownUser,
        clientOwner,
        ownOrgId: "",
      };
      ctx.ownOrgId = await freshOwnOrg(ctx);
      const callers: Record<Actor, Account | null> = {
        mspAdmin: admin,
        technician: tech,
        otherMspAdmin: otherAdmin,
        ownOwner: owner,
        ownAdmin,
        ownUser,
        clientOwner,
        stranger: await api.account("link-stranger"),
        anonymous: null,
      };
      return { ctx, callers };
    },
    rows,
  );
});

test("a refused member learns nothing about the code, and a code that doesn't work is not found, however it doesn't", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("codes-admin");
  const mspId = await api.msp(admin, "Codes IT");
  const owner = await api.account("codes-owner");
  const member = await api.account("codes-member");
  const orgId = await api.organization(owner, "Codes Dental");
  await api.addMember(owner, orgId, member, "admin");
  const good = await newCode(api, admin, mspId);

  // A member who isn't an owner gets the same plain answer for a good code
  // and a made-up one.
  for (const code of [good.code, "7KQ2-MXP4-ZT9W-HN3R-VB8C-J5DF", "nonsense"]) {
    const refused = await api.call(member, "POST", previewPath(orgId), { code });
    expect([refused.status, refused.body.message]).toEqual([400, OWNERS_ONLY]);
  }
  // A stranger, not found.
  const stranger = await api.account("codes-stranger");
  expect((await api.call(stranger, "POST", previewPath(orgId), { code: good.code })).status).toBe(404);

  const notValid = async (code: string) => {
    for (const p of [previewPath(orgId), linkPath(orgId)]) {
      const answer = await api.call(owner, "POST", p, { code });
      expect([answer.status, answer.body.message], `${p} ${code}`).toEqual([404, INVALID]);
    }
  };
  // Malformed, and made up.
  await notValid("nonsense");
  await notValid("7KQ2-MXP4-ZT9W-HN3R-VB8C-J5DF");
  // Guessed: a real code's first 8 characters, the rest wrong.
  const last = good.code.at(-1) === "0" ? "1" : "0";
  await notValid(good.code.slice(0, -1) + last);
  // Revoked.
  const revoked = await newCode(api, admin, mspId);
  expect((await api.call(admin, "DELETE", `${codesPath(mspId)}/${revoked.id}`)).status).toBe(200);
  await notValid(revoked.code);
  // Ended.
  const ended = await newCode(api, admin, mspId);
  if ((await endCode(ended.code)) != null) {
    await notValid(ended.code);
  }
  // Another MSP's admin can neither see nor revoke this MSP's codes.
  const otherAdmin = await api.account("codes-other-admin");
  const otherMspId = await api.msp(otherAdmin, "Other Codes IT");
  const theirs = await newCode(api, admin, mspId);
  expect((await api.call(otherAdmin, "DELETE", `${codesPath(otherMspId)}/${theirs.id}`)).status).toBe(404);
  expect((await api.call(otherAdmin, "GET", codesPath(mspId))).status).toBe(404);

  // The good one works, typed in lower case without dashes, once.
  const typed = good.code.replace(/-/g, "").toLowerCase();
  const seen = await api.call(owner, "POST", previewPath(orgId), { code: typed });
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  expect(seen.body.msp.name).toBe("Codes IT");
  const joined = await api.call(owner, "POST", linkPath(orgId), { code: typed });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  const second = await api.organization(owner, "Codes Law");
  for (const p of [previewPath(second), linkPath(second)]) {
    const used = await api.call(owner, "POST", p, { code: good.code });
    expect([used.status, used.body.message]).toEqual([404, INVALID]);
  }
  // The MSP it has already.
  const again = await api.call(owner, "POST", previewPath(orgId), { code: (await newCode(api, admin, mspId)).code });
  expect([again.status, again.body.message]).toEqual([400, "Codes Dental is already Codes IT's client."]);
  // The codes listed never carry the code itself.
  const open = await api.call(admin, "GET", codesPath(mspId));
  expect(JSON.stringify(open.body)).not.toContain(theirs.code);
});

test("an owner joins their organization to an MSP: its staff wait for the owner, and the console lists the client", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const admin = await api.account("join-admin");
  const tech = await api.account("join-tech");
  const limited = await api.account("join-limited");
  const mspId = await api.msp(admin, "Northwind IT");
  const other = await api.client(admin, mspId, "Baker Law");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.addStaff(admin, mspId, limited, "technician", {
    allClients: false,
    clients: [other],
    custom: null,
    installCommands: true,
  });
  const owner = await api.account("join-owner");
  const member = await api.account("join-member");
  const orgId = await api.organization(owner, "Acme Dental");
  await api.addMember(owner, orgId, member, "user");
  // A shared item, to see it stays the organization's.
  const item = await api.orgItem(owner, orgId, await api.collection(owner, orgId));
  const { code } = await newCode(api, admin, mspId, "Acme Dental");

  // Before anything changes: who would be added, as what.
  const preview = await api.call(owner, "POST", previewPath(orgId), { code });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  expect(preview.body).toMatchObject({ msp: { id: mspId, name: "Northwind IT" }, current: null, stayingOut: [] });
  expect(preview.body.adding.map((p: { email: string; role: string }) => [p.email, p.role])).toEqual([
    [admin.email, "owner"],
    [tech.email, "admin"],
  ]);
  expect(await clientsOf(api, admin, mspId)).toHaveLength(1);

  const joined = await api.call(owner, "POST", linkPath(orgId), { code });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  expect(joined.body).toMatchObject({ msp: { id: mspId, name: "Northwind IT" }, added: 2, moved: null });

  // The console lists it, joined with a code, with its admin waiting there.
  const listed = (await clientsOf(api, admin, mspId)).find((c) => c.id === orgId);
  expect(listed).toMatchObject({ name: "Acme Dental", joinedWithCode: true, you: { status: 1 } });
  // The technician limited to chosen clients sees none of it.
  expect((await clientsOf(api, limited, mspId)).map((c) => c.id)).toEqual([other]);

  // Its staff wait for the organization's key; its own people and items stay.
  const members = await api.members(owner, orgId);
  const status = (email: string) => members.find((m) => m.email === email)?.status;
  expect(status(admin.email)).toBe(1);
  expect(status(tech.email)).toBe(1);
  expect(status(limited.email)).toBeUndefined();
  expect(status(member.email)).toBe(2);
  expect(status(owner.email)).toBe(2);
  expect((await api.call(owner, "GET", `/api/ciphers/${item}`)).status).toBe(200);
  // The banner's list has each of them with the key the server holds for
  // their account, for the phrase.
  const banner = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/msp`);
  const adminRow = banner.body.staff.find((s: { email: string }) => s.email === admin.email);
  expect(adminRow).toMatchObject({ userId: admin.userId, status: 1, type: 0 });
  expect(adminRow.publicKey).toBe((await api.call(owner, "GET", `/api/users/${admin.userId}/public-key`)).body.publicKey);

  // Nothing confirms them on its own: the owner's list of who's waiting has
  // no staff seal for them, and the MSP's admin can give nobody a key there.
  const waiting = await api.call(owner, "GET", "/api/keykeeper/organizations/pending");
  const staffWaiting = waiting.body.data.filter((p: { organizationId: string; fromMsp: boolean }) => p.organizationId === orgId && p.fromMsp);
  expect(staffWaiting.map((p: { email: string }) => p.email).sort()).toEqual([admin.email, tech.email].sort());
  for (const p of staffWaiting) {
    expect(p.staffSeal ?? null).toBeNull();
  }
  const adminsList = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  expect(adminsList.body.data.filter((p: { organizationId: string }) => p.organizationId === orgId)).toEqual([]);

  // The owner confirms the MSP's admin by hand; then the admin's console
  // lists the technician to confirm there, as in any client.
  const adminMember = members.find((m) => m.email === admin.email)!;
  const confirmed = await api.call(owner, "POST", `/api/organizations/${orgId}/users/${adminMember.id}/confirm`, {
    key: encString(`org-key-for-${admin.email}`),
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const afterwards = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/pending`);
  expect(afterwards.body.data.filter((p: { organizationId: string }) => p.organizationId === orgId).map((p: { email: string }) => p.email)).toEqual([
    tech.email,
  ]);

  // The records: the MSP's Activity, without each person added, and the
  // organization's own view of its MSP's actions, with them.
  const events = await activity(api, admin, mspId);
  const used = events.find((e) => e.event === "link_code_used");
  expect(used).toMatchObject({ organizationId: orgId, actorEmail: owner.email, targetEmail: admin.email, detail: "Acme Dental" });
  expect(events.find((e) => e.event === "client_joined")).toMatchObject({ organizationId: orgId, actorEmail: owner.email, detail: null });
  expect(events.find((e) => e.event === "link_code_created")).toMatchObject({ actorEmail: admin.email, detail: "Acme Dental" });
  expect(events.filter((e) => e.event === "client_staff_added")).toEqual([]);
  const own = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/msp/activity`);
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  const kinds = own.body.data.map((e: { event: string }) => e.event);
  expect(kinds).toContain("client_joined");
  expect(kinds.filter((k: string) => k === "client_staff_added")).toHaveLength(2);
  expect(kinds).not.toContain("link_code_used");
});

test("moving to another MSP takes the old one out and brings the new one in, in one step", async ({ request }) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const oldAdmin = await api.account("move-old-admin");
  const oldTech = await api.account("move-old-tech");
  const oldMsp = await api.msp(oldAdmin, "Contoso IT");
  const orgId = await api.client(oldAdmin, oldMsp, "Fabrikam");
  await api.addStaff(oldAdmin, oldMsp, oldTech, "technician");
  await api.confirmPending(oldAdmin, oldMsp);
  const owner = await api.account("move-owner");
  await api.addMember(oldAdmin, orgId, owner, "owner");
  const newAdmin = await api.account("move-new-admin");
  const newMsp = await api.msp(newAdmin, "Northwind IT");
  const { code } = await newCode(api, newAdmin, newMsp);

  // The page names the MSP it has now; without the move said, nothing changes.
  const preview = await api.call(owner, "POST", previewPath(orgId), { code });
  expect(preview.body.current).toEqual({ id: oldMsp, name: "Contoso IT" });
  const unsaid = await api.call(owner, "POST", linkPath(orgId), { code });
  expect(unsaid.status).toBe(400);
  expect(unsaid.body.message).toContain("confirm the move");
  expect((await clientsOf(api, oldAdmin, oldMsp)).map((c) => c.id)).toContain(orgId);
  // The old MSP's own admin, an owner there through it, can't move it.
  const theirs = await api.call(oldAdmin, "POST", linkPath(orgId), { code, move: true });
  expect([theirs.status, theirs.body.message]).toEqual([400, OWNERS_ONLY]);

  const moved = await api.call(owner, "POST", linkPath(orgId), { code, move: true });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(moved.body.msp).toEqual({ id: newMsp, name: "Northwind IT" });
  expect(moved.body.added).toBe(1);
  expect(moved.body.moved).toMatchObject({ msp: { id: oldMsp, name: "Contoso IT" }, peopleRemoved: 2, installCommandRemoved: true });

  // The old MSP and its staff are out; the new one's admin waits for the owner.
  expect((await clientsOf(api, oldAdmin, oldMsp)).map((c) => c.id)).not.toContain(orgId);
  expect((await clientsOf(api, newAdmin, newMsp)).map((c) => c.id)).toContain(orgId);
  const members = await api.members(owner, orgId);
  expect(members.map((m) => m.email)).not.toContain(oldAdmin.email);
  expect(members.map((m) => m.email)).not.toContain(oldTech.email);
  expect(members.find((m) => m.email === newAdmin.email)?.status).toBe(1);
  expect(members.find((m) => m.email === owner.email)?.status).toBe(2);

  // Each MSP's Activity says so; the old one doesn't learn where it went.
  const old = await activity(api, oldAdmin, oldMsp);
  const away = old.find((e) => e.event === "client_moved_away");
  expect(away).toMatchObject({ organizationId: orgId, actorEmail: owner.email });
  expect(JSON.stringify(old)).not.toContain("Northwind");
  expect(old.map((e) => e.event)).not.toContain("client_removed_msp");
  expect((await activity(api, newAdmin, newMsp)).find((e) => e.event === "client_joined")).toMatchObject({
    organizationId: orgId,
    detail: "move",
  });
  // The organization's own view is now the new MSP's.
  const own = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/msp/activity`);
  expect(own.body.msp.name).toBe("Northwind IT");
  expect(own.body.data.map((e: { event: string }) => e.event)).toContain("client_joined");
  // The old MSP's staff changes never bring its people back.
  const later = await api.account("move-old-later");
  await api.addStaff(oldAdmin, oldMsp, later, "technician");
  expect((await api.members(owner, orgId)).map((m) => m.email)).not.toContain(later.email);
});

test("the MSP's security tools get its codes and joins, as its other activity", async ({ request }) => {
  test.setTimeout(150_000);
  const api = new Api(request);
  const cert = throwawayCert();
  const receiver = await httpsReceiver(cert);
  try {
    const admin = await api.account("stream-link-admin");
    const mspId = await api.msp(admin, "Streamed IT");
    const made = await api.call(
      admin,
      "POST",
      `/api/keykeeper/msp/${mspId}/event-streaming`,
      withMasterPassword(admin, {
        name: "SOC",
        kind: "webhook",
        webhook: { url: receiver.url("/soc"), caCertificate: cert.cert },
      }),
    );
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const events = () => receiver.received.map((r) => verifyWebhook(r, made.body.signingSecret));
    const owner = await api.account("stream-link-owner");
    const orgId = await api.organization(owner, "Streamed Dental");
    const { code } = await newCode(api, admin, mspId, "Streamed Dental");
    const joined = await api.call(owner, "POST", linkPath(orgId), { code });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    const seen = await waitFor(
      receiver.received,
      () => {
        const types = events().map((e: { type: number }) => e.type);
        return [9103, 9105, 9106].every((t) => types.includes(t)) ? events() : undefined;
      },
      "the code made, used, and the organization joining",
    );
    expect(seen.find((e: { type: number }) => e.type === 9106)).toMatchObject({
      category: "msp",
      action: "client_joined",
      organization: { id: orgId },
      actor: { email: owner.email },
    });
    // Each person added is the organization's own view's, not the feed's.
    expect(seen.map((e: { action: string }) => e.action)).not.toContain("client_staff_added");
  } finally {
    await receiver.close();
  }
});

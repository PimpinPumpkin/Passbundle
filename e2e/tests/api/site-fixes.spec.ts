// Site fixes and problem reports (DESIGN.md, "Site fixes (opt-in)"): a fix
// applies to everyone on the server once three different people with
// verified email addresses shared it, each counted once (the mail tests,
// tests/mail/site-fixes.spec.ts, where email can be verified); this server
// sends no email, so nobody here counts. What's stored has no account;
// problem reports are capped per site and per person; and an MSP's admins
// apply fixes to every client at once.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api } from "./support";

const fixFor = (host: string) => ({
  host,
  field: { id: "username", name: "username", label: "username" },
  fill: "never",
});
const newHost = () => `fix-${randomUUID().slice(0, 8)}.example.test`;

const list = async (api: Api, who: Account) => {
  const listed = await api.call(who, "GET", "/api/keykeeper/site-fixes");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body as { fixes: { host: string }[]; rules: { host: string }[] };
};

test("accounts that haven't verified their email address don't count toward a fix, however many", async ({
  request,
}) => {
  // Making accounts is enough to be "different people" otherwise, so a few
  // made for it could make a fix fill for everyone on the server.
  const api = new Api(request);
  const host = newHost();
  const fix = fixFor(host);
  const people = await Promise.all(["ana", "ben", "cy", "dee", "eve"].map((n) => api.account(n)));
  for (const who of people) {
    const shared = await api.call(who, "POST", "/api/keykeeper/site-fixes", fix);
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body).toEqual({ applies: false, counted: false });
  }
  expect((await list(api, people[0])).fixes.some((f) => f.host === host)).toBe(false);
  // Nobody shares without signing in.
  expect((await api.call(null, "POST", "/api/keykeeper/site-fixes", fix)).status).toBe(401);
});

test("a fix carries a site, a field, and a kind of value, and nothing else gets in", async ({
  request,
}) => {
  const api = new Api(request);
  const ana = await api.account("ana");
  const host = newHost();
  for (const bad of [
    // A custom field: its name can say something about the person.
    { ...fixFor(host), fill: "field" },
    // A page address, not a host.
    { ...fixFor(host), host: `https://${host}/login?user=ana` },
    // No way to find the field.
    { ...fixFor(host), field: {} },
    // A field described at length.
    { ...fixFor(host), field: { id: "x".repeat(201) } },
  ]) {
    const refused = await api.call(ana, "POST", "/api/keykeeper/site-fixes", bad);
    expect(refused.status, JSON.stringify(bad)).toBe(400);
  }
});

test("a problem report keeps the shape of the fields and a note, at most 20 a site a day", async ({
  request,
}) => {
  const api = new Api(request);
  // Each person sends at most 10 at once (the next test), so three people send them.
  const reporters = await Promise.all(["ana", "ben", "cy"].map((n) => api.account(n)));
  const ana = reporters[2];
  const host = newHost();
  const report = {
    host,
    fields: [
      { id: "pw", name: "password", label: "Password", type: "password", autocomplete: "current-password" },
    ],
    note: "The PIN box gets my password",
  };
  for (let i = 0; i < 20; i++) {
    const kept = await api.call(reporters[Math.floor(i / 10)], "POST", "/api/keykeeper/site-problems", report);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.kept).toBe(true);
  }
  const extra = await api.call(ana, "POST", "/api/keykeeper/site-problems", report);
  expect(extra.body.kept).toBe(false);
  // Too many fields, or a long note, are refused.
  const many = { ...report, host: newHost(), fields: Array(51).fill(report.fields[0]) };
  expect((await api.call(ana, "POST", "/api/keykeeper/site-problems", many)).status).toBe(400);
  const long = { ...report, host: newHost(), note: "n".repeat(1001) };
  expect((await api.call(ana, "POST", "/api/keykeeper/site-problems", long)).status).toBe(400);
});

test("one person sends at most 10 problem reports and 30 fixes at once", async ({ request }) => {
  // Reports and fixes are kept without the account, so this is the only
  // limit on what one person can make the server keep.
  const api = new Api(request);
  const ana = await api.account("ana");
  const report = (host: string) => ({ host, fields: [{ id: "pw", type: "password" }] });
  for (let i = 0; i < 10; i++) {
    expect((await api.call(ana, "POST", "/api/keykeeper/site-problems", report(newHost()))).status).toBe(200);
  }
  expect((await api.call(ana, "POST", "/api/keykeeper/site-problems", report(newHost()))).status).toBe(429);
  for (let i = 0; i < 30; i++) {
    expect((await api.call(ana, "POST", "/api/keykeeper/site-fixes", fixFor(newHost()))).status).toBe(200);
  }
  expect((await api.call(ana, "POST", "/api/keykeeper/site-fixes", fixFor(newHost()))).status).toBe(429);
  // Someone else isn't held up.
  const ben = await api.account("ben");
  expect((await api.call(ben, "POST", "/api/keykeeper/site-problems", report(newHost()))).status).toBe(200);
});

test("an MSP's admin applies a fix its staff shared to every client at once, and only its clients get it", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("fix-admin");
  const mspId = await api.msp(admin, "Fixing IT");
  const clientId = await api.client(admin, mspId, "Fixed Dental");
  const tech = await api.account("fix-tech");
  await api.addStaff(admin, mspId, tech, "technician");
  const member = await api.account("fix-member");
  await api.addMember(admin, clientId, member, "user");
  const outsider = await api.account("fix-outsider");
  const host = newHost();
  const fix = fixFor(host);

  // The technician shares a fix: the console shows it, with who sent it.
  expect((await api.call(tech, "POST", "/api/keykeeper/site-fixes", fix)).status).toBe(200);
  const shown = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/site-fixes`);
  expect(shown.status, JSON.stringify(shown.body)).toBe(200);
  expect(shown.body.shared).toContainEqual(expect.objectContaining({ ...fix, reportedBy: tech.email }));
  expect(shown.body.rules).toEqual([]);

  // Used for every client: the client's member and the staff get it at once; others don't.
  const added = await api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/site-rules`, fix);
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  expect((await list(api, member)).rules).toContainEqual(fix);
  expect((await list(api, tech)).rules).toContainEqual(fix);
  expect((await list(api, outsider)).rules).not.toContainEqual(fix);
  const events = (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`)).body.data;
  expect(events.map((e: { event: string }) => e.event)).toContain("site_rule_added");

  const removed = await api.call(admin, "DELETE", `/api/keykeeper/msp/${mspId}/site-rules/${added.body.id}`);
  expect(removed.status).toBe(200);
  expect((await list(api, member)).rules).not.toContainEqual(fix);
});

test.describe("Site rule permissions", () => {
  type Actor = "admin" | "technician" | "member" | "stranger" | "anonymous";
  type Context = { api: Api; mspId: string; admin: Account };
  const rows: MatrixRow<Actor, Context>[] = [
    {
      name: "see an MSP's site rules and its staff's fixes",
      allowed: ["admin"],
      request: async ({ mspId }) => ({ method: "GET", path: `/api/keykeeper/msp/${mspId}/site-fixes` }),
    },
    {
      name: "apply a fix to every client",
      allowed: ["admin"],
      request: async ({ mspId }) => ({
        method: "POST",
        path: `/api/keykeeper/msp/${mspId}/site-rules`,
        data: fixFor(newHost()),
      }),
    },
    {
      name: "remove a site rule",
      allowed: ["admin"],
      request: async ({ api, mspId, admin }) => {
        const added = await api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/site-rules`, fixFor(newHost()));
        return { method: "DELETE", path: `/api/keykeeper/msp/${mspId}/site-rules/${added.body.id}` };
      },
    },
  ];
  permissionMatrix<Actor, Context>(
    ["admin", "technician", "member", "stranger", "anonymous"],
    async (api) => {
      const admin = await api.account("rules-admin");
      const mspId = await api.msp(admin, "Rules IT");
      const clientId = await api.client(admin, mspId, "Rules Dental");
      const technician = await api.account("rules-tech");
      await api.addStaff(admin, mspId, technician, "technician");
      const member = await api.account("rules-member");
      await api.addMember(admin, clientId, member, "user");
      const stranger = await api.account("rules-stranger");
      return {
        ctx: { api, mspId, admin },
        callers: { admin, technician, member, stranger, anonymous: null },
      };
    },
    rows,
  );
});

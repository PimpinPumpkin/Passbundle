// Plans' emails (DESIGN.md, "Plans and billing", "What happens when payment
// stops"): the reminders an organization's owners get, once each, when its
// trial is about to end, and when a plan set to renew is in grace and when
// its grace has ended; and an emailed invitation, which can't be accepted
// once the organization's plan has ended, or into a family that already has
// more people than its plan covers (tests/api/plans-families.spec.ts has the
// other ways in).
//
// The reminders come from the plans' clock, a scheduled job. These tests
// start a server of their own that enforces plans, sends email, has the admin
// page on (the operator moves a plan's dates, never the clock), and runs the
// job every second (KK_PLAN_REMINDERS_SCHEDULE).
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { mailHttpPort, plansMailServerPort } from "../../paths.mjs";
import { Api, encString } from "../api/support";

import { inviteParams, joinByEmail, type Message, waitForMessage } from "./mailbox";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ORGANIZATION_ENDED =
  "This organization's plan has ended, so nothing new can be added. Everything in it can still be opened, changed, exported, and deleted.";

/** A moment this far from now, to the second, as the operator's route takes dates. */
const fromNow = (ms: number) => new Date(Math.floor((Date.now() + ms) / 1000) * 1000).toISOString();

/** A moment as the emails say it: "Monday, March 1, 2027, at 12:00 PM UTC". */
function inWords(date: string): string {
  const at = new Date(date);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true })
    .format(at)
    .replace(/\s/g, " ");
  return `${day}, at ${time} UTC`;
}

/** A day as the subjects say it: "March 1, 2027". */
const dayInWords = (date: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(new Date(date));

/** Every message to this address so far whose subject matches. */
async function messagesTo(address: string, subject: RegExp): Promise<Message[]> {
  const response = await fetch(`http://127.0.0.1:${mailHttpPort}/messages?to=${encodeURIComponent(address)}`);
  const messages: Message[] = await response.json();
  return messages.filter((m) => subject.test(m.subject));
}

/** A message's text as one line, so a paragraph wrapped in the email reads whole. */
const flat = (message: Message) => message.text.replace(/\s+/g, " ");

let child: ChildProcess | undefined;
let dataDir: string | undefined;
let operator: APIRequestContext;

test.use({ baseURL: `https://127.0.0.1:${plansMailServerPort}` });

test.beforeAll(async ({ playwright }) => {
  const adminToken = randomBytes(32).toString("base64url");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-plans-mail-"));
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: plansMailServerPort,
      KK_DATA_DIR: dataDir,
      KK_MAIL: "1",
      KK_ADMIN_TOKEN: adminToken,
      KK_PLANS_ENFORCED: "1",
      KK_PLAN_REMINDERS_SCHEDULE: "* * * * * *",
    },
    stdio: "ignore",
  });
  operator = await playwright.request.newContext({
    baseURL: `https://127.0.0.1:${plansMailServerPort}`,
    ignoreHTTPSErrors: true,
  });
  await expect
    .poll(async () => (await operator.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
    .toBe(200);
  const signedIn = await operator.post("/admin", { form: { token: adminToken } });
  expect(signedIn.status(), "the operator's sign-in to the admin page").toBe(200);
});

test.afterAll(async () => {
  await operator?.dispose();
  if (child) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  if (dataDir) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

/** The operator sets an organization's plan. */
async function setPlan(orgId: string, data: Record<string, unknown>) {
  const written = await operator.post(`/admin/plans/organizations/${orgId}`, { data });
  expect(written.status(), await written.text()).toBe(200);
}

const trialUntil = (freeUntil: string) => ({ plan: "business", freeUntil, freeWhy: "trial", standing: "none", renews: false });

test("a trial's reminders reach its owners once each, 7 days and 1 day before it ends, with the date, what stops, and that nothing is deleted", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("plans-mail-owner");
  const secondOwner = await api.account("plans-mail-second-owner");
  const member = await api.account("plans-mail-member");
  const orgId = await api.organization(owner, "Plans Reminder Org");
  await joinByEmail(api, owner, orgId, "Plans Reminder Org", secondOwner, { type: 0 });
  await joinByEmail(api, owner, orgId, "Plans Reminder Org", member, { type: 2 });
  // Another organization, whose reminders show the clock ran again after each.
  const otherOwner = await api.account("plans-mail-other-owner");
  const otherId = await api.organization(otherOwner, "Plans Reminder Other");
  const subject = /^The PassBundle trial for Plans Reminder Org ends on /;
  const otherSubject = /^The PassBundle trial for Plans Reminder Other ends on /;

  // A new organization's 30 days are too far off for a reminder.
  expect(await messagesTo(owner.email, subject)).toEqual([]);

  // Five days left: the 7-day reminder, to each owner.
  const ends = fromNow(5 * DAY);
  await setPlan(orgId, trialUntil(ends));
  const message = await waitForMessage(owner.email, subject);
  expect(message.subject).toBe(`The PassBundle trial for Plans Reminder Org ends on ${dayInWords(ends)}`);
  const text = flat(message);
  expect(text).toContain(`The free trial for Plans Reminder Org ends on ${inWords(ends)}.`);
  expect(text).toContain(
    "After that, nothing new can be added to Plans Reminder Org: no new people, shared items, shared folders, groups, or attachments. Premium features its members have through Plans Reminder Org stop too.",
  );
  expect(text).toContain(
    "Nothing is deleted. Everyone in Plans Reminder Org can still sign in, and open, change, export, and delete everything in it.",
  );
  await waitForMessage(secondOwner.email, subject);

  // The clock runs again (the other organization's reminder comes from a
  // later run), and the first doesn't go a second time. A member gets none.
  await setPlan(otherId, trialUntil(fromNow(5 * DAY)));
  await waitForMessage(otherOwner.email, otherSubject);
  expect(await messagesTo(owner.email, subject)).toHaveLength(1);
  expect(await messagesTo(secondOwner.email, subject)).toHaveLength(1);
  expect(await messagesTo(member.email, subject)).toEqual([]);

  // Twelve hours left: the 1-day reminder, once.
  const soon = fromNow(12 * HOUR);
  await setPlan(orgId, trialUntil(soon));
  await expect.poll(async () => (await messagesTo(owner.email, subject)).length, { timeout: 15_000 }).toBe(2);
  const last = (await messagesTo(owner.email, subject)).at(-1)!;
  expect(flat(last)).toContain(`The free trial for Plans Reminder Org ends on ${inWords(soon)}.`);
  await setPlan(otherId, trialUntil(fromNow(12 * HOUR)));
  await expect.poll(async () => (await messagesTo(otherOwner.email, otherSubject)).length, { timeout: 15_000 }).toBe(2);
  expect(await messagesTo(owner.email, subject)).toHaveLength(2);
});

test("a plan set to renew whose payment is due: its owners hear 3 days before its grace ends, and when it has, once each", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("plans-mail-grace-owner");
  const orgId = await api.organization(owner, "Plans Grace Org");
  const other = await api.account("plans-mail-grace-other");
  const otherId = await api.organization(other, "Plans Grace Other");

  // Paid through 12 days ago: 2 of its 14 days of grace left.
  const until = fromNow(-12 * DAY);
  const graceEnds = new Date(new Date(until).getTime() + 14 * DAY).toISOString();
  await setPlan(orgId, { plan: "business", standing: "until", until, renews: true });
  const due = await waitForMessage(owner.email, /unless it's paid$/);
  expect(due.subject).toBe(`Plans Grace Org's PassBundle plan ends on ${dayInWords(graceEnds)} unless it's paid`);
  expect(flat(due)).toContain(
    `The payment for Plans Grace Org's PassBundle plan hasn't come through. It was paid through ${inWords(until)}, and it ends on ${inWords(graceEnds)} unless it's paid by then.`,
  );
  expect(flat(due)).toContain("Nothing is deleted.");

  // Its grace has ended.
  const longAgo = fromNow(-15 * DAY);
  const endedAt = new Date(new Date(longAgo).getTime() + 14 * DAY).toISOString();
  await setPlan(orgId, { plan: "business", standing: "until", until: longAgo, renews: true });
  const ended = await waitForMessage(owner.email, /has ended$/);
  expect(ended.subject).toBe("Plans Grace Org's PassBundle plan has ended");
  expect(flat(ended)).toContain(
    `Plans Grace Org's PassBundle plan ended on ${inWords(endedAt)}, 14 days after it was due, because its payment didn't come through.`,
  );
  expect(flat(ended)).toContain(
    "Nothing new can be added to Plans Grace Org now: no new people, shared items, shared folders, groups, or attachments.",
  );

  // Once each: the clock runs again, and neither goes twice.
  await setPlan(otherId, { plan: "business", standing: "until", until: longAgo, renews: true });
  await waitForMessage(other.email, /has ended$/);
  expect(await messagesTo(owner.email, /unless it's paid$/)).toHaveLength(1);
  expect(await messagesTo(owner.email, /has ended$/)).toHaveLength(1);

  // A plan someone canceled ends as they chose, with no email.
  const canceled = await api.account("plans-mail-canceled");
  const canceledId = await api.organization(canceled, "Plans Canceled Org");
  await setPlan(canceledId, { plan: "business", standing: "until", until: fromNow(-HOUR), renews: false });
  await setPlan(otherId, { plan: "business", standing: "until", until: fromNow(-12 * DAY), renews: true });
  await waitForMessage(other.email, /unless it's paid$/);
  expect(await messagesTo(canceled.email, /PassBundle (plan|trial)|plan has ended|unless it.s paid/)).toEqual([]);
});

test("an emailed invitation can't be accepted once the organization's plan has ended", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("plans-mail-invite-owner");
  const invitee = await api.account("plans-mail-invitee");
  const orgId = await api.organization(owner, "Plans Invite Org");
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [invitee.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const link = inviteParams(await waitForMessage(invitee.email, /Join Plans Invite Org/));

  await setPlan(orgId, { plan: "business", standing: "until", until: fromNow(-60 * DAY), renews: false });
  const accepted = await api.call(invitee, "POST", `/api/organizations/${orgId}/users/${link.get("organizationUserId")}/accept`, {
    token: link.get("token"),
    resetPasswordKey: encString(`recovery-key-${invitee.email}`),
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(400);
  expect(accepted.body.message).toBe(ORGANIZATION_ENDED);
  const member = (await api.members(owner, orgId)).find((m) => m.email === invitee.email);
  expect(member?.status).toBe(0);
});

test("an emailed invitation into a family is accepted while it has six people at most, invitations included, and not past that", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("plans-mail-family-owner");
  const invitee = await api.account("plans-mail-family-invitee");
  const late = await api.account("plans-mail-family-late");
  const orgId = await api.organization(owner, "Plans Mail Family");
  const invite = async (email: string) => {
    const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [email],
      type: 2,
      collections: [],
      groups: [],
      permissions: {},
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  };
  const accept = async (who: typeof invitee, orgName: RegExp) => {
    const link = inviteParams(await waitForMessage(who.email, orgName));
    return api.call(who, "POST", `/api/organizations/${orgId}/users/${link.get("organizationUserId")}/accept`, {
      token: link.get("token"),
      resetPasswordKey: encString(`recovery-key-${who.email}`),
    });
  };
  const nobody = (n: number) => `plans-mail-family-${n}-${Math.random().toString(36).slice(2, 8)}@api.example.test`;
  const statusOf = async (email: string) => (await api.members(owner, orgId)).find((m) => m.email === email)?.status;

  // The owner, the invitee, and four more invitations: six.
  await invite(invitee.email);
  for (let n = 0; n < 4; n++) {
    await invite(nobody(n));
  }
  await setPlan(orgId, { plan: "families", standing: "until", until: fromNow(365 * DAY), renews: true });
  // Accepting takes no second place.
  const accepted = await accept(invitee, /Join Plans Mail Family/);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(await statusOf(invitee.email)).toBe(1);

  // Two more while it was Business: eight, and an invitation can't be accepted until two go.
  await setPlan(orgId, { plan: "business", standing: "until", until: fromNow(365 * DAY), renews: true });
  await invite(nobody(4));
  await invite(late.email);
  await setPlan(orgId, { plan: "families", standing: "until", until: fromNow(365 * DAY), renews: true });
  const refused = await accept(late, /Join Plans Mail Family/);
  expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  expect(refused.body.message).toBe("A Families plan covers 6 people, and this one has 8. Remove someone first.");
  expect(await statusOf(late.email)).toBe(0);
});

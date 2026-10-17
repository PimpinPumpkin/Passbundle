// Who may join a client with its install command, and who hears about it
// (DESIGN.md, "Onboarding through the RMM" and "Joining"). Limiting the
// command to email domains trusts an email only once it's verified, so these
// run on the server that sends email.
import { expect, test } from "@playwright/test";

import { type Account, Api } from "../api/support";

import { joinByEmail, type Message, waitForMessage } from "./mailbox";

/** Verifies an account's email the way a person does: the emailed link. */
async function verifyEmail(api: Api, account: Account) {
  const sent = await api.call(account, "POST", "/api/accounts/verify-email");
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const message = await waitForMessage(account.email, /Verify Your Email/);
  const link = /verify-email\/\?userId=([^&\s]+)&token=(\S+)/.exec(message.text);
  expect(link, message.text).toBeTruthy();
  const verified = await api.call(account, "POST", "/api/accounts/verify-email-token", {
    userId: link![1],
    token: link![2],
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
}

async function setUp(api: Api, name: string) {
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, `${name} IT`);
  const orgId = await api.client(admin, mspId, name);
  const enrollment = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`);
  expect(enrollment.body.domains).toEqual([]);
  return { admin, mspId, orgId, token: enrollment.body.token as string };
}

const join = (api: Api, person: Account, token: string) =>
  api.call(person, "POST", "/api/keykeeper/enrollment/join", { token });

/** Messages to this address so far, after giving the server a moment to send any. */
async function messagesTo(address: string): Promise<Message[]> {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const { mailHttpPort } = await import("../../paths.mjs");
  const response = await fetch(`http://127.0.0.1:${mailHttpPort}/messages?to=${encodeURIComponent(address)}`);
  return response.json();
}

test("an install command limited to email domains lets in only verified accounts there, and email invitations still work", async ({
  request,
}) => {
  const api = new Api(request);
  const { admin, mspId, orgId, token } = await setUp(api, "Domain Co");
  const domainsUrl = `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment/domains`;

  // Only the MSP's admins set it, and it takes domains, however typed.
  const stranger = await api.account("stranger");
  expect((await api.call(stranger, "PUT", domainsUrl, { domains: ["api.example.test"] })).status).not.toBe(200);
  const bad = await api.call(admin, "PUT", domainsUrl, { domains: ["api.example.test", "acme"] });
  expect(bad.status).toBe(400);
  expect(bad.body.message).toBe('"acme" isn\'t an email domain, like example.com');
  const set = await api.call(admin, "PUT", domainsUrl, { domains: ["@API.example.test", " branch.example.test "] });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(set.body.domains).toEqual(["api.example.test", "branch.example.test"]);

  // An account elsewhere is told why, before and at the join.
  const outsider = await api.account("outsider", `outsider-${Date.now()}@elsewhere.example.test`);
  await verifyEmail(api, outsider);
  const info = await api.call(outsider, "POST", "/api/keykeeper/enrollment/info", { token });
  expect(info.status).toBe(400);
  expect(info.body.message).toBe(
    `Domain Co's install link is for api.example.test or branch.example.test accounts, and you're signed in as ${outsider.email}. Ask its admins to invite you.`,
  );
  expect((await join(api, outsider, token)).status).toBe(400);

  // An account at the domain joins once its email is verified.
  const insider = await api.account("insider");
  const unverified = await join(api, insider, token);
  expect(unverified.status).toBe(400);
  expect(unverified.body.message).toContain("Verify your email address first");
  await verifyEmail(api, insider);
  expect((await join(api, insider, token)).status).toBe(200);

  // Someone the client's admins invited by email joins from any address.
  const guest = await api.account("guest", `guest-${Date.now()}@elsewhere.example.test`);
  const invited = await api.call(admin, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [guest.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  expect((await join(api, guest, token)).status).toBe(200);

  // Without domains, anyone with the command joins again.
  const cleared = await api.call(admin, "PUT", domainsUrl, { domains: [] });
  expect(cleared.body.domains).toEqual([]);
  expect((await join(api, outsider, token)).status).toBe(200);

  const events = (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`)).body.data
    .filter((e: { event: string }) => e.event === "install_domains_set")
    .map((e: { detail: string | null }) => e.detail ?? "");
  expect(events).toEqual(["", "api.example.test branch.example.test"]);
});

test("a client's own owners hear when someone joins with the install command, and the MSP doesn't", async ({
  request,
}) => {
  const api = new Api(request);
  const { admin, mspId, orgId, token } = await setUp(api, "Notice Co");
  // The client's own owner, invited by the MSP admin who set it up.
  const owner = await api.account("client-owner");
  await joinByEmail(api, admin, orgId, "Notice Co", owner, { type: 0 });

  // Joining is automatic: they're in, and the owner is told who it was.
  const person = await api.account("person");
  expect((await join(api, person, token)).status).toBe(200);
  const joined = await waitForMessage(owner.email, new RegExp(`^${person.email} joined Notice Co$`));
  expect(joined.text).toContain(`${person.email} joined Notice Co with your IT provider's install command.`);
  expect(joined.text).toContain("They get access without anyone confirming them.");
  expect(joined.text).toContain(`/#/organizations/${orgId}/members`);
  expect(joined.html).toContain("Open the Members page");

  // Nobody at the MSP gets one per join, and the person isn't told about themselves.
  const toAdmin = (await messagesTo(admin.email)).filter((m) => m.subject.includes(person.email));
  expect(toAdmin).toEqual([]);
  expect((await messagesTo(person.email)).filter((m) => / join/.test(m.subject))).toEqual([]);

  // Where an admin approves joiners, the email says so.
  const approval = await api.call(admin, "PUT", `/api/keykeeper/organizations/${orgId}/joining`, {
    autoConfirm: false,
    inviteHours: 120,
  });
  expect(approval.status, JSON.stringify(approval.body)).toBe(200);
  const second = await api.account("second");
  expect((await join(api, second, token)).status).toBe(200);
  const waiting = await waitForMessage(owner.email, new RegExp(`^${second.email} is waiting to join Notice Co$`));
  expect(waiting.text).toContain(`${second.email} asked to join Notice Co with your IT provider's install command.`);
  expect(waiting.text).toContain("They get access once an admin approves them");
  expect(waiting.html).toContain("Approve them");
  void mspId;
});

test("whoever sent an invitation hears the person joined, worded for whether an admin still has to approve them", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("org-owner");
  const automatic = await api.organization(owner, "Auto Join Co");
  const newcomer = await api.account("newcomer");
  await joinByEmail(api, owner, automatic, "Auto Join Co", newcomer, { type: 2 });
  const joined = await waitForMessage(owner.email, new RegExp(`^${newcomer.email} joined Auto Join Co$`));
  expect(joined.text).toContain(`${newcomer.email} accepted your invitation and joined Auto Join Co.`);
  expect(joined.text).toContain("They get access without anyone confirming them.");

  const approved = await api.organization(owner, "Approve Co");
  const set = await api.call(owner, "PUT", `/api/keykeeper/organizations/${approved}/joining`, {
    autoConfirm: false,
    inviteHours: 120,
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const later = await api.account("later");
  await joinByEmail(api, owner, approved, "Approve Co", later, { type: 2 });
  const accepted = await waitForMessage(owner.email, /^Invitation to Approve Co accepted$/);
  expect(accepted.text).toContain(`${later.email} has accepted your invitation to join Approve Co.`);
});

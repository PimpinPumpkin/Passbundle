// An invitation lasts as long as its organization says (see DESIGN.md,
// "Joining"), and the email tells the person how long that is.
import { expect, test } from "@playwright/test";

import { type Account, Api } from "../api/support";

import { inviteParams, waitForMessage } from "./mailbox";

async function inviteByEmail(api: Api, owner: Account, orgId: string, email: string) {
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [email],
    type: 2,
    collections: [],
    groups: [],
    accessSecretsManager: false,
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
}

/** How long the emailed invitation token is valid, in hours. */
function tokenHours(token: string): number {
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return (claims.exp - claims.nbf) / 3600;
}

test("an invitation lasts as long as the organization says, and its email says so", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("joining-owner");

  const quick = await api.organization(owner, "Two Hour Co");
  const set = await api.call(owner, "PUT", `/api/keykeeper/organizations/${quick}/joining`, {
    autoConfirm: true,
    inviteHours: 2,
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const soon = `soon-${Date.now()}@api.example.test`;
  await inviteByEmail(api, owner, quick, soon);
  const quickMessage = await waitForMessage(soon, /Join Two Hour Co/);
  expect(quickMessage.text).toContain("This invitation works for 2 hours.");
  expect(quickMessage.html).toContain("This invitation works for 2 hours.");
  expect(tokenHours(inviteParams(quickMessage).get("token")!)).toBe(2);

  // Without a setting, the server's: 5 days.
  const usual = await api.organization(owner, "Usual Co");
  const later = `later-${Date.now()}@api.example.test`;
  await inviteByEmail(api, owner, usual, later);
  const usualMessage = await waitForMessage(later, /Join Usual Co/);
  expect(usualMessage.text).toContain("This invitation works for 5 days.");
  expect(tokenHours(inviteParams(usualMessage).get("token")!)).toBe(120);
});

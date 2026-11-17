// An invitation says, in one plain sentence, when the organization's admins
// will see how many of the person's own passwords are weak, reused, or
// exposed (DESIGN.md, "Members' own passwords"): in the same words as the
// extension's question before joining with an install command. With the
// setting off, it says nothing of it.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type Account, Api } from "../api/support";

import { waitForMessage } from "./mailbox";

const SENTENCE = "will see how many of your own passwords are weak, reused, or exposed. Never which ones.";

async function invite(api: Api, owner: Account, orgId: string, email: string) {
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

test("an invitation says when the organization's admins will see how many of your own passwords are weak", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("member-health-invite-owner");
  const tag = randomUUID().slice(0, 6);

  const seeing = `Harbor Dental ${tag}`;
  const harbor = await api.organization(owner, seeing);
  const on = await api.call(owner, "PUT", `/api/keykeeper/organizations/${harbor}/member-health-setting`, {
    enabled: true,
  });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  const ana = `ana-${tag}@api.example.test`;
  await invite(api, owner, harbor, ana);
  const told = await waitForMessage(ana, new RegExp(`Join ${seeing}`));
  expect(told.text).toContain(`Admins at ${seeing} ${SENTENCE}`);
  expect(told.html).toContain(`Admins at ${seeing} ${SENTENCE}`);
  // Once, in the text and the HTML alike.
  expect(told.text.split("Never which ones").length).toBe(2);
  expect(told.html.split("Never which ones").length).toBe(2);

  // An organization made the upstream way has it off: nothing about it.
  const quiet = `Family ${tag}`;
  const family = await api.organization(owner, quiet);
  const ben = `ben-${tag}@api.example.test`;
  await invite(api, owner, family, ben);
  const plain = await waitForMessage(ben, new RegExp(`Join ${quiet}`));
  expect(plain.text).not.toContain(SENTENCE);
  expect(plain.html).not.toContain(SENTENCE);
  expect(plain.text).toContain(`You have been invited to join the *${quiet}* organization.`);
});

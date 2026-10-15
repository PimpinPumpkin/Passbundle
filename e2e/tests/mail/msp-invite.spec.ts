// An MSP staff invitation is emailed when the server sends email.
import { expect, test } from "@playwright/test";

import { Api } from "../api/support";

import { waitForMessage } from "./mailbox";

test("an invitation to the MSP's staff is emailed with its link", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("mail-invite-admin");
  const mspId = await api.msp(admin, "Mail Invite IT");
  const email = `mail-hire-${Date.now()}@api.example.test`;

  const invited = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/staff`,
    { email, role: "technician" },
  );
  expect(invited.body).toMatchObject({ invited: true, emailed: true });

  const message = await waitForMessage(email, /Join Mail Invite IT/);
  expect(message.text).toContain(
    `${admin.email} invited you to join *Mail Invite IT* as a technician`,
  );
  expect(message.text).toContain(invited.body.inviteUrl);
  expect(message.html).toContain(invited.body.inviteUrl);
});

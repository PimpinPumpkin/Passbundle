// Account recovery on a server that sends email (it's off without email).
// MSP staff are never part of a client's account recovery: recovery lets the
// client's admins take over the staff member's account, which can see every
// other client. Regular members invited by email are enrolled, as upstream does.
import { expect, test } from "@playwright/test";

import { Api, encString } from "../api/support";

import { inviteParams, waitForMessage } from "./mailbox";

test("MSP staff can't join a client's account recovery or be recovered by it; invited members can", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const member = await api.account("member");
  const mspId = await api.msp(admin, "Recovery IT");
  const orgId = await api.client(admin, mspId, "Recovery Client", "business");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);

  // With email, the organization offers account recovery.
  const profile = await api.call(admin, "GET", "/api/accounts/profile");
  expect(
    profile.body.organizations.find((o: { id: string }) => o.id === orgId)
      .useResetPassword,
  ).toBe(true);

  // A technician can't enroll themselves.
  const enroll = await api.call(
    tech,
    "PUT",
    `/api/organizations/${orgId}/users/${tech.userId}/reset-password-enrollment`,
    {
      resetPasswordKey: encString("tech-recovery-key"),
      masterPasswordHash: tech.password,
    },
  );
  expect(enroll.status).toBe(400);
  expect(enroll.body.message).toContain(
    "MSP staff can't join a client organization's account recovery",
  );

  // And the client's owner can't recover a technician.
  const techMember = (await api.members(admin, orgId)).find(
    (m) => m.email === tech.email,
  )!;
  const details = await api.call(
    admin,
    "GET",
    `/api/organizations/${orgId}/users/${techMember.id}/reset-password-details`,
  );
  expect(details.status).toBe(400);
  expect(details.body.message).toContain("MSP staff can't be recovered");

  // A member invited by email joins through the link and is enrolled, as upstream does.
  const invited = await api.call(
    admin,
    "POST",
    `/api/organizations/${orgId}/users/invite`,
    {
      emails: [member.email],
      type: 2,
      collections: [],
      groups: [],
      permissions: {},
    },
  );
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const link = inviteParams(
    await waitForMessage(member.email, /Join Recovery Client/),
  );
  const memberId = link.get("organizationUserId")!;
  const accepted = await api.call(
    member,
    "POST",
    `/api/organizations/${orgId}/users/${memberId}/accept`,
    {
      token: link.get("token"),
      resetPasswordKey: encString("member-recovery-key"),
    },
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const confirmed = await api.call(
    admin,
    "POST",
    `/api/organizations/${orgId}/users/${memberId}/confirm`,
    {
      key: encString(`org-key-for-${member.email}`),
    },
  );
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const memberDetails = await api.call(
    admin,
    "GET",
    `/api/organizations/${orgId}/users/${memberId}/reset-password-details`,
  );
  expect(memberDetails.status, JSON.stringify(memberDetails.body)).toBe(200);
  expect(memberDetails.body.resetPasswordKey).toBe(
    encString("member-recovery-key"),
  );
});

// Account recovery on a server that sends email (it's off without email).
// Each test turns it on first, since organizations start without it, Business
// ones included.
// MSP staff are never part of a client's account recovery: recovery lets the
// client's admins take over the staff member's account, which can see every
// other client. Regular members invited by email are enrolled, as upstream does.
import { expect, test } from "@playwright/test";

import { Api, encString } from "../api/support";

import { inviteParams, joinByEmail, verifyEmail, waitForMessage } from "./mailbox";

test("MSP staff can't join a client's account recovery or be recovered by it; invited members can", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const member = await api.account("member");
  const mspId = await api.msp(admin, "Recovery IT");
  const orgId = await api.client(admin, mspId, "Recovery Client", "business");
  // The MSP admin turns on account recovery for this client in its admin
  // console, with automatic enrollment.
  const policy = await api.call(
    admin,
    "PUT",
    `/api/organizations/${orgId}/policies/8`,
    {
      policy: { enabled: true, data: { autoEnrollEnabled: true } },
    },
  );
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  // Where the server sends email, a staff invitation needs a verified address.
  await verifyEmail(api, tech);
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
    "MSP staff can't join an organization's account recovery",
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

test("someone who joins an MSP's staff leaves every account recovery, and no organization can recover them", async ({
  request,
}) => {
  const api = new Api(request);
  // A company's own organization, enrolling its members in account recovery.
  const owner = await api.account("owner");
  const orgName = `Recovery Co ${Date.now()}`;
  const orgId = await api.organization(owner, orgName);
  const policy = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/8`, {
    policy: { enabled: true, data: { autoEnrollEnabled: true } },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  const person = await api.account("person");
  const memberId = await joinByEmail(api, owner, orgId, orgName, person, { type: 2 });
  const enrolled = await api.call(owner, "GET", `/api/organizations/${orgId}/users/${memberId}/reset-password-details`);
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);

  // They join an MSP's staff. Their account will reach every client, so the
  // company's recovery of it ends, and it can't be recovered at all.
  const mspAdmin = await api.account("msp-admin");
  const mspId = await api.msp(mspAdmin, "Elsewhere IT");
  await verifyEmail(api, person);
  await api.addStaff(mspAdmin, mspId, person, "technician");
  const details = await api.call(owner, "GET", `/api/organizations/${orgId}/users/${memberId}/reset-password-details`);
  expect(details.status).toBe(400);
  expect(details.body.message).toContain("MSP staff can't be recovered");
  const again = await api.call(person, "PUT", `/api/organizations/${orgId}/users/${person.userId}/reset-password-enrollment`, {
    resetPasswordKey: encString("person-recovery-key"),
    masterPasswordHash: person.password,
  });
  expect(again.status).toBe(400);
  expect(again.body.message).toContain("MSP staff can't join an organization's account recovery");
});

test("a custom role with account recovery recovers regular members only", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgName = `Recovery Roles ${Date.now()}`;
  const orgId = await api.organization(owner, orgName);
  const policy = await api.call(
    owner,
    "PUT",
    `/api/organizations/${orgId}/policies/8`,
    {
      policy: { enabled: true, data: { autoEnrollEnabled: true } },
    },
  );
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const recoverer = await api.account("recoverer");
  const recovererId = await joinByEmail(api, owner, orgId, orgName, recoverer, {
    type: 4,
    permissions: { manageResetPassword: true },
  });
  const regularId = await joinByEmail(
    api,
    owner,
    orgId,
    orgName,
    await api.account("regular"),
    { type: 2 },
  );
  const adminId = await joinByEmail(
    api,
    owner,
    orgId,
    orgName,
    await api.account("admin"),
    { type: 1 },
  );
  const otherId = await joinByEmail(
    api,
    owner,
    orgId,
    orgName,
    await api.account("other"),
    {
      type: 4,
      permissions: { manageUsers: true },
    },
  );

  const details = (id: string) =>
    api.call(
      recoverer,
      "GET",
      `/api/organizations/${orgId}/users/${id}/reset-password-details`,
    );
  const regular = await details(regularId);
  expect(regular.status, JSON.stringify(regular.body)).toBe(200);
  expect(regular.body.resetPasswordKey).toBeTruthy();
  for (const id of [adminId, otherId, recovererId]) {
    const refused = await details(id);
    expect(refused.status, id).toBe(400);
    expect(refused.body.message).toMatch(
      /only manage regular members|own membership/,
    );
  }
  // And nothing beyond account recovery: forbidden, not a lost session.
  expect(
    (await api.call(recoverer, "GET", `/api/organizations/${orgId}/policies`))
      .status,
  ).toBe(403);
});

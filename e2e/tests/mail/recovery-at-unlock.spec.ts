// Enrolling at unlock (DESIGN.md, "Enrolling at unlock"): when an organization
// turns on account recovery with automatic enrollment after people joined,
// their web vault or extension enrolls them at their next unlock, without
// their master password (an app unlocked with a PIN, biometrics, or a reload
// doesn't have it). The server takes that only from a confirmed member, for
// themselves, where the organization enrolls everyone, and only the first
// time: replacing an enrollment still needs the password. On the server that
// sends email, since account recovery needs it.
import { expect, test } from "@playwright/test";

import { type Account, Api, encString } from "../api/support";

import { inviteParams, verifyEmail, waitForMessage } from "./mailbox";

const enrollment = (orgId: string, userId: string) =>
  `/api/organizations/${orgId}/users/${userId}/reset-password-enrollment`;

/** Account recovery on, with or without automatic enrollment, as an owner turns it on later. */
async function turnOnRecovery(api: Api, owner: Account, orgId: string, autoEnrollEnabled = true) {
  const policy = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/8`, {
    policy: { enabled: true, data: { autoEnrollEnabled } },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
}

/**
 * Invites an account by email and has them join through the emailed link
 * before the organization uses account recovery, so they join without
 * enrolling, then confirms them unless told not to. Returns their membership id.
 */
async function joinBeforeRecovery(
  api: Api,
  owner: Account,
  orgId: string,
  orgName: string,
  member: Account,
  role: { type: number; permissions?: Record<string, boolean> } = { type: 2 },
  confirm = true,
): Promise<string> {
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [member.email],
    type: role.type,
    collections: [],
    groups: [],
    permissions: role.permissions ?? {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const link = inviteParams(await waitForMessage(member.email, new RegExp(`Join ${orgName}`)));
  const memberId = link.get("organizationUserId")!;
  const accepted = await api.call(member, "POST", `/api/organizations/${orgId}/users/${memberId}/accept`, {
    token: link.get("token"),
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  if (confirm) {
    await confirmMember(api, owner, orgId, memberId, member);
  }
  return memberId;
}

async function confirmMember(api: Api, owner: Account, orgId: string, memberId: string, member: Account) {
  const confirmed = await api.call(owner, "POST", `/api/organizations/${orgId}/users/${memberId}/confirm`, {
    key: encString(`org-key-for-${member.email}`),
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
}

/** The recovery key the server holds for a member, as the owner's Recover account reads it. */
async function recoveryKey(api: Api, owner: Account, orgId: string, memberId: string) {
  const details = await api.call(owner, "GET", `/api/organizations/${orgId}/users/${memberId}/reset-password-details`);
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  return details.body.resetPasswordKey as string | null;
}

test("a confirmed member enrolls without their master password where the organization enrolls everyone, and only the first time", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgName = `Unlock Co ${Date.now()}`;
  const orgId = await api.organization(owner, orgName);
  const member = await api.account("member");
  const memberId = await joinBeforeRecovery(api, owner, orgId, orgName, member);
  const enroll = (key: string, extra: Record<string, unknown> = {}) =>
    api.call(member, "PUT", enrollment(orgId, member.userId), { resetPasswordKey: encString(key), ...extra });

  // Before the organization uses account recovery, there's nothing to enroll in.
  const before = await enroll("too-early");
  expect(before.status).toBe(400);
  expect(before.body.message).toContain("Policy not found");

  // On, without automatic enrollment: enrolling is the member's choice, with
  // their master password, as upstream asks.
  await turnOnRecovery(api, owner, orgId, false);
  const optional = await enroll("by-choice");
  expect(optional.status).toBe(400);
  expect(optional.body.message).toContain("No validation provided");
  expect(await recoveryKey(api, owner, orgId, memberId)).toBeNull();

  // With automatic enrollment, the member's app enrolls them at unlock, without it.
  await turnOnRecovery(api, owner, orgId);
  const automatic = await enroll("at-unlock");
  expect(automatic.status, JSON.stringify(automatic.body)).toBe(200);
  expect(await recoveryKey(api, owner, orgId, memberId)).toBe(encString("at-unlock"));
  const profile = await api.call(member, "GET", "/api/accounts/profile");
  expect(profile.body.organizations.find((o: { id: string }) => o.id === orgId).resetPasswordEnrolled).toBe(true);

  // A session alone can't replace it: that needs the master password, as before.
  const replaced = await enroll("replaced");
  expect(replaced.status).toBe(400);
  expect(replaced.body.message).toContain("No validation provided");
  expect(await recoveryKey(api, owner, orgId, memberId)).toBe(encString("at-unlock"));
  const withPassword = await enroll("with-password", { masterPasswordHash: member.password });
  expect(withPassword.status, JSON.stringify(withPassword.body)).toBe(200);
  expect(await recoveryKey(api, owner, orgId, memberId)).toBe(encString("with-password"));

  // Nor withdraw, which the policy doesn't allow at all.
  const withdrawn = await api.call(member, "PUT", enrollment(orgId, member.userId), { resetPasswordKey: "" });
  expect(withdrawn.status).toBe(400);
  expect(withdrawn.body.message).toContain("can't be withdrawn");
  expect(await recoveryKey(api, owner, orgId, memberId)).toBe(encString("with-password"));
});

test("a password that's sent is still checked, even where none is needed", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgName = `Unlock Check ${Date.now()}`;
  const orgId = await api.organization(owner, orgName);
  const member = await api.account("member");
  const memberId = await joinBeforeRecovery(api, owner, orgId, orgName, member);
  await turnOnRecovery(api, owner, orgId);

  const wrong = await api.call(member, "PUT", enrollment(orgId, member.userId), {
    resetPasswordKey: encString("wrong-password"),
    masterPasswordHash: Buffer.from("not the password").toString("base64"),
  });
  expect(wrong.status).toBe(400);
  expect(wrong.body.message).toContain("Invalid password");
  expect(await recoveryKey(api, owner, orgId, memberId)).toBeNull();
});

test("someone who accepted but isn't confirmed yet needs their master password, and enrolls without it once confirmed", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgName = `Unlock Wait ${Date.now()}`;
  const orgId = await api.organization(owner, orgName);
  const member = await api.account("member");
  const memberId = await joinBeforeRecovery(api, owner, orgId, orgName, member, { type: 2 }, false);
  await turnOnRecovery(api, owner, orgId);

  const waiting = await api.call(member, "PUT", enrollment(orgId, member.userId), {
    resetPasswordKey: encString("waiting"),
  });
  expect(waiting.status).toBe(400);
  expect(waiting.body.message).toContain("No validation provided");

  await confirmMember(api, owner, orgId, memberId, member);
  const confirmed = await api.call(member, "PUT", enrollment(orgId, member.userId), {
    resetPasswordKey: encString("confirmed"),
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  expect(await recoveryKey(api, owner, orgId, memberId)).toBe(encString("confirmed"));
});

test("without a password, every role enrolls itself, and nobody enrolls someone else, in another organization, or signed out", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgName = `Unlock Roles ${Date.now()}`;
  const orgId = await api.organization(owner, orgName);
  const roles: [string, { type: number; permissions?: Record<string, boolean> }][] = [
    ["admin", { type: 1 }],
    ["user", { type: 2 }],
    ["manager", { type: 3 }],
    ["custom", { type: 4, permissions: { manageUsers: true } }],
  ];
  const members: { name: string; account: Account; memberId: string }[] = [];
  for (const [name, role] of roles) {
    const account = await api.account(name);
    members.push({ name, account, memberId: await joinBeforeRecovery(api, owner, orgId, orgName, account, role) });
  }
  // Someone in another organization only.
  const outsider = await api.account("outsider");
  await api.organization(outsider, `Elsewhere ${Date.now()}`);
  await turnOnRecovery(api, owner, orgId);
  const noPassword = (as: Account | null, userId: string, label: string) =>
    api.call(as, "PUT", enrollment(orgId, userId), { resetPasswordKey: encString(label) });

  const user = members.find((m) => m.name === "user")!;
  const admin = members.find((m) => m.name === "admin")!;

  // Not for someone else, whatever the role: an admin can't enroll a member.
  const forSomeoneElse = await noPassword(admin.account, user.account.userId, "admin-for-user");
  expect(forSomeoneElse.status).toBe(400);
  expect(forSomeoneElse.body.message).toContain("User to enroll isn't member of required organization");
  // Not in an organization they aren't in.
  const outside = await noPassword(outsider, outsider.userId, "outsider");
  expect(outside.status).toBe(401);
  // Not signed out.
  const signedOut = await noPassword(null, user.account.userId, "signed-out");
  expect(signedOut.status).toBe(401);
  for (const m of members) {
    expect(await recoveryKey(api, owner, orgId, m.memberId)).toBeNull();
  }

  // Each role for itself, the owner too, as accepting an invitation enrolls every role.
  const ownerId = (await api.members(owner, orgId)).find((m) => m.email === owner.email)!.id;
  const ownerEnrolled = await noPassword(owner, owner.userId, "owner");
  expect(ownerEnrolled.status, JSON.stringify(ownerEnrolled.body)).toBe(200);
  expect(await recoveryKey(api, owner, orgId, ownerId)).toBe(encString("owner"));
  for (const m of members) {
    const enrolled = await noPassword(m.account, m.account.userId, m.name);
    expect(enrolled.status, `${m.name}: ${JSON.stringify(enrolled.body)}`).toBe(200);
    expect(await recoveryKey(api, owner, orgId, m.memberId)).toBe(encString(m.name));
  }
});

test("MSP staff can't enroll without a password either", async ({ request }) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const mspId = await api.msp(admin, "Unlock IT");
  // The Business preset turns on account recovery with automatic enrollment.
  const orgId = await api.client(admin, mspId, "Unlock Client", "business");
  await verifyEmail(api, tech);
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);

  const refused = await api.call(tech, "PUT", enrollment(orgId, tech.userId), {
    resetPasswordKey: encString("tech-at-unlock"),
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("MSP staff can't join an organization's account recovery");
  const techMember = (await api.members(admin, orgId)).find((m) => m.email === tech.email)!;
  const listed = await api.call(admin, "GET", `/api/organizations/${orgId}/users`);
  expect(listed.body.data.find((m: { id: string }) => m.id === techMember.id).resetPasswordEnrolled).toBe(false);
});

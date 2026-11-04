// Inviting someone without an account to an MSP's staff. Accepting needs the
// invitation's secret link and an account with the invited email address.
import { expect, test } from "@playwright/test";

import { Api } from "./support";

const ACCEPTED = 1;

test("someone without an account is invited, then accepts with the link and joins every client", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("invite-admin");
  const mspId = await api.msp(admin, "Invite IT");
  const orgId = await api.client(admin, mspId, "Invite Dental");

  // No account uses this address yet.
  const email = `new-hire-${Date.now()}@api.example.test`;
  const invited = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/staff`,
    { email, role: "technician" },
  );
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  expect(invited.body).toMatchObject({
    invited: true,
    email,
    role: "technician",
    emailed: false,
  });
  const token = /#\/msp\?invite=([A-Za-z0-9_-]{43})$/.exec(
    invited.body.inviteUrl,
  )?.[1];
  expect(token).toBeTruthy();
  const overview = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(
    overview.body.invites.map((i: { email: string; role: string }) => [
      i.email,
      i.role,
    ]),
  ).toEqual([[email, "technician"]]);

  // Inviting again is refused until the first one is cancelled.
  const again = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/staff`,
    { email, role: "admin" },
  );
  expect(again.status).toBe(400);
  expect(again.body.message).toContain("already invited");

  // The link alone isn't enough: another account can't use it.
  const stranger = await api.account("stranger");
  const wrong = await api.call(
    stranger,
    "POST",
    "/api/keykeeper/msp/invites/accept",
    { token },
  );
  expect(wrong.status).toBe(400);
  expect(wrong.body.message).toContain(`This invitation is for ${email}`);
  const strangerInfo = await api.call(
    stranger,
    "POST",
    "/api/keykeeper/msp/invites/info",
    { token },
  );
  expect(strangerInfo.body).toMatchObject({
    mspName: "Invite IT",
    role: "technician",
    forYou: false,
  });

  // They create an account with that address, set up an authenticator app
  // (the MSP requires two-step login of its staff), and accept.
  const hire = await api.account("new-hire", email);
  await api.giveAuthenticator(hire);
  const info = await api.call(hire, "POST", "/api/keykeeper/msp/invites/info", {
    token,
  });
  expect(info.body).toMatchObject({
    mspName: "Invite IT",
    email,
    invitedBy: admin.email,
    forYou: true,
  });
  const accepted = await api.call(
    hire,
    "POST",
    "/api/keykeeper/msp/invites/accept",
    { token },
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(accepted.body).toEqual({ mspId, role: "technician" });

  const after = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(after.body.invites).toEqual([]);
  expect(after.body.staff.map((s: { email: string }) => s.email)).toContain(
    email,
  );
  expect(
    (await api.members(admin, orgId)).find((m) => m.email === email)?.status,
  ).toBe(ACCEPTED);

  // A used link doesn't work again.
  expect(
    (
      await api.call(hire, "POST", "/api/keykeeper/msp/invites/accept", {
        token,
      })
    ).status,
  ).toBe(404);

  const events = (
    await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events?limit=3`)
  ).body.data;
  expect(
    events.map((e: { event: string; targetEmail: string }) => [
      e.event,
      e.targetEmail,
    ]),
  ).toEqual([
    ["staff_invite_accepted", email],
    ["staff_invited", email],
    ["client_created", null],
  ]);
});

test("a cancelled invitation stops working", async ({ request }) => {
  const api = new Api(request);
  const admin = await api.account("cancel-admin");
  const mspId = await api.msp(admin, "Cancel IT");
  const email = `cancelled-${Date.now()}@api.example.test`;
  const invited = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/staff`,
    { email, role: "admin" },
  );
  const token = invited.body.inviteUrl.split("invite=")[1];

  const cancelled = await api.call(
    admin,
    "DELETE",
    `/api/keykeeper/msp/${mspId}/invites/${invited.body.inviteId}`,
  );
  expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
  const hire = await api.account("cancelled-hire", email);
  const accept = await api.call(
    hire,
    "POST",
    "/api/keykeeper/msp/invites/accept",
    { token },
  );
  expect(accept.status).toBe(404);
  expect(accept.body.message).toContain("isn't valid anymore");
  const events = (
    await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events?limit=1`)
  ).body.data;
  expect(events[0]).toMatchObject({
    event: "staff_invite_cancelled",
    targetEmail: email,
  });
});

test("adding someone with an account invites them too, with the same answer as an address without one, and they join only by accepting", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("invite-admin");
  const mspId = await api.msp(admin, "Consent IT");
  await api.client(admin, mspId, "Consent Dental");
  const existing = await api.account("existing");
  const nobody = `nobody-${Date.now()}@api.example.test`;

  const shape = (body: Record<string, unknown>) => Object.keys(body).sort();
  const forExisting = await api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/staff`, {
    email: existing.email,
    role: "technician",
  });
  const forNobody = await api.call(admin, "POST", `/api/keykeeper/msp/${mspId}/staff`, {
    email: nobody,
    role: "technician",
  });
  expect(forExisting.status).toBe(200);
  expect(forNobody.status).toBe(200);
  expect(shape(forExisting.body)).toEqual(shape(forNobody.body));
  expect(forExisting.body.invited).toBe(true);

  // Not on the staff, and in no client, until they accept.
  const overview = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(overview.body.staff.map((s: { email: string }) => s.email)).not.toContain(existing.email);
  expect(await api.orgsOf(existing)).toEqual([]);
  const token = forExisting.body.inviteUrl.split("invite=")[1];
  const accepted = await api.call(existing, "POST", "/api/keykeeper/msp/invites/accept", { token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const after = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`);
  expect(after.body.staff.map((s: { email: string }) => s.email)).toContain(existing.email);
});

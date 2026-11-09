// Joining a Business client through the install command on a server that
// sends email, where account recovery is on: enrollment is part of the join.
// Here an invitation waits for the person instead of being accepted at once,
// so someone invited by email can join with the command instead.
import { expect, test } from "@playwright/test";

import { Api, encString } from "../api/support";

import { verifyEmail } from "./mailbox";

const INVITED = 0;
const ACCEPTED = 1;

test("joining a Business client through the install command enrolls the person in account recovery", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Recovery Join IT");
  const orgId = await api.client(admin, mspId, "Recovery Join Co", "business");
  const token = (
    await api.call(
      admin,
      "GET",
      `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
    )
  ).body.token;

  const person = await api.account("person");
  const info = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/info",
    { token },
  );
  expect(info.body).toMatchObject({
    organizationId: orgId,
    accountRecovery: true,
  });

  const withoutKey = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/join",
    { token },
  );
  expect(withoutKey.status).toBe(400);
  expect(withoutKey.body.message).toContain(
    "needs account recovery enrollment",
  );

  const joined = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/join",
    {
      token,
      resetPasswordKey: encString("person-recovery-key"),
    },
  );
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  await api.confirmPending(admin, mspId);

  const member = (await api.members(admin, orgId)).find(
    (m) => m.email === person.email,
  )!;
  const details = await api.call(
    admin,
    "GET",
    `/api/organizations/${orgId}/users/${member.id}/reset-password-details`,
  );
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  expect(details.body.resetPasswordKey).toBe(encString("person-recovery-key"));
});

test("someone invited with a narrower grant to Everyone keeps it when they join with the install command", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Invited Join IT");
  const orgId = await api.client(admin, mspId, "Invited Join Co", "business");
  const token = (
    await api.call(
      admin,
      "GET",
      `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
    )
  ).body.token;
  const collections = await api.call(
    admin,
    "GET",
    `/api/organizations/${orgId}/collections`,
  );
  const everyone = collections.body.data.find(
    (c: { name: string }) => c.name === encString("collection-Invited Join Co"),
  ).id;
  const grantIn = async (email: string) => {
    const memberId = (await api.members(admin, orgId)).find(
      (m) => m.email === email,
    )!.id;
    const details = await api.call(
      admin,
      "GET",
      `/api/organizations/${orgId}/collections/${everyone}/details`,
    );
    return details.body.users.find((u: { id: string }) => u.id === memberId);
  };
  const join = (person: { token: string }) =>
    api.call(person, "POST", "/api/keykeeper/enrollment/join", {
      token,
      resetPasswordKey: encString("recovery-key"),
    });

  // Invited by email with Can view there.
  const guest = await api.account("guest");
  await verifyEmail(api, guest);
  const invited = await api.call(
    admin,
    "POST",
    `/api/organizations/${orgId}/users/invite`,
    {
      emails: [guest.email],
      type: 2,
      collections: [
        { id: everyone, readOnly: true, hidePasswords: false, manage: false },
      ],
      groups: [],
      permissions: {},
    },
  );
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  expect(
    (await api.members(admin, orgId)).find((m) => m.email === guest.email)
      ?.status,
  ).toBe(INVITED);
  const before = await grantIn(guest.email);
  expect(before.keykeeper.edit).toBe(false);

  const joined = await join(guest);
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  expect(joined.body.status).toBe(ACCEPTED);
  // Still Can view, not the Can edit a join gives someone without a grant.
  expect(await grantIn(guest.email)).toEqual(before);

  const walkIn = await api.account("walk-in");
  await verifyEmail(api, walkIn);
  const walkedIn = await join(walkIn);
  expect(walkedIn.status, JSON.stringify(walkedIn.body)).toBe(200);
  const theirs = await grantIn(walkIn.email);
  expect([theirs.readOnly, theirs.hidePasswords, theirs.manage]).toEqual([
    false,
    false,
    false,
  ]);
  expect(theirs.keykeeper.edit).toBe(true);
});

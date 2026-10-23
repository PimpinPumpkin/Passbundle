// Joining a Business client through the install command on a server that
// sends email, where account recovery is on: enrollment is part of the join.
import { expect, test } from "@playwright/test";

import { Api, encString } from "../api/support";

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

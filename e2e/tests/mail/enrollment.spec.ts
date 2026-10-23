// Joining a Business client through the install command on a server that
// sends email. Account recovery starts off, in an MSP's defaults and so in its
// clients; once an MSP admin turns it on with automatic enrollment,
// enrollment is part of the join.
import { expect, test } from "@playwright/test";

import { Api, encString } from "../api/support";

const RESET_PASSWORD = 8;

test("account recovery starts off, and once an MSP admin turns it on, joining through the install command enrolls the person", async ({
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

  // This server sends email, so the MSP can turn account recovery on, but a
  // new MSP's default has it off, and so does a new client that follows it.
  const policies = async () =>
    (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/policies`))
      .body;
  const before = await policies();
  expect(before.types).toContain(RESET_PASSWORD);
  expect(
    before.defaults.find((p: { type: number }) => p.type === RESET_PASSWORD),
  ).toMatchObject({ enabled: false });
  expect(
    before.clients.find((c: { id: string }) => c.id === orgId).own,
  ).toEqual([]);

  const person = await api.account("person");
  const info = async () =>
    (
      await api.call(person, "POST", "/api/keykeeper/enrollment/info", {
        token,
      })
    ).body;
  expect(await info()).toMatchObject({
    organizationId: orgId,
    accountRecovery: false,
  });

  // The MSP admin turns it on as a default, with automatic enrollment, and
  // the client, which follows the default, gets it.
  const turnedOn = await api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/policies/${RESET_PASSWORD}`,
    { enabled: true, data: { autoEnrollEnabled: true } },
  );
  expect(turnedOn.status, JSON.stringify(turnedOn.body)).toBe(200);
  expect(turnedOn.body).toMatchObject({
    changed: [{ id: orgId }],
    kept: [],
    refused: [],
  });
  expect(await info()).toMatchObject({
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

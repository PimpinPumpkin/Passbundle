// Joining a client through the RMM install command's enrollment token. A join
// goes through the same checks as an emailed invite, never includes the org
// key, and waits for the MSP console to confirm it.
import { expect, test } from "@playwright/test";

import { Api, encString } from "./support";

const ACCEPTED = 1;
const CONFIRMED = 2;

async function setUp(api: Api, preset?: "business") {
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Enrollment IT");
  const orgId = await api.client(admin, mspId, "Enroll Co", preset);
  const enrollment = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
  );
  expect(enrollment.status, JSON.stringify(enrollment.body)).toBe(200);
  return { admin, mspId, orgId, token: enrollment.body.token as string };
}

test("someone with the install command's token joins a Business client, gets Everyone, and the console confirms them", async ({
  request,
}) => {
  const api = new Api(request);
  const { admin, mspId, orgId, token } = await setUp(api, "business");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const person = await api.account("person");
  const info = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/info",
    { token },
  );
  expect(info.status, JSON.stringify(info.body)).toBe(200);
  // A Business client starts without account recovery, and this test server
  // couldn't offer it anyway: it sends no email. The mail tests cover joining
  // with recovery.
  expect(info.body).toMatchObject({
    organizationId: orgId,
    organizationName: "Enroll Co",
    accountRecovery: false,
  });
  expect(info.body.publicKey).toBeTruthy();

  const joined = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/join",
    { token },
  );
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  expect(joined.body).toMatchObject({
    organizationId: orgId,
    status: ACCEPTED,
  });

  // Waiting for the org key: a join never includes it.
  expect(
    (await api.members(admin, orgId)).find((m) => m.email === person.email)
      ?.status,
  ).toBe(ACCEPTED);
  expect(await api.orgsOf(person)).toEqual([]);

  // The console confirms them, and they get the Everyone collection.
  expect(await api.confirmPending(admin, mspId)).toEqual([person.email]);
  expect(await api.orgsOf(person)).toEqual([orgId]);
  const collections = await api.call(person, "GET", "/api/collections");
  expect(
    collections.body.data.map(
      (c: { organizationId: string }) => c.organizationId,
    ),
  ).toEqual([orgId]);

  // Joining again is harmless, and the console counts one join.
  const again = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/join",
    { token },
  );
  expect(again.body.status).toBe(CONFIRMED);
  const enrollment = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
  );
  expect(enrollment.body.joins).toBe(1);
});

test("a replaced token stops working", async ({ request }) => {
  const api = new Api(request);
  const { admin, mspId, orgId, token } = await setUp(api, "business");
  const replaced = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
  );
  expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
  expect(replaced.body.token).not.toBe(token);

  const person = await api.account("person");
  const old = await api.call(person, "POST", "/api/keykeeper/enrollment/info", {
    token,
  });
  expect(old.status).toBe(404);
  expect(old.body.message).toContain("isn't valid anymore");
  const fresh = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/info",
    { token: replaced.body.token },
  );
  expect(fresh.status).toBe(200);
});

test("someone already in another organization can't join a Business client", async ({
  request,
}) => {
  const api = new Api(request);
  const { token } = await setUp(api, "business");
  const person = await api.account("person");
  await api.organization(person, "Their Family");

  const joined = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/join",
    {
      token,
      resetPasswordKey: encString("person-recovery-key"),
    },
  );
  expect(joined.status).toBe(400);
  expect(joined.body.message).toMatch(/policy forbids/);
});

test("a client without Business defaults needs no recovery key and adds no collection", async ({
  request,
}) => {
  const api = new Api(request);
  const { admin, mspId, orgId, token } = await setUp(api);
  const person = await api.account("person");

  const info = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/info",
    { token },
  );
  expect(info.body.accountRecovery).toBe(false);
  const joined = await api.call(
    person,
    "POST",
    "/api/keykeeper/enrollment/join",
    { token },
  );
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  await api.confirmPending(admin, mspId);
  expect(await api.orgsOf(person)).toEqual([orgId]);
  expect((await api.call(person, "GET", "/api/collections")).body.data).toEqual(
    [],
  );
});

test("unknown tokens and anonymous callers are refused", async ({
  request,
}) => {
  const api = new Api(request);
  const person = await api.account("person");
  const bogus = "A".repeat(43);
  expect(
    (
      await api.call(person, "POST", "/api/keykeeper/enrollment/info", {
        token: bogus,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api.call(person, "POST", "/api/keykeeper/enrollment/join", {
        token: bogus,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api.call(null, "POST", "/api/keykeeper/enrollment/info", {
        token: bogus,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await api.call(null, "POST", "/api/keykeeper/enrollment/join", {
        token: bogus,
      })
    ).status,
  ).toBe(401);
});

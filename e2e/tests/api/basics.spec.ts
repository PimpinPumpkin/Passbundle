// The API test client itself: accounts, logins, organizations, and members.
import { expect, test } from "@playwright/test";

import { Api } from "./support";

test("an account registers, logs in, and creates an organization with a confirmed member", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const member = await api.account("member");
  const orgId = await api.organization(owner, "Acme Dental");

  await api.addMember(owner, orgId, member, "user");

  const members = await api.call(
    owner,
    "GET",
    `/api/organizations/${orgId}/users`,
  );
  expect(
    members.body.data
      .map((m: { email: string; status: number }) => [m.email, m.status])
      .sort(),
  ).toEqual(
    [
      [owner.email, 2],
      [member.email, 2],
    ].sort(),
  );
  // The member sees the org in their profile.
  const profile = await api.call(member, "GET", "/api/accounts/profile");
  expect(profile.body.organizations.map((o: { id: string }) => o.id)).toEqual([
    orgId,
  ]);
});

test("the API refuses calls without a login", async ({ request }) => {
  const api = new Api(request);
  expect((await api.call(null, "GET", "/api/accounts/profile")).status).toBe(
    401,
  );
});

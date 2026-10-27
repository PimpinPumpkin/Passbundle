// A client's own members get its Templates collection, read-only, so they can
// use the MSP's templates and the MSP keeps them (DESIGN.md, "MSP templates").
import { expect, test } from "@playwright/test";

import { type Account, Api, encString } from "./support";

type Access = { id: string; readOnly: boolean; hidePasswords: boolean; manage: boolean };

test("a client's members get its Templates collection read-only, now and when they join, and nobody else's access changes", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Template Share IT");
  const orgId = await api.client(admin, mspId, "Share Dental");
  const token = (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`)).body
    .token as string;
  const joinAndConfirm = async (person: Account) => {
    const joined = await api.call(person, "POST", "/api/keykeeper/enrollment/join", { token });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(await api.confirmPending(admin, mspId)).toEqual([person.email]);
  };
  const memberId = async (person: Account) => (await api.members(admin, orgId)).find((m) => m.email === person.email)!.id;

  // Two members in before there are templates.
  const early = await api.account("early");
  await joinAndConfirm(early);
  const editor = await api.account("editor");
  await joinAndConfirm(editor);
  const tech = await api.account("tech");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);

  // The console has the server make the Templates collection: new and
  // empty, and both members get it read-only at once.
  const collection = await api.templatesCollection(admin, mspId, orgId);
  // An admin then lets one of them edit it.
  const shared = await api.call(admin, "PUT", `/api/organizations/${orgId}/users/${await memberId(editor)}`, {
    type: 2,
    collections: [{ id: collection, readOnly: false, hidePasswords: false, manage: false }],
    groups: [],
    permissions: {},
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  // Someone who joins afterward gets it once they're confirmed.
  const later = await api.account("later");
  const joined = await api.call(later, "POST", "/api/keykeeper/enrollment/join", { token });
  expect(joined.status).toBe(200);
  const users = async () =>
    (await api.call(admin, "GET", `/api/organizations/${orgId}/collections/${collection}/users`)).body as Access[];
  expect((await users()).map((u) => u.id)).not.toContain(await memberId(later));
  expect(await api.confirmPending(admin, mspId)).toEqual([later.email]);

  const access = new Map((await users()).map((u) => [u.id, u]));
  for (const person of [early, later]) {
    expect(access.get(await memberId(person)), person.email).toMatchObject({
      readOnly: true,
      hidePasswords: false,
      manage: false,
    });
  }
  // The edit access an admin gave stays; the MSP's people and the owner
  // reach it the way they did.
  expect(access.get(await memberId(editor))).toMatchObject({ readOnly: false });
  expect(access.has(await memberId(tech))).toBe(false);
  expect(access.has(await memberId(admin))).toBe(false);
  expect(access.size).toBe(3);

  // A member sees the MSP's copies there and can't change them.
  const copy = await api.orgItem(admin, orgId, collection);
  const seen = await api.call(early, "GET", `/api/ciphers/${copy}`);
  expect(seen.status, JSON.stringify(seen.body)).toBe(200);
  const edited = await api.call(early, "PUT", `/api/ciphers/${copy}`, {
    ...seen.body,
    notes: encString("changed by a member"),
  });
  expect(edited.status).not.toBe(200);
});

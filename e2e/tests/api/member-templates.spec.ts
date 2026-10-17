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

  // Two members in before there are templates; an admin lets one edit the
  // collection the console will use for them.
  const early = await api.account("early");
  await joinAndConfirm(early);
  const editor = await api.account("editor");
  await joinAndConfirm(editor);
  const tech = await api.account("tech");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);
  const collection = await api.collection(admin, orgId);
  const shared = await api.call(admin, "PUT", `/api/organizations/${orgId}/collections/${collection}`, {
    name: encString("templates"),
    groups: [],
    users: [{ id: await memberId(editor), readOnly: false, hidePasswords: false, manage: false }],
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);

  // The console records it as the Templates collection.
  const recorded = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/clients/${orgId}/templates-collection`, {
    collectionId: collection,
  });
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);

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

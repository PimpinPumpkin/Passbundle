// The MSP audit log: every MSP action, with who did it, to which client and
// person, newest first. Names and emails are copied in when it happens.
import { expect, test } from "@playwright/test";

import { Api } from "./support";

type Event = {
  date: string;
  event: string;
  actorEmail: string | null;
  organizationName: string | null;
  targetEmail: string | null;
  detail: string | null;
};

test("the audit log records each MSP action and who did it, newest first", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("audit-admin");
  const tech = await api.account("audit-tech");
  const person = await api.account("audit-person");
  const owner = await api.account("audit-owner");

  const mspId = await api.msp(admin, "Audit IT");
  const orgId = await api.client(admin, mspId, "Audit Dental", "business");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);
  await api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/staff/${tech.userId}`,
    { role: "admin" },
  );
  const replaced = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
  );
  await api.call(person, "POST", "/api/keykeeper/enrollment/join", {
    token: replaced.body.token,
  });
  await api.confirmPending(admin, mspId);
  await api.call(
    admin,
    "DELETE",
    `/api/keykeeper/msp/${mspId}/staff/${tech.userId}`,
  );
  await api.addMember(admin, orgId, owner, "owner");
  await api.call(owner, "DELETE", `/api/keykeeper/organizations/${orgId}/msp`);

  // The technician was removed, so read as the admin.
  const listed = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/events`,
  );
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const events: Event[] = listed.body.data;
  const summary = events.map((e) => [
    e.event,
    e.actorEmail,
    e.organizationName,
    e.targetEmail,
    e.detail,
  ]);
  expect(summary).toEqual(
    [
      ["msp_created", admin.email, null, null, "Audit IT"],
      [
        "client_created",
        admin.email,
        "Audit Dental",
        null,
        "Business defaults",
      ],
      ["staff_added", admin.email, null, tech.email, "technician"],
      ["member_confirmed", admin.email, "Audit Dental", tech.email, null],
      ["staff_role_changed", admin.email, null, tech.email, "admin"],
      ["install_token_replaced", admin.email, "Audit Dental", null, null],
      [
        "joined_with_install_command",
        person.email,
        "Audit Dental",
        person.email,
        null,
      ],
      ["member_confirmed", admin.email, "Audit Dental", person.email, null],
      ["staff_removed", admin.email, null, tech.email, null],
      // addMember confirms the owner through upstream's confirm.
      ["member_confirmed", admin.email, "Audit Dental", owner.email, null],
      ["client_removed_msp", owner.email, "Audit Dental", null, null],
    ].reverse(),
  );
  expect(
    events.every((e) => e.date && (e as unknown as { ip: string }).ip),
  ).toBe(true);

  // Pages, newest first, by the date of the oldest entry already shown.
  const first = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/events?limit=4`,
  );
  expect(first.body.data.map((e: Event) => e.event)).toEqual(
    events.slice(0, 4).map((e) => e.event),
  );
  const before = encodeURIComponent(first.body.data[3].date);
  const second = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/events?limit=4&before=${before}`,
  );
  expect(second.body.data.map((e: Event) => e.event)).toEqual(
    events.slice(4, 8).map((e) => e.event),
  );
  expect(
    (
      await api.call(
        admin,
        "GET",
        `/api/keykeeper/msp/${mspId}/events?before=yesterday`,
      )
    ).status,
  ).toBe(400);
});

test("a technician's console only gets members a technician may confirm", async ({
  request,
}) => {
  const api = new Api(request);
  const admin = await api.account("pending-admin");
  const tech = await api.account("pending-tech");
  const newTech = await api.account("pending-new-tech");
  const member = await api.account("pending-member");
  const mspId = await api.msp(admin, "Pending IT");
  const orgId = await api.client(admin, mspId, "Pending Co");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);

  // Another technician (an admin in the client) and a regular member are waiting.
  await api.addStaff(admin, mspId, newTech, "technician");
  await api.call(admin, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [member.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });

  // Upstream lets only owners confirm admins, so the technician gets just the member.
  const forTech = await api.call(
    tech,
    "GET",
    `/api/keykeeper/msp/${mspId}/pending`,
  );
  expect(forTech.body.data.map((p: { email: string }) => p.email)).toEqual([
    member.email,
  ]);
  expect(await api.confirmPending(tech, mspId)).toEqual([member.email]);
  const forAdmin = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/pending`,
  );
  expect(forAdmin.body.data.map((p: { email: string }) => p.email)).toEqual([
    newTech.email,
  ]);
});

// One person on the staff of two MSPs (DESIGN.md, "Several MSPs"). The server
// has always allowed it: staff are kept per MSP, and each client belongs to
// at most one MSP. Every console request names the MSP it works on, and gets
// only that MSP's clients, staff, waiting members, and activity, with the
// person's role there.
import { expect, test } from "@playwright/test";

import { Api } from "./support";

test("someone on two MSPs' staff sees each one apart, with their role in each, and nothing of one through the other", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const dana = await api.account("two-msps-dana");
  const contosoAdmin = await api.account("two-msps-contoso");
  const newcomer = await api.account("two-msps-newcomer");

  // Dana runs Northwind IT, and is a technician at Contoso IT.
  const northwind = await api.msp(dana, "Northwind IT");
  const acme = await api.client(dana, northwind, "Acme Dental");
  const contoso = await api.msp(contosoAdmin, "Contoso IT");
  const fabrikam = await api.client(contosoAdmin, contoso, "Fabrikam Law");
  await api.addStaff(contosoAdmin, contoso, dana, "technician");
  expect(await api.confirmPending(contosoAdmin, contoso)).toEqual([dana.email]);

  const listed = await api.call(dana, "GET", "/api/keykeeper/msp");
  expect(listed.status).toBe(200);
  expect(
    listed.body.data.map((m: { id: string; name: string; role: string }) => [m.id, m.name, m.role]).sort(),
  ).toEqual(
    [
      [northwind, "Northwind IT", "admin"],
      [contoso, "Contoso IT", "technician"],
    ].sort(),
  );

  // Each MSP, by its id: its own clients and staff, and Dana's role there.
  const seen = async (mspId: string) => {
    const result = await api.call(dana, "GET", `/api/keykeeper/msp/${mspId}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body as {
      role: string;
      clients: { id: string }[];
      staff: { email: string }[];
    };
  };
  const asNorthwind = await seen(northwind);
  expect(asNorthwind.role).toBe("admin");
  expect(asNorthwind.clients.map((c) => c.id)).toEqual([acme]);
  expect(asNorthwind.staff.map((s) => s.email)).toEqual([dana.email]);
  const asContoso = await seen(contoso);
  expect(asContoso.role).toBe("technician");
  expect(asContoso.clients.map((c) => c.id)).toEqual([fabrikam]);
  expect(asContoso.staff.map((s) => s.email).sort()).toEqual([contosoAdmin.email, dana.email].sort());

  // She's an owner in Northwind's client and an admin in Contoso's.
  const profile = await api.call(dana, "GET", "/api/accounts/profile");
  const typeIn = (orgId: string) =>
    profile.body.organizations.find((o: { id: string }) => o.id === orgId)?.type;
  expect(typeIn(acme)).toBe(0);
  expect(typeIn(fabrikam)).toBe(1);

  // Who's waiting, per MSP: someone joining Contoso's client never shows in Northwind's list.
  await api.addMember(contosoAdmin, fabrikam, newcomer, "user", { confirm: false });
  const waiting = async (mspId: string) =>
    (await api.call(dana, "GET", `/api/keykeeper/msp/${mspId}/pending`)).body.data.map(
      (p: { organizationId: string; email: string }) => [p.organizationId, p.email],
    );
  expect(await waiting(northwind)).toEqual([]);
  expect(await waiting(contoso)).toEqual([[fabrikam, newcomer.email]]);

  // What she may do follows her role in the MSP the request names.
  const added = await api.client(dana, northwind, "Baker Law");
  expect(added).toBeTruthy();
  const refused = await api.call(dana, "POST", `/api/keykeeper/msp/${contoso}/clients`, {
    name: "Not Hers",
    collectionName: "2.x|y|z",
    key: "2.x|y|z",
    keys: { publicKey: "AAAA", encryptedPrivateKey: "2.x|y|z" },
  });
  expect(refused.status).toBe(403);

  // Each MSP's activity is its own.
  const events = async (mspId: string) =>
    (await api.call(dana, "GET", `/api/keykeeper/msp/${mspId}/events`)).body.data.map(
      (e: { event: string; organizationName: string | null }) => [e.event, e.organizationName],
    );
  const northwindEvents = await events(northwind);
  expect(northwindEvents).toContainEqual(["client_created", "Baker Law"]);
  expect(JSON.stringify(northwindEvents)).not.toContain("Fabrikam");
  const contosoEvents = await events(contoso);
  expect(contosoEvents).toContainEqual(["client_created", "Fabrikam Law"]);
  expect(JSON.stringify(contosoEvents)).not.toContain("Acme Dental");
  expect(JSON.stringify(contosoEvents)).not.toContain("Baker Law");
});

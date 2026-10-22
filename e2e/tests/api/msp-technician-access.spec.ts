// Technician access: which clients a technician reaches, their role inside
// them (admin, or a custom role with or without vault items), and whether they
// see install commands. Every change applies to all of their clients at once
// and goes in the MSP's audit log; MSP admins stay owners of every client.
import { expect, test } from "@playwright/test";

import { type Account, Api } from "./support";

const OWNER = 0;
const ADMIN = 1;
const CUSTOM = 4;
const ACCEPTED = 1;
const CONFIRMED = 2;
const REVOKED = -1;

type Access = {
  allClients: boolean;
  clients: string[];
  custom: { permissions: Record<string, boolean>; vaultItems: boolean } | null;
  installCommands: boolean;
};

const EVERY_CLIENT: Access = {
  allClients: true,
  clients: [],
  custom: null,
  installCommands: true,
};

async function setAccess(
  api: Api,
  admin: Account,
  mspId: string,
  tech: Account,
  access: Access,
) {
  return api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/staff/${tech.userId}/access`,
    access,
  );
}

/** Someone's membership in a client, as the MSP admin (an owner there) sees it. */
async function memberIn(api: Api, admin: Account, orgId: string, who: Account) {
  return (await api.members(admin, orgId)).find((m) => m.email === who.email);
}

/**
 * What a client's own owners and admins are told one of the MSP's people can
 * do there (the MSP admin is an owner of every client, so asks for them).
 */
async function staffSeen(api: Api, admin: Account, orgId: string, who: Account) {
  const seen = await api.call(
    admin,
    "GET",
    `/api/keykeeper/organizations/${orgId}/msp`,
  );
  expect(seen.status).toBe(200);
  return seen.body.staff.find((s: { email: string }) => s.email === who.email);
}

/** How many of a client's collections someone gets in their own vault. */
async function collectionsSeen(api: Api, who: Account, orgId: string) {
  const sync = await api.call(who, "GET", "/api/sync?excludeDomains=true");
  expect(sync.status).toBe(200);
  return sync.body.collections.filter(
    (c: { organizationId: string }) => c.organizationId === orgId,
  ).length;
}

test("a technician limited to chosen clients is taken out of the others at once, and new clients reach only technicians with every client", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const everywhere = await api.account("tech-everywhere");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental");
  const law = await api.client(admin, mspId, "Baker Law");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.addStaff(admin, mspId, everywhere, "technician");
  await api.confirmPending(admin, mspId);
  expect(await memberIn(api, admin, law, tech)).toMatchObject({
    status: CONFIRMED,
    type: ADMIN,
  });

  const limited = await setAccess(api, admin, mspId, tech, {
    ...EVERY_CLIENT,
    allClients: false,
    clients: [dental],
  });
  expect(limited.status, JSON.stringify(limited.body)).toBe(200);
  expect(limited.body).toMatchObject({ allClients: false, clients: [dental] });
  expect(await memberIn(api, admin, law, tech)).toBeUndefined();
  expect(await memberIn(api, admin, dental, tech)).toMatchObject({
    status: CONFIRMED,
    type: ADMIN,
  });
  expect(await api.orgsOf(tech)).toEqual([dental]);

  // Their console shows only that client, and its install command.
  const overview = (await api.call(tech, "GET", `/api/keykeeper/msp/${mspId}`))
    .body;
  expect(overview.clients.map((c: { id: string }) => c.id)).toEqual([dental]);
  expect(overview.access).toMatchObject({
    allClients: false,
    clients: [dental],
  });
  // Only MSP admins see each technician's access.
  expect(
    overview.staff.every((s: { access: unknown }) => s.access === null),
  ).toBe(true);
  const enrollment = (orgId: string) =>
    api.call(
      tech,
      "GET",
      `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
    );
  expect((await enrollment(dental)).status).toBe(200);
  expect((await enrollment(law)).status).toBe(404);

  // A new client reaches technicians with every client, not this one.
  const contoso = await api.client(admin, mspId, "Contoso Clinic");
  expect(await memberIn(api, admin, contoso, everywhere)).toMatchObject({
    status: ACCEPTED,
    type: ADMIN,
  });
  expect(await memberIn(api, admin, contoso, tech)).toBeUndefined();

  // The audit log records the change; this technician's copy leaves out
  // clients they don't reach.
  const events = async (who: Account) =>
    (await api.call(who, "GET", `/api/keykeeper/msp/${mspId}/events`)).body
      .data as {
      event: string;
      organizationName: string | null;
      targetEmail: string | null;
      detail: string | null;
    }[];
  const changed = (await events(admin)).find(
    (e) => e.event === "staff_access_changed",
  );
  expect(changed).toMatchObject({
    targetEmail: tech.email,
    detail: "Acme Dental, as admin, install commands",
  });
  const theirs = await events(tech);
  expect(theirs.some((e) => e.event === "staff_access_changed")).toBe(true);
  expect(
    new Set(
      theirs.map((e) => e.organizationName).filter((name) => name != null),
    ),
  ).toEqual(new Set(["Acme Dental"]));
  expect(
    (await events(admin)).some((e) => e.organizationName === "Contoso Clinic"),
  ).toBe(true);

  // Back to every client: they join the others, waiting for the org key.
  expect((await setAccess(api, admin, mspId, tech, EVERY_CLIENT)).status).toBe(
    200,
  );
  for (const orgId of [law, contoso]) {
    expect(await memberIn(api, admin, orgId, tech)).toMatchObject({
      status: ACCEPTED,
      type: ADMIN,
    });
  }
  expect(await memberIn(api, admin, dental, tech)).toMatchObject({
    status: CONFIRMED,
  });
});

test("a technician with a custom role acts only within it, sees vault items only when given them, and gets no install commands when they're off", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("helpdesk");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const helpdesk: Access = {
    allClients: true,
    clients: [],
    custom: {
      permissions: { manageUsers: true, manageResetPassword: true },
      vaultItems: false,
    },
    installCommands: false,
  };

  // Access chosen when adding them applies from the start.
  await api.addStaff(admin, mspId, tech, "technician", helpdesk);
  expect(await memberIn(api, admin, dental, tech)).toMatchObject({
    status: ACCEPTED,
    type: CUSTOM,
  });
  await api.confirmPending(admin, mspId);
  const listed = (
    await api.call(admin, "GET", `/api/organizations/${dental}/users`)
  ).body.data.find((m: { email: string }) => m.email === tech.email);
  expect(listed).toMatchObject({ status: CONFIRMED, type: CUSTOM });
  expect(listed.permissions).toMatchObject({
    manageUsers: true,
    manageResetPassword: true,
    managePolicies: false,
  });
  // The client's owners see the role, its permissions, and no vault items.
  expect(await staffSeen(api, admin, dental, tech)).toMatchObject({
    role: "custom",
    permissions: ["manageUsers", "manageResetPassword"],
    vaultItems: false,
  });
  expect(await staffSeen(api, admin, dental, admin)).toMatchObject({
    role: "owner",
    permissions: [],
    vaultItems: true,
  });

  // Their role reaches members, not policies; no install commands; no items.
  expect(
    (await api.call(tech, "GET", `/api/organizations/${dental}/users`)).status,
  ).toBe(200);
  expect(
    (await api.call(tech, "GET", `/api/organizations/${dental}/policies`))
      .status,
  ).toBe(403);
  expect(
    (
      await api.call(
        tech,
        "GET",
        `/api/keykeeper/msp/${mspId}/clients/${dental}/enrollment`,
      )
    ).status,
  ).toBe(403);
  expect(await collectionsSeen(api, tech, dental)).toBe(0);

  // With vault items, they see every collection in their own vault, but the
  // apps don't offer them collection management, which custom roles can't do.
  expect(
    (
      await setAccess(api, admin, mspId, tech, {
        ...helpdesk,
        custom: { ...helpdesk.custom!, vaultItems: true },
      })
    ).status,
  ).toBe(200);
  expect(await collectionsSeen(api, tech, dental)).toBe(2);
  expect(await staffSeen(api, admin, dental, tech)).toMatchObject({
    role: "custom",
    vaultItems: true,
  });
  const org = (
    await api.call(tech, "GET", "/api/accounts/profile")
  ).body.organizations.find((o: { id: string }) => o.id === dental);
  expect(org.type).toBe(CUSTOM);
  expect(org.permissions).toMatchObject({
    manageUsers: true,
    editAnyCollection: false,
    createNewCollections: false,
    deleteAnyCollection: false,
  });

  // Made an MSP admin, they're an owner with no custom role; made a
  // technician again, their stored access comes back.
  const role = (r: string) =>
    api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/staff/${tech.userId}`, {
      role: r,
    });
  expect((await role("admin")).status).toBe(200);
  expect(await memberIn(api, admin, dental, tech)).toMatchObject({
    status: CONFIRMED,
    type: OWNER,
  });
  expect((await role("technician")).status).toBe(200);
  expect(await memberIn(api, admin, dental, tech)).toMatchObject({
    status: CONFIRMED,
    type: CUSTOM,
  });
});

test("an invitation carries a technician's access, and access is checked", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental");
  const law = await api.client(admin, mspId, "Baker Law");

  // Someone without an account yet, invited for one client only.
  const email = `new-tech-${Date.now()}@api.example.test`;
  const onlyLaw: Access = {
    ...EVERY_CLIENT,
    allClients: false,
    clients: [law],
    installCommands: false,
  };
  const invited = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/staff`,
    {
      email,
      role: "technician",
      access: onlyLaw,
    },
  );
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  expect(invited.body.invited).toBe(true);
  const listedInvite = (
    await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`)
  ).body.invites.find((i: { email: string }) => i.email === email);
  expect(listedInvite.access).toMatchObject({
    allClients: false,
    clients: [law],
  });

  const newcomer = await api.account("new-tech", email);
  const token = new URL(invited.body.inviteUrl).hash.split("invite=")[1];
  const accepted = await api.call(
    newcomer,
    "POST",
    "/api/keykeeper/msp/invites/accept",
    { token },
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(await memberIn(api, admin, law, newcomer)).toMatchObject({
    type: ADMIN,
  });
  expect(await memberIn(api, admin, dental, newcomer)).toBeUndefined();
  expect(await staffSeen(api, admin, law, newcomer)).toMatchObject({
    role: "admin",
    permissions: [],
    vaultItems: true,
  });

  // Clients must be the MSP's own, and a custom role needs a permission.
  const other = await api.account("other-msp-admin");
  const otherMsp = await api.msp(other, "Other IT");
  const theirClient = await api.client(other, otherMsp, "Not Yours Inc");
  const refused = async (access: Access, message: RegExp) => {
    const result = await setAccess(api, admin, mspId, newcomer, access);
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect(result.body.message).toMatch(message);
  };
  await refused(
    { ...onlyLaw, clients: [law, theirClient] },
    /Client not found/,
  );
  await refused(
    { ...onlyLaw, custom: { permissions: {}, vaultItems: true } },
    /at least one permission/,
  );
  const result = await api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/staff/${admin.userId}/access`,
    onlyLaw,
  );
  expect(result.status).toBe(400);
  expect(result.body.message).toMatch(/owners of every client/);
  expect(await memberIn(api, admin, law, newcomer)).toBeDefined();
  expect(await memberIn(api, other, theirClient, newcomer)).toBeUndefined();
});

test("a technician with a custom role works in every Business client: single organization leaves MSP staff alone, and two-step login applies to them", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("helpdesk");
  const member = await api.account("dental-member");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const law = await api.client(admin, mspId, "Baker Law", "business");

  // A custom role makes them a regular member in each client, and both
  // clients have single organization on. Staff are exempt, as admins are.
  await api.addStaff(admin, mspId, tech, "technician", {
        allClients: true,
        clients: [],
        custom: { permissions: { manageUsers: true }, vaultItems: false },
        installCommands: true,
      });
  // One membership waiting in each client, both confirmed.
  expect(await api.confirmPending(admin, mspId)).toEqual([
    tech.email,
    tech.email,
  ]);
  for (const org of [dental, law]) {
    expect(await memberIn(api, admin, org, tech)).toMatchObject({
      status: CONFIRMED,
      type: CUSTOM,
    });
  }

  // Turning on two-step login revokes the client's own members without it,
  // and the technician without it too: staff follow a client's two-step
  // policy. Turning on single organization again revokes members of other
  // organizations, but not the technician.
  await api.addMember(admin, dental, member, "user");
  const policy = async (orgId: string, type: number) => {
    const result = await api.call(
      admin,
      "PUT",
      `/api/organizations/${orgId}/policies/${type}`,
      {
        policy: { enabled: true, data: null },
      },
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  };
  await policy(dental, 0);
  await policy(law, 3);
  for (const who of [member, tech]) {
    expect(await memberIn(api, admin, dental, who)).toMatchObject({
      status: REVOKED,
    });
  }
  expect(await memberIn(api, admin, law, tech)).toMatchObject({
    status: CONFIRMED,
  });

  // They still work in the other client.
  expect(
    (await api.call(tech, "GET", `/api/organizations/${law}/users`)).status,
  ).toBe(200);
});

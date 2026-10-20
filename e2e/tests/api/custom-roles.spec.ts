// Custom roles: a regular member plus permissions, which the server enforces
// for exactly the endpoints those permissions cover. A custom member acts as an
// admin, but only on regular members, and can't grant more than that.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api, encString } from "./support";

const ACTORS = [
  "owner",
  "admin",
  "manageUsers",
  "manageResetPassword",
  "managePolicies",
  "accessEventLogs",
  "accessImportExport",
  "user",
  "stranger",
  "anonymous",
] as const;
type Actor = (typeof ACTORS)[number];
type Context = { api: Api; orgId: string; owner: Account };
type Row = MatrixRow<Actor, Context>;

const ADMINS: Actor[] = ["owner", "admin"];

async function members(ctx: Context) {
  return ctx.api.members(ctx.owner, ctx.orgId);
}

/** A regular member to act on, fresh for each call. */
async function regularMember(ctx: Context) {
  return ctx.api.addMember(
    ctx.owner,
    ctx.orgId,
    await ctx.api.account("regular"),
    "user",
  );
}

const rows: Row[] = [
  {
    name: "list members",
    allowed: [...ADMINS, "manageUsers", "manageResetPassword"],
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/users`,
    }),
  },
  {
    // The Members page loads it for its Collections column, so whoever can
    // open that page can read it.
    name: "list collections",
    allowed: [...ADMINS, "manageUsers", "manageResetPassword"],
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/collections`,
    }),
  },
  {
    // The member dialogs and the import page load it. It lists only the
    // collections a member without access to all items is assigned to.
    name: "list the collections a member can use",
    allowed: [...ADMINS, "manageUsers", "accessImportExport"],
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/collections/details`,
    }),
  },
  {
    name: "invite a regular member",
    allowed: [...ADMINS, "manageUsers"],
    request: async (ctx) => {
      const email = `invitee-${randomUUID().slice(0, 8)}@api.example.test`;
      return {
        method: "POST",
        path: `/api/organizations/${ctx.orgId}/users/invite`,
        data: {
          emails: [email],
          type: 2,
          collections: [],
          groups: [],
          permissions: {},
        },
        check: async (allowed) =>
          expect((await members(ctx)).some((m) => m.email === email)).toBe(
            allowed,
          ),
      };
    },
  },
  {
    name: "confirm a regular member",
    allowed: [...ADMINS, "manageUsers"],
    request: async (ctx) => {
      const pending = await ctx.api.account("pending");
      await ctx.api.call(
        ctx.owner,
        "POST",
        `/api/organizations/${ctx.orgId}/users/invite`,
        {
          emails: [pending.email],
          type: 2,
          collections: [],
          groups: [],
          permissions: {},
        },
      );
      const id = (await members(ctx)).find(
        (m) => m.email === pending.email,
      )!.id;
      return {
        method: "POST",
        path: `/api/organizations/${ctx.orgId}/users/${id}/confirm`,
        data: { key: encString("org-key") },
        check: async (allowed) =>
          expect((await members(ctx)).find((m) => m.id === id)!.status).toBe(
            allowed ? 2 : 1,
          ),
      };
    },
  },
  {
    name: "remove a regular member",
    allowed: [...ADMINS, "manageUsers"],
    request: async (ctx) => {
      const id = await regularMember(ctx);
      return {
        method: "DELETE",
        path: `/api/organizations/${ctx.orgId}/users/${id}`,
        check: async (allowed) =>
          expect((await members(ctx)).some((m) => m.id === id)).toBe(!allowed),
      };
    },
  },
  {
    name: "revoke a regular member",
    allowed: [...ADMINS, "manageUsers"],
    request: async (ctx) => {
      const id = await regularMember(ctx);
      return {
        method: "PUT",
        path: `/api/organizations/${ctx.orgId}/users/${id}/revoke`,
        check: async (allowed) =>
          expect(
            (await members(ctx)).find((m) => m.id === id)!.status < 0,
          ).toBe(allowed),
      };
    },
  },
  {
    name: "see policies",
    allowed: [...ADMINS, "managePolicies"],
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/policies`,
    }),
  },
  {
    name: "turn on a policy",
    allowed: [...ADMINS, "managePolicies"],
    request: async (ctx) => {
      const path = `/api/organizations/${ctx.orgId}/policies/6`;
      await ctx.api.call(ctx.owner, "PUT", path, {
        policy: { enabled: false, data: null },
      });
      return {
        method: "PUT",
        path,
        data: { policy: { enabled: true, data: null } },
        check: async (allowed) => {
          const listed = await ctx.api.call(
            ctx.owner,
            "GET",
            `/api/organizations/${ctx.orgId}/policies`,
          );
          expect(
            listed.body.data.find((p: { type: number }) => p.type === 6)
              ?.enabled === true,
          ).toBe(allowed);
        },
      };
    },
  },
  {
    name: "read the event log",
    allowed: [...ADMINS, "accessEventLogs"],
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/events?start=2020-01-01T00:00:00.000Z&end=2035-01-01T00:00:00.000Z`,
    }),
  },
  {
    // The export holds every item, and a client's own custom roles can't
    // have access to all items yet.
    name: "export the organization's vault",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/export`,
    }),
  },
  {
    // The admin console's Vault tab loads its items and groups. No custom
    // permission covers them, so custom roles never show as managing
    // collections, which would open that tab and sign them out.
    name: "load the organization's items for the admin console",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/ciphers/organization-details?organizationId=${orgId}`,
    }),
  },
  {
    name: "list groups",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/groups`,
    }),
  },
  {
    // Not covered by any custom permission: still admins only.
    name: "create a collection",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "POST",
      path: `/api/organizations/${orgId}/collections`,
      data: { name: encString("collection"), groups: [], users: [] },
    }),
  },
  {
    name: "rename the organization",
    allowed: ["owner"],
    request: async ({ orgId, owner }) => ({
      method: "PUT",
      path: `/api/organizations/${orgId}`,
      data: { name: "Custom Roles Org", billingEmail: owner.email },
    }),
  },
];

test.describe("Custom role permissions", () => {
  permissionMatrix(
    ACTORS,
    async (api) => {
      const owner = await api.account("owner");
      const orgId = await api.organization(owner, "Custom Roles Org");
      const callers = {
        owner,
        stranger: await api.account("stranger"),
        anonymous: null,
      } as Record<Actor, Account | null>;
      callers.admin = await api.account("admin");
      await api.addMember(owner, orgId, callers.admin!, "admin");
      callers.user = await api.account("user");
      await api.addMember(owner, orgId, callers.user!, "user");
      for (const permission of [
        "manageUsers",
        "manageResetPassword",
        "managePolicies",
        "accessEventLogs",
        "accessImportExport",
      ] as const) {
        callers[permission] = await api.account(permission);
        await api.addCustomMember(owner, orgId, callers[permission]!, {
          [permission]: true,
        });
      }
      return { ctx: { api, orgId, owner }, callers };
    },
    rows,
  );
});

test("a manage-users member can read the collection lists the Members page and member dialog load, and no more", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Collections Org");
  const created = await api.call(
    owner,
    "POST",
    `/api/organizations/${orgId}/collections`,
    { name: encString("Front desk"), groups: [], users: [] },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const poc = await api.account("poc");
  await api.addCustomMember(owner, orgId, poc, { manageUsers: true });

  const listed = await api.call(
    poc,
    "GET",
    `/api/organizations/${orgId}/collections`,
  );
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(listed.body.data.map((c: { id: string }) => c.id)).toContain(
    created.body.id,
  );

  // The dialog's list, with who has access, covers only their own collections.
  const details = await api.call(
    poc,
    "GET",
    `/api/organizations/${orgId}/collections/details`,
  );
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  expect(details.body.data).toEqual([]);
  const ownerDetails = await api.call(
    owner,
    "GET",
    `/api/organizations/${orgId}/collections/details`,
  );
  expect(
    ownerDetails.body.data.map((c: { id: string }) => c.id),
  ).toContain(created.body.id);
});

test("a custom member is refused with 403 where their role doesn't reach, and a logged-out caller still gets 401", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Forbidden Org");
  const collection = await api.call(
    owner,
    "POST",
    `/api/organizations/${orgId}/collections`,
    { name: encString("Admins"), groups: [], users: [] },
  );
  expect(collection.status, JSON.stringify(collection.body)).toBe(200);
  const poc = await api.account("poc");
  await api.addCustomMember(owner, orgId, poc, { manageUsers: true });

  // One endpoint behind each guard a custom member can be turned away by.
  const uncovered: [string, "GET" | "POST" | "PUT", string, unknown?][] = [
    ["admin", "GET", `/api/organizations/${orgId}/policies`],
    [
      "manager",
      "GET",
      `/api/organizations/${orgId}/collections/${collection.body.id}/details`,
    ],
    [
      "manager, no collection",
      "POST",
      `/api/organizations/${orgId}/collections`,
      { name: encString("Not yours"), groups: [], users: [] },
    ],
    [
      "owner",
      "PUT",
      `/api/organizations/${orgId}`,
      { name: "Renamed", billingEmail: owner.email },
    ],
  ];
  for (const [guard, method, path, data] of uncovered) {
    const forbidden = await api.call(poc, method, path, data);
    expect(forbidden.status, `${guard}: ${JSON.stringify(forbidden.body)}`).toBe(
      403,
    );
    const anonymous = await api.call(null, method, path, data);
    expect(anonymous.status, `${guard}, logged out`).toBe(401);
  }

  // Nothing changed.
  const collections = await api.call(
    owner,
    "GET",
    `/api/organizations/${orgId}/collections`,
  );
  expect(
    collections.body.data.filter(
      (c: { name: string }) => c.name === encString("Not yours"),
    ),
  ).toEqual([]);
  const profile = await api.call(owner, "GET", "/api/accounts/profile");
  expect(
    profile.body.organizations.find((o: { id: string }) => o.id === orgId)
      .name,
  ).toBe("Forbidden Org");
});

test("a custom member who manages members can't reach beyond regular members or grant more", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Escalation Org");
  const poc = await api.account("poc");
  const pocId = await api.addCustomMember(owner, orgId, poc, {
    manageUsers: true,
  });
  const admin = await api.account("admin");
  const adminId = await api.addMember(owner, orgId, admin, "admin");
  const other = await api.account("other-custom");
  const otherId = await api.addCustomMember(owner, orgId, other, {
    managePolicies: true,
  });
  const regular = await api.account("regular");
  const regularId = await api.addMember(owner, orgId, regular, "user");
  const refusedWith =
    (message: RegExp) =>
    (result: { status: number; body: { message?: string } }) => {
      expect(result.status, JSON.stringify(result.body)).toBe(400);
      expect(result.body.message).toMatch(message);
    };
  const regularOnly = refusedWith(/only manage regular members|own membership/);
  const regularGrant = refusedWith(/only add regular members|Only Owners/);
  const edit = (id: string, data: Record<string, unknown>) =>
    api.call(poc, "PUT", `/api/organizations/${orgId}/users/${id}`, {
      collections: [],
      groups: [],
      permissions: {},
      ...data,
    });

  // Not themselves, not admins, not other custom members.
  regularOnly(await edit(pocId, { type: 2 }));
  regularOnly(await edit(adminId, { type: 2 }));
  regularOnly(await edit(otherId, { type: 2 }));
  regularOnly(
    await api.call(
      poc,
      "DELETE",
      `/api/organizations/${orgId}/users/${adminId}`,
    ),
  );
  regularOnly(
    await api.call(
      poc,
      "DELETE",
      `/api/organizations/${orgId}/users/${otherId}`,
    ),
  );
  regularOnly(
    await api.call(
      poc,
      "PUT",
      `/api/organizations/${orgId}/users/${adminId}/revoke`,
    ),
  );
  regularOnly(
    await api.call(
      poc,
      "PUT",
      `/api/organizations/${orgId}/users/${otherId}/revoke`,
    ),
  );

  // No promotions, no custom roles, no access to all items.
  regularGrant(await edit(regularId, { type: 1 }));
  regularGrant(
    await edit(regularId, { type: 4, permissions: { manageUsers: true } }),
  );
  const invite = (data: Record<string, unknown>) =>
    api.call(poc, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [`x-${randomUUID().slice(0, 8)}@api.example.test`],
      collections: [],
      groups: [],
      permissions: {},
      ...data,
    });
  regularGrant(await invite({ type: 1 }));
  regularGrant(await invite({ type: 0 }));
  regularGrant(
    await invite({ type: 4, permissions: { managePolicies: true } }),
  );
  regularGrant(
    await invite({
      type: 4,
      permissions: {
        createNewCollections: true,
        editAnyCollection: true,
        deleteAnyCollection: true,
      },
    }),
  );

  // Nothing changed for anyone.
  const after = await api.members(owner, orgId);
  const typeOf = (id: string) => after.find((m) => m.id === id)?.type;
  expect([
    typeOf(pocId),
    typeOf(adminId),
    typeOf(otherId),
    typeOf(regularId),
  ]).toEqual([4, 1, 4, 2]);
  expect(after.every((m) => m.status === 2)).toBe(true);

  // A regular member is fair game.
  const ok = await edit(regularId, { type: 2 });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
});

test("a custom role can't also manage all collections, while upstream's Custom with only those still can", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "All Collections Org");
  const admin = await api.account("admin");
  await api.addMember(owner, orgId, admin, "admin");
  const allCollections = {
    createNewCollections: true,
    editAnyCollection: true,
    deleteAnyCollection: true,
  };
  const refused = (result: { status: number; body: { message?: string } }) => {
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect(result.body.message).toMatch(/can't also manage all collections/);
  };

  // Owners and admins can't invite someone with both, and any one of the
  // collection permissions is enough to refuse it.
  const invite = (by: Account, permissions: Record<string, boolean>) => {
    const email = `both-${randomUUID().slice(0, 8)}@api.example.test`;
    return api.call(by, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [email],
      type: 4,
      collections: [],
      groups: [],
      permissions,
    });
  };
  refused(await invite(owner, { manageUsers: true, ...allCollections }));
  refused(await invite(admin, { manageUsers: true, ...allCollections }));
  refused(
    await invite(owner, { managePolicies: true, editAnyCollection: true }),
  );
  refused(
    await invite(owner, { accessEventLogs: true, createNewCollections: true }),
  );

  // Nor edit a custom member or a regular member into both.
  const poc = await api.account("poc");
  const pocId = await api.addCustomMember(owner, orgId, poc, {
    manageUsers: true,
  });
  const regular = await api.account("regular");
  const regularId = await api.addMember(owner, orgId, regular, "user");
  for (const id of [pocId, regularId]) {
    refused(
      await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${id}`, {
        type: 4,
        collections: [],
        groups: [],
        permissions: { manageUsers: true, ...allCollections },
      }),
    );
  }

  // Nobody new joined, and nothing changed for anyone.
  const after = await api.members(owner, orgId);
  expect(after.filter((m) => m.email.startsWith("both-"))).toEqual([]);
  const pocListed = after.find((m) => m.id === pocId) as unknown as {
    type: number;
    permissions: Record<string, boolean>;
  };
  expect(pocListed.type).toBe(4);
  expect(pocListed.permissions).toMatchObject({
    manageUsers: true,
    editAnyCollection: false,
  });
  expect(after.find((m) => m.id === regularId)!.type).toBe(2);

  // A custom member's own view never shows collection management, so the
  // apps don't offer them the admin console's collection tools.
  const org = (
    await api.call(poc, "GET", "/api/accounts/profile")
  ).body.organizations.find((o: { id: string }) => o.id === orgId);
  expect(org.permissions).toMatchObject({
    manageUsers: true,
    createNewCollections: false,
    editAnyCollection: false,
    deleteAnyCollection: false,
  });

  // Upstream's Custom with only the collection permissions is still a
  // manager of every collection, and can load the admin console's Vault tab.
  const manager = await api.account("manager");
  const managerId = await api.addCustomMember(
    owner,
    orgId,
    manager,
    allCollections,
  );
  const managerListed = (
    await api.call(owner, "GET", `/api/organizations/${orgId}/users`)
  ).body.data.find((m: { id: string }) => m.id === managerId);
  expect(managerListed.type).toBe(4);
  expect(managerListed.permissions).toMatchObject({
    ...allCollections,
    manageUsers: false,
  });
  for (const path of [
    `/api/ciphers/organization-details?organizationId=${orgId}`,
    `/api/organizations/${orgId}/groups`,
  ]) {
    const loaded = await api.call(manager, "GET", path);
    expect(loaded.status, `${path}: ${JSON.stringify(loaded.body)}`).toBe(200);
  }
});

test("owners and admins assign custom roles, and clients see them as Custom with their permissions", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Assign Org");
  const admin = await api.account("admin");
  await api.addMember(owner, orgId, admin, "admin");

  // An admin (an MSP technician, say) makes a client's point of contact.
  const poc = await api.account("poc");
  const pocId = await api.addCustomMember(admin, orgId, poc, {
    manageUsers: true,
    managePolicies: true,
  });
  const listed = (
    await api.call(owner, "GET", `/api/organizations/${orgId}/users`)
  ).body.data.find((m: { id: string }) => m.id === pocId);
  expect(listed.type).toBe(4);
  expect(listed.permissions).toMatchObject({
    manageUsers: true,
    managePolicies: true,
    manageResetPassword: false,
  });

  // Their own view of the organization drives what the apps show them.
  const profile = await api.call(poc, "GET", "/api/accounts/profile");
  const org = profile.body.organizations.find(
    (o: { id: string }) => o.id === orgId,
  );
  expect(org.type).toBe(4);
  expect(org.permissions).toMatchObject({
    manageUsers: true,
    managePolicies: true,
    accessEventLogs: false,
  });

  // Editing them into a regular member takes the permissions away, everywhere.
  const edited = await api.call(
    owner,
    "PUT",
    `/api/organizations/${orgId}/users/${pocId}`,
    {
      type: 2,
      collections: [],
      groups: [],
      permissions: {},
    },
  );
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  expect(
    (await api.call(poc, "GET", `/api/organizations/${orgId}/policies`)).status,
  ).toBe(401);
  const after = (await api.call(poc, "GET", "/api/accounts/profile")).body
    .organizations[0];
  expect(after.type).toBe(2);
});

test("a manage-users member gives others only collections it can reach, with no more than its own access, and never the right to manage them", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Grants Org");
  const reachable = await api.collection(owner, orgId);
  const readOnly = await api.collection(owner, orgId);
  const elsewhere = await api.collection(owner, orgId);
  const poc = await api.account("poc");
  const pocId = await api.addCustomMember(owner, orgId, poc, { manageUsers: true });
  // The owner gives the point of contact two collections, one read-only.
  const assigned = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${pocId}`, {
    type: 4,
    permissions: { manageUsers: true },
    collections: [
      { id: reachable, readOnly: false, hidePasswords: false, manage: false },
      { id: readOnly, readOnly: true, hidePasswords: false, manage: false },
    ],
    groups: [],
  });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

  const invite = (collection: string, rights: { readOnly?: boolean; manage?: boolean }) =>
    api.call(poc, "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [`newcomer-${randomUUID().slice(0, 8)}@api.example.test`],
      type: 2,
      collections: [{ id: collection, readOnly: false, hidePasswords: false, manage: false, ...rights }],
      groups: [],
      permissions: {},
    });
  for (const [collection, rights, message] of [
    [elsewhere, {}, /collections it can reach/],
    [reachable, { manage: true }, /right to manage/],
    [readOnly, {}, /more access to a collection than it has/],
  ] as const) {
    const refused = await invite(collection, rights);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.message).toMatch(message);
  }
  expect((await invite(reachable, {})).status).toBe(200);
  expect((await invite(readOnly, { readOnly: true })).status).toBe(200);

  // Editing someone, it changes only what it reaches: their other
  // collections stay as they were.
  const member = await api.account("member");
  const memberId = await api.addMember(owner, orgId, member, "user");
  const given = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
    type: 2,
    collections: [{ id: elsewhere, readOnly: false, hidePasswords: false, manage: false }],
    groups: [],
  });
  expect(given.status, JSON.stringify(given.body)).toBe(200);
  const edited = await api.call(poc, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
    type: 2,
    collections: [{ id: reachable, readOnly: false, hidePasswords: false, manage: false }],
    groups: [],
  });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  const details = await api.call(owner, "GET", `/api/organizations/${orgId}/users/${memberId}?includeCollections=true`);
  const ids = details.body.collections.map((c: { id: string }) => c.id).sort();
  expect(ids).toEqual([reachable, elsewhere].sort());
});

test("a custom role with import and export can't export the vault, which holds every item, without access to all items", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Export Org");
  await api.collection(owner, orgId);
  const exporter = await api.account("exporter");
  await api.addCustomMember(owner, orgId, exporter, { accessImportExport: true });
  const refused = await api.call(exporter, "GET", `/api/organizations/${orgId}/export`);
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(/needs access to all items/);
  const exported = await api.call(owner, "GET", `/api/organizations/${orgId}/export`);
  expect(exported.status, JSON.stringify(exported.body)).toBe(200);
});

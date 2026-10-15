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
    allowed: [...ADMINS, "manageUsers"],
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/users`,
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
    name: "export the organization's vault",
    allowed: [...ADMINS, "accessImportExport"],
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/export`,
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

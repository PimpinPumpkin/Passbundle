// Who may do what in an organization. Each row is one request and the roles
// allowed to make it; every other caller must be refused, and for requests that
// change something, the change must happen only when allowed. The MSP console
// relies on these: MSP admins act as owners and technicians as admins.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, type Api, encString } from "./support";

const ACTORS = [
  "owner",
  "admin",
  "manager",
  "user",
  "stranger",
  "anonymous",
] as const;
type Actor = (typeof ACTORS)[number];

type Context = {
  api: Api;
  orgId: string;
  owner: Account;
  roles: Record<"admin" | "manager" | "user", Account>;
};
type Row = MatrixRow<Actor, Context>;

const OWNER_ONLY: Actor[] = ["owner"];
const ADMINS: Actor[] = ["owner", "admin"];

const freshEmail = () => `invitee-${randomUUID().slice(0, 8)}@api.example.test`;

async function members(ctx: Context) {
  return (
    await ctx.api.call(
      ctx.owner,
      "GET",
      `/api/organizations/${ctx.orgId}/users`,
    )
  ).body.data as {
    id: string;
    email: string;
    status: number;
    type: number;
  }[];
}

const rows: Row[] = [
  {
    name: "see the organization's settings",
    allowed: OWNER_ONLY,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}`,
    }),
  },
  {
    name: "rename the organization",
    allowed: OWNER_ONLY,
    request: async (ctx) => {
      const name = `Renamed ${randomUUID().slice(0, 8)}`;
      return {
        method: "PUT",
        path: `/api/organizations/${ctx.orgId}`,
        data: { name, billingEmail: ctx.owner.email },
        check: async (allowed) => {
          const org = await ctx.api.call(
            ctx.owner,
            "GET",
            `/api/organizations/${ctx.orgId}`,
          );
          expect(org.body.name === name).toBe(allowed);
        },
      };
    },
  },
  {
    name: "list members",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/users`,
    }),
  },
  {
    name: "invite a member",
    allowed: ADMINS,
    request: async (ctx) => {
      const email = freshEmail();
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
    name: "remove a member",
    allowed: ADMINS,
    request: async (ctx) => {
      const victim = await ctx.api.addMember(
        ctx.owner,
        ctx.orgId,
        await ctx.api.account("victim"),
        "user",
      );
      return {
        method: "DELETE",
        path: `/api/organizations/${ctx.orgId}/users/${victim}`,
        check: async (allowed) =>
          expect((await members(ctx)).some((m) => m.id === victim)).toBe(
            !allowed,
          ),
      };
    },
  },
  {
    name: "confirm a member, giving them the org key",
    allowed: ADMINS,
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
        data: { key: encString(`org-key-for-${pending.email}`) },
        check: async (allowed) => {
          const status = (await members(ctx)).find((m) => m.id === id)!.status;
          expect(status).toBe(allowed ? 2 : 1);
        },
      };
    },
  },
  {
    name: "list policies",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/policies`,
    }),
  },
  {
    name: "turn on a policy",
    allowed: ADMINS,
    request: async (ctx) => {
      // "Remove Send" (6): harmless to turn on and off.
      const path = `/api/organizations/${ctx.orgId}/policies/6`;
      const off = await ctx.api.call(ctx.owner, "PUT", path, {
        policy: { enabled: false, data: null },
      });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      return {
        method: "PUT",
        path,
        data: { policy: { enabled: true, data: null } },
        check: async (allowed) => {
          const policies = await ctx.api.call(
            ctx.owner,
            "GET",
            `/api/organizations/${ctx.orgId}/policies`,
          );
          const policy = policies.body.data.find(
            (p: { type: number }) => p.type === 6,
          );
          expect(policy?.enabled === true).toBe(allowed);
        },
      };
    },
  },
  {
    name: "list collections",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/collections`,
    }),
  },
  {
    name: "create a collection",
    allowed: ADMINS,
    request: async (ctx) => {
      const path = `/api/organizations/${ctx.orgId}/collections`;
      const before = (await ctx.api.call(ctx.owner, "GET", path)).body.data
        .length;
      return {
        method: "POST",
        path,
        data: { name: encString("collection"), groups: [], users: [] },
        check: async (allowed) => {
          const after = (await ctx.api.call(ctx.owner, "GET", path)).body.data
            .length;
          expect(after - before).toBe(allowed ? 1 : 0);
        },
      };
    },
  },
  {
    name: "add an item to a collection",
    allowed: ADMINS,
    request: async (ctx, _actor, account) => {
      const before = (await orgItems(ctx)).length;
      return {
        method: "POST",
        path: "/api/ciphers/create",
        data: {
          cipher: note(ctx, account),
          collectionIds: [await defaultCollection(ctx)],
        },
        check: async (allowed) =>
          expect((await orgItems(ctx)).length - before).toBe(allowed ? 1 : 0),
      };
    },
  },
  {
    name: "list all of the organization's items",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/ciphers/organization-details?organizationId=${orgId}`,
    }),
  },
  {
    name: "see an item without access to its collection",
    allowed: ADMINS,
    request: async (ctx) => ({
      method: "GET",
      path: `/api/ciphers/${await orgItem(ctx)}`,
    }),
  },
  {
    name: "see an item through the admin route",
    allowed: ADMINS,
    request: async (ctx) => ({
      method: "GET",
      path: `/api/ciphers/${await orgItem(ctx)}/admin`,
    }),
  },
  {
    name: "edit an item without access to its collection",
    allowed: ADMINS,
    request: async (ctx, _actor, account) => {
      const id = await orgItem(ctx);
      const edited = note(ctx, account);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}`,
        data: edited,
        check: async (allowed) =>
          expect((await itemAsOwner(ctx, id)).name === edited.name).toBe(
            allowed,
          ),
      };
    },
  },
  {
    name: "edit an item through the admin route",
    allowed: ADMINS,
    request: async (ctx, _actor, account) => {
      const id = await orgItem(ctx);
      const edited = note(ctx, account);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}/admin`,
        data: edited,
        check: async (allowed) =>
          expect((await itemAsOwner(ctx, id)).name === edited.name).toBe(
            allowed,
          ),
      };
    },
  },
  {
    name: "move an item to the trash through the admin route",
    allowed: ADMINS,
    request: async (ctx) => {
      const id = await orgItem(ctx);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}/delete-admin`,
        check: async (allowed) =>
          expect((await itemAsOwner(ctx, id)).deletedDate != null).toBe(
            allowed,
          ),
      };
    },
  },
  {
    name: "delete an item for good through the admin route",
    allowed: ADMINS,
    request: async (ctx) => {
      const id = await orgItem(ctx);
      return {
        method: "DELETE",
        path: `/api/ciphers/${id}/admin`,
        check: async (allowed) => {
          const result = await ctx.api.call(
            ctx.owner,
            "GET",
            `/api/ciphers/${id}/admin`,
          );
          expect(result.status === 200).toBe(!allowed);
        },
      };
    },
  },
  {
    name: "rename a collection",
    allowed: ADMINS,
    request: async (ctx) => {
      const id = await newCollection(ctx);
      const name = encString(`renamed-${randomUUID()}`);
      return {
        method: "PUT",
        path: `/api/organizations/${ctx.orgId}/collections/${id}`,
        data: { name, groups: [], users: [] },
        check: async (allowed) => {
          const found = (await collections(ctx)).find((c) => c.id === id);
          expect(found?.name === name).toBe(allowed);
        },
      };
    },
  },
  {
    name: "delete a collection",
    allowed: ADMINS,
    request: async (ctx) => {
      const id = await newCollection(ctx);
      return {
        method: "DELETE",
        path: `/api/organizations/${ctx.orgId}/collections/${id}`,
        check: async (allowed) =>
          expect((await collections(ctx)).some((c) => c.id === id)).toBe(
            !allowed,
          ),
      };
    },
  },
  {
    // Upstream's rule: only owners grant or remove the admin and owner roles.
    // MSP technicians are admins in their clients, so they can't either.
    name: "make a member an admin",
    allowed: OWNER_ONLY,
    request: async (ctx) => roleChange(ctx, 1),
  },
  {
    name: "make a member an owner",
    allowed: OWNER_ONLY,
    request: async (ctx) => roleChange(ctx, 0),
  },
  {
    name: "revoke a member's access",
    allowed: ADMINS,
    request: async (ctx) => {
      const id = await ctx.api.addMember(
        ctx.owner,
        ctx.orgId,
        await ctx.api.account("revokee"),
        "user",
      );
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
    name: "export the organization's vault",
    allowed: ADMINS,
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/organizations/${orgId}/export`,
    }),
  },
  {
    name: "see the organization's API key",
    allowed: OWNER_ONLY,
    request: async ({ orgId }, _actor, account) => ({
      method: "POST",
      path: `/api/organizations/${orgId}/api-key`,
      data: { masterPasswordHash: account?.password ?? "not-logged-in" },
    }),
  },
  {
    name: "delete the organization",
    allowed: OWNER_ONLY,
    request: async (ctx, _actor, account) => {
      // A fresh organization each time, with the same people in it.
      const orgId = await ctx.api.organization(
        ctx.owner,
        `Doomed ${randomUUID().slice(0, 8)}`,
      );
      for (const [role, member] of Object.entries(ctx.roles)) {
        await ctx.api.addMember(
          ctx.owner,
          orgId,
          member,
          role as "admin" | "manager" | "user",
        );
      }
      return {
        method: "DELETE",
        path: `/api/organizations/${orgId}`,
        data: { masterPasswordHash: account?.password ?? "not-logged-in" },
        check: async (allowed) => {
          const result = await ctx.api.call(
            ctx.owner,
            "GET",
            `/api/organizations/${orgId}`,
          );
          expect(result.status === 200).toBe(!allowed);
        },
      };
    },
  },
];

/** A new secure note, encrypted (as far as the server can tell) by this caller. */
function note(ctx: Context, account: Account | null) {
  return {
    type: 2,
    name: encString(`item-${randomUUID()}`),
    notes: null,
    secureNote: { type: 0 },
    organizationId: ctx.orgId,
    encryptedFor: account?.userId ?? ctx.owner.userId,
    favorite: false,
    reprompt: 0,
    fields: [],
  };
}

async function collections(
  ctx: Context,
): Promise<{ id: string; name: string }[]> {
  return (
    await ctx.api.call(
      ctx.owner,
      "GET",
      `/api/organizations/${ctx.orgId}/collections`,
    )
  ).body.data;
}

async function defaultCollection(ctx: Context): Promise<string> {
  return (await collections(ctx))[0].id;
}

async function newCollection(ctx: Context): Promise<string> {
  const created = await ctx.api.call(
    ctx.owner,
    "POST",
    `/api/organizations/${ctx.orgId}/collections`,
    {
      name: encString("collection"),
      groups: [],
      users: [],
    },
  );
  expect(created.status).toBe(200);
  return created.body.id;
}

/** A new item in the default collection, added by the owner. */
async function orgItem(ctx: Context): Promise<string> {
  const created = await ctx.api.call(ctx.owner, "POST", "/api/ciphers/create", {
    cipher: note(ctx, ctx.owner),
    collectionIds: [await defaultCollection(ctx)],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id;
}

async function orgItems(ctx: Context): Promise<unknown[]> {
  const path = `/api/ciphers/organization-details?organizationId=${ctx.orgId}`;
  return (await ctx.api.call(ctx.owner, "GET", path)).body.data;
}

async function itemAsOwner(ctx: Context, id: string) {
  return (await ctx.api.call(ctx.owner, "GET", `/api/ciphers/${id}/admin`))
    .body;
}

async function roleChange(ctx: Context, type: number) {
  const id = await ctx.api.addMember(
    ctx.owner,
    ctx.orgId,
    await ctx.api.account("promotee"),
    "user",
  );
  return {
    method: "PUT" as const,
    path: `/api/organizations/${ctx.orgId}/users/${id}`,
    data: {
      type,
      collections: [],
      groups: [],
      accessAll: false,
      permissions: {},
    },
    check: async (allowed: boolean) =>
      expect((await members(ctx)).find((m) => m.id === id)!.type === type).toBe(
        allowed,
      ),
  };
}

test.describe("Organization permissions", () => {
  permissionMatrix(
    ACTORS,
    async (api) => {
      const owner = await api.account("owner");
      const orgId = await api.organization(owner, "Permissions Org");
      const callers = {
        owner,
        stranger: await api.account("stranger"),
        anonymous: null,
      } as Record<Actor, Account | null>;
      for (const role of ["admin", "manager", "user"] as const) {
        callers[role] = await api.account(role);
        await api.addMember(owner, orgId, callers[role]!, role);
      }
      const roles = {
        admin: callers.admin!,
        manager: callers.manager!,
        user: callers.user!,
      };
      return { ctx: { api, orgId, owner, roles }, callers };
    },
    rows,
  );
});

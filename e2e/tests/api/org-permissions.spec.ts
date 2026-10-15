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

type Context = { api: Api; orgId: string; owner: Account };
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
];

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
      return { ctx: { api, orgId, owner }, callers };
    },
    rows,
  );
});

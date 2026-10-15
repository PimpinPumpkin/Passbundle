// Who may do what with an MSP. The MSP's admins run it; technicians can see it
// and the memberships waiting for the org key; another MSP's staff, the
// client's own people, and strangers get nothing, except that a client's own
// owners can see their MSP and remove it.
import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import type { Account, Api } from "./support";

const ACTORS = [
  "mspAdmin",
  "technician",
  "otherMspAdmin",
  "clientOwner",
  "clientUser",
  "stranger",
  "anonymous",
] as const;
type Actor = (typeof ACTORS)[number];
type Context = {
  api: Api;
  mspId: string;
  orgId: string;
  admin: Account;
  tech: Account;
  owner: Account;
  user: Account;
};
type Row = MatrixRow<Actor, Context>;

const LOGGED_IN = ACTORS.filter((a) => a !== "anonymous");

async function overview(ctx: Context) {
  return (
    await ctx.api.call(ctx.admin, "GET", `/api/keykeeper/msp/${ctx.mspId}`)
  ).body;
}

/** A technician added just for one call. */
async function freshTechnician(ctx: Context) {
  const tech = await ctx.api.account("extra-tech");
  await ctx.api.addStaff(ctx.admin, ctx.mspId, tech, "technician");
  return tech;
}

const rows: Row[] = [
  {
    name: "list your own MSPs",
    allowed: LOGGED_IN,
    request: async () => ({ method: "GET", path: "/api/keykeeper/msp" }),
  },
  {
    name: "see an MSP, its staff, and its clients",
    allowed: ["mspAdmin", "technician"],
    request: async ({ mspId }) => ({
      method: "GET",
      path: `/api/keykeeper/msp/${mspId}`,
    }),
  },
  {
    name: "add a client",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const before = (await overview(ctx)).clients.length;
      return {
        method: "POST",
        path: `/api/keykeeper/msp/${ctx.mspId}/clients`,
        data: {
          name: "Another Client",
          collectionName: "2.aXY=|Y3Q=|bWFj",
          key: "2.aXY=|Y3Q=|bWFj",
          keys: {
            publicKey: "cHVibGlj",
            encryptedPrivateKey: "2.aXY=|Y3Q=|bWFj",
          },
        },
        check: async (allowed) =>
          expect((await overview(ctx)).clients.length - before).toBe(
            allowed ? 1 : 0,
          ),
      };
    },
  },
  {
    name: "add a staff member",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const newcomer = await ctx.api.account("newcomer");
      return {
        method: "POST",
        path: `/api/keykeeper/msp/${ctx.mspId}/staff`,
        data: { email: newcomer.email, role: "technician" },
        check: async (allowed) => {
          const staff = (await overview(ctx)).staff.map(
            (s: { email: string }) => s.email,
          );
          expect(staff.includes(newcomer.email)).toBe(allowed);
        },
      };
    },
  },
  {
    name: "change a staff member's role",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const tech = await freshTechnician(ctx);
      return {
        method: "PUT",
        path: `/api/keykeeper/msp/${ctx.mspId}/staff/${tech.userId}`,
        data: { role: "admin" },
        check: async (allowed) => {
          const role = (await overview(ctx)).staff.find(
            (s: { email: string }) => s.email === tech.email,
          ).role;
          expect(role).toBe(allowed ? "admin" : "technician");
        },
      };
    },
  },
  {
    name: "remove a staff member",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const tech = await freshTechnician(ctx);
      return {
        method: "DELETE",
        path: `/api/keykeeper/msp/${ctx.mspId}/staff/${tech.userId}`,
        check: async (allowed) => {
          const staff = (await overview(ctx)).staff.map(
            (s: { email: string }) => s.email,
          );
          expect(staff.includes(tech.email)).toBe(!allowed);
        },
      };
    },
  },
  {
    name: "list memberships waiting for the org key",
    allowed: ["mspAdmin", "technician"],
    request: async ({ mspId }) => ({
      method: "GET",
      path: `/api/keykeeper/msp/${mspId}/pending`,
    }),
  },
  {
    name: "see a client's MSP",
    allowed: ["mspAdmin", "technician", "clientOwner"],
    request: async ({ orgId }) => ({
      method: "GET",
      path: `/api/keykeeper/organizations/${orgId}/msp`,
    }),
  },
  {
    name: "see a client's enrollment token for its install command",
    allowed: ["mspAdmin", "technician"],
    request: async ({ mspId, orgId }) => ({
      method: "GET",
      path: `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
    }),
  },
  {
    name: "replace a client's enrollment token",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const path = `/api/keykeeper/msp/${ctx.mspId}/clients/${ctx.orgId}/enrollment`;
      const before = (await ctx.api.call(ctx.admin, "GET", path)).body.token;
      return {
        method: "POST",
        path,
        check: async (allowed) => {
          const after = (await ctx.api.call(ctx.admin, "GET", path)).body.token;
          expect(after !== before).toBe(allowed);
        },
      };
    },
  },
  {
    name: "read the MSP's audit log",
    allowed: ["mspAdmin", "technician"],
    request: async ({ mspId }) => ({
      method: "GET",
      path: `/api/keykeeper/msp/${mspId}/events`,
    }),
  },
  {
    name: "cancel an invitation to the staff",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const email = `invitee-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@api.example.test`;
      const invited = await ctx.api.call(
        ctx.admin,
        "POST",
        `/api/keykeeper/msp/${ctx.mspId}/staff`,
        {
          email,
          role: "technician",
        },
      );
      expect(invited.status).toBe(200);
      return {
        method: "DELETE",
        path: `/api/keykeeper/msp/${ctx.mspId}/invites/${invited.body.inviteId}`,
        check: async (allowed) => {
          const invites = (await overview(ctx)).invites.map(
            (i: { email: string }) => i.email,
          );
          expect(invites.includes(email)).toBe(!allowed);
        },
      };
    },
  },
  {
    name: "remove a client's MSP",
    allowed: ["clientOwner"],
    request: async (ctx) => {
      // A fresh client each time, with the same people in it.
      const orgId = await ctx.api.client(
        ctx.admin,
        ctx.mspId,
        `Leaving Client ${Date.now()}`,
      );
      await ctx.api.confirmPending(ctx.admin, ctx.mspId);
      await ctx.api.addMember(ctx.admin, orgId, ctx.owner, "owner");
      await ctx.api.addMember(ctx.admin, orgId, ctx.user, "user");
      return {
        method: "DELETE",
        path: `/api/keykeeper/organizations/${orgId}/msp`,
        check: async (allowed) => {
          const clients = (await overview(ctx)).clients.map(
            (c: { id: string }) => c.id,
          );
          expect(clients.includes(orgId)).toBe(!allowed);
        },
      };
    },
  },
];

test.describe("MSP permissions", () => {
  permissionMatrix(
    ACTORS,
    async (api) => {
      const admin = await api.account("msp-admin");
      const tech = await api.account("technician");
      const other = await api.account("other-msp-admin");
      const owner = await api.account("client-owner");
      const user = await api.account("client-user");
      const mspId = await api.msp(admin, "Matrix MSP");
      await api.msp(other, "Other MSP");
      const orgId = await api.client(admin, mspId, "Matrix Client");
      await api.addStaff(admin, mspId, tech, "technician");
      await api.confirmPending(admin, mspId);
      await api.addMember(admin, orgId, owner, "owner");
      await api.addMember(admin, orgId, user, "user");
      const callers: Record<Actor, Account | null> = {
        mspAdmin: admin,
        technician: tech,
        otherMspAdmin: other,
        clientOwner: owner,
        clientUser: user,
        stranger: await api.account("stranger"),
        anonymous: null,
      };
      return { ctx: { api, mspId, orgId, admin, tech, owner, user }, callers };
    },
    rows,
  );
});

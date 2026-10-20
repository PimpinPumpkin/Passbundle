// Who may do what with an MSP. The MSP's admins run it; technicians can see it
// and the memberships waiting for the org key; another MSP's staff, the
// client's own people, and strangers get nothing, except that a client's own
// owners can see their MSP and remove it. The limited technician has a custom
// role in the client and no install commands.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import type { Account, Api } from "./support";

const ACTORS = [
  "mspAdmin",
  "technician",
  "limitedTech",
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

/** The MSP's template ids, as its admin sees them. */
async function templateIds(ctx: Context): Promise<string[]> {
  return (
    await ctx.api.call(
      ctx.admin,
      "GET",
      `/api/keykeeper/msp/${ctx.mspId}/templates`,
    )
  ).body.templates.map((t: { templateId: string }) => t.templateId);
}

/** A template for every client, added by the MSP's admin. */
async function newTemplate(ctx: Context): Promise<string> {
  const id = randomUUID();
  const source = await ctx.api.personalItem(ctx.admin);
  const added = await ctx.api.call(
    ctx.admin,
    "PUT",
    `/api/keykeeper/msp/${ctx.mspId}/templates/${id}`,
    { sourceCipherId: source, allClients: true },
  );
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  return id;
}

const rows: Row[] = [
  {
    name: "list your own MSPs",
    allowed: LOGGED_IN,
    request: async () => ({ method: "GET", path: "/api/keykeeper/msp" }),
  },
  {
    name: "see an MSP, its staff, and its clients",
    allowed: ["mspAdmin", "technician", "limitedTech"],
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
        // Adding someone invites them; they join when they accept.
        check: async (allowed) => {
          const invited = (await overview(ctx)).invites.map(
            (i: { email: string }) => i.email,
          );
          expect(invited.includes(newcomer.email)).toBe(allowed);
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
    name: "change a technician's access",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const tech = await freshTechnician(ctx);
      return {
        method: "PUT",
        path: `/api/keykeeper/msp/${ctx.mspId}/staff/${tech.userId}/access`,
        data: {
          allClients: false,
          clients: [ctx.orgId],
          custom: null,
          installCommands: false,
        },
        check: async (allowed) => {
          const access = (await overview(ctx)).staff.find(
            (s: { email: string }) => s.email === tech.email,
          ).access;
          expect(access.allClients).toBe(!allowed);
          expect(access.installCommands).toBe(!allowed);
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
    allowed: ["mspAdmin", "technician", "limitedTech"],
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
    allowed: ["mspAdmin", "technician", "limitedTech"],
    request: async ({ mspId }) => ({
      method: "GET",
      path: `/api/keykeeper/msp/${mspId}/events`,
    }),
  },
  {
    name: "see the default policies and which clients have their own",
    allowed: ["mspAdmin", "technician", "limitedTech"],
    request: async ({ mspId }) => ({
      method: "GET",
      path: `/api/keykeeper/msp/${mspId}/policies`,
    }),
  },
  {
    name: "change a default policy",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      // Flips the password generator default; the client follows it.
      const path = `/api/organizations/${ctx.orgId}/policies/2`;
      const before = (await ctx.api.call(ctx.admin, "GET", path)).body.enabled;
      return {
        method: "PUT",
        path: `/api/keykeeper/msp/${ctx.mspId}/policies/2`,
        data: { enabled: !before, data: null },
        check: async (allowed) => {
          const after = (await ctx.api.call(ctx.admin, "GET", path)).body
            .enabled;
          expect(after !== before).toBe(allowed);
        },
      };
    },
  },
  {
    name: "use a default policy in a client with its own setting",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      // The client turns on Remove Send, which is off by default.
      const path = `/api/organizations/${ctx.orgId}/policies/6`;
      const own = await ctx.api.call(ctx.admin, "PUT", path, {
        policy: { enabled: true, data: null },
      });
      expect(own.status).toBe(200);
      return {
        method: "POST",
        path: `/api/keykeeper/msp/${ctx.mspId}/policies/6/apply`,
        data: { clients: [ctx.orgId] },
        check: async (allowed) => {
          const enabled = (await ctx.api.call(ctx.admin, "GET", path)).body
            .enabled;
          expect(enabled).toBe(!allowed);
        },
      };
    },
  },
  {
    name: "see the templates sent to clients",
    allowed: ["mspAdmin", "technician", "limitedTech"],
    request: async ({ mspId }) => ({
      method: "GET",
      path: `/api/keykeeper/msp/${mspId}/templates`,
    }),
  },
  {
    name: "add a template for every client",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const id = randomUUID();
      const source = await ctx.api.personalItem(ctx.admin);
      return {
        method: "PUT",
        path: `/api/keykeeper/msp/${ctx.mspId}/templates/${id}`,
        data: { sourceCipherId: source, allClients: true },
        check: async (allowed) =>
          expect((await templateIds(ctx)).includes(id)).toBe(allowed),
      };
    },
  },
  {
    name: "stop sending a template",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const id = await newTemplate(ctx);
      return {
        method: "DELETE",
        path: `/api/keykeeper/msp/${ctx.mspId}/templates/${id}`,
        check: async (allowed) =>
          expect((await templateIds(ctx)).includes(id)).toBe(!allowed),
      };
    },
  },
  {
    name: "record a client's copy of a template",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const id = await newTemplate(ctx);
      const collection = await ctx.api.collection(ctx.admin, ctx.orgId);
      const copy = await ctx.api.orgItem(ctx.admin, ctx.orgId, collection);
      return {
        method: "POST",
        path: `/api/keykeeper/msp/${ctx.mspId}/templates/${id}/copies`,
        data: {
          copies: [
            { organizationId: ctx.orgId, cipherId: copy, sourceRevision: "r1" },
          ],
        },
        check: async (allowed) => {
          const copies = (
            await ctx.api.call(
              ctx.admin,
              "GET",
              `/api/keykeeper/msp/${ctx.mspId}/templates`,
            )
          ).body.copies.filter(
            (c: { templateId: string }) => c.templateId === id,
          );
          expect(copies.length).toBe(allowed ? 1 : 0);
        },
      };
    },
  },
  {
    name: "record a client's Templates collection",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const collection = await ctx.api.collection(ctx.admin, ctx.orgId);
      return {
        method: "PUT",
        path: `/api/keykeeper/msp/${ctx.mspId}/clients/${ctx.orgId}/templates-collection`,
        data: { collectionId: collection },
        check: async (allowed) => {
          const recorded = (
            await ctx.api.call(
              ctx.admin,
              "GET",
              `/api/keykeeper/msp/${ctx.mspId}/templates`,
            )
          ).body.collections[ctx.orgId];
          expect(recorded === collection).toBe(allowed);
        },
      };
    },
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
      const limited = await api.account("limited-tech");
      await api.addStaff(admin, mspId, limited, "technician", {
            allClients: false,
            clients: [orgId],
            custom: { permissions: { manageUsers: true }, vaultItems: false },
            installCommands: false,
          });
      await api.confirmPending(admin, mspId);
      await api.addMember(admin, orgId, owner, "owner");
      await api.addMember(admin, orgId, user, "user");
      const callers: Record<Actor, Account | null> = {
        mspAdmin: admin,
        technician: tech,
        limitedTech: limited,
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

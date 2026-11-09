// A shared folder's icon and color (DESIGN.md, "Folder icons"): the apps
// encrypt the choice with the organization's key, as they do the folder's
// name, and the server keeps it with the folder and sends it wherever the
// folder goes (sync, the folder's details, the admin console's list). The
// people who can rename the folder may change it, the same rule as upstream's
// rename: owners, admins, and anyone who manages the folder, directly or
// through a group. Everyone else is refused with 400, never 401 or 403,
// which sign the web vault out, and the same words whether or not the folder
// is there.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { port } from "../../paths.mjs";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api, encString } from "./support";

const REFUSED = "Only people who can rename this shared folder can change its icon.";

type Grid = {
  seePasswords: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  export: boolean;
  share: boolean;
  print: boolean;
  viewHistory: boolean;
  manage: boolean;
};
const NONE: Grid = {
  seePasswords: false,
  create: false,
  edit: false,
  delete: false,
  export: false,
  share: false,
  print: false,
  viewHistory: false,
  manage: false,
};
const VIEW: Grid = { ...NONE, seePasswords: true, print: true, viewHistory: true };
const EDIT: Grid = { ...VIEW, create: true, edit: true, delete: true, share: true };
const MANAGE: Grid = { ...EDIT, export: true, manage: true };

/** A grant as our web vault sends it: upstream's closest preset, and the grid. */
const grant = (id: string, grid: Grid) => ({
  id,
  readOnly: !grid.manage && !grid.edit,
  hidePasswords: !grid.manage && !grid.seePasswords,
  manage: grid.manage,
  keykeeper: grid,
});

const ACTORS = [
  "owner",
  "admin",
  // A regular member whose grid in F has manage.
  "folderManager",
  // Reaches F only through a group whose grid there has manage.
  "groupManager",
  // Upstream's Manager role, who can edit in F but doesn't manage it.
  "manager",
  "editor",
  "viewer",
  // A custom role that manages members, without F.
  "custom",
  // A member without F.
  "noFolder",
  // The owner of another organization.
  "outsider",
  "anonymous",
] as const;
type Actor = (typeof ACTORS)[number];
const MAY: Actor[] = ["owner", "admin", "folderManager", "groupManager"];
const MAY_NOT: Actor[] = ["manager", "editor", "viewer", "custom", "noFolder", "outsider"];

type Context = {
  api: Api;
  owner: Account;
  orgId: string;
  /** The folder everyone's grids are in. */
  folder: string;
  /** A folder of the outsider's own organization. */
  otherOrgFolder: string;
  otherOrgId: string;
};

const lookPath = (orgId: string, folder: string) =>
  `/api/keykeeper/organizations/${orgId}/collections/${folder}/look`;
const setLook = (ctx: Context, who: Account | null, look: string | null, folder = ctx.folder) =>
  ctx.api.call(who, "PUT", lookPath(ctx.orgId, folder), { look });

/** The folder's look, as its details tell its owner. */
async function lookOf(ctx: Context, folder = ctx.folder): Promise<string | null> {
  const details = await ctx.api.call(
    ctx.owner,
    "GET",
    `/api/organizations/${ctx.orgId}/collections/${folder}/details`,
  );
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  return details.body.keykeeperLook;
}

async function setUp(api: Api): Promise<{ ctx: Context; callers: Record<Actor, Account | null> }> {
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Folder Icons Org");
  const callers = { owner, anonymous: null } as Record<Actor, Account | null>;
  const memberIds = {} as Record<Actor, string>;
  for (const actor of ["admin", "folderManager", "groupManager", "manager", "editor", "viewer", "noFolder"] as const) {
    const account = await api.account(actor);
    callers[actor] = account;
    memberIds[actor] = await api.addMember(
      owner,
      orgId,
      account,
      actor === "admin" ? "admin" : actor === "manager" ? "manager" : "user",
    );
  }
  callers.custom = await api.account("custom");
  await api.addCustomMember(owner, orgId, callers.custom, { manageUsers: true });

  const group = await api.call(owner, "POST", `/api/organizations/${orgId}/groups`, {
    name: "Folder managers",
    accessAll: false,
    externalId: null,
    collections: [],
    users: [memberIds.groupManager],
  });
  expect(group.status, JSON.stringify(group.body)).toBe(200);

  const folder = await api.collection(owner, orgId);
  const access = await api.call(owner, "PUT", `/api/organizations/${orgId}/collections/${folder}`, {
    name: encString(`folder-${randomUUID()}`),
    users: [
      grant(memberIds.folderManager, MANAGE),
      grant(memberIds.manager, EDIT),
      grant(memberIds.editor, EDIT),
      grant(memberIds.viewer, VIEW),
    ],
    groups: [grant(group.body.id, MANAGE)],
  });
  expect(access.status, JSON.stringify(access.body)).toBe(200);

  callers.outsider = await api.account("outsider");
  const otherOrgId = await api.organization(callers.outsider, "Someone Else's Org");
  const otherOrgFolder = await api.collection(callers.outsider, otherOrgId);

  return { ctx: { api, owner, orgId, folder, otherOrgFolder, otherOrgId }, callers };
}

const rows: MatrixRow<Actor, Context>[] = [
  {
    name: "give a shared folder an icon and a color",
    allowed: MAY,
    request: async (ctx, actor) => {
      const look = encString(`look-${actor}-${randomUUID()}`);
      return {
        method: "PUT",
        path: lookPath(ctx.orgId, ctx.folder),
        data: { look },
        check: async (allowed) => expect((await lookOf(ctx)) === look).toBe(allowed),
      };
    },
  },
  {
    name: "give a shared folder back its plain glyph",
    allowed: MAY,
    request: async (ctx) => {
      const before = encString(`look-${randomUUID()}`);
      expect((await setLook(ctx, ctx.owner, before)).status).toBe(200);
      return {
        method: "PUT",
        path: lookPath(ctx.orgId, ctx.folder),
        data: { look: null },
        check: async (allowed) => expect(await lookOf(ctx)).toBe(allowed ? null : before),
      };
    },
  },
];

test.describe("Who may change a shared folder's icon", () => {
  permissionMatrix(ACTORS, setUp, rows);
});

test.describe("Shared folder icons", () => {
  let ctx: Context;
  let callers: Record<Actor, Account | null>;
  let dispose: () => Promise<void>;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(180_000);
    const request = await playwright.request.newContext({
      baseURL: `https://127.0.0.1:${port}`,
      ignoreHTTPSErrors: true,
    });
    dispose = () => request.dispose();
    ({ ctx, callers } = await setUp(new Api(request)));
  });

  test.afterAll(async () => {
    await dispose();
  });

  test("everyone else is refused with 400, in the same words whether or not the folder is there", async () => {
    const before = encString(`look-${randomUUID()}`);
    expect((await setLook(ctx, ctx.owner, before)).status).toBe(200);
    for (const actor of MAY_NOT) {
      const refused = await setLook(ctx, callers[actor], encString(`look-${actor}`));
      expect(refused.status, actor).toBe(400);
      expect(refused.body.message, actor).toBe(REFUSED);
    }
    // A folder that isn't there, and another organization's folder through
    // this organization, are refused the same way, even for its owner.
    for (const [who, folder] of [
      [ctx.owner, randomUUID()],
      [ctx.owner, ctx.otherOrgFolder],
      [callers.outsider, ctx.otherOrgFolder],
    ] as const) {
      const refused = await setLook(ctx, who, encString("look"), folder);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toBe(REFUSED);
    }
    expect((await setLook(ctx, null, encString("look"))).status).toBe(401);
    expect(await lookOf(ctx)).toBe(before);
    // The other organization's folder kept its plain glyph.
    const theirs = await ctx.api.call(
      callers.outsider,
      "GET",
      `/api/organizations/${ctx.otherOrgId}/collections/${ctx.otherOrgFolder}/details`,
    );
    expect(theirs.body.keykeeperLook).toBeNull();
  });

  test("keeps only an encrypted look, which says nothing it can read", async () => {
    for (const plain of [
      '{"icon":"bank","tone":"emerald"}',
      "bank emerald",
      "2.only|two",
      "2.not base64!|YQ==|YQ==",
      `2.YQ==|${"A".repeat(1100)}|YQ==`,
    ]) {
      const refused = await setLook(ctx, ctx.owner, plain);
      expect(refused.status, plain.slice(0, 30)).toBe(400);
      expect(refused.body.message).toMatch(/encrypted/);
    }
    // An empty one is the plain folder.
    expect((await setLook(ctx, ctx.owner, "")).status).toBe(200);
    expect(await lookOf(ctx)).toBeNull();
  });

  test("goes with the folder: in sync for everyone who has it, its details, and the admin console's list", async () => {
    const look = encString(`look-${randomUUID()}`);
    const saved = await setLook(ctx, callers.folderManager, look);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // The answer is the folder, as upstream's save answers.
    expect(saved.body).toMatchObject({ id: ctx.folder, keykeeperLook: look, manage: true });

    for (const actor of ["owner", "admin", "folderManager", "groupManager", "manager", "editor", "viewer"] as const) {
      const sync = await ctx.api.call(callers[actor], "GET", "/api/sync?excludeDomains=true");
      expect(sync.status, actor).toBe(200);
      const folder = sync.body.collections.find((c: { id: string }) => c.id === ctx.folder);
      expect(folder?.keykeeperLook, actor).toBe(look);
      // Every other folder in sync says it has none, rather than leaving it out.
      for (const other of sync.body.collections.filter((c: { id: string }) => c.id !== ctx.folder)) {
        expect(other).toHaveProperty("keykeeperLook");
      }
    }
    // Those without the folder don't get it, or its look.
    for (const actor of ["custom", "noFolder", "outsider"] as const) {
      const sync = await ctx.api.call(callers[actor], "GET", "/api/sync?excludeDomains=true");
      expect(sync.status, actor).toBe(200);
      expect(sync.body.collections.some((c: { id: string }) => c.id === ctx.folder), actor).toBe(false);
    }

    const list = await ctx.api.call(callers.viewer, "GET", "/api/collections");
    expect(list.body.data.find((c: { id: string }) => c.id === ctx.folder)?.keykeeperLook).toBe(look);
    const console = await ctx.api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections/details`);
    expect(console.body.data.find((c: { id: string }) => c.id === ctx.folder)?.keykeeperLook).toBe(look);
    const manager = await ctx.api.call(
      callers.folderManager,
      "GET",
      `/api/organizations/${ctx.orgId}/collections/${ctx.folder}/details`,
    );
    expect(manager.status).toBe(200);
    expect(manager.body.keykeeperLook).toBe(look);
  });

  test("renaming the folder and changing who has it keep its look", async () => {
    const look = encString(`look-${randomUUID()}`);
    expect((await setLook(ctx, ctx.owner, look)).status).toBe(200);
    const details = await ctx.api.call(
      ctx.owner,
      "GET",
      `/api/organizations/${ctx.orgId}/collections/${ctx.folder}/details`,
    );
    const renamed = await ctx.api.call(ctx.owner, "PUT", `/api/organizations/${ctx.orgId}/collections/${ctx.folder}`, {
      name: encString(`renamed-${randomUUID()}`),
      users: details.body.users,
      groups: details.body.groups,
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.keykeeperLook).toBe(look);
    expect(await lookOf(ctx)).toBe(look);
  });

  test("a change tells the folder's people's apps to sync again, as a rename does", async () => {
    const revision = async () =>
      (await ctx.api.call(callers.viewer, "GET", "/api/accounts/revision-date")).body;
    const before = await revision();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await setLook(ctx, ctx.owner, encString(`look-${randomUUID()}`))).status).toBe(200);
    expect(await revision()).toBeGreaterThan(before);
  });

  test("a save's answer says the person has the folder, so the web vault keeps it in its menu", async () => {
    // Upstream's web vault takes a folder out of its own list until the next
    // sync when a save's answer doesn't say so.
    const made = await ctx.api.call(ctx.owner, "POST", `/api/organizations/${ctx.orgId}/collections`, {
      name: encString(`made-${randomUUID()}`),
      groups: [],
      users: [],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ assigned: true, keykeeperLook: null });

    const details = await ctx.api.call(
      ctx.owner,
      "GET",
      `/api/organizations/${ctx.orgId}/collections/${ctx.folder}/details`,
    );
    const renamed = await ctx.api.call(
      callers.folderManager,
      "PUT",
      `/api/organizations/${ctx.orgId}/collections/${ctx.folder}`,
      { name: encString(`renamed-${randomUUID()}`), users: details.body.users, groups: details.body.groups },
    );
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.assigned).toBe(true);

    const look = await setLook(ctx, callers.groupManager, encString(`look-${randomUUID()}`));
    expect(look.body.assigned).toBe(true);
  });

  test("a new folder has none until someone picks one", async () => {
    const fresh = await ctx.api.collection(ctx.owner, ctx.orgId);
    expect(await lookOf(ctx, fresh)).toBeNull();
    const sync = await ctx.api.call(ctx.owner, "GET", "/api/sync?excludeDomains=true");
    expect(sync.body.collections.find((c: { id: string }) => c.id === fresh)).toMatchObject({
      keykeeperLook: null,
    });
  });
});

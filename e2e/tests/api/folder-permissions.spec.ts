// Shared folders' capabilities, enforced by the server (DESIGN.md, "Folders and
// permissions"). Each person reaches the folder with a grid that has one
// capability the others lack, so every row shows exactly who that request's
// capability lets through, on every way an item is written: made, moved in,
// imported, edited, its attachments, trashed, restored, deleted (one or
// several), added to or taken out of a folder (one or several), its history
// read and cleared, and the folder's own name and people. Then what the
// security review asked for: adding an item to a folder is sharing it, a
// grant sent back without its grid keeps it, an item's folders outside sync
// include read-only ones, history needs both its capabilities in one folder,
// imports are checked before anything is saved, and refusals don't sign the
// web vault out.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { port } from "../../paths.mjs";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api, encString } from "./support";

export type Grid = {
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
const ALL: Grid = {
  seePasswords: true,
  create: true,
  edit: true,
  delete: true,
  export: true,
  share: true,
  print: true,
  viewHistory: true,
  manage: true,
};
export const PRESETS = {
  view: { ...NONE, seePasswords: true, print: true, viewHistory: true },
  viewHidden: { ...NONE, viewHistory: true },
  edit: {
    ...NONE,
    seePasswords: true,
    create: true,
    edit: true,
    delete: true,
    share: true,
    print: true,
    viewHistory: true,
  },
  manage: ALL,
} satisfies Record<string, Grid>;

/** A grant as our web vault sends it: upstream's closest preset, and the grid. */
export function grant(id: string, grid: Grid) {
  return {
    id,
    readOnly: !grid.manage && !grid.edit,
    hidePasswords: !grid.manage && !grid.seePasswords,
    manage: grid.manage,
    keykeeper: grid,
  };
}

// Each person in folder F, and what that gives them there.
const GRIDS = {
  viewer: PRESETS.view,
  noPasswords: PRESETS.viewHidden,
  creator: { ...NONE, create: true },
  editor: { ...NONE, seePasswords: true, edit: true },
  deleter: { ...NONE, seePasswords: true, delete: true },
  sharer: { ...NONE, seePasswords: true, edit: true, share: true },
  manager: PRESETS.manage,
} satisfies Record<string, Grid>;
type Person = keyof typeof GRIDS;

const ACTORS = [
  "owner",
  ...(Object.keys(GRIDS) as Person[]),
  // Reaches F only through a group that can edit.
  "groupEditor",
  // A member without F.
  "outsider",
  "anonymous",
] as const;
type Actor = (typeof ACTORS)[number];

type Context = {
  api: Api;
  orgId: string;
  owner: Account;
  /** The folder everyone's grids are in. */
  folder: string;
  /** A second folder where everyone who can edit in F can edit too. */
  other: string;
  memberIds: Record<Exclude<Actor, "owner" | "anonymous">, string>;
  groupId: string;
};
type Row = MatrixRow<Actor, Context>;

const CAN = {
  create: ["owner", "creator", "manager", "groupEditor"],
  edit: ["owner", "editor", "sharer", "manager", "groupEditor"],
  delete: ["owner", "deleter", "manager", "groupEditor"],
  history: ["owner", "viewer", "noPasswords", "manager", "groupEditor"],
  see: ["owner", "viewer", "noPasswords", "creator", "editor", "deleter", "sharer", "manager", "groupEditor"],
} satisfies Record<string, Actor[]>;

function note(orgId: string | null, account: Account | null, owner: Account) {
  return {
    type: 2,
    name: encString(`item-${randomUUID()}`),
    notes: null,
    secureNote: { type: 0 },
    organizationId: orgId,
    encryptedFor: account?.userId ?? owner.userId,
    favorite: false,
    reprompt: 0,
    fields: [],
  };
}

/** A new item in these folders, made by the owner. */
async function item(ctx: Context, folders: string[] = [ctx.folder]): Promise<string> {
  const created = await ctx.api.call(ctx.owner, "POST", "/api/ciphers/create", {
    cipher: note(ctx.orgId, ctx.owner, ctx.owner),
    collectionIds: folders,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id;
}

async function asOwner(ctx: Context, id: string) {
  return (await ctx.api.call(ctx.owner, "GET", `/api/ciphers/${id}/admin`)).body;
}

async function orgItemCount(ctx: Context): Promise<number> {
  const path = `/api/ciphers/organization-details?organizationId=${ctx.orgId}`;
  return (await ctx.api.call(ctx.owner, "GET", path)).body.data.length;
}

/** Gives the folder exactly these people and groups, as the owner. */
async function setAccess(
  api: Api,
  owner: Account,
  orgId: string,
  folder: string,
  users: [string, Grid][],
  groups: [string, Grid][],
  name = encString(`folder-${randomUUID()}`),
) {
  const saved = await api.call(owner, "PUT", `/api/organizations/${orgId}/collections/${folder}`, {
    name,
    users: users.map(([id, grid]) => grant(id, grid)),
    groups: groups.map(([id, grid]) => grant(id, grid)),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

/** A folder with the same people as F, for requests that change a folder. */
async function copyOfF(ctx: Context): Promise<string> {
  const created = await ctx.api.call(ctx.owner, "POST", `/api/organizations/${ctx.orgId}/collections`, {
    name: encString(`copy-${randomUUID()}`),
    groups: [],
    users: [],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await setAccess(
    ctx.api,
    ctx.owner,
    ctx.orgId,
    created.body.id,
    (Object.keys(GRIDS) as Person[]).map((p) => [ctx.memberIds[p], GRIDS[p]]),
    [[ctx.groupId, PRESETS.edit]],
  );
  return created.body.id;
}

const rows: Row[] = [
  {
    name: "see an item in the folder",
    allowed: CAN.see,
    request: async (ctx) => ({ method: "GET", path: `/api/ciphers/${await item(ctx)}` }),
  },
  {
    name: "make an item in the folder",
    allowed: CAN.create,
    request: async (ctx, _actor, account) => {
      const before = await orgItemCount(ctx);
      return {
        method: "POST",
        path: "/api/ciphers/create",
        data: { cipher: note(ctx.orgId, account, ctx.owner), collectionIds: [ctx.folder] },
        check: async (allowed) => expect((await orgItemCount(ctx)) - before).toBe(allowed ? 1 : 0),
      };
    },
  },
  {
    name: "move a personal item into the folder",
    allowed: CAN.create,
    request: async (ctx, _actor, account) => {
      // The caller's own item; someone not logged in gets the owner's.
      const mover = account ?? ctx.owner;
      const own = await ctx.api.call(mover, "POST", "/api/ciphers", note(null, mover, ctx.owner));
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const moved = note(ctx.orgId, mover, ctx.owner);
      return {
        method: "PUT",
        path: `/api/ciphers/${own.body.id}/share`,
        data: { cipher: { ...moved, id: own.body.id }, collectionIds: [ctx.folder] },
        check: async (allowed) => {
          const now = await ctx.api.call(ctx.owner, "GET", `/api/ciphers/${own.body.id}/admin`);
          expect(now.body?.organizationId === ctx.orgId).toBe(allowed);
        },
      };
    },
  },
  {
    name: "import items into the folder",
    allowed: CAN.create,
    request: async (ctx, _actor, account) => {
      const before = await orgItemCount(ctx);
      return {
        method: "POST",
        path: `/api/ciphers/import-organization?organizationId=${ctx.orgId}`,
        data: {
          ciphers: [note(ctx.orgId, account, ctx.owner)],
          collections: [{ id: ctx.folder, name: encString("imported") }],
          collectionRelationships: [{ key: 0, value: 0 }],
        },
        check: async (allowed) => expect((await orgItemCount(ctx)) - before).toBe(allowed ? 1 : 0),
      };
    },
  },
  {
    name: "edit an item",
    allowed: CAN.edit,
    request: async (ctx, _actor, account) => {
      const id = await item(ctx);
      const edited = note(ctx.orgId, account, ctx.owner);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}`,
        data: edited,
        check: async (allowed) => expect((await asOwner(ctx, id)).name === edited.name).toBe(allowed),
      };
    },
  },
  {
    name: "add an attachment to an item",
    allowed: CAN.edit,
    request: async (ctx) => {
      const id = await item(ctx);
      return {
        method: "POST",
        path: `/api/ciphers/${id}/attachment/v2`,
        data: { key: encString("attachment-key"), fileName: encString("file"), fileSize: 10 },
        check: async (allowed) =>
          expect(((await asOwner(ctx, id)).attachments ?? []).length).toBe(allowed ? 1 : 0),
      };
    },
  },
  {
    name: "move an item to the trash",
    allowed: CAN.delete,
    request: async (ctx) => {
      const id = await item(ctx);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}/delete`,
        check: async (allowed) => expect((await asOwner(ctx, id)).deletedDate != null).toBe(allowed),
      };
    },
  },
  {
    name: "move several items to the trash",
    allowed: CAN.delete,
    request: async (ctx) => {
      const ids = [await item(ctx), await item(ctx)];
      return {
        method: "PUT",
        path: "/api/ciphers/delete",
        data: { ids },
        check: async (allowed) => {
          for (const id of ids) {
            expect((await asOwner(ctx, id)).deletedDate != null).toBe(allowed);
          }
        },
      };
    },
  },
  {
    name: "restore an item from the trash",
    allowed: CAN.delete,
    request: async (ctx) => {
      const id = await item(ctx);
      const trashed = await ctx.api.call(ctx.owner, "PUT", `/api/ciphers/${id}/delete`);
      expect(trashed.status).toBe(200);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}/restore`,
        check: async (allowed) => expect((await asOwner(ctx, id)).deletedDate == null).toBe(allowed),
      };
    },
  },
  {
    name: "delete an item for good",
    allowed: CAN.delete,
    request: async (ctx) => {
      const id = await item(ctx);
      return {
        method: "DELETE",
        path: `/api/ciphers/${id}`,
        check: async (allowed) => {
          const result = await ctx.api.call(ctx.owner, "GET", `/api/ciphers/${id}/admin`);
          expect(result.status === 200).toBe(!allowed);
        },
      };
    },
  },
  {
    name: "delete several items for good",
    allowed: CAN.delete,
    request: async (ctx) => {
      const ids = [await item(ctx), await item(ctx)];
      return {
        method: "POST",
        path: "/api/ciphers/delete",
        data: { ids },
        check: async (allowed) => {
          for (const id of ids) {
            const result = await ctx.api.call(ctx.owner, "GET", `/api/ciphers/${id}/admin`);
            expect(result.status === 200).toBe(!allowed);
          }
        },
      };
    },
  },
  {
    // Edit with passwords showing and share on the item, and create in the
    // other folder, which everyone who edits in F has. The editor, without
    // share, can't: the other folder would let them delete it.
    name: "add an item to another folder too",
    allowed: ["owner", "sharer", "manager", "groupEditor"],
    request: async (ctx) => {
      const id = await item(ctx);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}/collections_v2`,
        data: { collectionIds: [ctx.folder, ctx.other] },
        check: async (allowed) =>
          expect((await asOwner(ctx, id)).collectionIds.includes(ctx.other)).toBe(allowed),
      };
    },
  },
  {
    // An organization's item sent through share with another folder: the
    // same as adding it there.
    name: "add an item to another folder through share",
    allowed: ["owner", "sharer", "manager", "groupEditor"],
    request: async (ctx, _actor, account) => {
      const id = await item(ctx);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}/share`,
        data: { cipher: { ...note(ctx.orgId, account, ctx.owner), id }, collectionIds: [ctx.other] },
        check: async (allowed) =>
          expect((await asOwner(ctx, id)).collectionIds.includes(ctx.other)).toBe(allowed),
      };
    },
  },
  {
    // Share in F, the folder it leaves.
    name: "move an item out of the folder into another",
    allowed: ["owner", "sharer", "manager", "groupEditor"],
    request: async (ctx) => {
      const id = await item(ctx);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}/collections_v2`,
        data: { collectionIds: [ctx.other] },
        check: async (allowed) =>
          expect((await asOwner(ctx, id)).collectionIds.includes(ctx.folder)).toBe(!allowed),
      };
    },
  },
  {
    name: "move an item out through the admin console",
    allowed: ["owner", "sharer", "manager", "groupEditor"],
    request: async (ctx) => {
      const id = await item(ctx);
      return {
        method: "PUT",
        path: `/api/ciphers/${id}/collections-admin`,
        data: { collectionIds: [ctx.other] },
        check: async (allowed) =>
          expect((await asOwner(ctx, id)).collectionIds.includes(ctx.folder)).toBe(!allowed),
      };
    },
  },
  {
    name: "add several items to another folder",
    allowed: ["owner", "sharer", "manager", "groupEditor"],
    request: async (ctx) => {
      const ids = [await item(ctx), await item(ctx)];
      return {
        method: "POST",
        path: "/api/ciphers/bulk-collections",
        data: { organizationId: ctx.orgId, cipherIds: ids, collectionIds: [ctx.other], removeCollections: false },
        check: async (allowed) => {
          for (const id of ids) {
            expect((await asOwner(ctx, id)).collectionIds.includes(ctx.other)).toBe(allowed);
          }
        },
      };
    },
  },
  {
    name: "take several items out of the folder",
    allowed: ["owner", "sharer", "manager", "groupEditor"],
    request: async (ctx) => {
      const ids = [await item(ctx, [ctx.folder, ctx.other]), await item(ctx, [ctx.folder, ctx.other])];
      return {
        method: "POST",
        path: "/api/ciphers/bulk-collections",
        data: { organizationId: ctx.orgId, cipherIds: ids, collectionIds: [ctx.folder], removeCollections: true },
        check: async (allowed) => {
          for (const id of ids) {
            expect((await asOwner(ctx, id)).collectionIds.includes(ctx.folder)).toBe(!allowed);
          }
        },
      };
    },
  },
  {
    name: "see an item's history",
    allowed: CAN.history,
    request: async (ctx) => ({ method: "GET", path: `/api/keykeeper/ciphers/${await item(ctx)}/history` }),
  },
  {
    // View item history and delete.
    name: "clear an item's history",
    allowed: ["owner", "manager", "groupEditor"],
    request: async (ctx) => {
      const id = await item(ctx);
      const edited = await ctx.api.call(ctx.owner, "PUT", `/api/ciphers/${id}`, note(ctx.orgId, ctx.owner, ctx.owner));
      expect(edited.status).toBe(200);
      return {
        method: "DELETE",
        path: `/api/keykeeper/ciphers/${id}/history`,
        check: async (allowed) => {
          const history = await ctx.api.call(ctx.owner, "GET", `/api/keykeeper/ciphers/${id}/history`);
          expect(history.body.data.length === 0).toBe(allowed);
        },
      };
    },
  },
  {
    name: "see who reaches the folder",
    allowed: ["owner", "manager"],
    request: async (ctx) => ({
      method: "GET",
      path: `/api/organizations/${ctx.orgId}/collections/${ctx.folder}/details`,
    }),
  },
  {
    name: "list the organization's folders with their access",
    allowed: ["owner", "manager"],
    request: async (ctx) => ({ method: "GET", path: `/api/organizations/${ctx.orgId}/collections/details` }),
  },
  {
    name: "list the members' names to choose from",
    allowed: ["owner", "manager"],
    request: async (ctx) => ({ method: "GET", path: `/api/organizations/${ctx.orgId}/users/mini-details` }),
  },
  {
    name: "rename the folder and change who reaches it",
    allowed: ["owner", "manager"],
    request: async (ctx) => {
      const id = await copyOfF(ctx);
      const name = encString(`renamed-${randomUUID()}`);
      const details = await ctx.api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections/${id}/details`);
      // Everyone stays, and the outsider is added.
      const users = [
        ...details.body.users.filter((u: { id: string }) => Object.values(ctx.memberIds).includes(u.id)),
        grant(ctx.memberIds.outsider, PRESETS.view),
      ];
      return {
        method: "PUT",
        path: `/api/organizations/${ctx.orgId}/collections/${id}`,
        data: { name, users, groups: details.body.groups },
        check: async (allowed) => {
          const after = await ctx.api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections/${id}/details`);
          expect(after.body.name === name).toBe(allowed);
          expect(after.body.users.some((u: { id: string }) => u.id === ctx.memberIds.outsider)).toBe(allowed);
        },
      };
    },
  },
  {
    name: "make a folder",
    allowed: ["owner"],
    request: async (ctx) => {
      const name = encString(`new-${randomUUID()}`);
      return {
        method: "POST",
        path: `/api/organizations/${ctx.orgId}/collections`,
        data: { name, groups: [], users: [] },
        check: async (allowed) => {
          const all = await ctx.api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections`);
          expect(all.body.data.some((c: { name: string }) => c.name === name)).toBe(allowed);
        },
      };
    },
  },
  {
    name: "delete the folder",
    allowed: ["owner"],
    request: async (ctx) => {
      const id = await copyOfF(ctx);
      return {
        method: "DELETE",
        path: `/api/organizations/${ctx.orgId}/collections/${id}`,
        check: async (allowed) => {
          const all = await ctx.api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections`);
          expect(all.body.data.some((c: { id: string }) => c.id === id)).toBe(!allowed);
        },
      };
    },
  },
];

async function setUp(api: Api) {
  const owner = await api.account("owner");
  const orgId = await api.organization(owner, "Folder Grid Org");
  const callers = { owner, anonymous: null } as Record<Actor, Account | null>;
  const memberIds = {} as Context["memberIds"];
  for (const actor of ACTORS) {
    if (actor === "owner" || actor === "anonymous") {
      continue;
    }
    const account = await api.account(actor);
    callers[actor] = account;
    memberIds[actor] = await api.addMember(owner, orgId, account, "user");
  }
  const group = await api.call(owner, "POST", `/api/organizations/${orgId}/groups`, {
    name: "Editors",
    accessAll: false,
    externalId: null,
    collections: [],
    users: [memberIds.groupEditor],
  });
  expect(group.status, JSON.stringify(group.body)).toBe(200);
  const folder = await api.collection(owner, orgId);
  const other = await api.collection(owner, orgId);
  const people = (Object.keys(GRIDS) as Person[]).map((p): [string, Grid] => [memberIds[p], GRIDS[p]]);
  await setAccess(api, owner, orgId, folder, people, [[group.body.id, PRESETS.edit]]);
  // In the other folder, everyone who can edit in F can edit.
  await setAccess(
    api,
    owner,
    orgId,
    other,
    (["editor", "sharer", "manager"] as Person[]).map((p): [string, Grid] => [memberIds[p], PRESETS.edit]),
    [[group.body.id, PRESETS.edit]],
  );
  return { ctx: { api, orgId, owner, folder, other, memberIds, groupId: group.body.id }, callers };
}

test.describe("Shared folder capabilities", () => {
  permissionMatrix(ACTORS, setUp, rows);
});

test.describe("Shared folder grids", () => {
  let api: Api;
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
    api = new Api(request);
    ({ ctx, callers } = await setUp(api));
  });

  test.afterAll(async () => {
    await dispose();
  });

  test("sync says what each person can do in the folder and with each item", async () => {
    const id = await item(ctx);
    for (const person of Object.keys(GRIDS) as Person[]) {
      const sync = await api.call(callers[person], "GET", "/api/sync?excludeDomains=true");
      expect(sync.status).toBe(200);
      const folder = sync.body.collections.find((c: { id: string }) => c.id === ctx.folder);
      expect(folder.keykeeper, person).toEqual(GRIDS[person]);
      const synced = sync.body.ciphers.find((c: { id: string }) => c.id === id);
      expect(synced.edit, person).toBe(GRIDS[person].edit);
      expect(synced.viewPassword, person).toBe(GRIDS[person].seePasswords);
      expect(synced.permissions, person).toEqual({ delete: GRIDS[person].delete, restore: GRIDS[person].delete });
    }
    // Upstream's fields carry the closest preset.
    const sync = await api.call(callers.creator, "GET", "/api/sync?excludeDomains=true");
    const folder = sync.body.collections.find((c: { id: string }) => c.id === ctx.folder);
    expect([folder.readOnly, folder.hidePasswords, folder.manage]).toEqual([true, true, false]);
    // A member without the folder doesn't get it, or its items.
    const outsider = await api.call(callers.outsider, "GET", "/api/sync?excludeDomains=true");
    expect(outsider.body.collections.some((c: { id: string }) => c.id === ctx.folder)).toBe(false);
    expect(outsider.body.ciphers.some((c: { id: string }) => c.id === id)).toBe(false);
  });

  test("the folder's details list each person's and group's grid", async () => {
    const details = await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections/${ctx.folder}/details`);
    for (const person of Object.keys(GRIDS) as Person[]) {
      const user = details.body.users.find((u: { id: string }) => u.id === ctx.memberIds[person]);
      expect(user.keykeeper, person).toEqual(GRIDS[person]);
    }
    expect(details.body.groups.find((g: { id: string }) => g.id === ctx.groupId).keykeeper).toEqual(PRESETS.edit);
    // And so do a member's own collections and a group's.
    const members = await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/users?includeCollections=true`);
    const creator = members.body.data.find((m: { id: string }) => m.id === ctx.memberIds.creator);
    expect(creator.collections.find((c: { id: string }) => c.id === ctx.folder).keykeeper).toEqual(GRIDS.creator);
    const groups = await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/groups/details`);
    const group = groups.body.data.find((g: { id: string }) => g.id === ctx.groupId);
    expect(group.collections.find((c: { id: string }) => c.id === ctx.folder).keykeeper).toEqual(PRESETS.edit);
  });

  test("grids that break the rules are refused, and nothing changes", async () => {
    const folder = await copyOfF(ctx);
    const before = await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections/${folder}/details`);
    for (const broken of [
      { ...NONE, export: true },
      { ...NONE, print: true },
      { ...NONE, edit: true, share: true },
      { ...NONE, manage: true },
      { ...ALL, delete: false },
    ]) {
      const result = await api.call(ctx.owner, "PUT", `/api/organizations/${ctx.orgId}/collections/${folder}`, {
        name: before.body.name,
        users: [{ ...grant(ctx.memberIds.viewer, PRESETS.view), keykeeper: broken }],
        groups: [],
      });
      expect(result.status, JSON.stringify(broken)).toBe(400);
    }
    const after = await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections/${folder}/details`);
    expect(after.body.users).toEqual(before.body.users);
    expect(after.body.groups).toEqual(before.body.groups);
  });

  test("a grant saved without a grid is the preset upstream's fields name", async () => {
    const folder = await copyOfF(ctx);
    const saved = await api.call(ctx.owner, "PUT", `/api/organizations/${ctx.orgId}/collections/${folder}`, {
      name: encString("upstream"),
      users: [{ id: ctx.memberIds.creator, readOnly: false, hidePasswords: true, manage: false }],
      groups: [],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const details = await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections/${folder}/details`);
    // Upstream's "Can edit except passwords".
    expect(details.body.users.find((u: { id: string }) => u.id === ctx.memberIds.creator).keykeeper).toEqual({
      ...NONE,
      create: true,
      edit: true,
      delete: true,
      viewHistory: true,
    });
  });

  test("several ways into a folder give the most open of each capability", async () => {
    const folder = await copyOfF(ctx);
    const viewHidden = await api.account("view-hidden");
    const member = await api.addMember(ctx.owner, ctx.orgId, viewHidden, "user");
    const group = await api.call(ctx.owner, "POST", `/api/organizations/${ctx.orgId}/groups`, {
      name: "Droppers",
      accessAll: false,
      externalId: null,
      collections: [grant(folder, { ...NONE, create: true })],
      users: [member],
    });
    expect(group.status).toBe(200);
    await setAccess(api, ctx.owner, ctx.orgId, folder, [[member, PRESETS.viewHidden]], [[group.body.id, { ...NONE, create: true }]]);
    const sync = await api.call(viewHidden, "GET", "/api/sync?excludeDomains=true");
    expect(sync.body.collections.find((c: { id: string }) => c.id === folder).keykeeper).toEqual({
      ...NONE,
      create: true,
      viewHistory: true,
    });
    // See passwords is off only while every way turns it off.
    await setAccess(api, ctx.owner, ctx.orgId, folder, [[member, PRESETS.viewHidden]], [[group.body.id, PRESETS.view]]);
    const again = await api.call(viewHidden, "GET", "/api/sync?excludeDomains=true");
    expect(again.body.collections.find((c: { id: string }) => c.id === folder).keykeeper.seePasswords).toBe(true);
  });

  test("an item in two folders gets what either allows", async () => {
    const id = await item(ctx, [ctx.folder, ctx.other]);
    // The viewer can't delete in F; given delete in the other folder, they can.
    const viewerOther = await copyOfF(ctx);
    await setAccess(api, ctx.owner, ctx.orgId, viewerOther, [[ctx.memberIds.viewer, { ...PRESETS.view, delete: true }]], []);
    const moved = await api.call(ctx.owner, "PUT", `/api/ciphers/${id}/collections_v2`, {
      collectionIds: [ctx.folder, viewerOther],
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const trashed = await api.call(callers.viewer, "PUT", `/api/ciphers/${id}/delete`);
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
  });

  test("an item only leaves its last folder by being deleted", async () => {
    const id = await item(ctx);
    const result = await api.call(callers.sharer, "PUT", `/api/ciphers/${id}/collections_v2`, { collectionIds: [] });
    expect(result.status).toBe(400);
    expect((await asOwner(ctx, id)).collectionIds).toEqual([ctx.folder]);
  });

  test("adding an item to another folder is sharing it: without share, no new folder lets someone delete it or read its history", async () => {
    // The editor can edit in F, without share, delete, or history, and has
    // Can edit in the other folder.
    const id = await item(ctx);
    const editor = callers.editor;
    for (const [label, method, path, data] of [
      ["one item", "PUT", `/api/ciphers/${id}/collections_v2`, { collectionIds: [ctx.folder, ctx.other] }],
      ["through share", "PUT", `/api/ciphers/${id}/share`, {
        cipher: { ...note(ctx.orgId, editor, ctx.owner), id },
        collectionIds: [ctx.folder, ctx.other],
      }],
      ["several items", "POST", "/api/ciphers/bulk-collections", {
        organizationId: ctx.orgId,
        cipherIds: [id],
        collectionIds: [ctx.other],
        removeCollections: false,
      }],
    ] as const) {
      const refused = await api.call(editor, method, path, data);
      expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(400);
      expect(refused.body.message, label).toMatch(/permission to share/);
    }
    expect((await asOwner(ctx, id)).collectionIds).toEqual([ctx.folder]);
    // So it stays out of their reach to delete, or to read its history.
    expect((await api.call(editor, "PUT", `/api/ciphers/${id}/delete`)).status).toBe(400);
    expect((await api.call(editor, "GET", `/api/keykeeper/ciphers/${id}/history`)).status).toBe(404);
    // With share on the item, it goes in.
    const shared = await api.call(callers.sharer, "PUT", `/api/ciphers/${id}/collections_v2`, {
      collectionIds: [ctx.folder, ctx.other],
    });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect((await asOwner(ctx, id)).collectionIds.sort()).toEqual([ctx.folder, ctx.other].sort());
  });

  test("a grant sent back without its grid keeps it, on every save that resends grants, until upstream's fields change", async () => {
    const folder = await copyOfF(ctx);
    const custom: Grid = { ...NONE, seePasswords: true, edit: true, viewHistory: true };
    const group = await api.call(ctx.owner, "POST", `/api/organizations/${ctx.orgId}/groups`, {
      name: "Resaved",
      accessAll: false,
      externalId: null,
      collections: [grant(folder, custom)],
      users: [],
    });
    expect(group.status, JSON.stringify(group.body)).toBe(200);
    await setAccess(api, ctx.owner, ctx.orgId, folder, [[ctx.memberIds.creator, custom]], [[group.body.id, custom]]);
    const upstream = (g: { keykeeper?: Grid }) => ({ ...g, keykeeper: undefined });
    const details = async () =>
      (await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections/${folder}/details`)).body;
    const creatorGrid = async () =>
      (await details()).users.find((u: { id: string }) => u.id === ctx.memberIds.creator).keykeeper;
    const groupGrid = async () =>
      (await details()).groups.find((g: { id: string }) => g.id === group.body.id).keykeeper;

    // The folder, saved the upstream way.
    let before = await details();
    let saved = await api.call(ctx.owner, "PUT", `/api/organizations/${ctx.orgId}/collections/${folder}`, {
      name: before.name,
      users: before.users.filter((u: { id: string }) => Object.values(ctx.memberIds).includes(u.id)).map(upstream),
      groups: before.groups.map(upstream),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await creatorGrid()).toEqual(custom);
    expect(await groupGrid()).toEqual(custom);

    // Bulk access, the upstream way.
    before = await details();
    saved = await api.call(ctx.owner, "POST", `/api/organizations/${ctx.orgId}/collections/bulk-access`, {
      collectionIds: [folder],
      users: before.users.filter((u: { id: string }) => Object.values(ctx.memberIds).includes(u.id)).map(upstream),
      groups: before.groups.map(upstream),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await creatorGrid()).toEqual(custom);
    expect(await groupGrid()).toEqual(custom);

    // The member, edited the upstream way.
    const member = await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/users/${ctx.memberIds.creator}?includeCollections=true&includeGroups=true`);
    saved = await api.call(ctx.owner, "PUT", `/api/organizations/${ctx.orgId}/users/${ctx.memberIds.creator}`, {
      type: 2,
      accessAll: false,
      permissions: {},
      collections: member.body.collections.map(upstream),
      groups: member.body.groups,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await creatorGrid()).toEqual(custom);

    // The group, edited the upstream way.
    const groupDetails = await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/groups/${group.body.id}/details`);
    saved = await api.call(ctx.owner, "PUT", `/api/organizations/${ctx.orgId}/groups/${group.body.id}`, {
      name: "Resaved",
      accessAll: false,
      externalId: null,
      collections: groupDetails.body.collections.map(upstream),
      users: [],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await groupGrid()).toEqual(custom);

    // Upstream's fields changed: the preset they name.
    before = await details();
    saved = await api.call(ctx.owner, "PUT", `/api/organizations/${ctx.orgId}/collections/${folder}`, {
      name: before.name,
      users: [{ id: ctx.memberIds.creator, readOnly: true, hidePasswords: false, manage: false }],
      groups: [],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await creatorGrid()).toEqual(PRESETS.view);
  });

  test("an item's folders outside sync include the ones someone can only view, so saving them back changes nothing", async () => {
    // The viewer has Can view in F; give them Can edit in a second folder.
    const second = await copyOfF(ctx);
    await setAccess(api, ctx.owner, ctx.orgId, second, [[ctx.memberIds.viewer, PRESETS.edit]], []);
    const id = await item(ctx, [ctx.folder, second]);
    const viewer = callers.viewer;
    const both = [ctx.folder, second].sort();
    for (const path of [`/api/ciphers/${id}`, `/api/ciphers/${id}/details`]) {
      const got = await api.call(viewer, "GET", path);
      expect(got.status, path).toBe(200);
      expect(got.body.collectionIds.sort(), path).toEqual(both);
    }
    // After a save, and in what the item form posts back.
    const edited = await api.call(viewer, "PUT", `/api/ciphers/${id}`, note(ctx.orgId, viewer, ctx.owner));
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.collectionIds.sort()).toEqual(both);
    const posted = await api.call(viewer, "PUT", `/api/ciphers/${id}/collections_v2`, {
      collectionIds: edited.body.collectionIds,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect((await asOwner(ctx, id)).collectionIds.sort()).toEqual(both);
    // Someone who reaches only one of them sees only that one.
    const creator = await api.call(callers.creator, "GET", `/api/ciphers/${id}`);
    expect(creator.body.collectionIds).toEqual([ctx.folder]);
  });

  test("an item's history needs view item history with see passwords, or with delete, in the same folder", async () => {
    const a = await copyOfF(ctx);
    const b = await copyOfF(ctx);
    const person = await api.account("history-split");
    const member = await api.addMember(ctx.owner, ctx.orgId, person, "user");
    await setAccess(api, ctx.owner, ctx.orgId, a, [[member, { ...NONE, viewHistory: true }]], []);
    await setAccess(api, ctx.owner, ctx.orgId, b, [[member, { ...NONE, seePasswords: true, delete: true }]], []);
    const id = await item(ctx, [a, b]);
    const edited = await api.call(ctx.owner, "PUT", `/api/ciphers/${id}`, note(ctx.orgId, ctx.owner, ctx.owner));
    expect(edited.status).toBe(200);
    // History from A, passwords and delete from B: dates and authors only,
    // and no clearing.
    const history = await api.call(person, "GET", `/api/keykeeper/ciphers/${id}/history`);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.hidePasswords).toBe(true);
    expect(history.body.data.length).toBe(1);
    expect(history.body.data[0].cipher).toBeNull();
    const cleared = await api.call(person, "DELETE", `/api/keykeeper/ciphers/${id}/history`);
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(400);
    expect((await api.call(ctx.owner, "GET", `/api/keykeeper/ciphers/${id}/history`)).body.data.length).toBe(1);
    // All three in A: contents, and clearing.
    await setAccess(api, ctx.owner, ctx.orgId, a, [[member, { ...NONE, viewHistory: true, seePasswords: true, delete: true }]], []);
    const full = await api.call(person, "GET", `/api/keykeeper/ciphers/${id}/history`);
    expect(full.body.hidePasswords).toBe(false);
    expect(full.body.data[0].cipher).not.toBeNull();
    expect((await api.call(person, "DELETE", `/api/keykeeper/ciphers/${id}/history`)).status).toBe(200);
  });

  test("an import with a broken relationship saves nothing", async () => {
    const before = await orgItemCount(ctx);
    const folders = (await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections`)).body.data.length;
    for (const [who, relationships] of [
      [ctx.owner, [{ key: 0, value: 0 }, { key: 1, value: 5 }]],
      [ctx.owner, [{ key: 0, value: 0 }, { key: 7, value: 0 }]],
      [callers.creator, [{ key: 0, value: 0 }, { key: 1, value: 3 }]],
    ] as const) {
      const imported = await api.call(who, "POST", `/api/ciphers/import-organization?organizationId=${ctx.orgId}`, {
        ciphers: [note(ctx.orgId, who, ctx.owner), note(ctx.orgId, who, ctx.owner)],
        collections: [{ id: ctx.folder, name: encString("imported") }, { name: encString(`new-${randomUUID()}`) }],
        collectionRelationships: relationships,
      });
      expect(imported.status, JSON.stringify(imported.body)).toBe(400);
    }
    expect(await orgItemCount(ctx)).toBe(before);
    expect((await api.call(ctx.owner, "GET", `/api/organizations/${ctx.orgId}/collections`)).body.data.length).toBe(folders);
  });

  test("refusals a member's web vault can run into don't sign it out", async () => {
    // A regular member on a folder's manager routes: 404, not 401.
    for (const [method, path] of [
      ["GET", `/api/organizations/${ctx.orgId}/collections/${ctx.folder}/details`],
      ["GET", `/api/organizations/${ctx.orgId}/collections/${ctx.folder}/users`],
      ["GET", `/api/organizations/${ctx.orgId}/users/mini-details`],
    ] as const) {
      const refused = await api.call(callers.viewer, method, path);
      expect(refused.status, `${method} ${path}`).toBe(404);
    }
    // Clearing history without delete: 400, not 403.
    const id = await item(ctx);
    const cleared = await api.call(callers.viewer, "DELETE", `/api/keykeeper/ciphers/${id}/history`);
    expect(cleared.status).toBe(400);
    // Logged out is still 401.
    expect((await api.call(null, "GET", `/api/organizations/${ctx.orgId}/users/mini-details`)).status).toBe(401);
  });

  test("a folder's manager sees members who joined, and no directory ids", async () => {
    const invited = `invited-${randomUUID().slice(0, 8)}@api.example.test`;
    const invite = await api.call(ctx.owner, "POST", `/api/organizations/${ctx.orgId}/users/invite`, {
      emails: [invited],
      type: 2,
      collections: [],
      groups: [],
      permissions: {},
    });
    expect(invite.status, JSON.stringify(invite.body)).toBe(200);
    const directory = await api.call(ctx.owner, "POST", `/api/organizations/${ctx.orgId}/groups`, {
      name: "From the directory",
      accessAll: false,
      externalId: `dir-${randomUUID()}`,
      collections: [],
      users: [],
    });
    expect(directory.status, JSON.stringify(directory.body)).toBe(200);

    const emails = async (who: Account) =>
      (await api.call(who, "GET", `/api/organizations/${ctx.orgId}/users/mini-details`)).body.data.map(
        (m: { email: string }) => m.email,
      );
    expect(await emails(ctx.owner)).toContain(invited);
    const managerSees = await emails(callers.manager!);
    expect(managerSees).not.toContain(invited);
    expect(managerSees).toContain(callers.viewer!.email);

    const externalId = async (who: Account) =>
      (await api.call(who, "GET", `/api/organizations/${ctx.orgId}/groups`)).body.data.find(
        (g: { id: string }) => g.id === directory.body.id,
      ).externalId;
    expect(await externalId(ctx.owner)).toMatch(/^dir-/);
    expect(await externalId(callers.manager!)).toBeNull();
  });

  test("a folder's manager changes only their own folders", async () => {
    const managed = await copyOfF(ctx);
    const notManaged = await api.collection(ctx.owner, ctx.orgId);
    await setAccess(api, ctx.owner, ctx.orgId, notManaged, [[ctx.memberIds.manager, PRESETS.edit]], []);
    const refused = await api.call(callers.manager, "PUT", `/api/organizations/${ctx.orgId}/collections/${notManaged}`, {
      name: encString("taken over"),
      users: [grant(ctx.memberIds.manager, ALL)],
      groups: [],
    });
    expect([401, 403, 404]).toContain(refused.status);
    // The organization's list shows who reaches only the folders they manage.
    const list = await api.call(callers.manager, "GET", `/api/organizations/${ctx.orgId}/collections/details`);
    expect(list.status).toBe(200);
    const shown = (folder: string) => list.body.data.find((c: { id: string }) => c.id === folder);
    expect(shown(managed).users.length).toBeGreaterThan(0);
    expect(shown(notManaged).users).toEqual([]);
    expect(shown(notManaged).groups).toEqual([]);
  });
});

test.describe("Who can give what in a folder", () => {
  const newcomer = () => `newcomer-${randomUUID().slice(0, 8)}@api.example.test`;

  test("a custom role gives, in each folder, only capabilities it has there itself, and never manage", async ({
    request,
  }) => {
    const api = new Api(request);
    const owner = await api.account("owner");
    const orgId = await api.organization(owner, "Custom Grants Org");
    const folder = await api.collection(owner, orgId);
    const viaGroup = await api.collection(owner, orgId);
    const poc = await api.account("poc");
    const pocId = await api.addCustomMember(owner, orgId, poc, { manageUsers: true });
    const own: Grid = { ...NONE, seePasswords: true, create: true, print: true };
    const assigned = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${pocId}`, {
      type: 4,
      permissions: { manageUsers: true },
      collections: [grant(folder, own)],
      groups: [],
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    // They reach the second folder only through a group that can edit there.
    const group = await api.call(owner, "POST", `/api/organizations/${orgId}/groups`, {
      name: "Front office",
      accessAll: false,
      externalId: null,
      collections: [grant(viaGroup, PRESETS.edit)],
      users: [pocId],
    });
    expect(group.status, JSON.stringify(group.body)).toBe(200);

    const invite = (collection: unknown) =>
      api.call(poc, "POST", `/api/organizations/${orgId}/users/invite`, {
        emails: [newcomer()],
        type: 2,
        collections: [collection],
        groups: [],
        permissions: {},
      });
    for (const [label, collection, message] of [
      ["edit, which it doesn't have", grant(folder, { ...own, edit: true }), /more access/],
      ["export, which it doesn't have", grant(folder, { ...own, export: true }), /more access/],
      ["view item history, which it doesn't have", grant(folder, { ...NONE, viewHistory: true }), /more access/],
      // Upstream's fields alone are checked as the preset they name: Can view
      // includes view item history.
      ["Can view, sent the upstream way", { id: folder, readOnly: true, hidePasswords: false, manage: false }, /more access/],
      ["manage", grant(folder, ALL), /right to manage/],
      ["more than the group gives", grant(viaGroup, { ...PRESETS.edit, export: true }), /more access/],
    ] as const) {
      const refused = await invite(collection);
      expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(400);
      expect(refused.body.message, label).toMatch(message);
    }
    for (const [label, collection] of [
      ["create only", grant(folder, { ...NONE, create: true })],
      ["all it has", grant(folder, own)],
      ["what the group gives", grant(viaGroup, PRESETS.edit)],
    ] as const) {
      const allowed = await invite(collection);
      expect(allowed.status, `${label}: ${JSON.stringify(allowed.body)}`).toBe(200);
    }
  });

  test("a custom role re-saves a member whose grant is wider than its own, and can't change that grant or reach past its folders", async ({
    request,
  }) => {
    const api = new Api(request);
    const owner = await api.account("owner");
    const orgId = await api.organization(owner, "Custom Re-save Org");
    const folder = await api.collection(owner, orgId);
    const elsewhere = await api.collection(owner, orgId);
    const poc = await api.account("poc");
    const pocId = await api.addCustomMember(owner, orgId, poc, { manageUsers: true });
    const own: Grid = { ...NONE, seePasswords: true, create: true, print: true };
    const assigned = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${pocId}`, {
      type: 4,
      permissions: { manageUsers: true },
      collections: [grant(folder, own)],
      groups: [],
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    // The owner gave a regular member more in the folder than the role has.
    const member = await api.account("member");
    const memberId = await api.addMember(owner, orgId, member, "user");
    const wider = PRESETS.edit;
    const given = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
      type: 2,
      collections: [grant(folder, wider)],
      groups: [],
      permissions: {},
    });
    expect(given.status, JSON.stringify(given.body)).toBe(200);

    const edit = (collections: unknown[]) =>
      api.call(poc, "PUT", `/api/organizations/${orgId}/users/${memberId}`, {
        type: 2,
        collections,
        groups: [],
        permissions: {},
      });
    const grants = async () => {
      const members = await api.call(owner, "GET", `/api/organizations/${orgId}/users?includeCollections=true`);
      const listed = members.body.data.find((m: { id: string }) => m.id === memberId);
      return listed.collections.map((c: { id: string; keykeeper: Grid }) => [c.id, c.keykeeper]);
    };

    // Re-saving the grant as it is, with our grid or the upstream way, isn't
    // giving it: it succeeds and changes nothing.
    for (const [label, collection] of [
      ["with its grid", grant(folder, wider)],
      ["the upstream way", { id: folder, readOnly: false, hidePasswords: false, manage: false }],
    ] as const) {
      const resaved = await edit([collection]);
      expect(resaved.status, `${label}: ${JSON.stringify(resaved.body)}`).toBe(200);
      expect(await grants(), label).toEqual([[folder, wider]]);
    }

    // Changing it is giving it, so the role can't, wider or narrower.
    for (const [label, grid, message] of [
      ["wider still", { ...wider, export: true }, /more access/],
      ["narrower, but still more than the role has", { ...wider, delete: false }, /more access/],
      ["another preset the role doesn't have", PRESETS.view, /more access/],
      ["manage", ALL, /right to manage/],
    ] as const) {
      const refused = await edit([grant(folder, grid)]);
      expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(400);
      expect(refused.body.message, label).toMatch(message);
    }
    expect(await grants()).toEqual([[folder, wider]]);

    // Nor can it give a grant in a folder it doesn't reach, even next to the
    // one it re-saves as it was.
    const outside = await edit([grant(folder, wider), grant(elsewhere, PRESETS.viewHidden)]);
    expect(outside.status, JSON.stringify(outside.body)).toBe(400);
    expect(outside.body.message).toMatch(/collections it can reach/);
    expect(await grants()).toEqual([[folder, wider]]);
  });

  test("an MSP technician with vault items gives any capability but manage", async ({ request }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const admin = await api.account("msp-admin");
    const mspId = await api.msp(admin, "Grid IT");
    const clientId = await api.client(admin, mspId, "Grid Dental");
    const folder = await api.collection(admin, clientId);
    const tech = await api.account("tech");
    await api.addStaff(admin, mspId, tech, "technician", {
      allClients: true,
      clients: [],
      custom: { permissions: { manageUsers: true }, vaultItems: true },
      installCommands: false,
    });
    await api.confirmPending(admin, mspId);
    const invite = (grid: Grid) =>
      api.call(tech, "POST", `/api/organizations/${clientId}/users/invite`, {
        emails: [newcomer()],
        type: 2,
        collections: [grant(folder, grid)],
        groups: [],
        permissions: {},
      });
    const exporter = await invite({ ...PRESETS.edit, export: true });
    expect(exporter.status, JSON.stringify(exporter.body)).toBe(200);
    const manager = await invite(ALL);
    expect(manager.status).toBe(400);
    expect(manager.body.message).toMatch(/right to manage/);
    // And their own vault doesn't show them managing the folder.
    const sync = await api.call(tech, "GET", "/api/sync?excludeDomains=true");
    const synced = sync.body.collections.find((c: { id: string }) => c.id === folder);
    expect(synced.manage).toBe(false);
    expect(synced.keykeeper).toEqual({ ...ALL, manage: false });
  });
});

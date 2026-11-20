// One organization for the tests of exporting an organization's items
// (DESIGN.md, "Folders and permissions", B39): its folders, an item where
// each person may and may not export, and a person for each role, all with
// real keys, since the apps decrypt what they export. The command-line test
// (cli/organization-export.spec.ts) and the web vault's
// (organization-export.spec.ts) use it.
import { type APIRequestContext, expect } from "@playwright/test";

import {
  type RealAccount,
  type RealOrganization,
  realAccount,
  realCollection,
  realLogin,
  realMember,
  realOrganization,
} from "./vault-crypto";

const NONE = {
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
/** "Can view", as the access selector's preset. */
const VIEW = { ...NONE, seePasswords: true, print: true, viewHistory: true };

const grant = (id: string, grid: typeof NONE) => ({
  id,
  readOnly: !grid.edit,
  hidePasswords: !grid.seePasswords,
  manage: grid.manage,
  keykeeper: grid,
});

/** Who may export what here, with the items each one's export holds. */
export type ExportScenario = {
  owner: RealAccount;
  org: RealOrganization;
  /** Every item of the organization, by name. */
  everything: string[];
  /** Every folder, by name. */
  folders: string[];
  /** A regular member with export in Reports: Can view in Payroll, passwords hidden in Domain admins, not in Archive. */
  member: RealAccount;
  /** A regular member who can export none of the folders she reaches (Can view in Payroll). */
  noExport: RealAccount;
  /** A regular member who can export the one folder she reaches, Reports. */
  everyFolder: RealAccount;
  /** A custom role with import and export, without access to all items, reaching the folders as `member` does. */
  customRole: RealAccount;
  /** A custom role with import and export and access to all items, which the server's export of the whole organization answers. */
  allItems: RealAccount;
  /** What `member` and `customRole` may export: the items in Reports, and the folder. */
  theirs: { items: string[]; folders: string[] };
};

export async function exportScenario(request: APIRequestContext, prefix: string): Promise<ExportScenario> {
  const owner = await realAccount(request, `${prefix}-owner`);
  const org = await realOrganization(request, owner, "Northwind Traders");
  const reports = await realCollection(request, owner, org, "Reports");
  const payroll = await realCollection(request, owner, org, "Payroll");
  const domainAdmins = await realCollection(request, owner, org, "Domain admins");
  const archive = await realCollection(request, owner, org, "Archive");
  const old = await realCollection(request, owner, org, "Old");

  const login = (name: string) => ({
    name,
    username: `${name.toLowerCase().replace(/\s+/g, "-")}@northwind.test`,
    password: `${name.toLowerCase().replace(/\s+/g, "-")}-password`,
    uri: "https://northwind.test",
  });
  await realLogin(request, owner, org, reports, login("Quarterly report"));
  // In a folder she may export and one she may not: what any of its folders allows.
  await realLogin(request, owner, org, [reports, payroll], login("Shared drive"));
  await realLogin(request, owner, org, payroll, login("Payroll portal"));
  await realLogin(request, owner, org, domainAdmins, login("Domain admin"));
  await realLogin(request, owner, org, archive, login("Old server"));
  // An item in no folder: its folder deleted. Only those who reach every item have it.
  await realLogin(request, owner, org, old, login("Retired router"));
  const deleted = await request.delete(`/api/organizations/${org.id}/collections/${old}`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  expect(deleted.status(), await deleted.text()).toBe(200);

  const reach = [
    grant(reports, { ...VIEW, export: true }),
    grant(payroll, VIEW),
    grant(domainAdmins, { ...NONE, viewHistory: true }),
  ];
  const member = await realAccount(request, `${prefix}-member`);
  await realMember(request, owner, org, member, reach);
  const noExport = await realAccount(request, `${prefix}-no-export`);
  await realMember(request, owner, org, noExport, [grant(payroll, VIEW)]);
  const everyFolder = await realAccount(request, `${prefix}-every-folder`);
  await realMember(request, owner, org, everyFolder, [grant(reports, { ...VIEW, export: true })]);
  const customRole = await realAccount(request, `${prefix}-custom`);
  await realMember(request, owner, org, customRole, reach, {
    type: 4,
    permissions: { accessImportExport: true },
  });
  const allItems = await realAccount(request, `${prefix}-all-items`);
  await realMember(request, owner, org, allItems, [], {
    type: 4,
    permissions: { accessImportExport: true, keykeeperAccessAllItems: true },
  });

  return {
    owner,
    org,
    everything: [
      "Domain admin",
      "Old server",
      "Payroll portal",
      "Quarterly report",
      "Retired router",
      "Shared drive",
    ],
    folders: ["Archive", "Domain admins", "Payroll", "Reports"],
    member,
    noExport,
    everyFolder,
    customRole,
    allItems,
    theirs: { items: ["Quarterly report", "Shared drive"], folders: ["Reports"] },
  };
}

/** An unencrypted .json export's item and folder names, sorted. */
export function exportedNames(exported: { items: { name: string }[]; collections: { name: string }[] }) {
  return {
    items: exported.items.map((i) => i.name).sort(),
    folders: exported.collections.map((c) => c.name).sort(),
  };
}

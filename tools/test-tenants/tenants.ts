// Who and what the test tenants are (README.md, "Who it makes"): the people,
// the organizations and their shared folders, and the items. Plain data; the
// seeder (seed.ts) encrypts all of it before anything reaches the server.
// Passwords not written here (most of them) are made at random when seeding;
// the ones written here are the weak, reused, and exposed ones the health
// views should find. Nothing here is real: the domains are under .test
// (RFC 2606), and the sites are fictional or public.

/** Someone the tool makes an account for, or only invites. */
export type Person = {
  /** The first name in lowercase: how the tool's commands and the credentials file name them. */
  key: string;
  name: string;
  domain: string;
  /** False for someone who's only invited and hasn't joined, so has no account. */
  account: boolean;
  /** An authenticator app (two-step login), set up before any role that needs it. */
  authenticator: boolean;
  /** What they are, for the credentials file. */
  about: string;
};

export const PEOPLE: Person[] = [
  // Harbor IT, the MSP.
  { key: "maya", name: "Maya Chen", domain: "harborit.test", account: true, authenticator: true, about: "Harbor IT: MSP admin, set up Harbor IT" },
  { key: "owen", name: "Owen Brooks", domain: "harborit.test", account: true, authenticator: true, about: "Harbor IT: MSP admin" },
  { key: "theo", name: "Theo Ramirez", domain: "harborit.test", account: true, authenticator: true, about: "Harbor IT: technician, every client as admin, sees install commands" },
  { key: "priya", name: "Priya Shah", domain: "harborit.test", account: true, authenticator: true, about: "Harbor IT: technician, Northwind Dental (Helpdesk custom role) and Cedar Ridge Veterinary (admin)" },
  { key: "sam", name: "Sam Whitfield", domain: "harborit.test", account: true, authenticator: true, about: "Harbor IT: technician, every client, custom role with vault items and event logs" },
  { key: "jordan", name: "Jordan Blake", domain: "harborit.test", account: false, authenticator: false, about: "Harbor IT: invited to the staff, hasn't joined" },
  // Northwind Dental.
  { key: "grace", name: "Grace Liu", domain: "northwind-dental.test", account: true, authenticator: true, about: "Northwind Dental: owner" },
  { key: "marcus", name: "Marcus Reed", domain: "northwind-dental.test", account: true, authenticator: true, about: "Northwind Dental: admin (office manager)" },
  { key: "lena", name: "Lena Fischer", domain: "northwind-dental.test", account: true, authenticator: true, about: "Northwind Dental: custom role (manage members, view event logs)" },
  { key: "tom", name: "Tom Alvarez", domain: "northwind-dental.test", account: true, authenticator: false, about: "Northwind Dental: member (front desk)" },
  { key: "aisha", name: "Aisha Patel", domain: "northwind-dental.test", account: true, authenticator: true, about: "Northwind Dental: member (hygienist), two-step login by choice" },
  { key: "ben", name: "Ben Carter", domain: "northwind-dental.test", account: true, authenticator: false, about: "Northwind Dental: member, revoked" },
  { key: "casey", name: "Casey Nguyen", domain: "northwind-dental.test", account: false, authenticator: false, about: "Northwind Dental: invited, hasn't joined" },
  // Bluebird Law.
  { key: "elena", name: "Elena Rossi", domain: "bluebird-law.test", account: true, authenticator: true, about: "Bluebird Law: owner" },
  { key: "noah", name: "Noah Bennett", domain: "bluebird-law.test", account: true, authenticator: true, about: "Bluebird Law: admin" },
  { key: "chloe", name: "Chloe Martin", domain: "bluebird-law.test", account: true, authenticator: true, about: "Bluebird Law: member" },
  { key: "liam", name: "Liam Walsh", domain: "bluebird-law.test", account: true, authenticator: false, about: "Bluebird Law: accepted without two-step login, so waiting" },
  // Cedar Ridge Veterinary.
  { key: "ravi", name: "Ravi Menon", domain: "cedar-vet.test", account: true, authenticator: true, about: "Cedar Ridge Veterinary: owner" },
  { key: "jess", name: "Jess Taylor", domain: "cedar-vet.test", account: true, authenticator: false, about: "Cedar Ridge Veterinary: member" },
  { key: "kai", name: "Kai Anderson", domain: "cedar-vet.test", account: true, authenticator: false, about: "Cedar Ridge Veterinary: member with weak, reused, and exposed passwords of his own" },
  // Pinecrest Construction.
  { key: "frank", name: "Frank Delgado", domain: "pinecrest-build.test", account: true, authenticator: true, about: "Pinecrest Construction: owner" },
  { key: "rosa", name: "Rosa Martinez", domain: "pinecrest-build.test", account: true, authenticator: true, about: "Pinecrest Construction: admin (office)" },
  { key: "mike", name: "Mike O'Neill", domain: "pinecrest-build.test", account: true, authenticator: false, about: "Pinecrest Construction: member (site lead, Field crew)" },
  { key: "dana", name: "Dana Kowalski", domain: "pinecrest-build.test", account: true, authenticator: false, about: "Pinecrest Construction: member (estimator, Office)" },
  { key: "luis", name: "Luis Ortega", domain: "pinecrest-build.test", account: true, authenticator: false, about: "Pinecrest Construction: member (Field crew)" },
  { key: "ivy", name: "Ivy Park", domain: "pinecrest-build.test", account: true, authenticator: true, about: "Pinecrest Construction: member (accounts payable, Office)" },
  { key: "greg", name: "Greg Hollis", domain: "pinecrest-build.test", account: true, authenticator: false, about: "Pinecrest Construction: member, revoked" },
  // Summit Accounting.
  { key: "nora", name: "Nora Feld", domain: "summit-cpa.test", account: true, authenticator: false, about: "Summit Accounting: owner (no rule asks her for two-step login)" },
  { key: "paul", name: "Paul Grant", domain: "summit-cpa.test", account: true, authenticator: false, about: "Summit Accounting: member" },
  // The Rivera Family.
  { key: "carmen", name: "Carmen Rivera", domain: "rivera-family.test", account: true, authenticator: false, about: "The Rivera Family: owner; Diego is her legacy contact" },
  { key: "diego", name: "Diego Rivera", domain: "rivera-family.test", account: true, authenticator: true, about: "The Rivera Family: admin; also a member of Summit Accounting" },
  { key: "sofia", name: "Sofia Rivera", domain: "rivera-family.test", account: true, authenticator: false, about: "The Rivera Family: member (a teenager)" },
  { key: "marisol", name: "Marisol Rivera", domain: "rivera-family.test", account: false, authenticator: false, about: "The Rivera Family: invited, hasn't joined" },
  // On their own.
  { key: "alex", name: "Alex Morgan", domain: "morgan-home.test", account: true, authenticator: false, about: "On their own: a personal account with no organization" },
];

/** first.last@domain, as the README says, without apostrophes. */
export function emailOf(person: Person): string {
  const local = person.name.toLowerCase().replace(/'/g, "").split(/\s+/).join(".");
  return `${local}@${person.domain}`;
}

export function person(key: string): Person {
  const found = PEOPLE.find((p) => p.key === key);
  if (!found) {
    throw new Error(`No one called ${key} in the test tenants`);
  }
  return found;
}

/** Every email domain the tenants use, for SIGNUPS_DOMAINS_WHITELIST. */
export const DOMAINS = [...new Set(PEOPLE.map((p) => p.domain))];

// What someone can do in a shared folder (DESIGN.md, "Folders and permissions").
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
/** The access selector's presets. */
export const PRESETS = {
  view: { ...NONE, seePasswords: true, print: true, viewHistory: true },
  viewHidden: { ...NONE, viewHistory: true },
  edit: { ...NONE, seePasswords: true, create: true, edit: true, delete: true, share: true, print: true, viewHistory: true },
  manage: { seePasswords: true, create: true, edit: true, delete: true, export: true, share: true, print: true, viewHistory: true, manage: true },
} satisfies Record<string, Grid>;
type Access = keyof typeof PRESETS | Grid;

export type FieldSpec = { name: string; value: string; type: "text" | "hidden" | "boolean" };

/** An item. Strings are what the person sees; the seeder encrypts each. */
export type ItemSpec = {
  name: string;
  /** Shared folders it's in (an organization's items), or the personal folder (someone's own). */
  folders?: string[];
  folder?: string;
  /** Who saved its current version: the organization's creator if left out (in someone's own vault, them). */
  by?: string;
  notes?: string;
  fields?: FieldSpec[];
  /** Expires this many days from the day it's seeded (negative: already expired). */
  expires?: number;
  /** keykeeper.remind: days before, comma-separated. */
  remind?: string;
  /** Made from this built-in template (libs/common/src/vault/keykeeper/templates.ts in the clients). */
  template?: { id: string; name: string };
  /** Made from a custom template defined by name in the same organization or vault. */
  fromTemplate?: string;
  /** A custom template: its base type. The item is a secure note. */
  defines?: "login" | "note";
  /**
   * Its earlier versions, oldest first (the first is when it was made), each
   * saved by `by` (the item's own `by` if left out), with its password (made
   * at random if left out) and notes (the item's if left out).
   */
  history?: { password?: string; by?: string; notes?: string }[];
  favorite?: boolean;
  reprompt?: boolean;
  trash?: boolean;
} & (
  | {
      type: "login";
      /** Left out: made at random. */
      password?: string;
      username?: string;
      uris?: string[];
      /** A one-time code's key, made at random. */
      totp?: boolean;
      /** A passkey for this site, made on this computer. */
      passkey?: { rpId: string; userName: string };
    }
  | { type: "note" }
  | {
      type: "card";
      cardholderName: string;
      brand: string;
      number: string;
      code: string;
      /** Months from the seeding month (0: this month; negative: expired). */
      expiresInMonths: number;
    }
  | { type: "identity"; identity: Record<string, string> }
  | { type: "ssh" }
  | { type: "bank"; bank: Record<string, string> }
  | { type: "license"; license: Record<string, string> }
  | { type: "passport"; passport: Record<string, string> }
);

export type Member = {
  key: string;
  role: "owner" | "admin" | "user" | "custom";
  /** A custom role's permissions (manageUsers, manageResetPassword, managePolicies, accessEventLogs, accessImportExport). */
  permissions?: Record<string, boolean>;
  /** Their folders, directly. */
  access?: Record<string, Access>;
  /** revoked: confirmed, then revoked. invited: no account, hasn't joined. waiting: accepted, not let in. */
  state?: "revoked" | "invited" | "waiting";
};

export type FolderSpec = { name: string; icon?: string; tone?: string };

export type OrgSpec = {
  key: string;
  name: string;
  kind: "client" | "internal" | "family";
  /** For clients: the Business preset (the MSP's default policies), or none. */
  preset?: "business" | "none";
  /** Who makes it: Maya for Harbor IT's clients and its own organization. */
  creator: string;
  /** The folder made with it: Everyone for a client, or the family's first. */
  firstFolder: string;
  folders: FolderSpec[];
  members: Member[];
  groups?: { name: string; members: string[]; access: Record<string, Access> }[];
  items: ItemSpec[];
  /** Who deletes it at teardown: an owner of its own (an MSP's people can't delete a client with owners). */
  deleteAs: string;
};

const custom = (grid: Partial<Grid>): Grid => ({ ...NONE, ...grid });

/** Template fields, as a template's editor makes them. */
const text = (name: string, value = ""): FieldSpec => ({ name, value, type: "text" });
const hidden = (name: string, value = ""): FieldSpec => ({ name, value, type: "hidden" });
const yesNo = (name: string, value = "false"): FieldSpec => ({ name, value, type: "boolean" });

// Well-known breached passwords (in Have I Been Pwned), and weak ones, for
// the health views. Reused ones are used by more than one item.
/** A value made at random when seeding (an API key's key, say). */
export const RANDOM = "<random>";

export const WEAK = {
  exposed1: "Password123!",
  exposed2: "Summer2023!",
  exposed3: "qwerty123",
  exposed4: "letmein1",
  weak1: "northwind1",
  weak2: "pinecrest",
  weak3: "kai12345",
  reusedDental: "Smile2024!",
  reusedBuild: "Build2023!",
  reusedKai: "Fluffy2019!",
  reusedTom: "Tommy88!",
  reusedAlex: "Morgan#2021",
} as const;

export const ORGS: OrgSpec[] = [
  {
    key: "harbor",
    name: "Harbor IT",
    kind: "internal",
    creator: "maya",
    firstFolder: "Vendor portals",
    deleteAs: "maya",
    folders: [
      { name: "Vendor portals", icon: "globe", tone: "sapphire" },
      { name: "RMM and tools", icon: "terminal", tone: "turquoise" },
      { name: "Client templates", icon: "note", tone: "amethyst" },
      { name: "Harbor IT finance", icon: "bank", tone: "emerald" },
    ],
    members: [
      { key: "owen", role: "owner" },
      { key: "theo", role: "user", access: { "Vendor portals": "edit", "RMM and tools": "view" } },
      { key: "priya", role: "user", access: { "Vendor portals": "edit", "RMM and tools": "view" } },
      { key: "sam", role: "user", access: { "Vendor portals": "view", "RMM and tools": "view" } },
    ],
    items: [
      { type: "login", name: "Distributor portal", folders: ["Vendor portals"], username: "orders@harborit.test", uris: ["https://partners.example-distributor.test"], totp: true, history: [{ by: "owen" }, { by: "maya" }] },
      { type: "login", name: "Microsoft Partner Center", folders: ["Vendor portals"], username: "maya.chen@harborit.test", uris: ["https://partner.microsoft.com"], totp: true },
      { type: "login", name: "Domain registrar", folders: ["Vendor portals"], username: "harborit", uris: ["https://www.namecheap.com"], expires: 12, notes: "Client domains renew in bulk in December." },
      { type: "login", name: "RMM console", folders: ["RMM and tools"], username: "maya.chen", uris: ["https://rmm.harborit.test"], totp: true },
      { type: "login", name: "Backup appliance", folders: ["RMM and tools"], username: "admin", uris: ["https://10.20.0.15"], template: { id: "server", name: "Server" }, fields: [text("Hostname", "backup01.harborit.local"), text("Port", "443"), text("Operating system", "Ubuntu 24.04")] },
      { type: "ssh", name: "Backup server deploy key", folders: ["RMM and tools"], notes: "Used by the nightly offsite sync." },
      { type: "note", name: "Wildcard certificate", folders: ["RMM and tools"], expires: 9, template: { id: "certificate", name: "Certificate" }, fields: [text("Common name", "*.harborit.test"), text("Issuer", "Let's Encrypt"), hidden("Private key", "")] },
      { type: "note", name: "Firewall", folders: ["Client templates"], defines: "login", fields: [text("Model"), text("Firmware version"), text("Management URL"), hidden("Pre-shared key"), yesNo("HA pair")] },
      { type: "note", name: "Microsoft 365 tenant", folders: ["Client templates"], defines: "note", fields: [text("Tenant name"), text("Tenant ID"), text("Primary domain"), text("Break-glass account"), hidden("Break-glass password")] },
      { type: "note", name: "Line-of-business app", folders: ["Client templates"], defines: "login", fields: [text("Vendor"), text("Support phone"), hidden("License key")] },
      { type: "card", name: "Harbor IT Amex", folders: ["Harbor IT finance"], cardholderName: "Maya Chen", brand: "Amex", number: "378282246310005", code: "1234", expiresInMonths: 14 },
      { type: "bank", name: "Operating account", folders: ["Harbor IT finance"], bank: { bankName: "First Harbor Bank", nameOnAccount: "Harbor IT LLC", accountType: "Checking", accountNumber: "000123456789", routingNumber: "021000021", bankContactPhone: "555-0100" } },
    ],
  },
  {
    key: "northwind",
    name: "Northwind Dental",
    kind: "client",
    preset: "business",
    creator: "maya",
    firstFolder: "Everyone",
    deleteAs: "grace",
    folders: [
      { name: "Front desk", icon: "people", tone: "aquamarine" },
      { name: "Practice software", icon: "desktop", tone: "turquoise" },
      { name: "Banking and payroll", icon: "bank", tone: "emerald" },
      { name: "Vendors", icon: "globe", tone: "gold" },
    ],
    members: [
      { key: "grace", role: "owner" },
      { key: "marcus", role: "admin", access: { "Banking and payroll": "manage" } },
      { key: "lena", role: "custom", permissions: { manageUsers: true, accessEventLogs: true }, access: { Everyone: "edit" } },
      { key: "tom", role: "user", access: { Everyone: "edit", Vendors: custom({ seePasswords: true, create: true, edit: true, viewHistory: true }) } },
      { key: "aisha", role: "user", access: { Everyone: "edit", Vendors: "view" } },
      { key: "ben", role: "user", access: { Everyone: "edit", "Front desk": "edit" }, state: "revoked" },
      { key: "casey", role: "user", access: { Everyone: "edit" }, state: "invited" },
    ],
    groups: [
      { name: "Front desk", members: ["tom", "lena"], access: { "Front desk": "edit", "Practice software": "viewHidden" } },
      { name: "Clinical", members: ["grace", "aisha"], access: { "Practice software": "view" } },
    ],
    items: [
      { type: "login", name: "Dentrix Ascend", folders: ["Practice software"], by: "grace", username: "frontoffice@northwind-dental.test", uris: ["https://live.dentrixascend.com"], totp: true, history: [{ by: "grace" }, { by: "marcus" }] },
      { type: "login", name: "Imaging workstation", folders: ["Practice software"], by: "marcus", username: "xray", password: WEAK.weak1, uris: ["https://10.1.1.40"] },
      { type: "login", name: "Patient portal admin", folders: ["Practice software"], username: "admin", password: WEAK.reusedDental, uris: ["https://portal.northwind-dental.test"] },
      { type: "login", name: "Front desk PC", folders: ["Front desk"], by: "marcus", username: "frontdesk", password: WEAK.exposed1, notes: "Shared Windows login at reception." },
      { type: "login", name: "Insurance eligibility", folders: ["Front desk"], username: "northwind-dental", password: WEAK.reusedDental, uris: ["https://www.availity.com"] },
      { type: "login", name: "Appointment reminders", folders: ["Front desk"], username: "grace.liu@northwind-dental.test", password: WEAK.reusedDental, uris: ["https://app.weave.test"] },
      { type: "note", name: "Office Wi-Fi", folders: ["Everyone"], template: { id: "wifi", name: "Wi-Fi network" }, fields: [text("Network name", "Northwind-Staff"), hidden("Password", "smile-bright-molar-42"), text("Security type", "WPA3")] },
      { type: "note", name: "Alarm codes", folders: ["Everyone"], notes: "Front door: 4417, then # within 30 seconds.\nBack door is on the same panel." },
      { type: "login", name: "Payroll", folders: ["Banking and payroll"], by: "marcus", username: "marcus.reed@northwind-dental.test", uris: ["https://payroll.example-payroll.test"], totp: true, reprompt: true },
      { type: "bank", name: "Practice checking", folders: ["Banking and payroll"], bank: { bankName: "Northwind Community Bank", nameOnAccount: "Northwind Dental PC", accountType: "Checking", accountNumber: "004455667788", routingNumber: "011000015", pin: "8642" } },
      { type: "card", name: "Practice Visa", folders: ["Banking and payroll"], cardholderName: "Grace Liu", brand: "Visa", number: "4111111111111111", code: "737", expiresInMonths: 0 },
      { type: "login", name: "Dental supply orders", folders: ["Vendors"], username: "orders@northwind-dental.test", uris: ["https://www.henryschein.com"], history: [{ by: "tom" }] },
      { type: "login", name: "Lab cases", folders: ["Vendors"], username: "northwind", password: WEAK.exposed2, uris: ["https://lab.example-lab.test"] },
      { type: "note", name: "Practice domain", folders: ["Admins"], expires: 20, template: { id: "domain", name: "Domain" }, fields: [text("Domain name", "northwind-dental.test"), text("Registrar", "Namecheap"), yesNo("Auto-renew", "false")] },
      { type: "note", name: "Website certificate", folders: ["Admins"], expires: -10, template: { id: "certificate", name: "Certificate" }, fields: [text("Common name", "www.northwind-dental.test"), text("Issuer", "Sectigo"), hidden("Private key", "")] },
    ],
  },
  {
    key: "bluebird",
    name: "Bluebird Law",
    kind: "client",
    preset: "business",
    creator: "maya",
    firstFolder: "Everyone",
    deleteAs: "elena",
    folders: [
      { name: "Court e-filing", icon: "license", tone: "amethyst" },
      { name: "Client portals", icon: "lock", tone: "garnet" },
    ],
    members: [
      { key: "elena", role: "owner" },
      { key: "noah", role: "admin" },
      { key: "chloe", role: "user", access: { Everyone: "edit", "Court e-filing": "edit", "Client portals": "viewHidden" } },
      { key: "liam", role: "user", access: { Everyone: "edit" }, state: "waiting" },
    ],
    items: [
      { type: "login", name: "State e-filing", folders: ["Court e-filing"], by: "elena", username: "erossi", uris: ["https://efile.courts.example.test"], totp: true, expires: 45, notes: "Bar number on file. Renew the e-filing certificate every year." },
      { type: "login", name: "PACER", folders: ["Court e-filing"], username: "bluebirdlaw", uris: ["https://pacer.uscourts.gov"], history: [{ by: "noah" }, { by: "chloe" }] },
      { type: "login", name: "Clio", folders: ["Everyone"], username: "office@bluebird-law.test", uris: ["https://app.clio.com"], totp: true },
      { type: "login", name: "Westlaw", folders: ["Everyone"], username: "bluebird-law", uris: ["https://www.westlaw.com"] },
      { type: "login", name: "Harper estate bank portal", folders: ["Client portals"], username: "harper.trust", uris: ["https://online.example-bank.test"], notes: "Trustee access only. Log every visit in the matter." },
      { type: "login", name: "Okafor family trust", folders: ["Client portals"], username: "okafor.trust", uris: ["https://trust.example-bank.test"] },
      { type: "note", name: "Office Wi-Fi", folders: ["Everyone"], template: { id: "wifi", name: "Wi-Fi network" }, fields: [text("Network name", "Bluebird"), hidden("Password", "objection-sustained-1987"), text("Security type", "WPA2")] },
    ],
  },
  {
    key: "cedar",
    name: "Cedar Ridge Veterinary",
    kind: "client",
    preset: "business",
    creator: "maya",
    firstFolder: "Everyone",
    deleteAs: "ravi",
    folders: [
      { name: "Clinic systems", icon: "server", tone: "turquoise" },
      { name: "Suppliers", icon: "card", tone: "topaz" },
    ],
    members: [
      { key: "ravi", role: "owner" },
      { key: "jess", role: "user", access: { Everyone: "edit", "Clinic systems": "edit", Suppliers: "view" } },
      { key: "kai", role: "user", access: { Everyone: "edit", "Clinic systems": "view" } },
    ],
    items: [
      { type: "login", name: "Practice management", folders: ["Clinic systems"], by: "ravi", username: "cedarridge", uris: ["https://cedar.example-vetsoftware.test"], totp: true },
      { type: "login", name: "Lab results", folders: ["Clinic systems"], username: "cedar-vet", password: WEAK.exposed2, uris: ["https://results.example-lab.test"] },
      { type: "login", name: "Pharmacy orders", folders: ["Suppliers"], username: "orders@cedar-vet.test", uris: ["https://orders.example-pharmacy.test"], history: [{ by: "ravi" }] },
      { type: "note", name: "Anesthesia machine service", folders: ["Clinic systems"], expires: 5, remind: "30,7,1", notes: "Annual service due. Call the vendor to book." },
      { type: "note", name: "Clinic Wi-Fi", folders: ["Everyone"], template: { id: "wifi", name: "Wi-Fi network" }, fields: [text("Network name", "CedarRidge-Staff"), hidden("Password", "good-dog-sit-stay-9"), text("Security type", "WPA2")] },
      { type: "note", name: "Line-of-business app license", folders: ["Clinic systems"], template: { id: "software-license", name: "Software license" }, fields: [hidden("License key", "CRV-2207-5513-9910"), text("Licensed to", "Cedar Ridge Veterinary"), text("Version", "12.4"), text("Purchase date", "2025-03-01")], expires: 110 },
    ],
  },
  {
    key: "pinecrest",
    name: "Pinecrest Construction",
    kind: "client",
    preset: "business",
    creator: "maya",
    firstFolder: "Everyone",
    deleteAs: "frank",
    folders: [
      { name: "Job sites", icon: "wifi", tone: "gold" },
      { name: "Fuel and company cards", icon: "card", tone: "topaz" },
      { name: "Suppliers", icon: "globe", tone: "sapphire" },
      { name: "Equipment rental", icon: "key", tone: "onyx" },
    ],
    members: [
      { key: "frank", role: "owner" },
      { key: "rosa", role: "admin" },
      { key: "mike", role: "user", access: { Everyone: "edit", "Equipment rental": "edit" } },
      { key: "dana", role: "user", access: { Everyone: "edit", Suppliers: "edit" } },
      { key: "luis", role: "user", access: { Everyone: "edit" } },
      { key: "ivy", role: "user", access: { Everyone: "edit", Suppliers: "view" } },
      { key: "greg", role: "user", access: { Everyone: "edit", "Job sites": "edit" }, state: "revoked" },
    ],
    groups: [
      { name: "Field crew", members: ["mike", "luis"], access: { "Job sites": "edit", "Fuel and company cards": "viewHidden" } },
      { name: "Office", members: ["rosa", "dana", "ivy"], access: { "Fuel and company cards": "edit", "Job sites": "view" } },
    ],
    items: [
      { type: "note", name: "Maple Street site Wi-Fi", folders: ["Job sites"], template: { id: "wifi", name: "Wi-Fi network" }, fields: [text("Network name", "PINECREST-MAPLE"), hidden("Password", WEAK.weak2), text("Security type", "WPA2")] },
      { type: "login", name: "Maple Street site router", folders: ["Job sites"], username: "admin", password: WEAK.weak2, uris: ["http://192.168.8.1"], template: { id: "router", name: "Router" }, fields: [text("Network name", "PINECREST-MAPLE"), hidden("Wi-Fi password", WEAK.weak2)] },
      { type: "note", name: "Site gate codes", folders: ["Job sites"], by: "mike", notes: "Maple Street: 2580\nRiverside: 1397 (changes monthly)", history: [{ by: "mike", notes: "Maple Street: 2580\nRiverside: 4410" }] },
      { type: "card", name: "Fuel card, truck 12", folders: ["Fuel and company cards"], cardholderName: "Pinecrest Construction", brand: "Mastercard", number: "5555555555554444", code: "321", expiresInMonths: 1 },
      { type: "card", name: "Company Amex", folders: ["Fuel and company cards"], by: "rosa", cardholderName: "Frank Delgado", brand: "Amex", number: "371449635398431", code: "4321", expiresInMonths: 26, reprompt: true },
      { type: "bank", name: "Payroll account", folders: ["Fuel and company cards"], bank: { bankName: "Pinecrest Federal Credit Union", nameOnAccount: "Pinecrest Construction Inc", accountType: "Checking", accountNumber: "7788990011", routingNumber: "122105155", swiftCode: "PFCUUS44", bankContactPhone: "555-0142" } },
      { type: "login", name: "Home Depot Pro", folders: ["Suppliers"], by: "dana", username: "purchasing@pinecrest-build.test", password: WEAK.reusedBuild, uris: ["https://www.homedepot.com"], history: [{ by: "rosa" }] },
      { type: "login", name: "Lumber yard account", folders: ["Suppliers"], username: "pinecrest", password: WEAK.reusedBuild, uris: ["https://orders.example-lumber.test"] },
      { type: "login", name: "Concrete supplier", folders: ["Suppliers"], username: "pinecrest", password: WEAK.exposed2, uris: ["https://portal.example-concrete.test"] },
      { type: "login", name: "Old supplier portal", folders: ["Suppliers"], username: "pinecrest", password: WEAK.reusedBuild, uris: ["https://old.example-supplier.test"], trash: true },
      { type: "login", name: "Equipment rental", folders: ["Equipment rental"], username: "pinecrest-build", uris: ["https://www.unitedrentals.com"], totp: true },
      { type: "note", name: "Contractor license", folders: ["Everyone"], expires: 5, remind: "90,30,7,1", notes: "State general contractor license. Renewal needs proof of insurance." },
      { type: "login", name: "Timesheets", folders: ["Everyone"], username: "crew@pinecrest-build.test", password: WEAK.exposed3, uris: ["https://app.example-timesheets.test"] },
    ],
  },
  {
    key: "summit",
    name: "Summit Accounting",
    kind: "client",
    preset: "none",
    creator: "maya",
    firstFolder: "Everyone",
    deleteAs: "nora",
    folders: [{ name: "Tax software", icon: "coins", tone: "emerald" }],
    members: [
      { key: "nora", role: "owner" },
      { key: "paul", role: "user", access: { Everyone: "edit", "Tax software": "edit" } },
      { key: "diego", role: "user", access: { Everyone: "edit", "Tax software": "view" } },
    ],
    items: [
      { type: "login", name: "Tax preparation software", folders: ["Tax software"], by: "nora", username: "summit-cpa", uris: ["https://tax.example-taxsoftware.test"], totp: true, expires: 60, history: [{ by: "paul" }] },
      { type: "login", name: "IRS e-Services", folders: ["Tax software"], username: "nfeld", uris: ["https://la.www4.irs.gov"] },
      { type: "note", name: "Office Wi-Fi", folders: ["Everyone"], template: { id: "wifi", name: "Wi-Fi network" }, fields: [text("Network name", "Summit"), hidden("Password", "debits-and-credits-77"), text("Security type", "WPA2")] },
    ],
  },
  {
    key: "rivera",
    name: "The Rivera Family",
    kind: "family",
    creator: "carmen",
    firstFolder: "Household",
    deleteAs: "carmen",
    folders: [
      { name: "Household", icon: "people", tone: "ruby" },
      { name: "Streaming and kids", icon: "star", tone: "amethyst" },
      { name: "Money", icon: "bank", tone: "emerald" },
      { name: "Travel documents", icon: "identity", tone: "aquamarine" },
    ],
    members: [
      { key: "diego", role: "admin" },
      { key: "sofia", role: "user", access: { Household: "edit", "Streaming and kids": "view", "Travel documents": "viewHidden" } },
      { key: "marisol", role: "user", access: { Household: "edit" }, state: "invited" },
    ],
    items: [
      { type: "login", name: "Netflix", folders: ["Streaming and kids"], username: "rivera.family@rivera-family.test", uris: ["https://www.netflix.com"], history: [{ by: "diego" }, { by: "carmen" }] },
      { type: "login", name: "Disney+", folders: ["Streaming and kids"], username: "rivera.family@rivera-family.test", uris: ["https://www.disneyplus.com"] },
      { type: "login", name: "School portal (Sofia)", folders: ["Streaming and kids"], username: "srivera", uris: ["https://portal.example-school.test"], fromTemplate: "School account", fields: [text("Student ID", "20931"), text("Teacher", "Ms. Okafor"), text("Grade", "10")] },
      { type: "note", name: "School account", folders: ["Household"], defines: "login", fields: [text("Student ID"), text("Teacher"), text("Grade")] },
      { type: "note", name: "Home Wi-Fi", folders: ["Household"], template: { id: "wifi", name: "Wi-Fi network" }, fields: [text("Network name", "Rivera-Home"), hidden("Password", "casa-azul-sunflower-6"), text("Security type", "WPA3")] },
      { type: "note", name: "House alarm", folders: ["Household"], notes: "Code 1958. Monitoring company: 555-0177." },
      { type: "login", name: "Mortgage", folders: ["Money"], username: "crivera", uris: ["https://www.example-mortgage.test"], reprompt: true },
      { type: "card", name: "Family Visa", folders: ["Money"], cardholderName: "Carmen Rivera", brand: "Visa", number: "4000056655665556", code: "456", expiresInMonths: 2 },
      { type: "passport", name: "Carmen's passport", folders: ["Travel documents"], passport: { givenName: "Carmen", surname: "Rivera", passportNumber: "X12345678", nationality: "United States", issuingCountry: "United States", dateOfBirth: "1981-04-17", sex: "F", birthPlace: "San Antonio, Texas", issueDate: "2017-02-10", expirationDate: "2027-02-09", passportType: "P" }, expires: 85 },
      { type: "passport", name: "Sofia's passport", folders: ["Travel documents"], passport: { givenName: "Sofia", surname: "Rivera", passportNumber: "X87654321", nationality: "United States", issuingCountry: "United States", dateOfBirth: "2010-09-03", sex: "F", issueDate: "2021-06-01", expirationDate: "2026-06-01", passportType: "P" }, expires: -160 },
      { type: "identity", name: "Carmen Rivera", folders: ["Travel documents"], identity: { title: "Ms", firstName: "Carmen", lastName: "Rivera", email: "carmen.rivera@rivera-family.test", phone: "555-0123", address1: "214 Alder Lane", city: "Austin", state: "TX", postalCode: "78704", country: "US", ssn: "078-05-1120" } },
    ],
  },
];

/** Things someone keeps in their own vault (personal folders, then items). */
export type OwnVault = { folders?: string[]; items: ItemSpec[] };

export const OWN: Record<string, OwnVault> = {
  alex: {
    folders: ["Banking", "Shopping", "Social", "Work", "Home"],
    items: [
      { type: "login", name: "Chase", folder: "Banking", username: "alexmorgan", uris: ["https://www.chase.com"], totp: true, favorite: true, reprompt: true, history: [{}, {}] },
      { type: "login", name: "Ally Bank", folder: "Banking", username: "alex.morgan", password: WEAK.reusedAlex, uris: ["https://www.ally.com"] },
      { type: "login", name: "Amazon", folder: "Shopping", username: "alex.morgan@morgan-home.test", password: WEAK.reusedAlex, uris: ["https://www.amazon.com"], favorite: true },
      { type: "login", name: "eBay", folder: "Shopping", username: "alexm", password: WEAK.exposed1, uris: ["https://www.ebay.com"] },
      { type: "login", name: "Target", folder: "Shopping", username: "alex.morgan@morgan-home.test", password: WEAK.reusedAlex, uris: ["https://www.target.com"] },
      { type: "login", name: "Instagram", folder: "Social", username: "alex.morgan", uris: ["https://www.instagram.com"], totp: true },
      { type: "login", name: "Reddit", folder: "Social", username: "alex_m", password: WEAK.exposed4, uris: ["https://www.reddit.com"] },
      { type: "login", name: "webauthn.io", folder: "Social", username: "alex.morgan", uris: ["https://webauthn.io"], passkey: { rpId: "webauthn.io", userName: "alex.morgan" }, notes: "Its passkey was made by the test tenants tool, so webauthn.io doesn't know it. Register a new passkey there to try signing in with one." },
      { type: "login", name: "GitHub", folder: "Work", username: "alexmorgan", uris: ["https://github.com"], totp: true, favorite: true },
      { type: "login", name: "Work email", folder: "Work", username: "alex.morgan@morgan-home.test", uris: ["https://outlook.office.com"], template: { id: "email-account", name: "Email account" }, fields: [text("Incoming server", "outlook.office365.com"), text("Outgoing server", "smtp.office365.com"), text("Port", "587")] },
      { type: "note", name: "Personal API key", folder: "Work", template: { id: "api-key", name: "API key" }, fields: [hidden("Key", RANDOM), hidden("Secret", RANDOM), text("Service URL", "https://api.example-weather.test"), text("Scopes", "read")], expires: 25 },
      { type: "login", name: "Home lab database", folder: "Home", username: "postgres", uris: ["https://nas.local:5432"], template: { id: "database", name: "Database" }, fields: [text("Type", "PostgreSQL"), text("Hostname", "nas.local"), text("Port", "5432"), text("Database name", "homeassistant")] },
      { type: "ssh", name: "Home lab", folder: "Home" },
      { type: "note", name: "Home Wi-Fi", folder: "Home", template: { id: "wifi", name: "Wi-Fi network" }, fields: [text("Network name", "Morgan-5G"), hidden("Password", "maple-syrup-on-pancakes-3"), text("Security type", "WPA3")] },
      { type: "note", name: "Gym membership", folder: "Home", defines: "note", fields: [text("Gym"), text("Member number"), hidden("Locker code")] },
      { type: "note", name: "Riverside Fitness", folder: "Home", fromTemplate: "Gym membership", fields: [text("Gym", "Riverside Fitness"), text("Member number", "RF-20931"), hidden("Locker code", "3317")] },
      { type: "note", name: "Library card", folder: "Home", template: { id: "membership", name: "Membership" }, fields: [text("Organization", "City Public Library"), text("Member ID", "29876005512"), text("Phone", "555-0199")] },
      { type: "note", name: "Recovery codes", notes: "Email: 4kq2-9xme, h7td-2b8w, p3vn-6jzr" },
      { type: "card", name: "Mastercard", folder: "Banking", cardholderName: "Alex Morgan", brand: "Mastercard", number: "5105105105105100", code: "123", expiresInMonths: -1 },
      { type: "card", name: "Visa debit", folder: "Banking", cardholderName: "Alex Morgan", brand: "Visa", number: "4242424242424242", code: "424", expiresInMonths: 30, favorite: true },
      { type: "identity", name: "Alex Morgan", identity: { firstName: "Alex", lastName: "Morgan", email: "alex.morgan@morgan-home.test", phone: "555-0161", address1: "88 Birch Street", address2: "Apt 4", city: "Portland", state: "OR", postalCode: "97205", country: "US", company: "Morgan Design" } },
      { type: "bank", name: "Checking", folder: "Banking", bank: { bankName: "Columbia River Bank", nameOnAccount: "Alex Morgan", accountType: "Checking", accountNumber: "1029384756", routingNumber: "123006800", iban: "", pin: "2468" } },
      { type: "license", name: "Driver's license", license: { firstName: "Alex", lastName: "Morgan", licenseNumber: "D1234567", issuingState: "OR", issuingCountry: "United States", dateOfBirth: "1990-07-22", issueDate: "2022-07-22", expirationDate: "2030-07-22", licenseClass: "C" } },
      { type: "passport", name: "Passport", passport: { givenName: "Alex", surname: "Morgan", passportNumber: "Z55501234", nationality: "United States", issuingCountry: "United States", dateOfBirth: "1990-07-22", sex: "X", issueDate: "2016-12-01", expirationDate: "2026-12-01", passportType: "P" }, expires: 22 },
      { type: "login", name: "Old Yahoo account", username: "alexmorgan90", password: WEAK.exposed3, uris: ["https://login.yahoo.com"], trash: true },
    ],
  },
  kai: {
    items: [
      { type: "login", name: "Gmail", username: "kai.anderson@cedar-vet.test", password: WEAK.reusedKai, uris: ["https://mail.google.com"] },
      { type: "login", name: "Facebook", username: "kai.anderson", password: WEAK.reusedKai, uris: ["https://www.facebook.com"] },
      { type: "login", name: "Spotify", username: "kaiand", password: WEAK.reusedKai, uris: ["https://open.spotify.com"] },
      { type: "login", name: "Xbox", username: "kai_a", password: WEAK.weak3, uris: ["https://www.xbox.com"] },
      { type: "login", name: "Pizza place", username: "kai.anderson", password: WEAK.exposed3, uris: ["https://order.example-pizza.test"] },
      { type: "login", name: "Bank", username: "kaianderson", uris: ["https://www.example-credit-union.test"] },
    ],
  },
  tom: {
    items: [
      { type: "login", name: "Personal email", username: "tom.alvarez@northwind-dental.test", password: WEAK.reusedTom, uris: ["https://mail.example-mail.test"] },
      { type: "login", name: "Fantasy football", username: "talvarez", password: WEAK.reusedTom, uris: ["https://fantasy.example-sports.test"] },
    ],
  },
  aisha: { items: [{ type: "login", name: "Continuing education", username: "apatel", uris: ["https://ce.example-dental-ce.test"], expires: 40 }] },
  grace: { items: [{ type: "login", name: "Dental association", username: "gliu", uris: ["https://www.ada.org"] }] },
  jess: { items: [{ type: "login", name: "Personal email", username: "jess.taylor", uris: ["https://mail.example-mail.test"] }] },
  mike: { items: [{ type: "login", name: "OSHA training", username: "moneill", uris: ["https://training.example-osha.test"], expires: 18 }] },
  carmen: {
    folders: ["Work"],
    items: [
      { type: "login", name: "Work email", folder: "Work", username: "carmen@example-employer.test", uris: ["https://outlook.office.com"] },
      { type: "license", name: "Driver's license", license: { firstName: "Carmen", lastName: "Rivera", licenseNumber: "TX40021234", issuingState: "TX", issuingCountry: "United States", dateOfBirth: "1981-04-17", expirationDate: "2029-04-17", licenseClass: "C" } },
    ],
  },
  sofia: { items: [{ type: "login", name: "Minecraft", username: "sofia_builds", uris: ["https://www.minecraft.net"] }] },
  diego: { items: [{ type: "login", name: "CPA society", username: "drivera", uris: ["https://www.example-cpa-society.test"] }] },
};

/** Templates Harbor IT sends its clients: every client, or chosen ones (by organization key). */
export const MSP_TEMPLATES: { name: string; clients: "all" | string[] }[] = [
  { name: "Firewall", clients: "all" },
  { name: "Microsoft 365 tenant", clients: "all" },
  { name: "Line-of-business app", clients: ["northwind", "cedar"] },
];

/** Harbor IT's staff, in the order they're invited, with their access (DESIGN.md, "Per MSP: technician access"). */
export type StaffSpec = {
  key: string;
  role: "admin" | "technician";
  /** Every client, or chosen ones (by organization key). */
  clients?: "all" | string[];
  custom?: { permissions: Record<string, boolean>; vaultItems: boolean } | null;
  installCommands?: boolean;
  /** Clients where their role differs: admin (null), or a custom role. */
  clientRoles?: { client: string; custom: { permissions: Record<string, boolean>; vaultItems: boolean } | null }[];
  /** Invited only: hasn't joined. */
  invitedOnly?: boolean;
};

export const STAFF: StaffSpec[] = [
  { key: "owen", role: "admin" },
  { key: "theo", role: "technician", clients: "all", custom: null, installCommands: true },
  {
    key: "priya",
    role: "technician",
    clients: ["northwind", "cedar"],
    custom: { permissions: { manageUsers: true, manageResetPassword: true }, vaultItems: false },
    installCommands: false,
    clientRoles: [{ client: "cedar", custom: null }],
  },
  {
    key: "sam",
    role: "technician",
    clients: "all",
    custom: { permissions: { accessEventLogs: true }, vaultItems: true },
    installCommands: false,
  },
  { key: "jordan", role: "technician", clients: "all", custom: null, installCommands: false, invitedOnly: true },
];

export const MSP_NAME = "Harbor IT";

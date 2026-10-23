// One fake vault, the same every time (seeded): the kinds of things people
// bring from another password manager, with the awkward cases on purpose.
// Everything is made up: example.com, .example, and .test domains,
// documentation IP ranges, "Test Person", and test card numbers.

/** A small seeded random number generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SEED = 20261022;

/** Folders, parents first. "Work/Servers" sits inside "Work". */
export const folders = ["Finance", "Personal", "Shopping", "Work", "Work/Servers"];

const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const BUILD_TOTP = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

export const otpauth = (issuer, account, secret) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

/** The secret in an otpauth:// URI, or the value itself if it's a bare secret. */
export function totpSecret(totp) {
  if (totp == null) return null;
  const match = /[?&]secret=([^&]+)/i.exec(totp);
  return match ? decodeURIComponent(match[1]) : totp;
}

const longNote = [
  "This is a long note, the kind people paste whole emails into.",
  "",
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `Line ${String(i + 1).padStart(2, "0")}: the fake account's terms, "quoted", with commas, semicolons; and a tab\there. Nothing here is real.`,
  ),
  "",
  "The end.",
].join("\n");

const recoveryCodes = Array.from({ length: 10 }, (_, i) => `fake-${String(1000 + i * 37).padStart(4, "0")}-code`).join(
  "\n",
);

/** The hand-made items: every awkward case once. */
const handmade = [
  {
    key: "mail",
    type: "login",
    name: "Example Mail",
    folder: "Personal",
    favorite: true,
    login: {
      username: "test.person@example.com",
      password: "Fake-Mail-Pass-01",
      uris: ["https://mail.example.com/login"],
      totp: otpauth("Example Mail", "test.person@example.com", TOTP_SECRET),
    },
    notes: "Recovery codes are in the fake safe.",
  },
  {
    key: "mail-duplicate",
    duplicateOf: "mail",
  },
  {
    key: "three-sites",
    type: "login",
    name: "Example Account (three sites)",
    folder: "Work",
    login: {
      username: "test.person",
      password: "One-Login-Three-Sites-22",
      uris: ["https://account.example.com/signin", "https://login.example.org/", "https://app.example.net/start"],
    },
    fields: [
      { name: "Employee ID", value: "E-0042", type: "text" },
      { name: "Security answer", value: "Blue Fake Penguin", type: "hidden" },
      { name: "Remember device", value: "true", type: "boolean" },
    ],
  },
  {
    key: "printer",
    type: "login",
    name: "Office printer admin",
    folder: "Work",
    login: { username: "admin", password: "printer-admin-0000" },
    notes: "No website: it's on the office network.",
  },
  {
    key: "router",
    type: "login",
    name: "Home router",
    folder: "Personal",
    login: { username: "admin", password: "router,admin,2026", uris: ["http://192.168.1.1:8080/"] },
  },
  {
    key: "nas",
    type: "login",
    name: "Test NAS",
    folder: "Work/Servers",
    login: { username: "nasadmin", password: `quote"inside'and'apostrophes"`, uris: ["https://10.0.0.5:5001/"] },
  },
  {
    key: "build",
    type: "login",
    name: "Build server",
    folder: "Work/Servers",
    login: {
      username: "deploy",
      password: "Build-Server-Pass-77",
      uris: ["https://203.0.113.10:8443/login"],
      totp: BUILD_TOTP,
    },
    fields: [{ name: "API token", value: "fake-token-0123456789abcdef", type: "hidden" }],
  },
  {
    key: "staging-db",
    type: "login",
    name: "Staging database",
    folder: "Work/Servers",
    login: { username: "dbuser", password: "  spaced out password  ", uris: ["https://db.staging.example.com:5432/"] },
    notes: "The password starts and ends with two spaces.",
  },
  {
    key: "android-app",
    type: "login",
    name: "Example Notes app",
    login: { username: "test.person", password: "App-Only-Pass-31", uris: ["androidapp://com.example.notes"] },
  },
  {
    key: "unicode",
    type: "login",
    name: "Café Ünïcode 日本語 🔑",
    folder: "Personal",
    login: {
      username: "tëst.pérson",
      password: "pässwörd-日本語-🔑-Ωμέγα",
      uris: ["https://unicode.example.com/"],
    },
    notes: "Ünïcode notes: 你好, привет, مرحبا, 🎉",
  },
  {
    key: "long-note",
    type: "login",
    name: "Long notes login",
    login: { username: "test.person", password: "Long-Notes-Pass-15", uris: ["https://notes.example.org/"] },
    notes: longNote,
  },
  {
    key: "multiline-password",
    type: "login",
    name: "Two-line password",
    login: { username: "test.person", password: "line one\nline two", uris: ["https://multiline.example.net/"] },
  },
  {
    key: "csv-password",
    type: "login",
    name: "Commas and quotes",
    login: { username: "test.person", password: `a,b"c""d,`, uris: ["https://csv.example.com/"] },
  },
  {
    key: "markup-password",
    type: "login",
    name: "Markup-looking password",
    folder: "Shopping",
    login: { username: "test.person", password: `<b>&amp;</b>\\n %s {0} $1`, uris: ["https://markup.example.com/"] },
  },
  {
    key: "empty-password",
    type: "login",
    name: "No password yet",
    login: { username: "test.person", password: "", uris: ["https://nopass.example.com/"] },
  },
  {
    key: "username-only",
    type: "login",
    name: "Username only",
    login: { username: "just-a-username" },
  },
  {
    key: "forum-1",
    type: "login",
    name: "Example Forum",
    login: { username: "test.person", password: "Forum-First-Account-1", uris: ["https://forum.example.com/"] },
  },
  {
    key: "forum-2",
    type: "login",
    name: "Example Forum (second account)",
    login: { username: "test.person.alt", password: "Forum-Second-Account-2", uris: ["https://forum.example.com/"] },
  },
  {
    key: "intranet",
    type: "login",
    name: "Intranet (browser sign-in box)",
    folder: "Work",
    login: {
      username: "tperson",
      password: "Intranet-Basic-Auth-9",
      uris: ["https://intranet.example.com/"],
      httpRealm: "Example Intranet",
    },
  },
  {
    key: "mixed-case-url",
    type: "login",
    name: "Mixed-case address",
    login: {
      username: "test.person",
      password: "Mixed-Case-Url-44",
      uris: ["https://www.mixedcase.example.com/Account/Login?next=%2Fhome&x=1"],
    },
  },
  {
    key: "schemeless",
    type: "login",
    name: "Address with no https",
    folder: "Shopping",
    login: { username: "test.person", password: "No-Scheme-Url-12", uris: ["shop.example.com/account"] },
  },
  {
    key: "bank",
    type: "login",
    name: "Example Bank",
    folder: "Finance",
    favorite: true,
    login: { username: "test.person", password: "Bank-Current-Pass-03", uris: ["https://bank.example.com/"] },
    passwordHistory: [
      { password: "Bank-Older-Pass-02", date: "2026-03-01T10:00:00.000Z" },
      { password: "Bank-Oldest-Pass-01", date: "2025-11-01T10:00:00.000Z" },
    ],
  },
  {
    key: "credit-union",
    type: "login",
    name: "Example Credit Union",
    folder: "Finance",
    favorite: true,
    login: { username: "tperson", password: "Credit-Union-Pass-88", uris: ["https://cu.example.com/"] },
    fields: [
      {
        name: "Backup codes",
        value: "11111-fake\n22222-fake\n33333-fake",
        type: "text",
      },
    ],
    notes: "Branch: Example Street.",
  },
  {
    key: "plus-address",
    type: "login",
    name: "Example Shop",
    folder: "Shopping",
    login: {
      username: "test.person+shopping@example.com",
      password: "Shop-Plus-Address-5",
      uris: ["https://shop.example.net/"],
    },
  },
  {
    key: "backslash",
    type: "login",
    name: "Backslashes and emoji",
    login: { username: "DOMAIN\\tperson", password: "back\\slash\\\\double-😀", uris: ["https://legacy.example.org/"] },
  },
  // Secure notes.
  {
    key: "wifi-note",
    type: "note",
    name: "Home Wi-Fi",
    folder: "Personal",
    notes: "Network: Fake-Home-5G\nPassword: not-a-real-wifi-pass",
  },
  {
    key: "license-note",
    type: "note",
    name: "Software license (fake)",
    folder: "Work",
    notes: "License key: FAKE-1234-ABCD-5678\nSeats: 3",
  },
  {
    key: "recovery-note",
    type: "note",
    name: "Recovery codes (fake)",
    favorite: true,
    notes: recoveryCodes,
  },
  {
    key: "unicode-note",
    type: "note",
    name: "Notizen 🗒️ Ünïcode",
    notes: "Grüße aus Köln. Ça va? 東京. 🚀",
  },
  {
    key: "long-note-only",
    type: "note",
    name: "Long note",
    notes: longNote,
  },
  {
    key: "note-fields",
    type: "note",
    name: "Locker combination",
    folder: "Personal",
    notes: "Gym locker.",
    fields: [
      { name: "Locker number", value: "0042", type: "text" },
      { name: "Combination", value: "12-34-56", type: "hidden" },
    ],
  },
  // Cards (test numbers from the card networks' published test ranges).
  {
    key: "visa",
    type: "card",
    name: "Test Visa",
    folder: "Finance",
    favorite: true,
    card: {
      cardholderName: "Test Person",
      brand: "Visa",
      number: "4111111111111111",
      expMonth: "12",
      expYear: "2030",
      code: "123",
    },
    notes: "Not a real card.",
  },
  {
    key: "mastercard",
    type: "card",
    name: "Test Mastercard",
    folder: "Finance",
    card: {
      cardholderName: "Test Person",
      brand: "Mastercard",
      number: "5555555555554444",
      expMonth: "1",
      expYear: "2029",
      code: "321",
    },
  },
  {
    key: "amex",
    type: "card",
    name: "Test Amex",
    card: {
      cardholderName: "Test Person",
      brand: "Amex",
      number: "378282246310005",
      expMonth: "7",
      expYear: "2031",
      code: "1234",
    },
  },
  {
    key: "discover",
    type: "card",
    name: "Test Discover",
    card: {
      cardholderName: "Tëst Pérsön",
      brand: "Discover",
      number: "6011111111111117",
      expMonth: "3",
      expYear: "2028",
      code: "456",
    },
  },
  // Identities.
  {
    key: "identity-home",
    type: "identity",
    name: "Test Person",
    folder: "Personal",
    identity: {
      title: "Mx",
      firstName: "Test",
      middleName: "Q",
      lastName: "Person",
      email: "test.person@example.com",
      phone: "+1 555 0100",
      address1: "1 Example Street",
      city: "Exampleville",
      state: "CA",
      postalCode: "90000",
      country: "US",
      username: "tperson",
    },
  },
  {
    key: "identity-work",
    type: "identity",
    name: "Test Person (work)",
    folder: "Work",
    identity: {
      firstName: "Test",
      lastName: "Person",
      company: "Example Corp",
      email: "t.person@corp.example.com",
      phone: "+1 555 0199",
    },
  },
  {
    key: "identity-unicode",
    type: "identity",
    name: "Zoë Ångström-Ñúñez",
    identity: {
      firstName: "Zoë",
      lastName: "Ångström-Ñúñez",
      email: "zoe@unicode.example.com",
      city: "Malmö",
      country: "SE",
    },
  },
];

const adjectives = [
  "Amber",
  "Birch",
  "Cobalt",
  "Copper",
  "Dune",
  "Fern",
  "Granite",
  "Harbor",
  "Indigo",
  "Juniper",
  "Lantern",
  "Meadow",
];
const nouns = ["Books", "Cloud", "Fitness", "Forum", "Garden", "Library", "Market", "Radio", "Studio", "Travel"];
const tlds = ["example", "example.com", "example.org", "example.net", "test"];
const usernames = ["test.person", "test.person@example.com", "tperson", "TestPerson42", "test_person"];
const fillerFolders = [null, null, null, "Personal", "Shopping", "Work", "Finance"];
const passwordChars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%&*+-=?@^_";

/** Ordinary logins, made up from word lists with the seeded generator. */
function filler(count) {
  const random = rng(SEED);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const used = new Set();
  const items = [];
  while (items.length < count) {
    const adjective = pick(adjectives);
    const noun = pick(nouns);
    const name = `${adjective} ${noun}`;
    if (used.has(name)) continue;
    used.add(name);
    const host = `${adjective}${noun}`.toLowerCase() + "." + pick(tlds);
    const length = 14 + Math.floor(random() * 11);
    let password = "";
    for (let i = 0; i < length; i++) password += passwordChars[Math.floor(random() * passwordChars.length)];
    const path = pick(["/", "/login", "/account/sign-in", "/users/sign_in"]);
    items.push({
      key: `filler-${items.length + 1}`,
      type: "login",
      name,
      folder: pick(fillerFolders),
      login: { username: pick(usernames), password, uris: [`https://${pick(["", "www.", "app."])}${host}${path}`] },
      notes: random() < 0.25 ? `Signed up for ${name} in a test.` : null,
    });
  }
  return items;
}

/** Every item, complete: defaults filled in, duplicates expanded, fixed dates. */
export function dataset() {
  const raw = [...handmade, ...filler(38)];
  const byKey = new Map();
  const items = raw.map((item, index) => {
    const base = item.duplicateOf
      ? { ...byKey.get(item.duplicateOf), key: item.key, duplicateOf: item.duplicateOf }
      : item;
    const created = new Date(Date.UTC(2025, 0, 1) + index * 86_400_000 * 3);
    const full = {
      key: base.key,
      duplicateOf: base.duplicateOf ?? null,
      type: base.type,
      name: base.name,
      folder: base.folder ?? null,
      favorite: base.favorite ?? false,
      notes: base.notes ?? null,
      fields: base.fields ?? [],
      passwordHistory: base.passwordHistory ?? [],
      login:
        base.type === "login"
          ? {
              username: base.login.username ?? "",
              password: base.login.password ?? "",
              uris: base.login.uris ?? [],
              totp: base.login.totp ?? null,
              httpRealm: base.login.httpRealm ?? null,
            }
          : null,
      card: base.card ?? null,
      identity: base.identity ?? null,
      created: created.toISOString(),
      updated: new Date(created.getTime() + 86_400_000).toISOString(),
      // A stable UUID-looking id, for formats that have one.
      uuid: fakeUuid(index),
    };
    byKey.set(full.key, full);
    return full;
  });
  return { folders, items };
}

/** A stable, obviously fake UUID for the nth item. */
export function fakeUuid(n, prefix = "00000000") {
  const hex = (n + 1).toString(16).padStart(12, "0");
  return `${prefix}-0000-4000-8000-${hex}`;
}

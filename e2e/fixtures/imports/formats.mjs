// The fake vault (dataset.mjs) written out the way each app exports it, and
// what PassBundle should hold after importing each file. README.md says
// where each format's shape comes from and what each importer leaves out.
//
// Each format has:
//   files(data)    the export, as { name, contents } (a Buffer or a string)
//   expect(files)  what the vault holds after importing it: { folders, items }
//                  plus anything the import screen reports. It reads the
//                  records the writer made, the way the importer does, so a
//                  difference in the e2e test is a difference in the importer.
import { otpauth, rng, SEED, totpSecret } from "./dataset.mjs";
import { normalize, sortItems } from "./vault.mjs";
import { zip } from "./zip.mjs";

// ---------------------------------------------------------------------------
// Shared helpers: CSV, and the importers' common rules (base-importer.ts).

/** Quotes a CSV value only when it must be (comma, quote, CR, or LF). */
const quoteIfNeeded = (v) => {
  const s = v ?? "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function csv(header, rows, { eol = "\n", trailingEol = true, quote = quoteIfNeeded } = {}) {
  const lines = [header.map(quote).join(","), ...rows.map((r) => header.map((h) => quote(r[h])).join(","))];
  return lines.join(eol) + (trailingEol ? eol : "");
}

const blank = (s) => s == null || typeof s !== "string" || s.trim() === "";
const orNull = (s) => (blank(s) ? null : s);
const newLine = /\r\n|\r|\n/;

function fixUri(uri) {
  if (uri == null) return null;
  uri = uri.trim();
  if (uri.indexOf("://") === -1 && uri.indexOf(".") >= 0) uri = "http://" + uri;
  return uri.length > 1000 ? uri.substring(0, 1000) : uri;
}

function makeUris(uri) {
  if (uri == null) return [];
  const list = typeof uri === "string" ? [uri] : uri;
  return list.map(fixUri).filter((u) => !blank(u));
}

/** A new item as the importers start one (initLoginCipher). */
function item(type = "login") {
  return {
    type,
    name: null,
    folder: null,
    favorite: false,
    reprompt: false,
    notes: "",
    fields: [],
    login: type === "login" ? { username: null, password: null, uris: [], totp: null } : null,
    passwordHistory: [],
    card: type === "card" ? {} : null,
    identity: type === "identity" ? {} : null,
  };
}

/** processKvp: a short one-line value is a field; anything else goes to the notes. */
function kvp(it, key, value, type = "text") {
  if (blank(value)) return;
  if (blank(key)) key = "";
  if (value.length > 200 || value.trim().search(newLine) > -1) {
    if (it.notes == null) it.notes = "";
    // On a line of its own after notes already there.
    if (it.notes.length > 0 && !it.notes.endsWith("\n")) it.notes += "\n";
    it.notes += key + ": " + value.split(newLine).join("\n") + "\n";
  } else {
    it.fields.push({ name: key, value, type });
  }
}

/** cleanupCipher, then the vault's own normalizing (empty is no value). */
function cleanup(it) {
  if (it.type !== "login") it.login = null;
  if (blank(it.name)) it.name = "--";
  if (blank(it.notes)) it.notes = null;
  return it;
}

/** convertToNoteIfNeeded: a login with nothing to sign in with is a note. */
function toNoteIfEmpty(it) {
  if (it.type === "login" && blank(it.login.username) && blank(it.login.password) && it.login.uris.length === 0) {
    it.type = "note";
    it.login = null;
  }
}

/** processFolder: backslashes are slashes, and every parent folder exists too. */
function addFolder(folders, name) {
  if (blank(name)) return null;
  name = name.replace(/\\/g, "/").replace(/^\/+/g, "");
  const parts = name.split("/");
  for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  return name;
}

function result(items, folders, extra = {}) {
  return {
    folders: [...folders].sort(),
    items: sortItems(
      items.map((i) => normalize({ ...i, passwordHistory: i.passwordHistory.map((p) => ({ password: p })) })),
    ),
    ...extra,
  };
}

/** The card brand the importers work out from the number (CardView.getCardBrandByPatterns). */
function brandOf(number) {
  if (blank(number)) return null;
  if (/^4/.test(number)) return "Visa";
  if (
    /^(5[1-5][0-9]{14}|2(22[1-9][0-9]{12}|2[3-9][0-9]{13}|[3-6][0-9]{14}|7[0-1][0-9]{13}|720[0-9]{12}))$/.test(number)
  ) {
    return "Mastercard";
  }
  if (/^3[47]/.test(number)) return "Amex";
  if (/^(6011|65|64[4-9]|622)/.test(number)) return "Discover";
  return null;
}

/** A card brand from the name another app gives it (base-importer.ts, cardBrandFromName). */
function brandFromName(name) {
  if (blank(name)) return null;
  const brands = {
    visa: "Visa",
    visaelectron: "Visa",
    mastercard: "Mastercard",
    mc: "Mastercard",
    amex: "Amex",
    americanexpress: "Amex",
    discover: "Discover",
    diners: "Diners Club",
    dinersclub: "Diners Club",
    jcb: "JCB",
    maestro: "Maestro",
    unionpay: "UnionPay",
    chinaunionpay: "UnionPay",
    rupay: "RuPay",
  };
  return brands[name.toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

const host = (uri) => new URL(uri).host;
const withoutWww = (h) => (h.startsWith("www.") ? h.slice(4) : h);
/** A browser keeps a site, not a path: its origin with the scheme it was saved on. */
function origin(uri) {
  if (/^androidapp:\/\//.test(uri)) return null;
  const withScheme = uri.includes("://") ? uri : `https://${uri}`;
  const url = new URL(withScheme);
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
}

/** The fake signing-certificate hash in an Android app's facet URI. */
function androidFacet(pkg) {
  const random = rng(SEED + pkg.length);
  const bytes = Buffer.from(Array.from({ length: 64 }, () => Math.floor(random() * 256)));
  return `android://${bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_")}@${pkg}/`;
}

const logins = (data) => data.items.filter((i) => i.type === "login");
const ms = (iso) => String(new Date(iso).getTime());
const seconds = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// ---------------------------------------------------------------------------
// Chromium browsers: Chrome, Edge, Brave. One row per site (a password used
// on three sites is three saved passwords), the site's address with no path,
// rows sorted by every column, values quoted only when they must be.

function chromiumRows(data) {
  const rows = [];
  const seen = new Set();
  for (const it of logins(data)) {
    for (const uri of it.login.uris) {
      let name;
      let url;
      if (uri.startsWith("androidapp://")) {
        const pkg = uri.slice("androidapp://".length);
        name = "";
        url = androidFacet(pkg);
      } else {
        const o = origin(uri);
        if (o == null) continue;
        name = withoutWww(host(o));
        url = o + "/";
      }
      // Chrome keeps one password per site and username.
      const key = `${url}\u0000${it.login.username}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ name, url, username: it.login.username, password: it.login.password, note: it.notes ?? "" });
    }
  }
  const header = ["name", "url", "username", "password", "note"];
  const bytes = (r) => Buffer.from(header.map((h) => r[h]).join("\u0000"), "utf8");
  return rows.sort((a, b) => Buffer.compare(bytes(a), bytes(b)));
}

const chromiumHeader = ["name", "url", "username", "password", "note"];

/** chrome-csv-importer.ts, then the guided browser import (browser-import.ts). */
function expectChromium(rows, browserName) {
  const items = rows.map((row) => {
    const it = item();
    const android = /^android:\/\/.*(?<=@)(.*)(?=\/)/.exec(row.url);
    it.name = orNull(row.name) ?? (android ? android[1] : null) ?? "--";
    it.login.username = orNull(row.username);
    it.login.password = orNull(row.password);
    it.login.uris = makeUris(android ? `androidapp://${android[1]}` : row.url);
    it.notes = orNull(row.note);
    return cleanup(it);
  });
  return guided(items, `Check these: from ${browserName}`);
}

/**
 * The guided import into an empty vault: logins with no password are left
 * out, and so is the second of two with the same site, username, and password.
 */
function guided(parsed, checkFolder) {
  const site = (it) => {
    const uri = it.login.uris[0] ?? "";
    try {
      return new URL(uri).host.toLowerCase();
    } catch {
      return (uri || it.name || "").trim().toLowerCase();
    }
  };
  const known = new Map();
  const kept = [];
  const folders = new Set();
  const summary = { added: 0, alreadyThere: 0, toCheck: 0, empty: 0 };
  for (const it of parsed) {
    if (it.type !== "login") continue;
    const password = it.login.password ?? "";
    if (password === "") {
      summary.empty++;
      continue;
    }
    const key = `${site(it)}\u0000${(it.login.username ?? "").trim().toLowerCase()}`;
    const passwords = known.get(key);
    if (passwords?.has(password)) {
      summary.alreadyThere++;
      continue;
    }
    if (passwords != null) {
      it.folder = checkFolder;
      folders.add(checkFolder);
      summary.toCheck++;
    } else {
      summary.added++;
    }
    kept.push(it);
    known.set(key, (passwords ?? new Set()).add(password));
  }
  return result(kept, folders, { summary: summaryText(summary, checkFolder) });
}

/** What the guided import says it did (browser-import.component.ts). */
function summaryText(s, checkFolder) {
  const logins = (n) => (n === 1 ? "1 login" : `${n} logins`);
  const parts = [`Imported ${logins(s.added + s.toCheck)}.`];
  if (s.alreadyThere > 0)
    parts.push(`${s.alreadyThere === 1 ? "1 was" : `${s.alreadyThere} were`} already in your vault.`);
  if (s.toCheck > 0) {
    parts.push(
      `${s.toCheck === 1 ? "1 has" : `${s.toCheck} have`} a different password from a login you have for the same site, so ${s.toCheck === 1 ? "it's" : "they're"} in the folder "${checkFolder}" for you to compare.`,
    );
  }
  if (s.empty > 0)
    parts.push(
      `${s.empty === 1 ? "1 had" : `${s.empty} had`} no password and ${s.empty === 1 ? "was" : "were"} skipped.`,
    );
  return parts.join(" ");
}

const chrome = {
  id: "chrome",
  title: "Google Chrome (Mac or Linux)",
  files: (data) => [{ name: "Chrome Passwords.csv", contents: csv(chromiumHeader, chromiumRows(data)) }],
  expect: (data) => expectChromium(chromiumRows(data), "Google Chrome"),
};

const edge = {
  id: "edge",
  title: "Microsoft Edge (Windows)",
  // Chromium on Windows ends lines with CRLF.
  files: (data) => [
    { name: "Microsoft Edge Passwords.csv", contents: csv(chromiumHeader, chromiumRows(data), { eol: "\r\n" }) },
  ],
  expect: (data) => expectChromium(chromiumRows(data), "Microsoft Edge"),
};

const brave = {
  id: "brave",
  title: "Brave (Mac or Linux)",
  files: (data) => [{ name: "Brave Passwords.csv", contents: csv(chromiumHeader, chromiumRows(data)) }],
  expect: (data) => expectChromium(chromiumRows(data), "Brave"),
};

/**
 * Chrome's export after someone opened it in Excel and saved it as
 * "CSV UTF-8": a byte order mark, CRLF line endings, and the same quoting.
 */
const chromeExcel = {
  id: "chrome-excel",
  title: "Google Chrome, opened and saved again in Excel",
  files: (data) => [
    {
      name: "Chrome Passwords (saved in Excel).csv",
      contents: "﻿" + csv(chromiumHeader, chromiumRows(data), { eol: "\r\n" }),
    },
  ],
  expect: (data) => expectChromium(chromiumRows(data), "Google Chrome"),
};

// ---------------------------------------------------------------------------
// Firefox: about:logins, Export Passwords. Every value quoted, a missing
// value left empty with no quotes, CRLF between rows and none at the end.

const firefoxColumns = [
  "url",
  "username",
  "password",
  "httpRealm",
  "formActionOrigin",
  "guid",
  "timeCreated",
  "timeLastUsed",
  "timePasswordChanged",
];

function firefoxRows(data) {
  // Older Firefox versions export the Firefox account's own sign-in too.
  const rows = [
    {
      url: "chrome://FirefoxAccounts",
      username: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      password:
        '{"version":1,"accountData":{"kSync":"fake-not-a-real-key","kXCS":"fake","kExtSync":"fake","kExtKbHash":"fake"}}',
      httpRealm: "Firefox Accounts credentials",
      formActionOrigin: null,
      guid: "{00000000-0000-4000-8000-0000000000ff}",
      timeCreated: ms("2025-01-01T00:00:00Z"),
      timeLastUsed: ms("2025-01-01T00:00:00Z"),
      timePasswordChanged: ms("2025-01-01T00:00:00Z"),
    },
  ];
  const seen = new Set();
  let n = 0;
  for (const it of logins(data)) {
    // Firefox won't save a login without a password.
    if (it.login.password === "") continue;
    for (const uri of it.login.uris) {
      const o = origin(uri);
      if (o == null) continue;
      const key = `${o}\u0000${it.login.username}\u0000${it.login.httpRealm ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
      rows.push({
        url: o,
        username: it.login.username,
        password: it.login.password,
        httpRealm: it.login.httpRealm,
        formActionOrigin: it.login.httpRealm ? null : o,
        guid: `{${it.uuid.replace(/^00000000/, "f1ef0c00")}}`.replace(
          /-0000-4000-/,
          `-${String(n).padStart(4, "0")}-4000-`,
        ),
        timeCreated: ms(it.created),
        timeLastUsed: ms(it.updated),
        timePasswordChanged: ms(it.updated),
      });
    }
  }
  return rows;
}

const firefox = {
  id: "firefox",
  title: "Firefox",
  files: (data) => {
    const quote = (v) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
    const lines = [
      firefoxColumns.map((c) => `"${c}"`).join(","),
      ...firefoxRows(data).map((r) => firefoxColumns.map((c) => quote(r[c])).join(",")),
    ];
    return [{ name: "logins.csv", contents: lines.join("\r\n") }];
  },
  expect: (data) => {
    const items = firefoxRows(data)
      .filter((r) => r.url !== "chrome://FirefoxAccounts")
      .map((r) => {
        const it = item();
        it.name = withoutWww(new URL(r.url).hostname) || "--";
        it.login.username = orNull(r.username);
        it.login.password = orNull(r.password);
        it.login.uris = makeUris(r.url);
        return cleanup(it);
      });
    return guided(items, "Check these: from Firefox");
  },
};

// ---------------------------------------------------------------------------
// Apple Passwords (and Safari): File, Export All Passwords to File.

function appleRows(data) {
  const rows = [];
  const seen = new Set();
  for (const it of logins(data)) {
    // Every saved password has a password.
    if (it.login.password === "") continue;
    const sites = it.login.uris.map(origin).filter((o) => o != null);
    // Apps on Android aren't Apple's to keep.
    if (it.login.uris.length > 0 && sites.length === 0) continue;
    // A password with no website keeps a label instead.
    const targets = sites.length > 0 ? sites : [null];
    for (const o of targets) {
      const key = `${o}\u0000${it.login.username}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const site = o ? withoutWww(host(o)) : null;
      const totp =
        it.login.totp == null
          ? ""
          : it.login.totp.startsWith("otpauth://")
            ? it.login.totp
            : otpauth(site ?? it.name, it.login.username, totpSecret(it.login.totp));
      rows.push({
        Title: site ? (it.login.username ? `${site} (${it.login.username})` : site) : it.name,
        URL: o ? o + "/" : "",
        Username: it.login.username,
        Password: it.login.password,
        Notes: it.notes ?? "",
        OTPAuth: totp,
      });
    }
  }
  return rows.sort((a, b) => (a.Title < b.Title ? -1 : a.Title > b.Title ? 1 : a.URL < b.URL ? -1 : 1));
}

const apple = {
  id: "apple",
  title: "Apple Passwords (Mac)",
  files: (data) => [
    {
      name: "Passwords.csv",
      contents: csv(["Title", "URL", "Username", "Password", "Notes", "OTPAuth"], appleRows(data)),
    },
  ],
  // safari-csv-importer.ts, through the Apple Passwords step at sign-up.
  expect: (data) =>
    result(
      appleRows(data).map((r) => {
        const it = item();
        it.name = orNull(r.Title) ?? "--";
        it.login.username = orNull(r.Username);
        it.login.password = orNull(r.Password);
        it.login.uris = makeUris(orNull(r.URL));
        it.login.totp = orNull(r.OTPAuth);
        it.notes = orNull(r.Notes);
        return cleanup(it);
      }),
      new Set(),
    ),
};

// ---------------------------------------------------------------------------
// Bitwarden: Tools, Export vault, .json (not encrypted).

function bitwardenExport(data) {
  const folderId = (name) => `f01de000-0000-4000-8000-${String(data.folders.indexOf(name) + 1).padStart(12, "0")}`;
  const typeNumber = { login: 1, note: 2, card: 3, identity: 4 };
  const fieldNumber = { text: 0, hidden: 1, boolean: 2 };
  const items = data.items.map((it) => {
    const out = {
      passwordHistory: it.passwordHistory.length
        ? it.passwordHistory.map((h) => ({ lastUsedDate: h.date, password: h.password }))
        : null,
      revisionDate: it.updated,
      creationDate: it.created,
      deletedDate: null,
      archivedDate: it.archived ? it.updated : null,
      id: it.uuid,
      organizationId: null,
      folderId: it.folder ? folderId(it.folder) : null,
      type: typeNumber[it.type],
      reprompt: 0,
      name: it.name,
      notes: it.notes,
      favorite: it.favorite,
    };
    if (it.fields.length) {
      out.fields = it.fields.map((f) => ({ name: f.name, value: f.value, type: fieldNumber[f.type], linkedId: null }));
    }
    if (it.type === "login") {
      out.login = {
        fido2Credentials: [],
        uris: it.login.uris.map((uri) => ({ match: null, uri })),
        username: it.login.username || null,
        password: it.login.password || null,
        totp: it.login.totp,
      };
    } else if (it.type === "note") {
      out.secureNote = { type: 0 };
    } else if (it.type === "card") {
      out.card = { ...it.card };
    } else if (it.type === "identity") {
      out.identity = Object.fromEntries(
        [
          "title",
          "firstName",
          "middleName",
          "lastName",
          "address1",
          "address2",
          "address3",
          "city",
          "state",
          "postalCode",
          "country",
          "company",
          "email",
          "phone",
          "ssn",
          "username",
          "passportNumber",
          "licenseNumber",
        ].map((k) => [k, it.identity[k] ?? null]),
      );
    }
    out.collectionIds = null;
    return out;
  });
  return {
    encrypted: false,
    folders: data.folders.map((name) => ({ id: folderId(name), name })),
    items,
  };
}

const bitwarden = {
  id: "bitwarden",
  title: "Bitwarden (.json, not encrypted)",
  files: (data) => [
    { name: "bitwarden_export_20261001120000.json", contents: JSON.stringify(bitwardenExport(data), null, 2) },
  ],
  // Everything comes over as it was.
  expect: (data) => {
    const exported = bitwardenExport(data);
    const folders = new Map(exported.folders.map((f) => [f.id, f.name]));
    return {
      folders: [...folders.values()].sort(),
      items: sortItems(exported.items.map((i) => normalize(i, (id) => (id ? folders.get(id) : null)))),
    };
  },
};

// ---------------------------------------------------------------------------
// 1Password 8: File, Export, 1PUX. A zip with export.attributes,
// export.data (accounts, vaults, items), and files/.

const onePasswordAccount = "TESTPERSONFAKEACCOUNT00000";

function onePasswordItems(data) {
  const random = rng(SEED + 1);
  const id = (n = 26) =>
    Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz234567"[Math.floor(random() * 32)]).join("");
  let favorites = 0;
  const field = (title, fieldId, value, extra = {}) => ({
    title,
    id: fieldId,
    value,
    guarded: false,
    multiline: false,
    dontGenerate: false,
    inputTraits: { keyboard: "default", correction: "default", capitalization: "default" },
    ...extra,
  });
  return data.items.map((it) => {
    const favIndex = it.favorite ? ++favorites : 0;
    const base = {
      uuid: id(),
      favIndex,
      createdAt: seconds(it.created),
      updatedAt: seconds(it.updated),
      state: it.archived ? "archived" : "active",
    };
    const overview = { subtitle: "", title: it.name, ps: 0, pbe: 0.0, pgrng: false };
    if (it.folder) overview.tags = [it.folder];
    const custom = it.fields.filter((f) => f.type !== "boolean");
    const sections = [];
    const details = { loginFields: [], notesPlain: it.notes ?? "", sections };
    if (it.type === "login") {
      const l = it.login;
      if (l.username)
        details.loginFields.push({
          value: l.username,
          id: "",
          name: "username",
          fieldType: "T",
          designation: "username",
        });
      if (l.password)
        details.loginFields.push({
          value: l.password,
          id: "",
          name: "password",
          fieldType: "P",
          designation: "password",
        });
      for (const f of it.fields.filter((x) => x.type === "boolean")) {
        details.loginFields.push({
          value: f.value === "true" ? "✓" : "",
          id: f.name.toLowerCase().replace(/\W+/g, "-"),
          name: f.name,
          fieldType: "C",
        });
      }
      overview.subtitle = l.username;
      if (l.uris.length) {
        overview.urls = l.uris.map((url, i) => ({ label: i === 0 ? "website" : "", url }));
        overview.url = l.uris[0];
      }
      const extra = [];
      if (l.totp) extra.push(field("one-time password", `TOTP_${id()}`, { totp: l.totp }));
      for (const f of custom) {
        extra.push(
          field(f.name, id(), f.type === "hidden" ? { concealed: f.value } : { string: f.value }, {
            multiline: f.value.includes("\n"),
          }),
        );
      }
      if (extra.length) sections.push({ title: "", name: "add more", fields: extra });
      if (it.passwordHistory.length) {
        details.passwordHistory = it.passwordHistory.map((h) => ({ value: h.password, time: seconds(h.date) }));
      }
      return { ...base, categoryUuid: "001", details, overview };
    }
    if (it.type === "note") {
      if (custom.length) {
        sections.push({
          title: "",
          name: "add more",
          fields: custom.map((f) =>
            field(f.name, id(), f.type === "hidden" ? { concealed: f.value } : { string: f.value }),
          ),
        });
      }
      return { ...base, categoryUuid: "003", details, overview };
    }
    if (it.type === "card") {
      const c = it.card;
      overview.subtitle = `${c.number.slice(0, 4)} **** ${c.number.slice(-4)}`;
      sections.push({
        title: "",
        name: "",
        fields: [
          field("cardholder name", "cardholder", { string: c.cardholderName }, { guarded: true }),
          field("type", "type", { creditCardType: c.brand.toLowerCase() }, { guarded: true }),
          field("number", "ccnum", { creditCardNumber: c.number }, { guarded: true, clipboardFilter: "0123456789" }),
          field("verification number", "cvv", { concealed: c.code }, { guarded: true, dontGenerate: true }),
          field(
            "expiry date",
            "expiry",
            { monthYear: Number(c.expYear) * 100 + Number(c.expMonth) },
            { guarded: true },
          ),
          field("valid from", "validFrom", { monthYear: null }, { guarded: true }),
        ],
      });
      return { ...base, categoryUuid: "002", details, overview };
    }
    // Identity.
    const p = it.identity;
    overview.subtitle = [p.firstName, p.lastName].filter(Boolean).join(" ");
    sections.push({
      title: "Identification",
      name: "name",
      fields: [
        field("first name", "firstname", { string: p.firstName ?? "" }, { guarded: true }),
        field("initial", "initial", { string: p.middleName ?? "" }, { guarded: true }),
        field("last name", "lastname", { string: p.lastName ?? "" }, { guarded: true }),
        field("company", "company", { string: p.company ?? "" }, { guarded: true }),
      ],
    });
    sections.push({
      title: "Address",
      name: "address",
      fields: [
        field(
          "address",
          "address",
          {
            address: {
              street: p.address1 ?? "",
              city: p.city ?? "",
              country: (p.country ?? "").toLowerCase(),
              zip: p.postalCode ?? "",
              state: p.state ?? "",
            },
          },
          { guarded: true },
        ),
        field("default phone", "defphone", { phone: p.phone ?? "" }, { guarded: true }),
      ],
    });
    sections.push({
      title: "Internet Details",
      name: "internet",
      fields: [
        field("username", "username", { string: p.username ?? "" }, { guarded: true }),
        field("email", "email", { string: p.email ?? "" }, { guarded: true }),
      ],
    });
    return { ...base, categoryUuid: "004", details, overview };
  });
}

function onePasswordExportData(data) {
  const all = onePasswordItems(data);
  const inWork = data.items.map((it) => it.folder === "Work" || it.folder?.startsWith("Work/"));
  return {
    accounts: [
      {
        attrs: {
          accountName: "Test Person",
          name: "Test Person",
          avatar: "",
          email: "test.person@example.com",
          uuid: onePasswordAccount,
          domain: "https://my.1password.com/",
        },
        vaults: [
          {
            attrs: { uuid: "testpersonfakevault0000001", desc: "", avatar: "", name: "Personal", type: "P" },
            items: all.filter((_, i) => !inWork[i]),
          },
          {
            attrs: { uuid: "testpersonfakevault0000002", desc: "Fake work vault", avatar: "", name: "Work", type: "U" },
            items: all.filter((_, i) => inWork[i]),
          },
        ],
      },
    ],
  };
}

/** onepassword-1pux-importer.ts, item by item. */
function expectOnePasswordItem(src, folders) {
  const categories = { "001": "login", "002": "card", "003": "note", "004": "identity" };
  const it = item("login");
  const type = categories[src.categoryUuid];
  it.type = type;
  if (type === "card") it.card = {};
  if (type === "identity") it.identity = {};
  it.favorite = src.favIndex > 0;
  it.name = orNull(src.overview.title);
  if (src.overview.urls) it.login.uris = makeUris(src.overview.urls.map((u) => u.url).filter((u) => !blank(u)));
  if (src.overview.tags?.length) {
    const tag = src.overview.tags[0].trim().replace(/\w\S*/g, (w) => w.replace(/^\w/, (c) => c.toUpperCase()));
    it.folder = addFolder(folders, tag);
  }
  for (const lf of src.details.loginFields ?? []) {
    if (lf.designation === "username" && lf.value !== "") {
      it.type = "login";
      it.login.username = lf.value;
      continue;
    }
    if (lf.designation === "password" && lf.value !== "") {
      it.type = "login";
      it.login.password = lf.value;
      continue;
    }
    if (lf.fieldType === "C") kvp(it, lf.name, lf.value !== "" ? "true" : "false", "boolean");
    else kvp(it, lf.name, lf.value, lf.fieldType === "P" ? "hidden" : "text");
  }
  const history = src.details.passwordHistory ?? [];
  it.passwordHistory = history
    .filter((h) => !blank(h.value) && h.time != null)
    .sort((a, b) => b.time - a.time)
    .slice(0, Math.min(history.length, 5))
    .map((h) => h.value);
  for (const section of src.details.sections ?? []) {
    for (const f of section.fields ?? []) {
      const key = Object.keys(f.value)[0];
      const v = f.value[key];
      if (v == null || v === "") continue;
      const value = key === "monthYear" ? String(v) : v;
      if (type === "login") {
        if (f.id?.startsWith("TOTP_") && blank(it.login.totp)) {
          it.login.totp = value;
          continue;
        }
      } else if (type === "card") {
        const c = it.card;
        if (f.id === "ccnum") {
          c.number = value;
          c.brand = brandOf(value);
          continue;
        }
        if (f.id === "cvv") {
          c.code = value;
          continue;
        }
        if (f.id === "cardholder") {
          c.cardholderName = value;
          continue;
        }
        if (f.id === "expiry") {
          c.expMonth = value.substring(4, 6).replace(/^0/, "");
          c.expYear = value.substring(0, 4);
          continue;
        }
        if (f.id === "type") continue;
      } else if (type === "identity") {
        const p = it.identity;
        const map = {
          firstname: "firstName",
          lastname: "lastName",
          initial: "middleName",
          defphone: "phone",
          company: "company",
          email: "email",
          username: "username",
        };
        if (map[f.id] && blank(p[map[f.id]])) {
          p[map[f.id]] = value;
          continue;
        }
        if (key === "address") {
          p.address1 = orNull(v.street);
          p.city = orNull(v.city);
          if (!blank(v.country)) p.country = v.country.toUpperCase();
          p.postalCode = orNull(v.zip);
          p.state = orNull(v.state);
          continue;
        }
      }
      if (f.guarded) it.reprompt = true;
      kvp(it, f.title || section.title || "", value, key === "concealed" ? "hidden" : "text");
    }
  }
  // Notes, and what didn't fit in a field (a value on more than one line).
  if (!blank(src.details.notesPlain)) {
    const plain = src.details.notesPlain.split(newLine).join("\n").trimEnd();
    it.notes = blank(it.notes) ? plain : `${plain}\n\n${it.notes.trimEnd()}`;
  }
  if (it.type === "login") toNoteIfEmpty(it);
  // An archived item is archived (the importer stamps the time of the import).
  if (src.state === "archived") it.archivedDate = "archived";
  return cleanup(it);
}

const onePassword1pux = {
  id: "1password-1pux",
  title: "1Password 8 (1PUX)",
  files: (data) => [
    {
      name: `${onePasswordAccount}.1pux`,
      contents: zip([
        {
          name: "export.attributes",
          data: JSON.stringify({ version: 3, description: "1Password Unencrypted Export", createdAt: 1790856000 }),
        },
        { name: "export.data", data: JSON.stringify(onePasswordExportData(data)) },
        { name: "files/" },
      ]),
    },
  ],
  expect: (data) => {
    const folders = new Set();
    const items = onePasswordExportData(data).accounts[0].vaults.flatMap((v) =>
      v.items.map((i) => expectOnePasswordItem(i, folders)),
    );
    return result(items, folders);
  },
};

// 1Password 8 CSV: logins only, nine columns.
const onePasswordCsvHeader = [
  "Title",
  "Url",
  "Username",
  "Password",
  "OTPAuth",
  "Favorite",
  "Archived",
  "Tags",
  "Notes",
];

function onePasswordCsvRows(data) {
  return logins(data).map((it) => ({
    Title: it.name,
    Url: it.login.uris[0] ?? "",
    Username: it.login.username,
    Password: it.login.password,
    OTPAuth: it.login.totp
      ? it.login.totp.startsWith("otpauth://")
        ? it.login.totp
        : otpauth(it.name, it.login.username, it.login.totp)
      : "",
    Favorite: it.favorite ? "true" : "false",
    Archived: it.archived ? "true" : "false",
    Tags: it.folder ?? "",
    Notes: it.notes ?? "",
  }));
}

/** onepassword-8-csv-importer.ts ("1Password 8 (csv)"): standard CSV quoting. */
function expectOnePasswordCsv(csvRows) {
  const folders = new Set();
  const items = [];
  for (const row of csvRows) {
    if (Object.values(row).every(blank)) continue;
    const it = item();
    it.login.uris = blank(row.Url) ? [] : makeUris(row.Url.split(newLine));
    it.login.username = orNull(row.Username);
    it.login.password = orNull(row.Password);
    it.login.totp = orNull(row.OTPAuth?.trim());
    it.name = orNull(row.Title) ?? (it.login.uris[0] ? withoutWww(host(it.login.uris[0])) : null) ?? "--";
    it.notes = orNull(row.Notes) ?? "";
    it.favorite = /^(true|yes|1)$/i.test(row.Favorite.trim());
    const tags = (row.Tags ?? "")
      .split(/[,;\n]/)
      .map((t) => t.trim())
      .filter((t, i, all) => t !== "" && all.indexOf(t) === i);
    if (tags.length > 1) {
      if (it.notes.length > 0 && !it.notes.endsWith("\n")) it.notes += "\n";
      it.notes += "Tags: " + tags.join(", ");
    }
    if (blank(it.login.totp)) toNoteIfEmpty(it);
    cleanup(it);
    if (tags.length > 0) it.folder = addFolder(folders, tags[0]);
    if (/^(true|yes|1)$/i.test(row.Archived.trim())) it.archivedDate = "archived";
    items.push(it);
  }
  return result(items, folders);
}

const onePasswordCsv = {
  id: "1password-csv",
  title: "1Password 8 (CSV)",
  files: (data) => [
    {
      name: "1PasswordExport-TESTPERSON-20261001-120000.csv",
      contents: csv(onePasswordCsvHeader, onePasswordCsvRows(data)),
    },
  ],
  expect: (data) => expectOnePasswordCsv(onePasswordCsvRows(data)),
};

// ---------------------------------------------------------------------------
// LastPass: Advanced options, Export. Secure notes, cards, and addresses are
// rows whose url is "http://sn", their details in "extra" as "Key:value" lines.

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function lastPassRows(data) {
  return data.items.map((it) => {
    const grouping = (it.folder ?? "").replace(/\//g, "\\");
    const fav = it.favorite ? "1" : "0";
    if (it.type === "login") {
      const uri = it.login.uris[0] ?? "";
      return {
        url: uri && !uri.includes("://") ? `http://${uri}` : uri,
        username: it.login.username,
        password: it.login.password,
        totp: it.login.totp ? totpSecret(it.login.totp) : "",
        extra: it.notes ?? "",
        name: it.name,
        grouping,
        fav,
      };
    }
    let extra = it.notes ?? "";
    if (it.type === "card") {
      const c = it.card;
      extra = [
        "NoteType:Credit Card",
        "Language:en-US",
        `Name on Card:${c.cardholderName}`,
        `Type:${c.brand}`,
        `Number:${c.number}`,
        `Security Code:${c.code}`,
        "Start Date:,",
        `Expiration Date:${monthNames[Number(c.expMonth) - 1]},${c.expYear}`,
        `Notes:${it.notes ?? ""}`,
      ].join("\n");
    } else if (it.type === "identity") {
      const p = it.identity;
      extra = [
        "NoteType:Address",
        "Language:en-US",
        `Title:${p.title ?? ""}`,
        `First Name:${p.firstName ?? ""}`,
        `Middle Name:${p.middleName ?? ""}`,
        `Last Name:${p.lastName ?? ""}`,
        `Username:${p.username ?? ""}`,
        "Gender:",
        "Birthday:",
        `Company:${p.company ?? ""}`,
        `Address 1:${p.address1 ?? ""}`,
        "Address 2:",
        "Address 3:",
        `City / Town:${p.city ?? ""}`,
        "County:",
        `State:${p.state ?? ""}`,
        `Zip / Postal Code:${p.postalCode ?? ""}`,
        `Country:${p.country ?? ""}`,
        "Timezone:",
        `Email Address:${p.email ?? ""}`,
        `Phone:${p.phone ?? ""}`,
        "Evening Phone:",
        "Mobile Phone:",
        "Fax:",
        `Notes:${it.notes ?? ""}`,
      ].join("\n");
    }
    return { url: "http://sn", username: "", password: "", totp: "", extra, name: it.name, grouping, fav };
  });
}

/** lastpass-csv-importer.ts. */
function expectLastPass(rows) {
  const folders = new Set();
  const items = rows.map((row) => {
    const grouping = (row.grouping ?? "").replace(/\\/g, "/").replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    const note = row.url === "http://sn";
    let it = item(note ? "note" : "login");
    it.notes = null;
    it.favorite = row.fav === "1";
    it.name = orNull(row.name) ?? "--";
    if (!blank(grouping) && grouping !== "(none)") {
      folders.add(grouping);
      it.folder = grouping;
    }
    if (!note) {
      it.notes = orNull(row.extra);
      it.login.uris = makeUris(row.url);
      it.login.username = orNull(row.username);
      it.login.password = orNull(row.password);
      it.login.totp = orNull(row.totp);
      return it;
    }
    const lines = row.extra.split(newLine);
    const [kind, sub] = lines[0].split(":");
    if (kind !== "NoteType" || (sub !== "Credit Card" && sub !== "Address")) {
      it.notes = orNull(row.extra);
      return it;
    }
    const map =
      sub === "Credit Card"
        ? { Number: "number", "Name on Card": "cardholderName", "Security Code": "code", "Expiration Date": "expMonth" }
        : {
            Title: "title",
            "First Name": "firstName",
            "Last Name": "lastName",
            "Middle Name": "middleName",
            Company: "company",
            "Address 1": "address1",
            "Address 2": "address2",
            "Address 3": "address3",
            "City / Town": "city",
            State: "state",
            "Zip / Postal Code": "postalCode",
            Country: "country",
            "Email Address": "email",
            Username: "username",
            Phone: "phone",
          };
    const mapped = {};
    // The card's type and start date, for after the rest.
    const later = {};
    let inNotes = false;
    for (const line of lines) {
      if (inNotes) {
        it.notes += "\n" + line;
        continue;
      }
      if (blank(line)) continue;
      const colon = line.indexOf(":");
      const key = colon === -1 ? line : line.substring(0, colon);
      const val = colon === -1 ? null : line.substring(colon + 1);
      // LastPass's own Language isn't a field.
      if (blank(key) || blank(val) || key === "NoteType" || key === "Language") continue;
      if (key === "Notes") {
        it.notes = blank(it.notes) ? val : it.notes + "\n" + val;
        inNotes = true;
      } else if (sub === "Credit Card" && (key === "Type" || key === "Start Date")) {
        later[key] = val;
      } else if (key in map) {
        mapped[map[key]] = val;
      } else {
        kvp(it, key, val);
      }
    }
    if (sub === "Credit Card") {
      it.type = "card";
      it.card = { ...mapped };
      const [month, year] = mapped.expMonth.split(",");
      it.card.expMonth = String(monthNames.indexOf(month.trim()) + 1);
      if (!blank(year)) it.card.expYear = year;
      // The brand from the number, or else the type; a type that isn't the brand, and a
      // start date, stay fields.
      const typeBrand = brandFromName(later.Type);
      it.card.brand = brandOf(it.card.number) ?? typeBrand;
      if (!blank(later.Type) && typeBrand !== it.card.brand) kvp(it, "Type", later.Type);
      if (!blank(later["Start Date"]?.replace(/,/g, ""))) kvp(it, "Start Date", later["Start Date"]);
    } else {
      it.type = "identity";
      it.identity = { ...mapped };
    }
    return it;
  });
  return result(items, folders);
}

const lastPass = {
  id: "lastpass",
  title: "LastPass",
  files: (data) => [
    {
      name: "lastpass_export.csv",
      contents: csv(["url", "username", "password", "totp", "extra", "name", "grouping", "fav"], lastPassRows(data)),
    },
  ],
  expect: (data) => expectLastPass(lastPassRows(data)),
};

// ---------------------------------------------------------------------------
// Dashlane: Settings, Export data, CSV. A zip of one CSV per kind; the
// importer takes one CSV at a time.

function dashlaneFiles(data) {
  const credentials = logins(data).map((it) => ({
    username: it.login.username,
    username2: "",
    username3: "",
    title: it.name,
    password: it.login.password,
    note: it.notes ?? "",
    url: it.login.uris[0] ?? "",
    // Dashlane's categories have no folders inside them.
    category: (it.folder ?? "").split("/")[0],
    otpUrl: it.login.totp
      ? it.login.totp.startsWith("otpauth://")
        ? it.login.totp
        : otpauth(it.name, it.login.username, it.login.totp)
      : "",
  }));
  const notes = data.items.filter((i) => i.type === "note").map((it) => ({ title: it.name, note: it.notes ?? "" }));
  const payments = data.items
    .filter((i) => i.type === "card")
    .map((it) => ({
      type: "credit_card",
      account_name: it.card.cardholderName,
      account_holder: "",
      cc_number: it.card.number,
      code: it.card.code,
      expiration_month: it.card.expMonth.padStart(2, "0"),
      expiration_year: it.card.expYear,
      routing_number: "",
      account_number: "",
      country: "US",
      issuing_bank: "",
    }));
  const personal = [];
  for (const it of data.items.filter((i) => i.type === "identity")) {
    const p = it.identity;
    const row = (fields) => ({ ...Object.fromEntries(dashlanePersonalHeader.map((h) => [h, ""])), ...fields });
    personal.push(
      row({
        type: "name",
        title: p.title ?? "",
        first_name: p.firstName ?? "",
        middle_name: p.middleName ?? "",
        last_name: p.lastName ?? "",
        login: p.username ?? "",
      }),
    );
    if (p.email)
      personal.push(
        row({ type: "email", email: p.email, email_type: "personal", item_name: `${p.firstName}'s email` }),
      );
    if (p.phone) personal.push(row({ type: "number", item_name: `${p.firstName}'s number`, phone_number: p.phone }));
    if (p.address1 || p.city) {
      personal.push(
        row({
          type: "address",
          item_name: `${p.firstName}'s address`,
          address: p.address1 ?? "",
          country: p.country ?? "",
          state: p.state ?? "",
          city: p.city ?? "",
          zip: p.postalCode ?? "",
          address_recipient: `${p.firstName} ${p.lastName}`,
        }),
      );
    }
  }
  return {
    "credentials.csv": [dashlaneCredentialsHeader, credentials],
    "securenotes.csv": [["title", "note"], notes],
    "payments.csv": [dashlanePaymentsHeader, payments],
    "personalInfo.csv": [dashlanePersonalHeader, personal],
  };
}

const dashlaneCredentialsHeader = [
  "username",
  "username2",
  "username3",
  "title",
  "password",
  "note",
  "url",
  "category",
  "otpUrl",
];
const dashlanePaymentsHeader = [
  "type",
  "account_name",
  "account_holder",
  "cc_number",
  "code",
  "expiration_month",
  "expiration_year",
  "routing_number",
  "account_number",
  "country",
  "issuing_bank",
];
const dashlanePersonalHeader = [
  "type",
  "title",
  "first_name",
  "middle_name",
  "last_name",
  "login",
  "date_of_birth",
  "place_of_birth",
  "email",
  "email_type",
  "item_name",
  "phone_number",
  "address",
  "country",
  "state",
  "city",
  "zip",
  "address_recipient",
  "address_building",
  "address_apartment",
  "address_floor",
  "address_door_code",
  "job_title",
  "url",
];

/** dashlane-csv-importer.ts, for each file in turn. */
function expectDashlane(data) {
  const folders = new Set();
  const files = dashlaneFiles(data);
  const perFile = {};
  const items = [];
  const add = (file, it) => {
    perFile[file] = (perFile[file] ?? 0) + 1;
    items.push(cleanup(it));
  };
  for (const row of files["credentials.csv"][1]) {
    const it = item();
    it.folder = addFolder(folders, row.category);
    it.name = row.title;
    it.notes = row.note;
    it.login.username = row.username;
    it.login.password = row.password;
    it.login.totp = row.otpUrl;
    it.login.uris = makeUris(row.url);
    for (const key of ["username2", "username3"]) kvp(it, key, row[key]);
    toNoteIfEmpty(it);
    add("credentials.csv", it);
  }
  for (const row of files["securenotes.csv"][1]) {
    const it = item("note");
    it.name = row.title;
    it.notes = row.note;
    add("securenotes.csv", it);
  }
  for (const row of files["payments.csv"][1]) {
    const it = item("card");
    // No name for the card in the export: its brand and last four digits.
    it.card = {
      cardholderName: orNull(row.account_name),
      number: row.cc_number,
      brand: brandOf(row.cc_number),
      code: row.code,
    };
    it.name = `${it.card.brand ?? "Card"} ending ${row.cc_number.replace(/\D/g, "").slice(-4)}`;
    const m = /^0?([1-9]|1[0-2])\/((?:[1-2][0-9])?[0-9]{2})$/.exec(`${row.expiration_month}/${row.expiration_year}`);
    if (m) {
      it.card.expMonth = m[1];
      it.card.expYear = m[2].length === 2 ? `20${m[2]}` : m[2];
    }
    // Every column it doesn't map is a field; "credit_card" made it a card.
    for (const key of ["routing_number", "account_number", "country", "issuing_bank"]) kvp(it, key, row[key]);
    add("payments.csv", it);
  }
  // An identity for each person: a name row starts one, and the rows after it are
  // theirs unless they name exactly one other person ("Zoë's email").
  const people = [];
  for (const row of files["personalInfo.csv"][1]) {
    if (row.type === "name") {
      const first = row.first_name.trim().toLowerCase();
      const full = [first, row.last_name.trim().toLowerCase()].filter(Boolean).join(" ");
      people.push({ names: [full, first].filter(Boolean), rows: [row] });
      continue;
    }
    const text = `${row.item_name} ${row.address_recipient}`.toLowerCase();
    const inWord = (c) => c != null && (c.toLowerCase() !== c.toUpperCase() || /[0-9]/.test(c));
    const mentions = (name) => {
      for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
        const after = text.substring(i + name.length);
        if (!inWord(text[i - 1]) && (!inWord(after[0]) || (after[0] === "s" && !inWord(after[1])))) return true;
      }
      return false;
    };
    const named = people.filter((p) => p.names.some(mentions));
    (named.length === 1 ? named[0] : people[people.length - 1]).rows.push(row);
  }
  const mappedPersonal = new Set([
    "type",
    "title",
    "first_name",
    "middle_name",
    "last_name",
    "login",
    "email",
    "phone_number",
    "address",
    "country",
    "state",
    "city",
    "zip",
    "item_name",
  ]);
  for (const person of people) {
    const it = item("identity");
    const p = it.identity;
    for (const row of person.rows) {
      if (row.type === "name") {
        p.title = orNull(row.title);
        p.firstName = orNull(row.first_name);
        p.middleName = orNull(row.middle_name);
        p.lastName = orNull(row.last_name);
        p.username = orNull(row.login);
        it.name = [p.title, p.firstName, p.middleName, p.lastName].filter((x) => !blank(x)).join(" ");
      } else if (row.type === "email") {
        if (blank(p.email)) p.email = row.email;
        else kvp(it, orNull(row.item_name) ?? "email", row.email);
      } else if (row.type === "number") {
        if (blank(p.phone)) p.phone = row.phone_number;
        else kvp(it, orNull(row.item_name) ?? "phone_number", row.phone_number);
      } else if (row.type === "address") {
        if (blank(p.address1) && blank(p.city)) {
          p.address1 = orNull(row.address);
          p.city = orNull(row.city);
          p.postalCode = orNull(row.zip);
          p.state = orNull(row.state);
          p.country = orNull(row.country);
        } else {
          throw new Error("The fake data has one address a person; this model covers that case only.");
        }
      }
      for (const key of dashlanePersonalHeader) if (!mappedPersonal.has(key)) kvp(it, key, row[key]);
    }
    add("personalInfo.csv", it);
  }
  return result(items, folders, { perFile });
}

const dashlane = {
  id: "dashlane",
  title: "Dashlane (CSV)",
  files: (data) =>
    Object.entries(dashlaneFiles(data)).map(([name, [header, rows]]) => ({ name, contents: csv(header, rows) })),
  expect: expectDashlane,
};

// ---------------------------------------------------------------------------
// KeePass 2: File, Export, KeePass XML (2.x). Groups are folders; the root
// group's own entries have none. Tabs, CRLF, no byte order mark.

const xmlEscape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function keePassEntries(data) {
  const random = rng(SEED + 2);
  const uuid = () => Buffer.from(Array.from({ length: 16 }, () => Math.floor(random() * 256))).toString("base64");
  return data.items.map((it) => {
    const strings = [];
    const add = (key, value, protect = false) => strings.push({ key, value: value ?? "", protect });
    add("Title", it.name);
    add("Notes", it.notes ?? "");
    if (it.type === "login") {
      add("UserName", it.login.username);
      add("Password", it.login.password, true);
      add("URL", it.login.uris[0] ?? "");
      // More addresses, the way KeePass2Android and KeePassXC keep them.
      it.login.uris.slice(1).forEach((u, i) => add(`KP2A_URL_${i + 1}`, u));
      // KeePass 2.47 and later keep a TOTP secret in these.
      if (it.login.totp) add("TimeOtp-Secret-Base32", totpSecret(it.login.totp), true);
    } else {
      add("UserName", "");
      add("Password", "", true);
      add("URL", "");
    }
    for (const f of it.fields) add(f.name, f.value, f.type === "hidden");
    if (it.type === "card") {
      const c = it.card;
      add("Cardholder", c.cardholderName);
      add("Card number", c.number, true);
      add("Expires", `${c.expMonth.padStart(2, "0")}/${c.expYear}`);
      add("CVV", c.code, true);
    }
    if (it.type === "identity") {
      const p = it.identity;
      strings.find((s) => s.key === "UserName").value = p.username ?? "";
      const labels = {
        firstName: "First name",
        middleName: "Middle name",
        lastName: "Last name",
        company: "Company",
        email: "Email",
        phone: "Phone",
        address1: "Address",
        city: "City",
        state: "State",
        postalCode: "Postal code",
        country: "Country",
      };
      for (const [k, label] of Object.entries(labels)) if (p[k]) add(label, p[k]);
    }
    strings.sort((a, b) => a.key.localeCompare(b.key, "en"));
    return { it, uuid: uuid(), strings };
  });
}

function keePassXml(data) {
  const entries = keePassEntries(data);
  const t = (n) => "\t".repeat(n);
  const times = (iso, depth) => [
    `${t(depth)}<Times>`,
    `${t(depth + 1)}<CreationTime>${iso.replace(/\.\d+Z$/, "Z")}</CreationTime>`,
    `${t(depth + 1)}<LastModificationTime>${iso.replace(/\.\d+Z$/, "Z")}</LastModificationTime>`,
    `${t(depth + 1)}<LastAccessTime>${iso.replace(/\.\d+Z$/, "Z")}</LastAccessTime>`,
    `${t(depth + 1)}<ExpiryTime>${iso.replace(/\.\d+Z$/, "Z")}</ExpiryTime>`,
    `${t(depth + 1)}<Expires>False</Expires>`,
    `${t(depth + 1)}<UsageCount>0</UsageCount>`,
    `${t(depth + 1)}<LocationChanged>${iso.replace(/\.\d+Z$/, "Z")}</LocationChanged>`,
    `${t(depth)}</Times>`,
  ];
  const entryXml = (e, depth, history = true) => {
    const lines = [
      `${t(depth)}<Entry>`,
      `${t(depth + 1)}<UUID>${e.uuid}</UUID>`,
      `${t(depth + 1)}<IconID>0</IconID>`,
      `${t(depth + 1)}<ForegroundColor />`,
      `${t(depth + 1)}<BackgroundColor />`,
      `${t(depth + 1)}<OverrideURL />`,
      `${t(depth + 1)}<Tags />`,
      ...times(e.it.updated, depth + 1),
    ];
    for (const s of e.strings) {
      lines.push(`${t(depth + 1)}<String>`, `${t(depth + 2)}<Key>${xmlEscape(s.key)}</Key>`);
      lines.push(
        s.value === ""
          ? `${t(depth + 2)}<Value${s.protect ? ' ProtectInMemory="True"' : ""} />`
          : `${t(depth + 2)}<Value${s.protect ? ' ProtectInMemory="True"' : ""}>${xmlEscape(s.value)}</Value>`,
      );
      lines.push(`${t(depth + 1)}</String>`);
    }
    lines.push(
      `${t(depth + 1)}<AutoType>`,
      `${t(depth + 2)}<Enabled>True</Enabled>`,
      `${t(depth + 2)}<DataTransferObfuscation>0</DataTransferObfuscation>`,
      `${t(depth + 1)}</AutoType>`,
    );
    if (history && e.it.passwordHistory.length) {
      lines.push(`${t(depth + 1)}<History>`);
      for (const h of e.it.passwordHistory) {
        const old = {
          ...e,
          it: { ...e.it, updated: h.date },
          strings: e.strings.map((s) => (s.key === "Password" ? { ...s, value: h.password } : s)),
        };
        lines.push(...entryXml(old, depth + 2, false));
      }
      lines.push(`${t(depth + 1)}</History>`);
    } else if (history) {
      lines.push(`${t(depth + 1)}<History />`);
    }
    lines.push(`${t(depth)}</Entry>`);
    return lines;
  };
  const random = rng(SEED + 3);
  const groupUuid = () => Buffer.from(Array.from({ length: 16 }, () => Math.floor(random() * 256))).toString("base64");
  const recycleBin = groupUuid();
  const group = (name, uuid, depth, body) => [
    `${t(depth)}<Group>`,
    `${t(depth + 1)}<UUID>${uuid}</UUID>`,
    `${t(depth + 1)}<Name>${xmlEscape(name)}</Name>`,
    `${t(depth + 1)}<Notes />`,
    `${t(depth + 1)}<IconID>${name === "Recycle Bin" ? 43 : 48}</IconID>`,
    ...times("2025-01-01T00:00:00Z", depth + 1),
    `${t(depth + 1)}<IsExpanded>True</IsExpanded>`,
    `${t(depth + 1)}<DefaultAutoTypeSequence />`,
    `${t(depth + 1)}<EnableAutoType>null</EnableAutoType>`,
    `${t(depth + 1)}<EnableSearching>${name === "Recycle Bin" ? "False" : "null"}</EnableSearching>`,
    `${t(depth + 1)}<LastTopVisibleEntry>AAAAAAAAAAAAAAAAAAAAAA==</LastTopVisibleEntry>`,
    ...body,
    `${t(depth)}</Group>`,
  ];
  const inFolder = (name) => entries.filter((e) => e.it.folder === name);
  const groupTree = (depth) => [
    ...group(
      "Finance",
      groupUuid(),
      depth,
      inFolder("Finance").flatMap((e) => entryXml(e, depth + 1)),
    ),
    ...group(
      "Personal",
      groupUuid(),
      depth,
      inFolder("Personal").flatMap((e) => entryXml(e, depth + 1)),
    ),
    ...group(
      "Shopping",
      groupUuid(),
      depth,
      inFolder("Shopping").flatMap((e) => entryXml(e, depth + 1)),
    ),
    ...group("Work", groupUuid(), depth, [
      ...inFolder("Work").flatMap((e) => entryXml(e, depth + 1)),
      ...group(
        "Servers",
        groupUuid(),
        depth + 1,
        inFolder("Work/Servers").flatMap((e) => entryXml(e, depth + 2)),
      ),
    ]),
    // Deleted entries wait in the Recycle Bin, and the export has them too.
    ...group("Recycle Bin", recycleBin, depth, entryXml(keePassDeleted(), depth + 1)),
  ];
  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    "<KeePassFile>",
    "\t<Meta>",
    "\t\t<Generator>KeePass</Generator>",
    "\t\t<DatabaseName>Fake vault</DatabaseName>",
    "\t\t<DatabaseNameChanged>2025-01-01T00:00:00Z</DatabaseNameChanged>",
    "\t\t<DatabaseDescription />",
    "\t\t<DatabaseDescriptionChanged>2025-01-01T00:00:00Z</DatabaseDescriptionChanged>",
    "\t\t<DefaultUserName />",
    "\t\t<DefaultUserNameChanged>2025-01-01T00:00:00Z</DefaultUserNameChanged>",
    "\t\t<MaintenanceHistoryDays>365</MaintenanceHistoryDays>",
    "\t\t<Color />",
    "\t\t<MasterKeyChanged>2025-01-01T00:00:00Z</MasterKeyChanged>",
    "\t\t<MasterKeyChangeRec>-1</MasterKeyChangeRec>",
    "\t\t<MasterKeyChangeForce>-1</MasterKeyChangeForce>",
    "\t\t<MemoryProtection>",
    "\t\t\t<ProtectTitle>False</ProtectTitle>",
    "\t\t\t<ProtectUserName>False</ProtectUserName>",
    "\t\t\t<ProtectPassword>True</ProtectPassword>",
    "\t\t\t<ProtectURL>False</ProtectURL>",
    "\t\t\t<ProtectNotes>False</ProtectNotes>",
    "\t\t</MemoryProtection>",
    "\t\t<RecycleBinEnabled>True</RecycleBinEnabled>",
    `\t\t<RecycleBinUUID>${recycleBin}</RecycleBinUUID>`,
    "\t\t<RecycleBinChanged>2026-09-01T00:00:00Z</RecycleBinChanged>",
    "\t\t<EntryTemplatesGroup>AAAAAAAAAAAAAAAAAAAAAA==</EntryTemplatesGroup>",
    "\t\t<EntryTemplatesGroupChanged>2025-01-01T00:00:00Z</EntryTemplatesGroupChanged>",
    "\t\t<HistoryMaxItems>10</HistoryMaxItems>",
    "\t\t<HistoryMaxSize>6291456</HistoryMaxSize>",
    "\t\t<LastSelectedGroup>AAAAAAAAAAAAAAAAAAAAAA==</LastSelectedGroup>",
    "\t\t<LastTopVisibleGroup>AAAAAAAAAAAAAAAAAAAAAA==</LastTopVisibleGroup>",
    "\t\t<Binaries />",
    "\t\t<CustomData />",
    "\t</Meta>",
    "\t<Root>",
    ...group("Fake vault", groupUuid(), 2, [...inFolder(null).flatMap((e) => entryXml(e, 3)), ...groupTree(3)]),
    "\t\t<DeletedObjects />",
    "\t</Root>",
    "</KeePassFile>",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** The entry in the Recycle Bin. */
function keePassDeleted() {
  return {
    it: { updated: "2026-09-01T00:00:00.000Z", passwordHistory: [] },
    uuid: "ZGVsZXRlZC1lbnRyeS0wMQ==",
    strings: [
      { key: "Notes", value: "Deleted in KeePass; it shouldn't come back.", protect: false },
      { key: "Password", value: "Old-Deleted-Pass-00", protect: true },
      { key: "Title", value: "Old forum account (deleted)", protect: false },
      { key: "URL", value: "https://oldforum.example.com/", protect: false },
      { key: "UserName", value: "test.person", protect: false },
    ],
  };
}

/** keepass2-xml-importer.ts: every group but the root and the Recycle Bin is a folder. */
function expectKeePass(data) {
  const folders = new Set();
  const items = [];
  for (const e of keePassEntries(data)) {
    const it = item();
    const folder = e.it.folder;
    if (folder) {
      it.folder = folder;
      folders.add(folder);
    }
    let notes = null;
    let mainUri = null;
    const moreUris = [];
    for (const s of e.strings) {
      if (blank(s.value)) continue;
      if (s.key === "URL") mainUri = s.value;
      else if (/^(KP2A_URL(_\d+)?|URL[ _-]?\(?\d+\)?)$/i.test(s.key)) moreUris.push(s.value);
      else if (s.key === "UserName") it.login.username = s.value;
      else if (s.key === "Password") it.login.password = s.value;
      // KeePass 2.47's TOTP, with the default period, length, and algorithm: the secret.
      else if (s.key === "TimeOtp-Secret-Base32") it.login.totp = s.value.replace(/[\s=-]/g, "").toUpperCase();
      else if (s.key === "Title") it.name = s.value;
      else if (s.key === "Notes") notes = s.value;
      else if (s.protect) it.fields.push({ name: s.key, value: s.value, type: "hidden" });
      else kvp(it, s.key, s.value);
    }
    it.login.uris = makeUris([mainUri, ...moreUris].filter((u, i, all) => u != null && all.indexOf(u) === i));
    // The notes as they were, then what didn't fit in a field.
    if (notes != null) it.notes = blank(it.notes) ? notes : `${notes}\n${it.notes}`;
    // Nothing to sign in with: a secure note (KeePass keeps notes and cards as entries).
    if (blank(it.login.totp)) toNoteIfEmpty(it);
    items.push(cleanup(it));
  }
  // Every group is a folder, even with nothing directly in it.
  for (const name of ["Finance", "Personal", "Shopping", "Work", "Work/Servers"]) folders.add(name);
  return result(items, folders);
}

const keePass = {
  id: "keepass",
  title: "KeePass 2 (XML)",
  files: (data) => [{ name: "Fake vault.xml", contents: keePassXml(data) }],
  expect: expectKeePass,
};

// ---------------------------------------------------------------------------
// Proton Pass: Settings, Export, unencrypted. A zip with "Proton Pass/data.json";
// vaults instead of folders.

function protonPassExport(data) {
  const random = rng(SEED + 4);
  const opaque = () =>
    Buffer.from(Array.from({ length: 64 }, () => Math.floor(random() * 256)))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const vaultOf = (it) => (it.folder ? it.folder.split("/")[0] : "Personal");
  const vaultNames = ["Personal", "Finance", "Shopping", "Work"];
  const vaults = Object.fromEntries(
    vaultNames.map((name) => [
      opaque(),
      { name, description: name === "Personal" ? "Personal vault" : "", display: { color: 0, icon: 0 }, items: [] },
    ]),
  );
  const byName = new Map(Object.entries(vaults).map(([shareId, v]) => [v.name, [shareId, v]]));
  const extra = (fields) =>
    fields.map((f) => ({
      fieldName: f.name,
      type: f.type === "hidden" ? "hidden" : "text",
      data: { content: f.value },
    }));
  const push = (it, type, content, extraFields = [], state = 1) => {
    const [shareId, vault] = byName.get(vaultOf(it));
    vault.items.push({
      itemId: opaque(),
      shareId,
      data: {
        metadata: { name: it.name, note: it.notes ?? "", itemUuid: it.uuid.slice(-8) },
        extraFields,
        type,
        content,
      },
      state,
      aliasEmail: null,
      contentFormatVersion: 6,
      createTime: seconds(it.created),
      modifyTime: seconds(it.updated),
      pinned: it.favorite,
    });
  };
  for (const it of data.items) {
    if (it.type === "login") {
      const l = it.login;
      const email = /@/.test(l.username) && !/\\/.test(l.username);
      push(
        it,
        "login",
        {
          itemEmail: email ? l.username : "",
          password: l.password,
          urls: l.uris
            .filter((u) => !u.startsWith("androidapp://"))
            .map((u) => (u.includes("://") ? u : `https://${u}`)),
          totpUri: l.totp ? (l.totp.startsWith("otpauth://") ? l.totp : otpauth(it.name, l.username, l.totp)) : "",
          passkeys: [],
          itemUsername: email ? "" : l.username,
        },
        extra(it.fields),
      );
    } else if (it.type === "note") {
      push(it, "note", {}, extra(it.fields));
    } else if (it.type === "card") {
      const c = it.card;
      push(it, "creditCard", {
        cardholderName: c.cardholderName,
        cardType: 0,
        number: c.number,
        verificationNumber: c.code,
        expirationDate: `${c.expYear}-${c.expMonth.padStart(2, "0")}`,
        pin: "",
      });
    } else {
      const p = it.identity;
      push(it, "identity", {
        fullName: [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" "),
        email: p.email ?? "",
        phoneNumber: p.phone ?? "",
        firstName: p.firstName ?? "",
        middleName: p.middleName ?? "",
        lastName: p.lastName ?? "",
        birthdate: "",
        gender: "",
        extraPersonalDetails: [],
        organization: "",
        streetAddress: p.address1 ?? "",
        zipOrPostalCode: p.postalCode ?? "",
        city: p.city ?? "",
        stateOrProvince: p.state ?? "",
        countryOrRegion: p.country ?? "",
        floor: "",
        county: "",
        extraAddressDetails: [],
        socialSecurityNumber: "",
        passportNumber: "",
        licenseNumber: "",
        website: "",
        xHandle: "",
        secondPhoneNumber: "",
        linkedin: "",
        reddit: "",
        facebook: "",
        yahoo: "",
        instagram: "",
        extraContactDetails: [],
        company: p.company ?? "",
        jobTitle: "",
        personalWebsite: "",
        workPhoneNumber: "",
        workEmail: "",
        extraWorkDetails: [],
        extraSections: [],
      });
    }
  }
  // An item in Proton Pass's trash.
  push(
    {
      name: "Trashed login",
      notes: "In Proton Pass's trash.",
      folder: null,
      favorite: false,
      uuid: "00000000-0000-4000-8000-00000000dead",
      created: "2026-09-01T00:00:00Z",
      updated: "2026-09-02T00:00:00Z",
    },
    "login",
    {
      itemEmail: "",
      password: "Trashed-Pass-00",
      urls: ["https://trashed.example.com/"],
      totpUri: "",
      passkeys: [],
      itemUsername: "test.person",
    },
    [],
    2,
  );
  return { version: "1.31.0", userId: "fake-user-id-not-real", encrypted: false, vaults };
}

/** protonpass-json-importer.ts: each vault is a folder, when items come from more than one. */
function expectProtonPass(data) {
  const exported = protonPassExport(data);
  const folders = new Set();
  const items = [];
  const vaultsAreFolders = Object.values(exported.vaults).filter((v) => v.items.some((i) => i.state !== 2)).length > 1;
  for (const vault of Object.values(exported.vaults)) {
    for (const src of vault.items) {
      if (src.state === 2) continue;
      const d = src.data;
      const it = item();
      it.name = orNull(d.metadata.name) ?? "--";
      it.notes = orNull(d.metadata.note);
      it.favorite = src.pinned;
      const extraFields = () =>
        d.extraFields.forEach((f) =>
          kvp(
            it,
            f.fieldName,
            f.type === "totp" ? f.data.totpUri : f.data.content,
            f.type === "hidden" || f.type === "totp" ? "hidden" : "text",
          ),
        );
      if (d.type === "login") {
        const c = d.content;
        it.login.uris = makeUris(c.urls.length ? c.urls : null);
        it.login.username = orNull(c.itemUsername);
        if (it.login.username == null) it.login.username = orNull(c.itemEmail);
        else kvp(it, "email", c.itemEmail);
        it.login.password = orNull(c.password);
        it.login.totp = orNull(c.totpUri);
        extraFields();
      } else if (d.type === "note") {
        it.type = "note";
        extraFields();
      } else if (d.type === "creditCard") {
        const c = d.content;
        it.type = "card";
        it.card = {
          cardholderName: orNull(c.cardholderName),
          number: orNull(c.number),
          brand: brandOf(c.number),
          code: orNull(c.verificationNumber),
          expMonth: c.expirationDate.substring(5, 7).replace(/^0+/, ""),
          expYear: c.expirationDate.substring(0, 4),
        };
        if (!blank(c.pin)) kvp(it, "PIN", c.pin, "hidden");
        extraFields();
      } else if (d.type === "identity") {
        const c = d.content;
        it.type = "identity";
        const parts = c.fullName.trim().split(/\s+/);
        const company = orNull(c.company);
        const organization = orNull(c.organization);
        // The street on the first address line, then the organization when it isn't the
        // company, then the floor and county, with no empty lines between.
        const [address1, address2, address3] = [
          c.streetAddress,
          company != null && organization !== company ? organization : null,
          `${c.floor ?? ""} ${c.county ?? ""}`,
        ]
          .map((line) => orNull(line?.trim()))
          .filter((line) => line != null);
        it.identity = {
          firstName: parts[0] || orNull(c.firstName),
          lastName: parts.length > 1 ? parts[parts.length - 1] : orNull(c.lastName),
          middleName: parts.length > 2 ? parts.slice(1, -1).join(" ") : orNull(c.middleName),
          email: orNull(c.email),
          phone: orNull(c.phoneNumber),
          company: company ?? organization,
          address1: address1 ?? null,
          address2: address2 ?? null,
          address3: address3 ?? null,
          city: orNull(c.city),
          state: orNull(c.stateOrProvince),
          postalCode: orNull(c.zipOrPostalCode),
          country: orNull(c.countryOrRegion),
        };
        const mapped = [
          "fullName",
          "firstName",
          "middleName",
          "lastName",
          "email",
          "phoneNumber",
          "company",
          "socialSecurityNumber",
          "passportNumber",
          "licenseNumber",
          "organization",
          "streetAddress",
          "floor",
          "county",
          "city",
          "stateOrProvince",
          "zipOrPostalCode",
          "countryOrRegion",
        ];
        const extraKeys = [
          "extraPersonalDetails",
          "extraAddressDetails",
          "extraContactDetails",
          "extraWorkDetails",
          "extraSections",
        ];
        for (const [key, value] of Object.entries(c)) {
          if (!mapped.includes(key) && !extraKeys.includes(key)) kvp(it, key, value);
        }
        extraFields();
      }
      if (vaultsAreFolders) it.folder = addFolder(folders, vault.name);
      items.push(cleanup(it));
    }
  }
  return result(items, folders);
}

const protonPass = {
  id: "protonpass",
  title: "Proton Pass (zip)",
  files: (data) => [
    {
      name: "Proton Pass_export_2026-10-01.zip",
      contents: zip([{ name: "Proton Pass/data.json", data: JSON.stringify(protonPassExport(data), null, 2) }]),
    },
  ],
  expect: expectProtonPass,
};

export const formats = [
  chrome,
  chromeExcel,
  edge,
  brave,
  firefox,
  apple,
  onePassword1pux,
  onePasswordCsv,
  bitwarden,
  lastPass,
  dashlane,
  keePass,
  protonPass,
];

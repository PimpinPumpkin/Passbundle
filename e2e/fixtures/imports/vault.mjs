// What a vault holds, in one comparable shape: used for what each import
// should give (expected/*.json) and for reading the vault back after an
// import (the web vault's own .json export), so the two compare item by item.

const typeNames = { 1: "login", 2: "note", 3: "card", 4: "identity", 5: "sshkey" };
const fieldTypes = ["text", "hidden", "boolean", "linked"];
export const identityKeys = [
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
];
const cardKeys = ["cardholderName", "brand", "number", "expMonth", "expYear", "code"];

/** An empty string is no value. */
const value = (s) => (s == null || s === "" ? null : s);

/** One item, normalized. Takes the fields a web vault export item has. */
export function normalize(item, folderName = () => null) {
  const type = typeof item.type === "number" ? typeNames[item.type] : item.type;
  const out = {
    type,
    name: item.name,
    folder: item.folder !== undefined ? item.folder : folderName(item.folderId),
    favorite: !!item.favorite,
    reprompt: !!item.reprompt,
    notes: value(item.notes),
    fields: (item.fields ?? []).map((f) => ({
      name: value(f.name),
      value: value(f.value),
      type: typeof f.type === "number" ? fieldTypes[f.type] : f.type,
    })),
    login: null,
    passwordHistory: (item.passwordHistory ?? []).map((h) => h.password),
    card: null,
    identity: null,
  };
  if (type === "login") {
    const login = item.login ?? {};
    out.login = {
      username: value(login.username),
      password: value(login.password),
      uris: (login.uris ?? []).map((u) => (typeof u === "string" ? u : u.uri)).filter((u) => u != null),
      totp: value(login.totp),
    };
  }
  if (type === "card") {
    out.card = Object.fromEntries(cardKeys.map((k) => [k, value(item.card?.[k])]));
  }
  if (type === "identity") {
    out.identity = Object.fromEntries(
      identityKeys.filter((k) => value(item.identity?.[k]) != null).map((k) => [k, item.identity[k]]),
    );
  }
  return out;
}

/** A stable order for comparing: by type, name, then everything else. */
export function sortItems(items) {
  const key = (i) => JSON.stringify([i.type, i.name, i]);
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The web vault's unencrypted .json export, as a vault: folders and items. */
export function fromExport(exported) {
  const folders = new Map((exported.folders ?? []).map((f) => [f.id, f.name]));
  return {
    folders: [...folders.values()].sort(),
    items: sortItems(exported.items.map((i) => normalize(i, (id) => (id ? (folders.get(id) ?? null) : null)))),
  };
}

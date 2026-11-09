// Makes the test tenants (tenants.ts) through the server's API, and takes
// them down again. Every key and every encrypted value is made here, with the
// end-to-end tests' own crypto helpers (e2e/tests/support/vault-crypto.ts):
// account keys from the master password (PBKDF2), organization keys wrapped
// to each member's public key, and items encrypted with their organization's
// or account's key. The server gets only what the apps would send it.
import { createHash, generateKeyPairSync, randomBytes, randomInt, randomUUID } from "node:crypto";

import { encrypt, encryptTo, KDF, masterKeys, rsaKeyPair } from "../../e2e/tests/support/vault-crypto.ts";
import { type Api, ApiError, type Credentials, NewDeviceHeld, type Session, totp, stepOf } from "./api.ts";
import {
  emailOf,
  type FieldSpec,
  type Grid,
  type ItemSpec,
  MSP_NAME,
  MSP_TEMPLATES,
  ORGS,
  type OrgSpec,
  OWN,
  PEOPLE,
  person,
  PRESETS,
  RANDOM,
  STAFF,
} from "./tenants.ts";

/** Someone with an account, as the state file keeps them. */
export type PersonState = Credentials & {
  key: string;
  /** The master password, as the person types it. Only ever written to the state and credentials files. */
  password: string;
  userId?: string;
  recoveryCode?: string;
  /** Whether the server has the account (set once registration answers). */
  registered: boolean;
};

export type State = {
  version: 1;
  server: string;
  /** Whether the last seed finished. */
  complete: boolean;
  seededAt?: string;
  people: Record<string, PersonState>;
  mspId?: string;
  orgs: Record<string, { id: string; name: string; deleteAs: string }>;
};

export const newState = (server: string): State => ({ version: 1, server, complete: false, people: {}, orgs: {} });

type Log = (line: string) => void;

// Upstream's numbers.
const TYPES = { login: 1, note: 2, card: 3, identity: 4, ssh: 5, bank: 6, license: 7, passport: 8 } as const;
const FIELD_TYPES = { text: 0, hidden: 1, boolean: 2 } as const;
const ROLES = { owner: 0, admin: 1, user: 2, custom: 4 } as const;
const VAULT_LOCK_POLICY = 9;
const MASTER_PASSWORD_POLICY = 1;

/** A master password: five groups of four, about 100 bits, easy to type on a phone. */
export function masterPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const groups = Array.from({ length: 5 }, () =>
      Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(""),
    );
    const all = groups.join("-");
    if (/[a-z]/.test(all) && /[A-Z]/.test(all) && /[0-9]/.test(all)) {
      return all;
    }
  }
}

/** A strong item password, as the generator makes one: 20 characters of every kind. */
function itemPassword(): string {
  const sets = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#$%^&*-_"];
  for (;;) {
    const all = sets.join("");
    const value = Array.from({ length: 20 }, () => all[randomInt(all.length)]).join("");
    if (sets.every((s) => [...value].some((c) => s.includes(c)))) {
      return value;
    }
  }
}

function base32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const b of bytes) {
    bits += b.toString(2).padStart(8, "0");
  }
  return (bits.match(/.{1,5}/g) ?? []).map((c) => alphabet[parseInt(c.padEnd(5, "0"), 2)]).join("");
}

/** An OpenSSH Ed25519 key pair, as the apps' SSH key generator makes one. */
function sshKey(comment: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const str = (b: Buffer | string) => {
    const buf = Buffer.from(b);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    return Buffer.concat([len, buf]);
  };
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const blob = Buffer.concat([str("ssh-ed25519"), str(raw)]);
  const check = randomBytes(4);
  let secret = Buffer.concat([check, check, str("ssh-ed25519"), str(raw), str(Buffer.concat([seed, raw])), str(comment)]);
  for (let i = 1; secret.length % 8 !== 0; i++) {
    secret = Buffer.concat([secret, Buffer.from([i])]);
  }
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    str("none"),
    str("none"),
    str(Buffer.alloc(0)),
    count,
    str(blob),
    str(secret),
  ]);
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString("base64").match(/.{1,70}/g)!.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${blob.toString("base64")}`,
    keyFingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}

/** A passkey for a site, as the apps store one (upstream's Fido2Credential), before encryption. */
function passkey(rpId: string, userName: string, displayName: string) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    credentialId: randomUUID(),
    keyType: "public-key",
    keyAlgorithm: "ECDSA",
    keyCurve: "P-256",
    keyValue: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    rpId,
    rpName: rpId,
    userHandle: randomBytes(16).toString("base64url"),
    userName,
    userDisplayName: displayName,
    counter: "0",
    discoverable: "true",
  };
}

const isoDay = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

function cardExpiry(months: number) {
  const now = new Date();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 1));
  return { expMonth: String(at.getUTCMonth() + 1), expYear: String(at.getUTCFullYear()) };
}

/** A shared folder grant as the web vault sends it: upstream's closest preset, and the grid. */
function grant(id: string, access: keyof typeof PRESETS | Grid) {
  const grid = typeof access === "string" ? PRESETS[access] : access;
  return {
    id,
    readOnly: !grid.manage && !grid.edit,
    hidePasswords: !grid.manage && !grid.seePasswords,
    manage: grid.manage,
    keykeeper: grid,
  };
}

/** An item before it's encrypted: what its people see. */
type View = {
  type: number;
  name: string;
  notes: string | null;
  favorite: boolean;
  reprompt: number;
  fields: { name: string; value: string; type: number }[];
  part?: { key: string; values: Record<string, string | null> };
  login?: {
    username: string | null;
    password: string | null;
    totp: string | null;
    uris: string[];
    passkey?: ReturnType<typeof passkey>;
    passkeyMade?: string;
  };
};

/** An item's body for the API, every value encrypted with this key. */
function encryptView(
  key: Buffer,
  view: View,
  ownerId: string,
  organizationId: string | null,
  folderId: string | null,
  passwordHistory: { password: string; lastUsedDate: string }[],
) {
  const e = (value: string | null | undefined) => (value == null || value === "" ? null : encrypt(key, value));
  const body: Record<string, unknown> = {
    type: view.type,
    organizationId,
    encryptedFor: ownerId,
    folderId,
    name: e(view.name),
    notes: e(view.notes),
    favorite: view.favorite,
    reprompt: view.reprompt,
    fields: view.fields.map((f) => ({ name: e(f.name), value: e(f.value), type: f.type, linkedId: null })),
    passwordHistory: passwordHistory.length
      ? passwordHistory.map((h) => ({ password: e(h.password), lastUsedDate: h.lastUsedDate }))
      : null,
  };
  if (view.type === TYPES.note) {
    body.secureNote = { type: 0 };
  }
  if (view.login) {
    const l = view.login;
    body.login = {
      username: e(l.username),
      password: e(l.password),
      totp: e(l.totp),
      uris: l.uris.map((uri) => ({ uri: e(uri), match: null })),
      passwordRevisionDate: passwordHistory.length ? new Date().toISOString() : null,
      fido2Credentials: l.passkey
        ? [
            {
              ...Object.fromEntries(Object.entries(l.passkey).map(([k, v]) => [k, e(v)])),
              creationDate: l.passkeyMade,
            },
          ]
        : null,
    };
  }
  if (view.part) {
    body[view.part.key] = Object.fromEntries(Object.entries(view.part.values).map(([k, v]) => [k, e(v)]));
  }
  return body;
}

type Live = { state: PersonState; session: Session; userKey: Buffer; publicKey: Buffer };

type OrgLive = {
  spec: OrgSpec;
  id: string;
  key: Buffer;
  folders: Map<string, string>;
  members: Map<string, string>;
};

export class Seeder {
  private readonly api: Api;
  private readonly state: State;
  private readonly save: () => void;
  private readonly log: Log;
  private readonly live = new Map<string, Live>();
  private readonly orgs = new Map<string, OrgLive>();
  /** Custom templates' ids, by where they are (an organization's key, or a person's) and name. */
  private readonly templates = new Map<string, { id: string; itemId: string }>();

  constructor(api: Api, state: State, save: () => void, log: Log) {
    this.api = api;
    this.state = state;
    this.save = save;
    this.log = log;
  }

  private who(key: string): Live {
    const found = this.live.get(key);
    if (!found) {
      throw new Error(`${person(key).name} isn't signed in`);
    }
    return found;
  }

  private org(key: string): OrgLive {
    const found = this.orgs.get(key);
    if (!found) {
      throw new Error(`No organization ${key}`);
    }
    return found;
  }

  async run() {
    await this.accounts();
    await this.msp();
    for (const spec of ORGS) {
      await this.createOrganization(spec);
    }
    await this.staff();
    for (const spec of ORGS) {
      await this.fillOrganization(spec);
    }
    await this.mspTemplates();
    for (const [key, own] of Object.entries(OWN)) {
      await this.ownVault(key, own);
    }
    await this.legacyContact();
    this.state.complete = true;
    this.state.seededAt = new Date().toISOString();
    this.save();
  }

  /** Every account, with its keys, signed in; an authenticator app for those who have one. */
  private async accounts() {
    for (const p of PEOPLE.filter((p) => p.account)) {
      const email = emailOf(p);
      const password = masterPassword();
      const { passwordHash, stretched } = masterKeys(email, password);
      const st: PersonState = {
        key: p.key,
        name: p.name,
        email,
        password,
        passwordHash,
        device: randomUUID(),
        registered: false,
      };
      // Kept before the server has it, so a run that stops here can still be taken down.
      this.state.people[p.key] = st;
      this.save();
      const userKey = randomBytes(64);
      const { publicKey, privateKey } = rsaKeyPair();
      const token = await this.api.call(
        null,
        "POST",
        "/identity/accounts/register/send-verification-email",
        { email, name: p.name, receiveMarketingEmails: false },
        `Signing up ${p.name}`,
      );
      if (typeof token !== "string" || !token) {
        throw new Error(
          "The server emailed a link to verify the address instead of answering with it. The tool works only with a server that sends no email (test.passbundle.com, or a local test server).",
        );
      }
      await this.api.call(
        null,
        "POST",
        "/identity/accounts/register/finish",
        {
          email,
          emailVerificationToken: token,
          masterPasswordHash: passwordHash,
          masterPasswordHint: null,
          userSymmetricKey: encrypt(stretched, userKey),
          userAsymmetricKeys: {
            publicKey: publicKey.toString("base64"),
            encryptedPrivateKey: encrypt(userKey, privateKey),
          },
          ...KDF,
        },
        `Signing up ${p.name}`,
      );
      st.registered = true;
      this.save();
      const session = await this.api.signIn(st);
      const profile = await this.api.call(session, "GET", "/api/accounts/profile");
      st.userId = profile.id;
      this.live.set(p.key, { state: st, session, userKey, publicKey });
      if (p.authenticator) {
        const started = await this.api.call(session, "POST", "/api/two-factor/get-authenticator", {
          masterPasswordHash: passwordHash,
        });
        const key = started.authenticator?.key ?? started.key;
        await this.api.call(session, "POST", "/api/two-factor/authenticator", {
          key,
          token: totp(key),
          userVerificationToken: started.userVerificationToken,
          masterPasswordHash: passwordHash,
        });
        st.totpKey = key;
        st.totpStep = stepOf(Date.now());
        const recover = await this.api.call(session, "POST", "/api/two-factor/get-recover", {
          masterPasswordHash: passwordHash,
        });
        st.recoveryCode = recover.code;
      }
      this.save();
    }
    this.log(`Accounts: ${this.live.size} people, ${[...this.live.values()].filter((l) => l.state.totpKey).length} with an authenticator app`);
  }

  /** Harbor IT, with Maya as its admin, and its default policies: vault lock required for every client. */
  private async msp() {
    const maya = this.who("maya");
    const made = await this.api.call(maya.session, "POST", "/api/keykeeper/msp", { name: MSP_NAME }, `Setting up ${MSP_NAME}`);
    this.state.mspId = made.id;
    this.save();
    const overview = await this.api.call(maya.session, "GET", `/api/keykeeper/msp/${made.id}/policies`);
    const lock = overview.defaults.find((d: { type: number }) => d.type === VAULT_LOCK_POLICY);
    await this.api.call(
      maya.session,
      "PUT",
      `/api/keykeeper/msp/${made.id}/policies/${VAULT_LOCK_POLICY}`,
      { enabled: true, data: lock?.data ?? { minutes: 15 }, required: true },
      "Requiring vault lock for every client",
    );
    this.log(`${MSP_NAME}: set up by Maya Chen, vault lock required for every client`);
  }

  /** An organization with its own keys: a client (by Harbor IT), Harbor IT's own, or the family's. */
  private async createOrganization(spec: OrgSpec) {
    const creator = this.who(spec.creator);
    const key = randomBytes(64);
    const { publicKey, privateKey } = rsaKeyPair();
    const firstName = encrypt(key, spec.firstFolder);
    const business = spec.kind === "client" && spec.preset === "business";
    const adminsName = business ? encrypt(key, "Admins") : undefined;
    const common = {
      name: spec.name,
      billingEmail: creator.state.email,
      collectionName: firstName,
      key: encryptTo(creator.publicKey, key),
      keys: { publicKey: publicKey.toString("base64"), encryptedPrivateKey: encrypt(key, privateKey) },
    };
    const made =
      spec.kind === "client"
        ? await this.api.call(
            creator.session,
            "POST",
            `/api/keykeeper/msp/${this.state.mspId}/clients`,
            { ...common, preset: business ? "business" : undefined, adminsCollectionName: adminsName },
            `Adding the client ${spec.name}`,
          )
        : await this.api.call(creator.session, "POST", "/api/organizations", { ...common, planType: 0 }, `Making ${spec.name}`);
    this.state.orgs[spec.key] = { id: made.id, name: spec.name, deleteAs: spec.deleteAs };
    this.save();
    const folders = new Map<string, string>();
    const listed = await this.api.call(creator.session, "GET", `/api/organizations/${made.id}/collections`);
    for (const c of listed.data) {
      if (c.name === firstName) {
        folders.set(spec.firstFolder, c.id);
      } else if (c.name === adminsName) {
        folders.set("Admins", c.id);
      }
    }
    this.orgs.set(spec.key, { spec, id: made.id, key, folders, members: new Map() });
  }

  /** Harbor IT's staff: invited with their access, joined, and let into each client with its key. */
  private async staff() {
    const maya = this.who("maya");
    const mspId = this.state.mspId!;
    const clientIds = (keys: string[]) => keys.map((k) => this.org(k).id);
    for (const s of STAFF) {
      const p = person(s.key);
      const access =
        s.role === "technician"
          ? {
              allClients: s.clients === "all",
              clients: s.clients === "all" ? [] : clientIds(s.clients ?? []),
              custom: s.custom ?? null,
              installCommands: s.installCommands ?? false,
              clientRoles: (s.clientRoles ?? []).map((r) => ({ client: this.org(r.client).id, custom: r.custom })),
            }
          : undefined;
      const invited = await this.api.call(
        maya.session,
        "POST",
        `/api/keykeeper/msp/${mspId}/staff`,
        { email: emailOf(p), role: s.role, access },
        `Inviting ${p.name} to ${MSP_NAME}`,
      );
      if (s.invitedOnly) {
        continue;
      }
      const token = decodeURIComponent(new URL(invited.inviteUrl).hash.split("invite=")[1] ?? "");
      await this.api.call(this.who(s.key).session, "POST", "/api/keykeeper/msp/invites/accept", { token }, `${p.name} joining ${MSP_NAME}`);
    }
    const confirmed = await this.confirmPending();
    this.log(`${MSP_NAME}: ${STAFF.filter((s) => !s.invitedOnly).length} staff joined, ${confirmed} client places let in, Jordan Blake invited`);
  }

  /** What the MSP console does when it opens: gives everyone waiting the client's key. */
  private async confirmPending(): Promise<number> {
    const maya = this.who("maya");
    const pending = await this.api.call(maya.session, "GET", `/api/keykeeper/msp/${this.state.mspId}/pending`);
    let count = 0;
    for (const p of pending.data) {
      const org = [...this.orgs.values()].find((o) => o.id === p.organizationId);
      const member = [...this.live.values()].find((l) => l.state.email === String(p.email).toLowerCase());
      if (!org || !member) {
        continue;
      }
      await this.api.call(
        maya.session,
        "POST",
        `/api/organizations/${org.id}/users/${p.memberId}/confirm`,
        { key: encryptTo(member.publicKey, org.key) },
        `Letting ${member.state.name} into ${org.spec.name}`,
      );
      count++;
    }
    return count;
  }

  /** An organization's settings, shared folders, people, groups, and items. */
  private async fillOrganization(spec: OrgSpec) {
    const org = this.org(spec.key);
    const creator = this.who(spec.creator);
    await this.settings(spec, org, creator);
    for (const f of spec.folders) {
      if (!org.folders.has(f.name)) {
        const made = await this.api.call(creator.session, "POST", `/api/organizations/${org.id}/collections`, {
          name: encrypt(org.key, f.name),
          groups: [],
          users: [],
        });
        org.folders.set(f.name, made.id);
      }
      if (f.icon) {
        await this.api.call(
          creator.session,
          "PUT",
          `/api/keykeeper/organizations/${org.id}/collections/${org.folders.get(f.name)}/look`,
          { look: encrypt(org.key, JSON.stringify({ icon: f.icon, tone: f.tone ?? "sapphire" })) },
          `Choosing ${f.name}'s icon`,
        );
      }
    }
    const folderId = (name: string) => {
      const id = org.folders.get(name);
      if (!id) {
        throw new Error(`${spec.name} has no folder ${name}`);
      }
      return id;
    };
    for (const m of spec.members) {
      const p = person(m.key);
      const email = emailOf(p);
      await this.api.call(
        creator.session,
        "POST",
        `/api/organizations/${org.id}/users/invite`,
        {
          emails: [email],
          type: ROLES[m.role],
          collections: Object.entries(m.access ?? {}).map(([name, a]) => grant(folderId(name), a)),
          groups: [],
          accessSecretsManager: false,
          permissions: m.permissions ?? {},
        },
        `Inviting ${p.name} to ${spec.name}`,
      );
      const listed = await this.api.call(creator.session, "GET", `/api/organizations/${org.id}/users`);
      const membership = listed.data.find((u: { email: string }) => u.email === email);
      org.members.set(m.key, membership.id);
      if (m.state === "invited") {
        continue;
      }
      const member = this.who(m.key);
      try {
        await this.api.call(member.session, "POST", `/api/keykeeper/organizations/${org.id}/accept`, undefined, `${p.name} accepting a role in ${spec.name}`);
      } catch (e) {
        // Someone who joins without the two-step login it requires is signed
        // out as they accept: they wait, as Liam does.
        if (m.state !== "waiting") {
          throw e;
        }
      }
      if (m.state === "waiting") {
        continue;
      }
      await this.api.call(
        creator.session,
        "POST",
        `/api/organizations/${org.id}/users/${membership.id}/confirm`,
        { key: encryptTo(member.publicKey, org.key) },
        `Letting ${p.name} into ${spec.name}`,
      );
    }
    for (const g of spec.groups ?? []) {
      await this.api.call(creator.session, "POST", `/api/organizations/${org.id}/groups`, {
        name: g.name,
        accessAll: false,
        externalId: null,
        collections: Object.entries(g.access).map(([name, a]) => grant(folderId(name), a)),
        users: g.members.map((k) => org.members.get(k)),
      });
    }
    // Templates first, so items made from them can name them.
    const ordered = [...spec.items.filter((i) => i.defines), ...spec.items.filter((i) => !i.defines)];
    for (const item of ordered) {
      await this.item(item, { org, defaultBy: spec.creator, scope: spec.key });
    }
    for (const m of spec.members.filter((m) => m.state === "revoked")) {
      await this.api.call(creator.session, "PUT", `/api/organizations/${org.id}/users/${org.members.get(m.key)}/revoke`, undefined, `Revoking ${person(m.key).name}`);
    }
    const groups = (spec.groups ?? []).length;
    this.log(
      `${spec.name}: ${spec.members.length} people added, ${org.folders.size} shared folders${groups ? `, ${groups} groups` : ""}, ${spec.items.length} items`,
    );
  }

  /** A client's own settings, where it differs from Harbor IT's defaults. */
  private async settings(spec: OrgSpec, org: OrgLive, creator: Live) {
    const path = `/api/keykeeper/organizations/${org.id}`;
    if (spec.key === "bluebird") {
      await this.api.call(
        creator.session,
        "PUT",
        `${path}/admin-two-step`,
        { required: true, everyone: true, masterPasswordHash: creator.state.passwordHash },
        "Requiring two-step login of everyone at Bluebird Law",
      );
      const current = await this.api.call(creator.session, "GET", `/api/organizations/${org.id}/policies/${MASTER_PASSWORD_POLICY}`);
      await this.api.call(
        creator.session,
        "PUT",
        `/api/organizations/${org.id}/policies/${MASTER_PASSWORD_POLICY}`,
        { policy: { enabled: true, data: { ...(current?.data ?? {}), minLength: 16 } } },
        "Bluebird Law's own master password setting",
      );
    } else if (spec.key === "cedar") {
      await this.api.call(creator.session, "PUT", `${path}/password-change`, { allowed: false }, "Turning off assisted password change at Cedar Ridge Veterinary");
    } else if (spec.key === "pinecrest") {
      await this.api.call(creator.session, "PUT", `${path}/browser-autofill`, { mode: "offAndImport" }, "Turning off the browsers' card and address autofill at Pinecrest Construction");
    }
  }

  /** An item and its history, in an organization's folders or someone's own vault. */
  private async item(
    spec: ItemSpec,
    where: { org?: OrgLive; owner?: Live; folders?: Map<string, string>; defaultBy: string; scope: string },
  ) {
    const finalBy = spec.by ?? where.defaultBy;
    const versions = [...(spec.history ?? []).map((h) => ({ ...h, by: h.by ?? finalBy })), { by: finalBy, password: undefined, notes: undefined, final: true }];
    const totpKey = spec.type === "login" && spec.totp ? base32(randomBytes(20)) : null;
    const ssh = spec.type === "ssh" ? sshKey(`${spec.name.toLowerCase().replace(/\s+/g, "-")}`) : null;
    const owner = where.owner;
    const madeBy = this.who(versions[0].by);
    const key = where.org ? where.org.key : owner!.userKey;
    const passkeyMade = new Date().toISOString();
    const pk =
      spec.type === "login" && spec.passkey
        ? passkey(spec.passkey.rpId, spec.passkey.userName, person(where.scope.startsWith("own:") ? where.scope.slice(4) : finalBy).name)
        : undefined;
    const fields: FieldSpec[] = (spec.fields ?? []).map((f) => ({ ...f, value: f.value === RANDOM ? base32(randomBytes(20)) : f.value }));
    const extra: { name: string; value: string; type: number }[] = [];
    let definitionId: string | null = null;
    if (spec.defines) {
      definitionId = randomUUID();
      extra.push({ name: "keykeeper.template-definition", value: JSON.stringify({ id: definitionId, base: spec.defines, v: 1 }), type: FIELD_TYPES.text });
    }
    if (spec.template) {
      extra.push({ name: "keykeeper.template", value: JSON.stringify({ id: spec.template.id, name: spec.template.name, v: 1 }), type: FIELD_TYPES.text });
    }
    if (spec.fromTemplate) {
      const t = this.templates.get(`${where.scope}/${spec.fromTemplate}`);
      if (!t) {
        throw new Error(`No template ${spec.fromTemplate} where ${spec.name} goes`);
      }
      extra.push({ name: "keykeeper.template", value: JSON.stringify({ id: t.id, name: spec.fromTemplate, v: 1 }), type: FIELD_TYPES.text });
    }
    if (spec.expires != null) {
      extra.push({ name: "keykeeper.expires", value: isoDay(spec.expires), type: FIELD_TYPES.text });
    }
    if (spec.remind) {
      extra.push({ name: "keykeeper.remind", value: spec.remind, type: FIELD_TYPES.text });
    }
    const passwords = versions.map((v, i) =>
      spec.type !== "login" ? null : i === versions.length - 1 ? (spec.password ?? itemPassword()) : (v.password ?? itemPassword()),
    );
    const view = (i: number): View => {
      const v: View = {
        type: TYPES[spec.type],
        name: spec.name,
        notes: (i < versions.length - 1 ? versions[i].notes : undefined) ?? spec.notes ?? null,
        favorite: spec.favorite ?? false,
        reprompt: spec.reprompt ? 1 : 0,
        fields: [...fields.map((f) => ({ name: f.name, value: f.value, type: FIELD_TYPES[f.type] })), ...extra],
      };
      switch (spec.type) {
        case "login":
          v.login = {
            username: spec.username ?? null,
            password: passwords[i],
            totp: totpKey,
            uris: spec.uris ?? [],
            passkey: pk,
            passkeyMade,
          };
          break;
        case "card":
          v.part = {
            key: "card",
            values: { cardholderName: spec.cardholderName, brand: spec.brand, number: spec.number, code: spec.code, ...cardExpiry(spec.expiresInMonths) },
          };
          break;
        case "identity":
          v.part = { key: "identity", values: spec.identity };
          break;
        case "ssh":
          v.part = { key: "sshKey", values: ssh! };
          break;
        case "bank":
          v.part = { key: "bankAccount", values: spec.bank };
          break;
        case "license":
          v.part = { key: "driversLicense", values: spec.license };
          break;
        case "passport":
          v.part = { key: "passport", values: spec.passport };
          break;
        default:
          break;
      }
      return v;
    };

    const folderId = !where.org && spec.folder ? (where.folders?.get(spec.folder) ?? null) : null;
    let id: string;
    if (where.org) {
      const collectionIds = (spec.folders ?? []).map((f) => {
        const c = where.org!.folders.get(f);
        if (!c) {
          throw new Error(`${where.org!.spec.name} has no folder ${f}`);
        }
        return c;
      });
      const made = await this.api.call(
        madeBy.session,
        "POST",
        "/api/ciphers/create",
        { cipher: encryptView(key, view(0), madeBy.state.userId!, where.org.id, null, []), collectionIds },
        `Saving ${spec.name}`,
      );
      id = made.id;
    } else {
      const made = await this.api.call(
        owner!.session,
        "POST",
        "/api/ciphers",
        encryptView(key, view(0), owner!.state.userId!, null, folderId, []),
        `Saving ${spec.name}`,
      );
      id = made.id;
    }
    // Each later version is an edit, as an app saves one: the whole item
    // again, with the revision it replaces, and the old password kept in
    // upstream's password history.
    const history: { password: string; lastUsedDate: string }[] = [];
    for (let i = 1; i < versions.length; i++) {
      const saver = where.org ? this.who(versions[i].by) : owner!;
      if (passwords[i - 1] && passwords[i - 1] !== passwords[i]) {
        history.unshift({ password: passwords[i - 1]!, lastUsedDate: new Date().toISOString() });
      }
      const current = await this.api.call(saver.session, "GET", `/api/ciphers/${id}`);
      await this.api.call(
        saver.session,
        "PUT",
        `/api/ciphers/${id}`,
        {
          ...encryptView(key, view(i), saver.state.userId!, where.org?.id ?? null, folderId, history),
          lastKnownRevisionDate: current.revisionDate,
        },
        `Editing ${spec.name}`,
      );
    }
    if (definitionId) {
      this.templates.set(`${where.scope}/${spec.name}`, { id: definitionId, itemId: id });
    }
    if (spec.trash) {
      const deleter = where.org ? this.who(finalBy) : owner!;
      await this.api.call(deleter.session, "PUT", `/api/ciphers/${id}/delete`, undefined, `Moving ${spec.name} to the trash`);
    }
  }

  /** Harbor IT's templates, from its own organization, for every client or chosen ones. */
  private async mspTemplates() {
    const maya = this.who("maya");
    for (const t of MSP_TEMPLATES) {
      const found = this.templates.get(`harbor/${t.name}`);
      if (!found) {
        throw new Error(`No template ${t.name} in ${MSP_NAME}'s own organization`);
      }
      await this.api.call(
        maya.session,
        "PUT",
        `/api/keykeeper/msp/${this.state.mspId}/templates/${found.id}`,
        {
          sourceCipherId: found.itemId,
          allClients: t.clients === "all",
          clients: t.clients === "all" ? [] : t.clients.map((k) => this.org(k).id),
        },
        `Sending the template ${t.name} to clients`,
      );
    }
    this.log(`${MSP_NAME}: ${MSP_TEMPLATES.length} templates for clients (copies go out once an MSP admin's browser trusts each client)`);
  }

  /** Someone's own folders and items. */
  private async ownVault(key: string, own: (typeof OWN)[string]) {
    const owner = this.who(key);
    const folders = new Map<string, string>();
    for (const name of own.folders ?? []) {
      const made = await this.api.call(owner.session, "POST", "/api/folders", { name: encrypt(owner.userKey, name) });
      folders.set(name, made.id);
    }
    const ordered = [...own.items.filter((i) => i.defines), ...own.items.filter((i) => !i.defines)];
    for (const item of ordered) {
      await this.item(item, { owner, folders, defaultBy: key, scope: `own:${key}` });
    }
    this.log(`${owner.state.name}'s own vault: ${own.items.length} items${folders.size ? `, ${folders.size} folders` : ""}`);
  }

  /** Carmen names Diego her legacy contact (upstream's emergency access), with takeover after 7 days. */
  private async legacyContact() {
    const carmen = this.who("carmen");
    const diego = this.who("diego");
    await this.api.call(
      carmen.session,
      "POST",
      "/api/emergency-access/invite",
      { email: diego.state.email, type: 1, waitTimeDays: 7 },
      "Naming Diego Carmen's legacy contact",
    );
    const trusted = await this.api.call(carmen.session, "GET", "/api/emergency-access/trusted");
    const grant = trusted.data.find((g: { email: string }) => g.email === diego.state.email);
    await this.api.call(
      carmen.session,
      "POST",
      `/api/emergency-access/${grant.id}/confirm`,
      { key: encryptTo(diego.publicKey, carmen.userKey) },
      "Confirming Diego as Carmen's legacy contact",
    );
    this.log("Carmen Rivera: Diego Rivera is her legacy contact (takeover after 7 days)");
  }
}

/** Signs in as someone the state file has, or says why not (null). */
async function trySignIn(api: Api, st: PersonState, problems: string[]): Promise<Session | null> {
  try {
    return await api.signIn(st);
  } catch (e) {
    problems.push(e instanceof NewDeviceHeld || e instanceof ApiError ? e.message : String(e));
    return null;
  }
}

/**
 * Deletes what the state file says the tool made: the organizations, the MSP's
 * open invitation, then the accounts. Returns what it couldn't delete, by name.
 */
export async function teardown(api: Api, state: State, save: () => void, log: Log): Promise<string[]> {
  const problems: string[] = [];
  const sessions = new Map<string, Session | null>();
  const session = async (key: string) => {
    if (!sessions.has(key)) {
      const st = state.people[key];
      sessions.set(key, st?.registered ? await trySignIn(api, st, problems) : null);
      save();
    }
    return sessions.get(key) ?? null;
  };
  const gone = (e: unknown) => e instanceof ApiError && (e.status === 404 || /not found/i.test(e.message));

  // MSP staff invitations nobody accepted.
  if (state.mspId && state.people.maya?.registered) {
    const maya = await session("maya");
    if (maya) {
      try {
        const msp = await api.call(maya, "GET", `/api/keykeeper/msp/${state.mspId}`);
        for (const invite of msp.invites ?? []) {
          await api.call(maya, "DELETE", `/api/keykeeper/msp/${state.mspId}/invites/${invite.id}`, undefined, "Cancelling a staff invitation");
        }
      } catch (e) {
        if (!gone(e)) {
          problems.push(e instanceof Error ? e.message : String(e));
        }
      }
    }
  }
  for (const [key, org] of Object.entries(state.orgs)) {
    const as = await session(org.deleteAs);
    if (!as) {
      problems.push(`${org.name} stays: couldn't sign in as ${state.people[org.deleteAs]?.name ?? org.deleteAs}`);
      continue;
    }
    try {
      await api.call(as, "DELETE", `/api/organizations/${org.id}`, { masterPasswordHash: state.people[org.deleteAs].passwordHash }, `Deleting ${org.name}`);
      log(`Deleted ${org.name}`);
    } catch (e) {
      if (!gone(e)) {
        problems.push(e instanceof Error ? e.message : String(e));
        continue;
      }
    }
    delete state.orgs[key];
    save();
  }
  for (const [key, st] of Object.entries(state.people)) {
    if (st.registered) {
      const as = await session(key);
      if (!as) {
        problems.push(`${st.name}'s account stays`);
        continue;
      }
      try {
        await api.call(as, "DELETE", "/api/accounts", { masterPasswordHash: st.passwordHash }, `Deleting ${st.name}'s account`);
      } catch (e) {
        if (!gone(e)) {
          problems.push(e instanceof Error ? e.message : String(e));
          continue;
        }
      }
    }
    delete state.people[key];
    save();
  }
  log(problems.length ? "Deleted the rest of the accounts" : "Deleted the accounts");
  if (Object.keys(state.people).length === 0 && Object.keys(state.orgs).length === 0) {
    state.mspId = undefined;
    state.complete = false;
  }
  save();
  return problems;
}

/** Whether the server still has the tenants: Maya signs in and sees Harbor IT's clients. */
export async function check(api: Api, state: State, save: () => void): Promise<{ ok: boolean; detail: string }> {
  const maya = state.people.maya;
  if (!state.complete || !maya || !state.mspId) {
    return { ok: false, detail: "not seeded" };
  }
  try {
    const session = await api.signIn(maya);
    save();
    const msp = await api.call(session, "GET", `/api/keykeeper/msp/${state.mspId}`);
    const clients = (msp.clients ?? []).length;
    const staff = (msp.staff ?? []).length;
    return { ok: true, detail: `${msp.name}: ${staff} staff, ${clients} clients; ${Object.keys(state.people).length} people in all` };
  } catch (e) {
    save();
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** The credentials file: everyone's email and master password, and how to sign in with their two-step login. */
export function credentialsFile(state: State, command: string): string {
  const lines = [
    `# PassBundle test tenants on ${state.server}`,
    "",
    `Made by tools/test-tenants${state.seededAt ? ` on ${state.seededAt.slice(0, 10)}` : ""}. Every master password here was made by the tool for this server. Keep this file to yourself.`,
    "",
    `For someone with an authenticator app, \`${command} code <name>\` prints their current code, or add their key to your own authenticator app (the otpauth link).`,
    "",
  ];
  for (const p of PEOPLE) {
    const st = state.people[p.key];
    lines.push(`## ${p.name}`, "", p.about, "", `- Email: ${emailOf(p)}`);
    if (!p.account) {
      lines.push("- No account: invited, hasn't joined.", "");
      continue;
    }
    if (!st) {
      lines.push("- Not made on this server.", "");
      continue;
    }
    lines.push(`- Master password: \`${st.password}\``);
    if (st.totpKey) {
      const label = encodeURIComponent(`PassBundle test:${st.email}`);
      lines.push(
        `- Two-step login: authenticator app. \`${command} code ${p.key}\`, or otpauth://totp/${label}?secret=${st.totpKey}&issuer=${encodeURIComponent("PassBundle test")}`,
        `- Two-step login recovery code: \`${st.recoveryCode ?? "none"}\``,
      );
    } else {
      lines.push("- Two-step login: none");
    }
    lines.push("");
  }
  return lines.join("\n");
}

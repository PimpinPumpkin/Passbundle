// Plans (DESIGN.md, "Plans and billing"): the first piece, which records a
// plan for a person, an organization, or an MSP, works out what each person
// gets from it, and tells the apps in the sync; and the second, Premium's
// limits, where plans are enforced: attaching files (by the plan of whoever
// owns the item), sending files, and the data breach report.
//
// - Where plans aren't enforced (every server but one here, and every
//   self-hosted server unless it turns PLANS_ENFORCED on), a sync says what it
//   has always said, whatever plans are recorded, plus `keykeeperPlan` saying
//   so.
// - Where they are, the profile's `premium` and `premiumFromOrganization` and
//   each organization's `usersGetPremium`, `maxStorageGb`, `seats`, and
//   `productTierType` are true values, and `keykeeperPlan` says the rest.
//   `enabled` stays true: a plan never suspends an organization.
// - Where they are, only adding is refused, with one sentence in `message`.
//   Downloading, removing, and exporting files never look at a plan, and a
//   file Send made with Premium works after it ends. The operator's own caps
//   still apply, and a plan never gives more than one.
// - Only the operator writes a plan, through the admin page. A signed-in
//   person can only read one they manage, and anyone else gets "not found",
//   never 403, which would sign the web vault out.
//
// The server's clock can't be moved, so the tests move a plan's dates, through
// the operator's route. The exact moments (the second a trial ends, grace's
// first and last) are the server's unit tests'.
//
// The operator's route needs the admin page, which no other test server has
// on, so these tests start three servers of their own: one that enforces
// plans, one that doesn't, and one that enforces them under the operator's
// own caps, with a key for the breach report whose lookups it never makes.
// Each takes an admin token made up for the run, which is kept in memory
// only.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { plansCapsServerPort, plansOffServerPort, plansServerPort } from "../../paths.mjs";

import { type Account, Api, type Result, encString } from "./support";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** PLAN_GRACE_DAYS as the server ships it. */
const GRACE = 14 * DAY;

/** A moment this far from now, to the second, as the operator's route takes dates. */
const fromNow = (ms: number) => new Date(Math.floor((Date.now() + ms) / 1000) * 1000).toISOString();
/** A date the server sent or took, as a number. */
const moment = (date: string | null) => (date === null ? null : new Date(date).getTime());

type Kind = "users" | "organizations" | "msps";

/** A plan as the operator writes it. */
type PlanData = {
  plan: string;
  freeUntil?: string;
  freeWhy?: string;
  standing: string;
  until?: string;
  renews: boolean;
  billed?: string;
};

/** Good standing through a moment, renewing unless told otherwise. */
const paidUntil = (plan: string, until: string, renews = true): PlanData => ({ plan, standing: "until", until, renews });
/** Free until a moment, with nothing paid. */
const freeUntil = (plan: string, until: string, why = "trial"): PlanData => ({
  plan,
  freeUntil: until,
  freeWhy: why,
  standing: "none",
  renews: false,
});
/** Paid for as it goes, with no end date: an MSP's pool. */
const open = (plan: string): PlanData => ({ plan, standing: "open", renews: true, billed: "by_the_day" });

async function result(response: { status(): number; text(): Promise<string> }): Promise<Result> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; keep the text.
  }
  return { status: response.status(), body };
}

/** The operator: the admin page's sign-in on one server, which only its cookie carries. */
class Operator {
  constructor(private readonly http: APIRequestContext) {}

  async read(kind: Kind | string, id: string): Promise<Result> {
    return result(await this.http.get(`/admin/plans/${kind}/${id}`));
  }

  async write(kind: Kind | string, id: string, data: unknown): Promise<Result> {
    return result(await this.http.post(`/admin/plans/${kind}/${id}`, { data }));
  }

  /** Writes a plan that has to be taken. */
  async set(kind: Kind, id: string, data: PlanData): Promise<any> {
    const written = await this.write(kind, id, data);
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    return written.body;
  }

  async remove(kind: Kind | string, id: string): Promise<Result> {
    return result(
      await this.http.post(`/admin/plans/${kind}/${id}/remove`, { headers: { "Content-Type": "application/json" } }),
    );
  }

  async dispose() {
    await this.http.dispose();
  }
}

type PlansServer = { process: ChildProcess; dataDir: string; operator: Operator };

/**
 * Starts a server with the admin page on, and signs the operator in to it,
 * once: every test on it shares that sign-in.
 */
async function startServer(
  playwright: { request: { newContext(options: object): Promise<APIRequestContext> } },
  port: string,
  enforced: boolean,
  extra: Record<string, string> = {},
): Promise<PlansServer> {
  const adminToken = randomBytes(32).toString("base64url");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-plans-"));
  const process_ = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: port,
      KK_DATA_DIR: dataDir,
      KK_ADMIN_TOKEN: adminToken,
      ...(enforced ? { KK_PLANS_ENFORCED: "1" } : {}),
      ...extra,
    },
    stdio: "ignore",
  });
  const baseURL = `https://127.0.0.1:${port}`;
  const http = await playwright.request.newContext({ baseURL, ignoreHTTPSErrors: true });
  await expect
    .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
    .toBe(200);
  const signedIn = await http.post("/admin", { form: { token: adminToken } });
  expect(signedIn.status(), "the operator's sign-in to the admin page").toBe(200);
  return { process: process_, dataDir, operator: new Operator(http) };
}

async function stopServer(server: PlansServer | undefined) {
  if (!server) {
    return;
  }
  await server.operator.dispose();
  const exited = new Promise((resolve) => server.process.once("exit", resolve));
  server.process.kill("SIGTERM");
  await exited;
  fs.rmSync(server.dataDir, { recursive: true, force: true });
}

/** The profile a sync carries. */
async function profileOf(api: Api, account: Account): Promise<any> {
  const sync = await api.call(account, "GET", "/api/sync?excludeDomains=true");
  expect(sync.status, JSON.stringify(sync.body)).toBe(200);
  return sync.body.profile;
}

/** An organization as someone's sync has it. */
async function orgOf(api: Api, account: Account, orgId: string): Promise<any> {
  const profile = await profileOf(api, account);
  const org = profile.organizations.find((o: { id: string }) => o.id === orgId);
  expect(org, `organization ${orgId} in the profile of ${account.email}`).toBeTruthy();
  return org;
}

/** When an account last changed, which is what tells an app to sync. */
async function revisionOf(api: Api, account: Account): Promise<number> {
  const revision = await api.call(account, "GET", "/api/accounts/revision-date");
  expect(revision.status).toBe(200);
  return revision.body;
}

/** The fields of an organization that say it has the company features. */
const companyFeatures = [
  "usePolicies",
  "useGroups",
  "useEvents",
  "useSso",
  "useScim",
  "useResetPassword",
  "useCustomPermissions",
  "useApi",
];

/** What a sync has always said about plans, and says wherever they aren't enforced. */
function expectAsAlways(profile: any, orgIds: string[]) {
  expect(profile.premium).toBe(true);
  expect(profile.premiumFromOrganization).toBe(false);
  expect(profile.keykeeperPlan).toEqual({ enforced: false });
  expect(profile.organizations.map((o: { id: string }) => o.id).sort()).toEqual([...orgIds].sort());
  for (const org of profile.organizations) {
    expect(org.usersGetPremium).toBe(true);
    expect(org.maxStorageGb).toBe(32767);
    expect(org.seats).toBe(20);
    expect(org.productTierType).toBe(3);
    expect(org.enabled).toBe(true);
    expect(org.usePolicies).toBe(true);
    expect(org.useSso).toBe(true);
    expect(org.useCustomPermissions).toBe(true);
    expect(org.useApi).toBe(true);
    expect(org.keykeeperPlan).toEqual({ enforced: false });
  }
}

/** `keykeeperPlan` for someone or something with no plan, where plans are enforced. */
const noPlan = (plan: "free" | null, canManage: boolean) => ({
  enforced: true,
  plan,
  state: null,
  freeUntil: null,
  freeWhy: null,
  until: null,
  renews: null,
  storageGb: 0,
  people: null,
  coveredBy: null,
  canManage,
});

/**
 * Listens for a person's notifications as an open app does, and counts the
 * ones that tell it to sync. The server sends them over a WebSocket, as
 * MessagePack; a sync notice is the one whose `Type` is 5.
 */
async function listen(port: string, account: Account) {
  const syncNotice = Buffer.from([0xa4, 0x54, 0x79, 0x70, 0x65, 0x05]);
  let syncs = 0;
  let waiting = Buffer.alloc(0);
  const socket = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
    const request = https.request({
      host: "127.0.0.1",
      port,
      path: `/notifications/hub?access_token=${account.token}`,
      rejectUnauthorized: false,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    request.on("upgrade", (_response, upgraded, head) => {
      upgraded.unshift(head);
      resolve(upgraded);
    });
    request.on("response", (response) => reject(new Error(`No notifications: ${response.statusCode}`)));
    request.on("error", reject);
    request.end();
  });
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    waiting = Buffer.concat([waiting, chunk]);
    // The server's frames aren't masked: a byte of flags and kind, a length
    // (7 bits, or 16 or 64 after a marker), and the payload.
    for (;;) {
      if (waiting.length < 2) {
        return;
      }
      let length = waiting[1] & 0x7f;
      let start = 2;
      if (length === 126) {
        if (waiting.length < 4) {
          return;
        }
        length = waiting.readUInt16BE(2);
        start = 4;
      } else if (length === 127) {
        if (waiting.length < 10) {
          return;
        }
        length = Number(waiting.readBigUInt64BE(2));
        start = 10;
      }
      if (waiting.length < start + length) {
        return;
      }
      const binary = (waiting[0] & 0x0f) === 2;
      if (binary && waiting.subarray(start, start + length).includes(syncNotice)) {
        syncs += 1;
      }
      waiting = waiting.subarray(start + length);
    }
  });
  return { syncs: () => syncs, close: () => socket.destroy() };
}

/** What a refusal says, as the server writes it (DESIGN.md, "What the server refuses"). */
const ATTACHING_IS_PREMIUM = "Attaching files is part of Premium.";
const SENDING_FILES_IS_PREMIUM = "Sending files is part of Premium. Sending text is free.";
const BREACH_REPORT_IS_PREMIUM = "The data breach report is part of Premium.";
const ORGANIZATION_ENDED =
  "This organization's plan has ended, so nothing new can be added. Everything in it can still be opened, changed, exported, and deleted.";
/** Storage that's full, with whose it is ("Your", "Acme's") and the real figure. */
const full = (whose: string, size: string) => `${whose} ${size} for attachments is full. Delete some to make room.`;
/** What the server has always said to someone who can't change the item. */
const NOT_WRITABLE = "Cipher is not write accessible";
/**
 * What the server says, as it always has, when it's told never to reach a
 * host (HTTP_REQUEST_BLOCK_REGEX), as the third server is for the breach
 * report's: the kind of error, with the reason only in its log.
 */
const BLOCKED_LOOKUP = "CustomHttpClient";

const MB = 1024 * 1024;
/** The largest file the server takes, which an upload's first step can ask room for without sending it. */
const LARGEST = 525 * MB;

/** A refusal: the server's ordinary 400, with one sentence in `message`. */
function expectRefused(answer: Result, sentence: string) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(400);
  expect(answer.body.message).toBe(sentence);
}

/** A file's bytes as an app uploads them. They're encrypted already, so any bytes do. */
const bytesOf = (size: number, fill: number) => Buffer.alloc(size, fill);

/** What a Send says it holds, as the apps make one: text, which every plan has. */
const textSend = () => ({
  type: 0,
  key: encString("send-key"),
  name: encString("send-name"),
  notes: null,
  text: { text: encString("send-text"), hidden: false },
  deletionDate: fromNow(7 * DAY),
  expirationDate: null,
  maxAccessCount: null,
  password: null,
  disabled: false,
  hideEmail: false,
});
/** The name a file Send's file goes by, which its upload has to repeat. */
const SEND_FILE_NAME = "send-file.bin";
/** A Send of a file of this size. */
const fileSend = (size: number) => ({
  ...textSend(),
  type: 1,
  text: null,
  file: { fileName: SEND_FILE_NAME },
  fileLength: size,
});

/** The answer the breach report has always given where the server has no key: a link to the site's own free page. */
const breachLink = (username: string) => {
  const name = encodeURIComponent(username);
  return [
    {
      name: "HaveIBeenPwned",
      title: "Manual HIBP Check",
      domain: "haveibeenpwned.com",
      breachDate: "2019-08-18T00:00:00Z",
      addedDate: "2019-08-18T00:00:00Z",
      description: `Go to: <a href="https://haveibeenpwned.com/account/${name}" target="_blank" rel="noreferrer">https://haveibeenpwned.com/account/${name}</a> for a manual check.<br/><br/>HaveIBeenPwned API key not set!<br/>Go to <a href="https://haveibeenpwned.com/API/Key" target="_blank" rel="noreferrer">https://haveibeenpwned.com/API/Key</a> to purchase an API key from HaveIBeenPwned.<br/><br/>`,
      logoPath: "vw_static/hibp.png",
      pwnCount: 0,
      dataClasses: ["Error - No API key set!"],
    },
  ];
};

/** Someone's breach report for an address, as the web vault's report asks for it. */
const breachReport = (api: Api, as: Account | null, username: string) =>
  api.call(as, "GET", `/api/hibp/breach?username=${encodeURIComponent(username)}`);

/** Attachments and Sends as the apps make and fetch them, on one server. */
class Files {
  constructor(
    private readonly request: APIRequestContext,
    private readonly api: Api,
  ) {}

  private headers(as: { token: string } | null) {
    return as ? { Authorization: `Bearer ${as.token}` } : {};
  }

  private async multipart(as: { token: string } | null, path: string, data: Buffer, key = true, name = "file.bin") {
    return result(
      await this.request.fetch(path, {
        method: "POST",
        headers: this.headers(as),
        multipart: {
          ...(key ? { key: encString("attachment-key") } : {}),
          data: { name, mimeType: "application/octet-stream", buffer: data },
        },
      }),
    );
  }

  /**
   * An upload's first step, as the apps take it: the server makes a record
   * of the file's size, which counts as kept from then on, and says where
   * the file goes.
   */
  declare(as: Account | null, itemId: string, size: number): Promise<Result> {
    return this.api.call(as, "POST", `/api/ciphers/${itemId}/attachment/v2`, {
      key: encString("attachment-key"),
      fileName: encString("attachment-name"),
      fileSize: size,
    });
  }

  /** The second step: the file itself, for the record the first made. */
  upload(as: Account | null, itemId: string, attachmentId: string, data: Buffer): Promise<Result> {
    return this.multipart(as, `/api/ciphers/${itemId}/attachment/${attachmentId}`, data, false);
  }

  /** Both steps, which have to go through. Returns the attachment's id. */
  async attach(as: Account, itemId: string, data: Buffer): Promise<string> {
    const declared = await this.declare(as, itemId, data.length);
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const uploaded = await this.upload(as, itemId, declared.body.attachmentId, data);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    return declared.body.attachmentId;
  }

  /**
   * The older way, in one request, which older clients and scripts use, or
   * the organization view's route for it (`attachment-admin`).
   */
  attachInOne(
    as: Account | null,
    itemId: string,
    data: Buffer,
    route: "attachment" | "attachment-admin" = "attachment",
  ): Promise<Result> {
    return this.multipart(as, `/api/ciphers/${itemId}/${route}`, data);
  }

  /**
   * Replaces a file with another, as the apps do for each file when an item
   * moves into an organization: the old one goes, and the new one is added.
   */
  replace(as: Account, itemId: string, attachmentId: string, data: Buffer): Promise<Result> {
    return this.multipart(as, `/api/ciphers/${itemId}/attachment/${attachmentId}/share`, data);
  }

  /** A file, downloaded as an app does: its address, then its bytes. */
  async download(as: Account, itemId: string, attachmentId: string): Promise<Buffer> {
    const where = await this.api.call(as, "GET", `/api/ciphers/${itemId}/attachment/${attachmentId}`);
    expect(where.status, JSON.stringify(where.body)).toBe(200);
    const file = await this.request.get(where.body.url);
    expect(file.status()).toBe(200);
    return file.body();
  }

  remove(as: Account, itemId: string, attachmentId: string): Promise<Result> {
    return this.api.call(as, "DELETE", `/api/ciphers/${itemId}/attachment/${attachmentId}`);
  }

  /** The ids of an item's files, as someone's sync carries them, which is what the apps export a vault from. */
  async inSync(as: Account, itemId: string): Promise<string[]> {
    const sync = await this.api.call(as, "GET", "/api/sync?excludeDomains=true");
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    const item = sync.body.ciphers.find((c: { id: string }) => c.id === itemId);
    expect(item, `item ${itemId} in the sync of ${as.email}`).toBeTruthy();
    return (item.attachments ?? []).map((a: { id: string }) => a.id).sort();
  }

  /** A file Send's first step: the Send, and where its file goes. */
  declareSend(as: Account | null, size: number): Promise<Result> {
    return this.api.call(as, "POST", "/api/sends/file/v2", fileSend(size));
  }

  /** A file Send's second step: the file. */
  uploadSend(as: Account, sendId: string, fileId: string, data: Buffer): Promise<Result> {
    return this.multipart(as, `/api/sends/${sendId}/file/${fileId}`, data, false, SEND_FILE_NAME);
  }

  /** A file Send, both steps, which have to go through. */
  async sendFile(as: Account, data: Buffer): Promise<{ sendId: string; accessId: string; fileId: string }> {
    const declared = await this.declareSend(as, data.length);
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const made = {
      sendId: declared.body.sendResponse.id,
      accessId: declared.body.sendResponse.accessId,
      fileId: declared.body.sendResponse.file.id,
    };
    const uploaded = await this.uploadSend(as, made.sendId, made.fileId, data);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    return made;
  }

  /** What someone given a Send's link gets, with no account: its file's bytes. */
  async receive(accessId: string, fileId: string): Promise<Buffer> {
    const token = await this.request.post("/identity/connect/token", {
      form: { grant_type: "send_access", client_id: "send", scope: "api.send.access", send_id: accessId },
    });
    expect(token.status(), await token.text()).toBe(200);
    const access = await this.request.post(`/api/sends/access/file/${fileId}`, {
      headers: { Authorization: `Bearer ${(await token.json()).access_token}` },
    });
    expect(access.status(), await access.text()).toBe(200);
    const file = await this.request.get((await access.json()).url);
    expect(file.status()).toBe(200);
    return file.body();
  }
}

/** Gives members of an organization its one shared folder: each `edit` or `view`. */
async function share(api: Api, owner: Account, orgId: string, collectionId: string, grants: [string, "edit" | "view"][]) {
  const saved = await api.call(owner, "PUT", `/api/organizations/${orgId}/collections/${collectionId}`, {
    name: encString("shared-files"),
    users: grants.map(([id, how]) => ({ id, readOnly: how === "view", hidePasswords: false, manage: false })),
    groups: [],
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

test.describe("where plans aren't enforced and the admin page is off, as on every other test server", () => {
  test("a sync says what it has always said, and adds only that plans aren't enforced", async ({ request }) => {
    const api = new Api(request);
    const owner = await api.account("plans-main-owner");
    const member = await api.account("plans-main-member");
    const orgId = await api.organization(owner, "Plans Main Org");
    await api.addMember(owner, orgId, member, "user");

    expectAsAlways(await profileOf(api, owner), [orgId]);
    expectAsAlways(await profileOf(api, member), [orgId]);
    // The profile on its own carries the same.
    const profile = await api.call(owner, "GET", "/api/accounts/profile");
    expectAsAlways(profile.body, [orgId]);

    // Asking about a plan gets the same answer, for whoever could manage it.
    const own = await api.call(owner, "GET", "/api/keykeeper/plan");
    expect(own).toEqual({ status: 200, body: { enforced: false } });
    const orgs = await api.call(owner, "GET", `/api/keykeeper/plan?organization=${orgId}`);
    expect(orgs).toEqual({ status: 200, body: { enforced: false } });
    expect((await api.call(member, "GET", `/api/keykeeper/plan?organization=${orgId}`)).status).toBe(404);
  });

  test("there's no operator's route, for anyone", async ({ request }) => {
    const api = new Api(request);
    const owner = await api.account("plans-main-nobody");
    const orgId = await api.organization(owner, "Plans Main Closed");
    const plan = paidUntil("premium", fromNow(30 * DAY));

    for (const who of [null, owner]) {
      expect((await api.call(who, "GET", `/admin/plans/users/${owner.userId}`)).status).toBe(404);
      expect((await api.call(who, "POST", `/admin/plans/users/${owner.userId}`, plan)).status).toBe(404);
      expect((await api.call(who, "POST", `/admin/plans/users/${owner.userId}/remove`, {})).status).toBe(404);
      expect(
        (await api.call(who, "POST", `/admin/plans/organizations/${orgId}`, paidUntil("business", fromNow(30 * DAY))))
          .status,
      ).toBe(404);
    }
    expectAsAlways(await profileOf(api, owner), [orgId]);
  });
});

test.describe("where plans aren't enforced, with an operator", () => {
  test.use({ baseURL: `https://127.0.0.1:${plansOffServerPort}` });

  let server: PlansServer | undefined;
  let operator: Operator;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, plansOffServerPort, false);
    operator = server.operator;
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("a plan that's recorded changes nothing anyone sees, and nobody is told to sync", async ({ request }) => {
    const api = new Api(request);
    const owner = await api.account("plans-off-owner");
    const member = await api.account("plans-off-member");
    const orgId = await api.organization(owner, "Plans Off Org");
    await api.addMember(owner, orgId, member, "user");

    const before = { owner: await profileOf(api, owner), member: await profileOf(api, member) };
    expectAsAlways(before.owner, [orgId]);
    expectAsAlways(before.member, [orgId]);
    const revision = { owner: await revisionOf(api, owner), member: await revisionOf(api, member) };

    // Plans that ended long ago, which would take everything away if they
    // were enforced.
    const person = await operator.set("users", owner.userId, paidUntil("premium", fromNow(-60 * DAY), false));
    expect(person.enforced).toBe(false);
    expect(person.state).toBe("ended");
    expect(person.plan.plan).toBe("premium");
    const org = await operator.set("organizations", orgId, paidUntil("families", fromNow(-60 * DAY), false));
    expect(org.enforced).toBe(false);
    expect(org.state).toBe("ended");

    expect(await profileOf(api, owner)).toEqual(before.owner);
    expect(await profileOf(api, member)).toEqual(before.member);
    expect(await revisionOf(api, owner)).toBe(revision.owner);
    expect(await revisionOf(api, member)).toBe(revision.member);
    const asked = await api.call(owner, "GET", "/api/keykeeper/plan");
    expect(asked).toEqual({ status: 200, body: { enforced: false } });

    // The rows are there for the day the server enforces them.
    const read = await operator.read("organizations", orgId);
    expect(read.status).toBe(200);
    expect(read.body.plan.plan).toBe("families");
    expect((await operator.remove("users", owner.userId)).status).toBe(200);
    expect((await operator.remove("organizations", orgId)).status).toBe(200);
    expect(await profileOf(api, owner)).toEqual(before.owner);
    expect(await revisionOf(api, owner)).toBe(revision.owner);
  });

  test("nothing a plan would refuse is refused: files, file Sends, and the breach report answer as they always have", async ({
    request,
  }) => {
    const api = new Api(request);
    const files = new Files(request, api);
    const ended = await api.account("plans-off-ended");
    const nobody = await api.account("plans-off-nobody");
    const owner = await api.account("plans-off-files-owner");
    const orgId = await api.organization(owner, "Plans Off Files");
    const collectionId = await api.collection(owner, orgId);
    const sharedItem = await api.orgItem(owner, orgId, collectionId);
    // Plans that ended long ago, which would refuse all of it if they were
    // enforced; and someone with no plan at all, who would be on Free.
    await operator.set("users", ended.userId, paidUntil("premium", fromNow(-60 * DAY), false));
    await operator.set("organizations", orgId, paidUntil("business", fromNow(-60 * DAY), false));

    const data = bytesOf(1000, 6);
    for (const who of [ended, nobody]) {
      const itemId = await api.personalItem(who);
      const id = await files.attach(who, itemId, data);
      const inOne = await files.attachInOne(who, itemId, data);
      expect(inOne.status, JSON.stringify(inOne.body)).toBe(200);
      expect(await files.download(who, itemId, id)).toEqual(data);
      const send = await files.sendFile(who, data);
      expect(await files.receive(send.accessId, send.fileId)).toEqual(data);
      const asked = await breachReport(api, who, "someone@example.test");
      expect(asked).toEqual({ status: 200, body: breachLink("someone@example.test") });
    }
    const shared = await files.attach(owner, sharedItem, data);
    expect(await files.download(owner, sharedItem, shared)).toEqual(data);
  });
});

test.describe("where plans are enforced", () => {
  test.use({ baseURL: `https://127.0.0.1:${plansServerPort}` });

  let server: PlansServer | undefined;
  let operator: Operator;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, plansServerPort, true);
    operator = server.operator;
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("an account with no plan is on Free", async ({ request }) => {
    const api = new Api(request);
    const person = await api.account("plans-free");

    const profile = await profileOf(api, person);
    expect(profile.premium).toBe(false);
    expect(profile.premiumFromOrganization).toBe(false);
    expect(profile.keykeeperPlan).toEqual(noPlan("free", true));
    expect(profile.organizations).toEqual([]);

    const asked = await api.call(person, "GET", "/api/keykeeper/plan");
    expect(asked).toEqual({ status: 200, body: noPlan("free", true) });
    expect((await operator.read("users", person.userId)).body).toEqual({
      enforced: true,
      plan: null,
      state: null,
      coveredBy: null,
    });

    // The sign-in token's own `premium` claim is what it has always been:
    // nothing reads a plan from it.
    const claims = JSON.parse(Buffer.from(person.token.split(".")[1], "base64url").toString());
    expect(claims.premium).toBe(true);
  });

  test("Premium is a person's while it's free, paid for, or within grace, and not after", async ({ request }) => {
    const api = new Api(request);
    const person = await api.account("plans-premium");
    const plan = async () => (await profileOf(api, person)).keykeeperPlan;
    const premium = async () => (await profileOf(api, person)).premium;

    // A trial that has days left.
    let date = fromNow(7 * DAY);
    const written = await operator.set("users", person.userId, freeUntil("premium", date));
    expect(written.state).toBe("trial");
    expect(written.plan).toMatchObject({
      plan: "premium",
      freeWhy: "trial",
      standing: "none",
      until: null,
      renews: false,
      billed: "by_hand",
      setBy: "operator",
      provider: null,
      providerCustomer: null,
      providerSubscription: null,
      checkedAt: null,
    });
    expect(moment(written.plan.freeUntil)).toBe(moment(date));
    let profile = await profileOf(api, person);
    expect(profile.premium).toBe(true);
    expect(profile.premiumFromOrganization).toBe(false);
    expect(profile.keykeeperPlan).toMatchObject({
      enforced: true,
      plan: "premium",
      state: "trial",
      freeWhy: "trial",
      until: null,
      renews: false,
      storageGb: 5,
      people: null,
      coveredBy: null,
      canManage: true,
    });
    expect(moment(profile.keykeeperPlan.freeUntil)).toBe(moment(date));
    expect((await api.call(person, "GET", "/api/keykeeper/plan")).body).toEqual(profile.keykeeperPlan);

    // The trial is over and nothing was paid: Free again, with the plan
    // still on record as ended.
    await operator.set("users", person.userId, freeUntil("premium", fromNow(-HOUR)));
    profile = await profileOf(api, person);
    expect(profile.premium).toBe(false);
    expect(profile.keykeeperPlan).toMatchObject({ plan: "premium", state: "ended", storageGb: 0, canManage: true });

    // Paid through a date.
    date = fromNow(30 * DAY);
    await operator.set("users", person.userId, paidUntil("premium", date));
    profile = await profileOf(api, person);
    expect(profile.premium).toBe(true);
    expect(profile.keykeeperPlan).toMatchObject({
      plan: "premium",
      state: "active",
      freeUntil: null,
      freeWhy: null,
      renews: true,
      storageGb: 5,
    });
    expect(moment(profile.keykeeperPlan.until)).toBe(moment(date));

    // A renewal that didn't go through: payment is due, and nothing is
    // taken away for the grace days.
    await operator.set("users", person.userId, paidUntil("premium", fromNow(-DAY)));
    expect(await plan()).toMatchObject({ state: "paymentDue", storageGb: 5, renews: true });
    expect(await premium()).toBe(true);
    await operator.set("users", person.userId, paidUntil("premium", fromNow(-GRACE + HOUR)));
    expect(await plan()).toMatchObject({ state: "paymentDue", storageGb: 5 });
    expect(await premium()).toBe(true);
    // Past them, it has ended.
    await operator.set("users", person.userId, paidUntil("premium", fromNow(-GRACE - HOUR)));
    expect(await plan()).toMatchObject({ state: "ended", storageGb: 0 });
    expect(await premium()).toBe(false);

    // A plan the person canceled ends at its date, with no grace.
    await operator.set("users", person.userId, paidUntil("premium", fromNow(DAY), false));
    expect(await plan()).toMatchObject({ state: "active", renews: false });
    expect(await premium()).toBe(true);
    await operator.set("users", person.userId, paidUntil("premium", fromNow(-HOUR), false));
    expect(await plan()).toMatchObject({ state: "ended", renews: false });
    expect(await premium()).toBe(false);

    // An offer's free months read as a trial does, and say why.
    date = fromNow(90 * DAY);
    await operator.set("users", person.userId, freeUntil("premium", date, "offer"));
    expect(await plan()).toMatchObject({ state: "trial", freeWhy: "offer", storageGb: 5 });
    expect(await premium()).toBe(true);

    // A plan paid for while it's still free is active, and keeps the date
    // the free time ran to.
    await operator.set("users", person.userId, {
      ...paidUntil("premium", fromNow(30 * DAY)),
      freeUntil: date,
      freeWhy: "offer",
    });
    expect(await plan()).toMatchObject({ state: "active", freeWhy: "offer" });

    // With no end date at all.
    await operator.set("users", person.userId, { plan: "premium", standing: "open", renews: true });
    expect(await plan()).toMatchObject({ state: "active", until: null, renews: true });
    expect(await premium()).toBe(true);

    // The row removed: Free, as someone who never had one.
    expect((await operator.remove("users", person.userId)).status).toBe(200);
    profile = await profileOf(api, person);
    expect(profile.premium).toBe(false);
    expect(profile.keykeeperPlan).toEqual(noPlan("free", true));
    expect((await operator.remove("users", person.userId)).status).toBe(404);
  });

  test("an organization with no plan gives its members nothing, and stays open", async ({ request }) => {
    const api = new Api(request);
    const owner = await api.account("plans-bare-owner");
    const member = await api.account("plans-bare-member");
    const orgId = await api.organization(owner, "Plans Bare Org");
    await api.addMember(owner, orgId, member, "user");

    for (const who of [owner, member]) {
      const profile = await profileOf(api, who);
      expect(profile.premium).toBe(false);
      expect(profile.premiumFromOrganization).toBe(false);
      expect(profile.keykeeperPlan).toEqual(noPlan("free", true));
      const org = profile.organizations.find((o: { id: string }) => o.id === orgId);
      expect(org.usersGetPremium).toBe(false);
      expect(org.maxStorageGb).toBe(0);
      expect(org.seats).toBeNull();
      expect(org.productTierType).toBe(3);
      expect(org.enabled).toBe(true);
      // Its company features are as they've always been.
      expect(org.usePolicies).toBe(true);
      expect(org.useSso).toBe(true);
      expect(org.useCustomPermissions).toBe(true);
      expect(org.useApi).toBe(true);
      // Its owner could manage a plan. A member couldn't.
      expect(org.keykeeperPlan).toEqual(noPlan(null, who === owner));
    }
  });

  test("Business covers every member while it's in effect, and tells only its owners the dates", async ({
    request,
  }) => {
    const api = new Api(request);
    const owner = await api.account("plans-biz-owner");
    const admin = await api.account("plans-biz-admin");
    const member = await api.account("plans-biz-member");
    const waiting = await api.account("plans-biz-waiting");
    const revoked = await api.account("plans-biz-revoked");
    const orgId = await api.organization(owner, "Plans Business Org");
    await api.addMember(owner, orgId, admin, "admin");
    await api.addMember(owner, orgId, member, "user");
    // Joined, and not confirmed yet: a seat all the same.
    await api.addMember(owner, orgId, waiting, "user", { confirm: false });
    // Revoked: no seat.
    const revokedId = await api.addMember(owner, orgId, revoked, "user");
    const revoking = await api.call(owner, "PUT", `/api/organizations/${orgId}/users/${revokedId}/revoke`);
    expect(revoking.status, JSON.stringify(revoking.body)).toBe(200);

    const date = fromNow(30 * DAY);
    const written = await operator.set("organizations", orgId, paidUntil("business", date));
    expect(written.state).toBe("active");
    expect(written.plan.plan).toBe("business");

    // Its owner: everything about the plan.
    let org = await orgOf(api, owner, orgId);
    expect(org.usersGetPremium).toBe(true);
    // 1 GB a seat, and never less than 5.
    expect(org.maxStorageGb).toBe(5);
    expect(org.seats).toBeNull();
    expect(org.productTierType).toBe(3);
    expect(org.enabled).toBe(true);
    expect(org.usePolicies).toBe(true);
    expect(org.useSso).toBe(true);
    expect(org.useCustomPermissions).toBe(true);
    expect(org.useApi).toBe(true);
    expect(org.keykeeperPlan).toMatchObject({
      enforced: true,
      plan: "business",
      state: "active",
      freeUntil: null,
      freeWhy: null,
      renews: true,
      storageGb: 5,
      people: null,
      coveredBy: null,
      canManage: true,
    });
    expect(moment(org.keykeeperPlan.until)).toBe(moment(date));
    const asked = await api.call(owner, "GET", `/api/keykeeper/plan?organization=${orgId}`);
    expect(asked).toEqual({ status: 200, body: org.keykeeperPlan });

    // Everyone else who has joined: what they get, and no more.
    const covered = {
      enforced: true,
      plan: "business",
      state: "active",
      freeUntil: null,
      freeWhy: null,
      until: null,
      renews: null,
      storageGb: 5,
      people: null,
      coveredBy: null,
      canManage: false,
    };
    for (const who of [admin, member]) {
      const profile = await profileOf(api, who);
      // Premium's features come from the organization, not a plan of their own.
      expect(profile.premium).toBe(false);
      expect(profile.premiumFromOrganization).toBe(true);
      expect(profile.keykeeperPlan).toEqual({ ...noPlan("free", true), storageGb: 5 });
      org = profile.organizations.find((o: { id: string }) => o.id === orgId);
      expect(org.usersGetPremium).toBe(true);
      expect(org.maxStorageGb).toBe(5);
      expect(org.enabled).toBe(true);
      expect(org.keykeeperPlan).toEqual(covered);
    }
    let profile = await profileOf(api, waiting);
    expect(profile.premium).toBe(false);
    expect(profile.premiumFromOrganization).toBe(true);
    expect(profile.keykeeperPlan).toEqual({ ...noPlan("free", true), storageGb: 5 });
    profile = await profileOf(api, revoked);
    expect(profile.premium).toBe(false);
    expect(profile.premiumFromOrganization).toBe(false);
    expect(profile.keykeeperPlan).toEqual(noPlan("free", true));

    // Payment is due: the owner is told, and to everyone else it's as it was.
    await operator.set("organizations", orgId, paidUntil("business", fromNow(-DAY)));
    org = await orgOf(api, owner, orgId);
    expect(org.usersGetPremium).toBe(true);
    expect(org.maxStorageGb).toBe(5);
    expect(org.keykeeperPlan).toMatchObject({ state: "paymentDue", renews: true, canManage: true });
    org = await orgOf(api, member, orgId);
    expect(org.usersGetPremium).toBe(true);
    expect(org.keykeeperPlan).toEqual(covered);
    expect((await profileOf(api, member)).premiumFromOrganization).toBe(true);

    // Past the grace days it has ended. The organization stays enabled, so
    // everyone can still open it and get everything out.
    await operator.set("organizations", orgId, paidUntil("business", fromNow(-GRACE - HOUR)));
    for (const who of [owner, admin, member]) {
      profile = await profileOf(api, who);
      expect(profile.premium).toBe(false);
      expect(profile.premiumFromOrganization).toBe(false);
      expect(profile.keykeeperPlan).toEqual(noPlan("free", true));
      org = profile.organizations.find((o: { id: string }) => o.id === orgId);
      expect(org.usersGetPremium).toBe(false);
      expect(org.maxStorageGb).toBe(0);
      expect(org.seats).toBeNull();
      expect(org.productTierType).toBe(3);
      expect(org.enabled).toBe(true);
      expect(org.usePolicies).toBe(true);
      expect(org.keykeeperPlan).toMatchObject({
        plan: "business",
        state: "ended",
        storageGb: 0,
        canManage: who === owner,
      });
    }

    // Someone with a plan of their own keeps it whatever the organization's does.
    await operator.set("users", member.userId, paidUntil("premium", fromNow(30 * DAY)));
    profile = await profileOf(api, member);
    expect(profile.premium).toBe(true);
    expect(profile.premiumFromOrganization).toBe(false);
    expect(profile.keykeeperPlan).toMatchObject({ plan: "premium", state: "active", storageGb: 5 });
  });

  test("someone in two organizations is covered while either's plan is in effect", async ({ request }) => {
    const api = new Api(request);
    const ownerA = await api.account("plans-two-owner-a");
    const ownerB = await api.account("plans-two-owner-b");
    const member = await api.account("plans-two-member");
    const ended = await api.organization(ownerA, "Plans Two Ended");
    const running = await api.organization(ownerB, "Plans Two Running");
    await api.addMember(ownerA, ended, member, "user");
    await api.addMember(ownerB, running, member, "user");
    await operator.set("organizations", ended, paidUntil("business", fromNow(-DAY), false));
    await operator.set("organizations", running, paidUntil("business", fromNow(DAY)));

    let profile = await profileOf(api, member);
    expect(profile.premiumFromOrganization).toBe(true);
    const byId = Object.fromEntries(profile.organizations.map((o: { id: string }) => [o.id, o]));
    expect(byId[ended].usersGetPremium).toBe(false);
    expect(byId[ended].keykeeperPlan.state).toBe("ended");
    expect(byId[running].usersGetPremium).toBe(true);
    expect(byId[running].keykeeperPlan.state).toBe("active");

    await operator.set("organizations", running, paidUntil("business", fromNow(-DAY), false));
    profile = await profileOf(api, member);
    expect(profile.premiumFromOrganization).toBe(false);
    // The first organization's owner was never in the second.
    expect((await profileOf(api, ownerA)).premiumFromOrganization).toBe(false);
  });

  test("a family's organization has six places and none of the company features", async ({ request }) => {
    const api = new Api(request);
    const owner = await api.account("plans-family-owner");
    const member = await api.account("plans-family-member");
    const orgId = await api.organization(owner, "Plans Family");
    await api.addMember(owner, orgId, member, "user");

    await operator.set("organizations", orgId, paidUntil("families", fromNow(30 * DAY)));
    for (const who of [owner, member]) {
      const profile = await profileOf(api, who);
      expect(profile.premium).toBe(false);
      expect(profile.premiumFromOrganization).toBe(true);
      const org = profile.organizations.find((o: { id: string }) => o.id === orgId);
      expect(org.usersGetPremium).toBe(true);
      expect(org.maxStorageGb).toBe(5);
      expect(org.seats).toBe(6);
      expect(org.productTierType).toBe(1);
      expect(org.enabled).toBe(true);
      for (const feature of companyFeatures) {
        expect(org[feature], feature).toBe(false);
      }
      expect(org.keykeeperPlan).toMatchObject({
        enforced: true,
        plan: "families",
        state: "active",
        storageGb: 5,
        people: 6,
        coveredBy: null,
        canManage: who === owner,
      });
    }

    // Ended: still a family's, still enabled, and nobody is covered.
    await operator.set("organizations", orgId, paidUntil("families", fromNow(-DAY), false));
    const profile = await profileOf(api, member);
    expect(profile.premiumFromOrganization).toBe(false);
    const org = profile.organizations.find((o: { id: string }) => o.id === orgId);
    expect(org.usersGetPremium).toBe(false);
    expect(org.maxStorageGb).toBe(0);
    expect(org.seats).toBe(6);
    expect(org.productTierType).toBe(1);
    expect(org.enabled).toBe(true);
    expect(org.usePolicies).toBe(false);
    expect(org.keykeeperPlan).toMatchObject({ plan: "families", state: "ended", storageGb: 0, people: 6 });
  });

  test("an MSP's pool covers its staff and each client, whatever plan a client has of its own", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const admin = await api.account("plans-msp-admin");
    const mspId = await api.msp(admin, "Plans MSP");
    const clientId = await api.client(admin, mspId, "Plans Client");
    const tech = await api.account("plans-msp-tech");
    await api.addStaff(admin, mspId, tech, "technician");
    const clientOwner = await api.account("plans-client-owner");
    await api.addMember(admin, clientId, clientOwner, "owner");
    const clientMember = await api.account("plans-client-member");
    await api.addMember(admin, clientId, clientMember, "user");
    const coveredBy = { id: mspId, name: "Plans MSP" };

    // No pool yet: the client is the MSP's all the same, and has nothing.
    let org = await orgOf(api, clientOwner, clientId);
    expect(org.usersGetPremium).toBe(false);
    expect(org.maxStorageGb).toBe(0);
    expect(org.enabled).toBe(true);
    expect(org.keykeeperPlan).toEqual({ ...noPlan(null, false), coveredBy });
    expect((await profileOf(api, tech)).premiumFromOrganization).toBe(false);
    let pool = await api.call(admin, "GET", `/api/keykeeper/plan?msp=${mspId}`);
    expect(pool).toEqual({ status: 200, body: { ...noPlan(null, true), storageGb: null } });

    // The pool, paid for as it goes.
    const written = await operator.set("msps", mspId, open("msp"));
    expect(written.state).toBe("active");
    expect(written.plan).toMatchObject({ plan: "msp", standing: "open", until: null, renews: true, billed: "by_the_day" });
    pool = await api.call(admin, "GET", `/api/keykeeper/plan?msp=${mspId}`);
    expect(pool).toEqual({
      status: 200,
      body: {
        enforced: true,
        plan: "msp",
        state: "active",
        freeUntil: null,
        freeWhy: null,
        until: null,
        renews: true,
        // A pool has no storage of its own: each client has.
        storageGb: null,
        people: null,
        coveredBy: null,
        canManage: true,
      },
    });

    // Its staff have Premium's features, with or without a place in a client.
    for (const who of [admin, tech]) {
      const profile = await profileOf(api, who);
      expect(profile.premium).toBe(false);
      expect(profile.premiumFromOrganization).toBe(true);
      expect(profile.keykeeperPlan).toEqual({ ...noPlan("free", true), storageGb: 5 });
    }

    // The client's people are covered by it, and none of them manages it:
    // not even the client's own owner.
    const covered = {
      enforced: true,
      plan: "msp",
      state: "active",
      freeUntil: null,
      freeWhy: null,
      until: null,
      renews: null,
      storageGb: 5,
      people: null,
      coveredBy,
      canManage: false,
    };
    for (const who of [clientOwner, clientMember]) {
      const profile = await profileOf(api, who);
      expect(profile.premium).toBe(false);
      expect(profile.premiumFromOrganization).toBe(true);
      org = profile.organizations.find((o: { id: string }) => o.id === clientId);
      expect(org.usersGetPremium).toBe(true);
      expect(org.maxStorageGb).toBe(5);
      expect(org.seats).toBeNull();
      expect(org.productTierType).toBe(3);
      expect(org.enabled).toBe(true);
      expect(org.usePolicies).toBe(true);
      expect(org.keykeeperPlan).toEqual(covered);
    }
    // The MSP's admin manages what covers the client.
    org = await orgOf(api, admin, clientId);
    expect(org.keykeeperPlan).toEqual({ ...covered, renews: true, canManage: true });
    const asked = await api.call(admin, "GET", `/api/keykeeper/plan?organization=${clientId}`);
    expect(asked).toEqual({ status: 200, body: org.keykeeperPlan });

    // A plan of the client's own, long ended, is kept and ignored while it's
    // a client.
    const own = await operator.set("organizations", clientId, paidUntil("business", fromNow(-60 * DAY), false));
    expect(own.plan.plan).toBe("business");
    expect(own.state).toBe("active");
    expect(own.coveredBy).toEqual(coveredBy);
    org = await orgOf(api, clientMember, clientId);
    expect(org.usersGetPremium).toBe(true);
    expect(org.keykeeperPlan).toEqual(covered);

    // The pool ends: its staff and its clients' people are no longer covered,
    // and the client stays open.
    await operator.set("msps", mspId, { plan: "msp", standing: "none", renews: false });
    for (const who of [admin, tech, clientOwner, clientMember]) {
      const profile = await profileOf(api, who);
      expect(profile.premiumFromOrganization).toBe(false);
      expect(profile.keykeeperPlan).toEqual(noPlan("free", true));
    }
    org = await orgOf(api, clientMember, clientId);
    expect(org.usersGetPremium).toBe(false);
    expect(org.maxStorageGb).toBe(0);
    expect(org.enabled).toBe(true);
    expect(org.keykeeperPlan).toEqual({ ...covered, state: "ended", storageGb: 0 });

    // The pool is paid for again, and the client leaves: from that moment
    // the pool isn't the client's, and the plan it has of its own is, which
    // its own owner manages.
    await operator.set("msps", mspId, open("msp"));
    expect((await orgOf(api, clientMember, clientId)).usersGetPremium).toBe(true);
    const left = await api.call(clientOwner, "DELETE", `/api/keykeeper/organizations/${clientId}/msp`);
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    for (const who of [clientOwner, clientMember]) {
      const profile = await profileOf(api, who);
      expect(profile.premiumFromOrganization).toBe(false);
      org = profile.organizations.find((o: { id: string }) => o.id === clientId);
      expect(org.usersGetPremium).toBe(false);
      expect(org.maxStorageGb).toBe(0);
      expect(org.enabled).toBe(true);
      expect(org.keykeeperPlan).toMatchObject({
        plan: "business",
        state: "ended",
        storageGb: 0,
        coveredBy: null,
        canManage: who === clientOwner,
      });
    }
    expect((await api.call(clientOwner, "GET", `/api/keykeeper/plan?organization=${clientId}`)).status).toBe(200);
    expect((await api.call(admin, "GET", `/api/keykeeper/plan?organization=${clientId}`)).status).toBe(404);
    expect((await operator.read("organizations", clientId)).body).toMatchObject({ state: "ended", coveredBy: null });
    // The MSP's staff are still the pool's.
    expect((await profileOf(api, tech)).premiumFromOrganization).toBe(true);
    expect((await profileOf(api, admin)).premiumFromOrganization).toBe(true);
  });

  test("a plan that changes tells the people it reaches to sync, and nobody else", async ({ request }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const person = await api.account("plans-notice-person");
    const owner = await api.account("plans-notice-owner");
    const member = await api.account("plans-notice-member");
    const orgId = await api.organization(owner, "Plans Notice Org");
    await api.addMember(owner, orgId, member, "user");
    const admin = await api.account("plans-notice-admin");
    const mspId = await api.msp(admin, "Plans Notice MSP");
    const clientId = await api.client(admin, mspId, "Plans Notice Client");
    const tech = await api.account("plans-notice-tech");
    await api.addStaff(admin, mspId, tech, "technician");
    const clientMember = await api.account("plans-notice-client-member");
    await api.addMember(admin, clientId, clientMember, "user");
    const bystander = await api.account("plans-notice-bystander");

    const everyone = { person, owner, member, admin, tech, clientMember, bystander };
    type Name = keyof typeof everyone;
    const names = Object.keys(everyone) as Name[];
    const open_: Partial<Record<Name, Awaited<ReturnType<typeof listen>>>> = {};
    try {
      for (const name of names) {
        open_[name] = await listen(plansServerPort, everyone[name]);
      }
      const heard = (name: Name) => open_[name]!.syncs();
      const revisions = async () => {
        const all = {} as Record<Name, number>;
        for (const name of names) {
          all[name] = await revisionOf(api, everyone[name]);
        }
        return all;
      };
      /** After a change: these people were told to sync, once more each, and nobody else's account moved. */
      const expectTold = async (before: Record<Name, number>, heardBefore: Record<Name, number>, told: Name[]) => {
        const after = await revisions();
        for (const name of names) {
          if (told.includes(name)) {
            expect(after[name], `${name}'s account changed`).toBeGreaterThan(before[name]);
            await expect.poll(() => heard(name), { message: `${name} is told to sync` }).toBe(heardBefore[name] + 1);
          } else {
            expect(after[name], `${name}'s account didn't change`).toBe(before[name]);
          }
        }
        for (const name of names.filter((n) => !told.includes(n))) {
          expect(heard(name), `${name} isn't told to sync`).toBe(heardBefore[name]);
        }
      };
      const heardNow = () => Object.fromEntries(names.map((name) => [name, heard(name)])) as Record<Name, number>;

      // A person's own plan: that person.
      let before = await revisions();
      let heardBefore = heardNow();
      await operator.set("users", person.userId, paidUntil("premium", fromNow(30 * DAY)));
      await expectTold(before, heardBefore, ["person"]);

      // An organization's: everyone who has joined it.
      before = await revisions();
      heardBefore = heardNow();
      await operator.set("organizations", orgId, paidUntil("business", fromNow(30 * DAY)));
      await expectTold(before, heardBefore, ["owner", "member"]);

      // An MSP's pool: its staff, and the people of each client.
      before = await revisions();
      heardBefore = heardNow();
      await operator.set("msps", mspId, open("msp"));
      await expectTold(before, heardBefore, ["admin", "tech", "clientMember"]);

      // A plan removed is a change too.
      before = await revisions();
      heardBefore = heardNow();
      expect((await operator.remove("organizations", orgId)).status).toBe(200);
      await expectTold(before, heardBefore, ["owner", "member"]);

      expect(heard("bystander")).toBe(0);
    } finally {
      for (const listener of Object.values(open_)) {
        listener?.close();
      }
    }
  });

  test("nobody but the operator writes a plan", async ({ request }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const person = await api.account("plans-write-person");
    const owner = await api.account("plans-write-owner");
    const orgId = await api.organization(owner, "Plans Write Org");
    const admin = await api.account("plans-write-admin");
    const mspId = await api.msp(admin, "Plans Write MSP");

    const plans: [Kind, string, PlanData][] = [
      ["users", person.userId, paidUntil("premium", fromNow(30 * DAY))],
      ["users", owner.userId, paidUntil("premium", fromNow(30 * DAY))],
      ["organizations", orgId, paidUntil("business", fromNow(30 * DAY))],
      ["msps", mspId, open("msp")],
    ];
    // The operator's route takes the admin page's sign-in and nothing else:
    // not a signed-in person's token, whoever they are, for their own plan
    // or anyone's.
    for (const who of [null, person, owner, admin]) {
      for (const [kind, id, plan] of plans) {
        expect((await api.call(who, "POST", `/admin/plans/${kind}/${id}`, plan)).status).toBe(401);
        expect((await api.call(who, "POST", `/admin/plans/${kind}/${id}/remove`, {})).status).toBe(401);
        expect((await api.call(who, "GET", `/admin/plans/${kind}/${id}`)).status).toBe(401);
      }
    }
    // And the API a signed-in person uses has no way to write one at all.
    for (const who of [person, owner, admin]) {
      for (const method of ["POST", "PUT", "DELETE"] as const) {
        for (const query of ["", `?organization=${orgId}`, `?msp=${mspId}`]) {
          const answer = await api.call(who, method, `/api/keykeeper/plan${query}`, plans[0][2]);
          expect(answer.status, `${method} /api/keykeeper/plan${query}`).toBe(404);
        }
      }
    }

    // Nothing was written.
    for (const [kind, id] of plans) {
      expect((await operator.read(kind, id)).body).toEqual({
        enforced: true,
        plan: null,
        state: null,
        coveredBy: null,
      });
    }
    expect((await profileOf(api, person)).premium).toBe(false);
    expect((await orgOf(api, owner, orgId)).usersGetPremium).toBe(false);
  });

  test("a plan is read only by whoever manages it, and anyone else is told it isn't there", async ({ request }) => {
    test.setTimeout(180_000);
    const api = new Api(request);
    // An organization of its own: its owner manages its plan.
    const owner = await api.account("plans-read-owner");
    const orgId = await api.organization(owner, "Plans Read Org");
    const orgAdmin = await api.account("plans-read-org-admin");
    await api.addMember(owner, orgId, orgAdmin, "admin");
    const manager = await api.account("plans-read-manager");
    await api.addMember(owner, orgId, manager, "manager");
    const member = await api.account("plans-read-member");
    await api.addMember(owner, orgId, member, "user");
    // An owner who hasn't been confirmed isn't one yet.
    const unconfirmed = await api.account("plans-read-unconfirmed");
    await api.addMember(owner, orgId, unconfirmed, "owner", { confirm: false });
    // An MSP and its client: the MSP's admins manage the pool and what covers
    // the client.
    const mspAdmin = await api.account("plans-read-msp-admin");
    const mspId = await api.msp(mspAdmin, "Plans Read MSP");
    const clientId = await api.client(mspAdmin, mspId, "Plans Read Client");
    const tech = await api.account("plans-read-tech");
    await api.addStaff(mspAdmin, mspId, tech, "technician");
    const clientOwner = await api.account("plans-read-client-owner");
    await api.addMember(mspAdmin, clientId, clientOwner, "owner");
    const outsider = await api.account("plans-read-outsider");
    // Another organization's owner manages that one, and no other.
    const otherOwner = await api.account("plans-read-other-owner");
    const otherOrgId = await api.organization(otherOwner, "Plans Read Other");

    await operator.set("organizations", orgId, paidUntil("business", fromNow(30 * DAY)));
    await operator.set("organizations", otherOrgId, paidUntil("business", fromNow(30 * DAY)));
    await operator.set("msps", mspId, open("msp"));

    const everyone = { owner, orgAdmin, manager, member, unconfirmed, mspAdmin, tech, clientOwner, outsider, otherOwner };
    type Name = keyof typeof everyone;
    const allowed: [string, Name[]][] = [
      [`?organization=${orgId}`, ["owner"]],
      [`?organization=${otherOrgId}`, ["otherOwner"]],
      [`?organization=${clientId}`, ["mspAdmin"]],
      [`?msp=${mspId}`, ["mspAdmin"]],
      // Nothing by these ids, or the wrong kind of id.
      [`?organization=${randomUUID()}`, []],
      [`?msp=${randomUUID()}`, []],
      [`?organization=${mspId}`, []],
      [`?msp=${orgId}`, []],
      [`?organization=${owner.userId}`, []],
    ];
    for (const [query, may] of allowed) {
      for (const name of Object.keys(everyone) as Name[]) {
        const answer = await api.call(everyone[name], "GET", `/api/keykeeper/plan${query}`);
        if (may.includes(name)) {
          expect(answer.status, `${name} ${query}`).toBe(200);
          expect(answer.body.canManage).toBe(true);
        } else {
          // Never 403, which would sign the web vault out, and the same
          // answer as for an id that doesn't exist.
          expect(answer, `${name} ${query}`).toEqual({
            status: 404,
            body: expect.objectContaining({ message: "Plan not found" }),
          });
        }
      }
    }

    // Everyone reads their own, and only by asking for nothing else.
    for (const name of Object.keys(everyone) as Name[]) {
      const own = await api.call(everyone[name], "GET", "/api/keykeeper/plan");
      expect(own.status, name).toBe(200);
      expect(own.body).toMatchObject({ enforced: true, plan: "free", canManage: true });
    }
    // Not signed in: sign in first.
    for (const query of ["", `?organization=${orgId}`, `?msp=${mspId}`]) {
      expect((await api.call(null, "GET", `/api/keykeeper/plan${query}`)).status).toBe(401);
    }
    // An organization or an MSP, not both.
    const both = await api.call(owner, "GET", `/api/keykeeper/plan?organization=${orgId}&msp=${mspId}`);
    expect(both.status).toBe(400);
  });

  test("the operator's route takes a plan that fits its owner and makes sense, and nothing else", async ({
    request,
  }) => {
    const api = new Api(request);
    const person = await api.account("plans-fits-person");
    const owner = await api.account("plans-fits-owner");
    const orgId = await api.organization(owner, "Plans Fits Org");
    const admin = await api.account("plans-fits-admin");
    const mspId = await api.msp(admin, "Plans Fits MSP");
    const soon = fromNow(30 * DAY);

    // Premium is a person's, Families and Business an organization's, and
    // the pool an MSP's.
    const fits: Record<Kind, string[]> = {
      users: ["premium"],
      organizations: ["families", "business"],
      msps: ["msp"],
    };
    const ids: Record<Kind, string> = { users: person.userId, organizations: orgId, msps: mspId };
    for (const kind of Object.keys(fits) as Kind[]) {
      for (const plan of ["premium", "families", "business", "msp"]) {
        const written = await operator.write(kind, ids[kind], paidUntil(plan, soon));
        expect(written.status, `${plan} for ${kind}: ${JSON.stringify(written.body)}`).toBe(
          fits[kind].includes(plan) ? 200 : 400,
        );
      }
    }

    // What doesn't make sense is refused, and the plan stays as it was.
    const before = (await operator.read("users", person.userId)).body;
    expect(before.plan).toMatchObject({ plan: "premium", standing: "until", renews: true, setBy: "operator" });
    const refused: unknown[] = [
      { plan: "enterprise", standing: "open", renews: true },
      { plan: "premium", standing: "paid", renews: true },
      { plan: "premium", standing: "until", renews: true },
      { plan: "premium", standing: "open", until: soon, renews: true },
      { plan: "premium", standing: "none", until: soon, renews: false },
      { plan: "premium", standing: "none", freeUntil: soon, renews: false },
      { plan: "premium", standing: "none", freeWhy: "trial", renews: false },
      { plan: "premium", standing: "none", freeUntil: soon, freeWhy: "gift", renews: false },
      { plan: "premium", standing: "until", until: "next month", renews: true },
      { plan: "premium", standing: "open", renews: true, billed: "in kind" },
    ];
    for (const data of refused) {
      const written = await operator.write("users", person.userId, data);
      expect(written.status, JSON.stringify(data)).toBe(400);
    }
    // A field the operator doesn't set, or something missing: not taken.
    const malformed: unknown[] = [
      { plan: "premium", standing: "open", renews: true, setBy: "provider" },
      { plan: "premium", standing: "open", renews: true, enabled: false },
      { plan: "premium", standing: "open" },
      { standing: "open", renews: true },
      {},
    ];
    for (const data of malformed) {
      const written = await operator.write("users", person.userId, data);
      expect(written.status, JSON.stringify(data)).toBe(422);
    }
    expect((await operator.read("users", person.userId)).body).toEqual(before);

    // Nobody and nothing by that name: not found.
    const plan = paidUntil("premium", soon);
    expect((await operator.read("users", randomUUID())).status).toBe(404);
    expect((await operator.write("users", randomUUID(), plan)).status).toBe(404);
    expect((await operator.write("organizations", randomUUID(), paidUntil("business", soon))).status).toBe(404);
    expect((await operator.write("msps", randomUUID(), open("msp"))).status).toBe(404);
    expect((await operator.remove("users", randomUUID())).status).toBe(404);
    expect((await operator.read("teams", person.userId)).status).toBe(404);
    expect((await operator.write("teams", person.userId, plan)).status).toBe(404);
    expect((await operator.remove("teams", person.userId)).status).toBe(404);
    // An id of another kind names nobody of this one.
    expect((await operator.write("users", orgId, plan)).status).toBe(404);
    expect((await operator.read("organizations", person.userId)).status).toBe(404);

    // A plan the operator sets again replaces the one before: there's one.
    const again = await operator.set("users", person.userId, freeUntil("premium", soon, "offer"));
    expect(again.plan).toMatchObject({ plan: "premium", freeWhy: "offer", standing: "none", until: null, renews: false });
    expect((await operator.read("users", person.userId)).body).toEqual(again);
    expect((await operator.remove("users", person.userId)).status).toBe(200);
    expect((await operator.read("users", person.userId)).body.plan).toBeNull();
  });

  test("a person's own items: Free attaches nothing, Premium up to its 5 GB, and after Premium every file still downloads, syncs, and can be removed", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const files = new Files(request, api);
    const person = await api.account("plans-files-person");
    const itemId = await api.personalItem(person);
    const first = bytesOf(1000, 1);
    const second = bytesOf(2000, 2);

    // On Free, every way of adding a file is refused, and nothing is kept.
    expectRefused(await files.declare(person, itemId, first.length), ATTACHING_IS_PREMIUM);
    expectRefused(await files.attachInOne(person, itemId, first), ATTACHING_IS_PREMIUM);
    expectRefused(await files.attachInOne(person, itemId, first, "attachment-admin"), ATTACHING_IS_PREMIUM);
    expect(await files.inSync(person, itemId)).toEqual([]);
    // Nobody signed in is turned away before any plan is asked.
    expect((await files.declare(null, itemId, first.length)).status).toBe(401);
    expect((await files.attachInOne(null, itemId, first)).status).toBe(401);

    // Premium: both ways.
    await operator.set("users", person.userId, paidUntil("premium", fromNow(30 * DAY)));
    const firstId = await files.attach(person, itemId, first);
    const inOne = await files.attachInOne(person, itemId, second);
    expect(inOne.status, JSON.stringify(inOne.body)).toBe(200);
    const secondId = (await files.inSync(person, itemId)).find((id) => id !== firstId)!;

    // Its 5 GB: nine of the largest files leave too little room for a tenth.
    const large: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const declared = await files.declare(person, itemId, LARGEST);
      expect(declared.status, JSON.stringify(declared.body)).toBe(200);
      large.push(declared.body.attachmentId);
    }
    expectRefused(await files.declare(person, itemId, LARGEST), full("Your", "5 GB"));
    // A file that takes the place of one the same size adds nothing, and goes through.
    const replaced = await files.replace(person, itemId, firstId, first);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    const kept = await files.inSync(person, itemId);
    expect(kept).not.toContain(firstId);
    const movedId = kept.find((id) => id !== secondId && !large.includes(id))!;
    expect(await files.download(person, itemId, movedId)).toEqual(first);
    // Deleting makes room.
    expect((await files.remove(person, itemId, large.pop()!)).status).toBe(200);
    const again = await files.declare(person, itemId, LARGEST);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    large.push(again.body.attachmentId);

    // Premium ends: adding is refused again, a file that would replace one too,
    // and the one it would have replaced stays.
    await operator.set("users", person.userId, paidUntil("premium", fromNow(-60 * DAY), false));
    expectRefused(await files.declare(person, itemId, first.length), ATTACHING_IS_PREMIUM);
    expectRefused(await files.attachInOne(person, itemId, first), ATTACHING_IS_PREMIUM);
    expectRefused(await files.replace(person, itemId, movedId, first), ATTACHING_IS_PREMIUM);
    // Everything attached with Premium downloads, is in the sync the apps
    // export a vault from, and can be removed, though it's all over Free's
    // limit of nothing.
    expect(await files.download(person, itemId, movedId)).toEqual(first);
    expect(await files.download(person, itemId, secondId)).toEqual(second);
    expect(await files.inSync(person, itemId)).toEqual([movedId, secondId, ...large].sort());
    for (const id of [movedId, secondId, ...large]) {
      const removed = await files.remove(person, itemId, id);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    }
    expect(await files.inSync(person, itemId)).toEqual([]);
  });

  test("a shared item goes by its organization's plan, the sentence names the organization, and only someone who could add a file hears it", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const api = new Api(request);
    const files = new Files(request, api);
    const owner = await api.account("plans-shared-owner");
    const admin = await api.account("plans-shared-admin");
    const manager = await api.account("plans-shared-manager");
    const editor = await api.account("plans-shared-editor");
    const viewer = await api.account("plans-shared-viewer");
    const outsider = await api.account("plans-shared-outsider");
    const orgId = await api.organization(owner, "Plans Shared Org");
    const collectionId = await api.collection(owner, orgId);
    await api.addMember(owner, orgId, admin, "admin");
    const managerId = await api.addMember(owner, orgId, manager, "manager");
    const editorId = await api.addMember(owner, orgId, editor, "user");
    const viewerId = await api.addMember(owner, orgId, viewer, "user");
    await share(api, owner, orgId, collectionId, [
      [managerId, "edit"],
      [editorId, "edit"],
      [viewerId, "view"],
    ]);
    // Another organization's owner, with a plan in effect of its own.
    const elsewhere = await api.organization(outsider, "Plans Shared Elsewhere");
    await operator.set("organizations", elsewhere, paidUntil("business", fromNow(30 * DAY)));
    const itemId = await api.orgItem(owner, orgId, collectionId);
    const canAdd = [owner, admin, manager, editor];
    const cannot = [viewer, outsider];
    const data = bytesOf(1000, 4);
    const noPlan = "Plans Shared Org has no plan, so files can't be attached to its items.";
    const theirs = (size: string) => full("Plans Shared Org's", size);

    // No plan: refused for everyone who could add a file, even someone with
    // Premium of their own, and the sentence names the organization.
    await operator.set("users", editor.userId, paidUntil("premium", fromNow(30 * DAY)));
    for (const who of canAdd) {
      expectRefused(await files.declare(who, itemId, data.length), noPlan);
      expectRefused(await files.attachInOne(who, itemId, data, "attachment-admin"), noPlan);
    }
    // Anyone else hears what they always have, and nothing about a plan.
    for (const who of cannot) {
      expectRefused(await files.declare(who, itemId, data.length), NOT_WRITABLE);
      expectRefused(await files.attachInOne(who, itemId, data), NOT_WRITABLE);
    }
    expect((await files.declare(null, itemId, data.length)).status).toBe(401);

    // Business: every one of them adds a file, and nobody else does.
    await operator.set("organizations", orgId, paidUntil("business", fromNow(30 * DAY)));
    const attached: string[] = [];
    for (const who of canAdd) {
      attached.push(await files.attach(who, itemId, data));
    }
    for (const who of cannot) {
      expectRefused(await files.declare(who, itemId, data.length), NOT_WRITABLE);
    }

    // Five people, so the least an organization gets: 5 GB, whatever anyone's
    // own plan gives.
    const large: string[] = [];
    const fill = async (count: number) => {
      for (let i = 0; i < count; i += 1) {
        const declared = await files.declare(owner, itemId, LARGEST);
        expect(declared.status, JSON.stringify(declared.body)).toBe(200);
        large.push(declared.body.attachmentId);
      }
    };
    await fill(9);
    for (const who of canAdd) {
      expectRefused(await files.declare(who, itemId, LARGEST), theirs("5 GB"));
    }
    // 1 GB a person: two more people, 7 GB.
    for (const name of ["plans-shared-sixth", "plans-shared-seventh"]) {
      await api.addMember(owner, orgId, await api.account(name), "user");
    }
    await fill(4);
    expectRefused(await files.declare(owner, itemId, LARGEST), theirs("7 GB"));

    // A file whose record was made while the plan was in effect, and which
    // arrives after it ends.
    const waiting = await files.declare(editor, itemId, data.length);
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);

    // The plan ends: nothing new, for anyone.
    await operator.set("organizations", orgId, paidUntil("business", fromNow(-60 * DAY), false));
    for (const who of canAdd) {
      expectRefused(await files.declare(who, itemId, data.length), ORGANIZATION_ENDED);
      expectRefused(await files.attachInOne(who, itemId, data), ORGANIZATION_ENDED);
    }
    expectRefused(await files.upload(editor, itemId, waiting.body.attachmentId, data), ORGANIZATION_ENDED);
    for (const who of cannot) {
      expectRefused(await files.declare(who, itemId, data.length), NOT_WRITABLE);
    }
    // Every file downloads for whoever can open the item, is in the
    // organization's export, and can be removed.
    for (const who of [...canAdd, viewer]) {
      expect(await files.download(who, itemId, attached[0])).toEqual(data);
    }
    const exported = await api.call(owner, "GET", `/api/organizations/${orgId}/export`);
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const inExport = exported.body.ciphers.find((c: { id: string }) => c.id === itemId);
    const everyFile = [...attached, ...large, waiting.body.attachmentId].sort();
    expect(inExport.attachments.map((a: { id: string }) => a.id).sort()).toEqual(everyFile);
    expect((await files.remove(editor, itemId, attached[3])).status).toBe(200);
    for (const id of everyFile.filter((id) => id !== attached[3])) {
      const removed = await files.remove(owner, itemId, id);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    }
    expect(await files.inSync(owner, itemId)).toEqual([]);
  });

  test("Free sends text and not files, Premium sends files by any of its three ways, and a file Send outlives Premium", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const files = new Files(request, api);
    const person = await api.account("plans-send-person");
    const data = bytesOf(1500, 5);

    // On Free: text, and no file.
    expectRefused(await files.declareSend(person, data.length), SENDING_FILES_IS_PREMIUM);
    const text = await api.call(person, "POST", "/api/sends", textSend());
    expect(text.status, JSON.stringify(text.body)).toBe(200);
    const sends = await api.call(person, "GET", "/api/sends");
    expect(sends.body.data.map((s: { type: number }) => s.type)).toEqual([0]);
    expect((await files.declareSend(null, data.length)).status).toBe(401);

    // Premium: a file Send, which someone with no account receives.
    await operator.set("users", person.userId, paidUntil("premium", fromNow(30 * DAY)));
    const sent = await files.sendFile(person, data);
    expect(await files.receive(sent.accessId, sent.fileId)).toEqual(data);
    // Another, whose file is still on its way when Premium ends.
    const waiting = await files.declareSend(person, data.length);
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);

    // Premium ends: no new file Send, and text as ever.
    await operator.set("users", person.userId, paidUntil("premium", fromNow(-60 * DAY), false));
    expectRefused(await files.declareSend(person, data.length), SENDING_FILES_IS_PREMIUM);
    expect((await api.call(person, "POST", "/api/sends", textSend())).status).toBe(200);
    // The file Sends made with Premium keep working until they expire or are
    // deleted, the one whose file arrives now too.
    expect(await files.receive(sent.accessId, sent.fileId)).toEqual(data);
    const late = waiting.body.sendResponse;
    const uploaded = await files.uploadSend(person, late.id, late.file.id, data);
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect(await files.receive(late.accessId, late.file.id)).toEqual(data);
    for (const id of [sent.sendId, late.id]) {
      expect((await api.call(person, "DELETE", `/api/sends/${id}`)).status).toBe(200);
    }

    // Premium's features come with a place in an organization whose plan is
    // in effect, and with an MSP's staff: files on their own items, and file
    // Sends.
    const seat = await api.account("plans-send-seat");
    const orgId = await api.organization(seat, "Plans Send Org");
    const staff = await api.account("plans-send-staff");
    const mspId = await api.msp(staff, "Plans Send MSP");
    for (const who of [seat, staff]) {
      expectRefused(await files.declareSend(who, data.length), SENDING_FILES_IS_PREMIUM);
    }
    await operator.set("organizations", orgId, paidUntil("business", fromNow(30 * DAY)));
    await operator.set("msps", mspId, open("msp"));
    for (const who of [seat, staff]) {
      const made = await files.sendFile(who, data);
      expect(await files.receive(made.accessId, made.fileId)).toEqual(data);
      const itemId = await api.personalItem(who);
      const id = await files.attach(who, itemId, data);
      expect(await files.download(who, itemId, id)).toEqual(data);
    }
  });

  test("without a key of the server's own, the breach report is the link it has always been, on every plan", async ({
    request,
  }) => {
    const api = new Api(request);
    const person = await api.account("plans-breach-link");
    const asked = "someone@example.test";
    expect(await breachReport(api, person, asked)).toEqual({ status: 200, body: breachLink(asked) });
    await operator.set("users", person.userId, paidUntil("premium", fromNow(30 * DAY)));
    expect(await breachReport(api, person, asked)).toEqual({ status: 200, body: breachLink(asked) });
    expect((await breachReport(api, null, asked)).status).toBe(401);
  });
});

test.describe("where plans are enforced and the operator caps storage below them", () => {
  test.use({ baseURL: `https://127.0.0.1:${plansCapsServerPort}` });

  let server: PlansServer | undefined;
  let operator: Operator;

  test.beforeAll(async ({ playwright }) => {
    // server.mjs, KK_PLANS_CAPS: 2 MB for a person, 3 MB for an organization,
    // 1 MB of Send files, and a key for the breach report.
    server = await startServer(playwright, plansCapsServerPort, true, { KK_PLANS_CAPS: "1" });
    operator = server.operator;
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("a cap the operator set is the most a plan gives, and the sentence says the cap", async ({ request }) => {
    const api = new Api(request);
    const files = new Files(request, api);
    const person = await api.account("plans-caps-person");
    await operator.set("users", person.userId, paidUntil("premium", fromNow(30 * DAY)));
    const itemId = await api.personalItem(person);
    const file = bytesOf(MB, 7);

    // Premium gives 5 GB, and the cap 2 MB: the cap, to the last byte.
    const fileId = await files.attach(person, itemId, file);
    expectRefused(await files.declare(person, itemId, MB + 1), full("Your", "2 MB"));
    const rest = await files.declare(person, itemId, MB);
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expectRefused(await files.declare(person, itemId, 1), full("Your", "2 MB"));
    expectRefused(await files.attachInOne(person, itemId, bytesOf(1, 7)), full("Your", "2 MB"));
    // Full, its files still download, and removing one makes room.
    expect(await files.download(person, itemId, fileId)).toEqual(file);
    expect((await files.remove(person, itemId, rest.body.attachmentId)).status).toBe(200);
    expect((await files.declare(person, itemId, MB)).status).toBe(200);

    // On Free, what the plan says comes first.
    const free = await api.account("plans-caps-free");
    expectRefused(await files.declare(free, await api.personalItem(free), 1), ATTACHING_IS_PREMIUM);

    // An organization's plan gives it 5 GB, and the cap 3 MB.
    const orgId = await api.organization(person, "Plans Capped Org");
    const collectionId = await api.collection(person, orgId);
    const shared = await api.orgItem(person, orgId, collectionId);
    await operator.set("organizations", orgId, paidUntil("business", fromNow(30 * DAY)));
    expect((await files.declare(person, shared, 3 * MB)).status).toBe(200);
    expectRefused(await files.declare(person, shared, 1), full("Plans Capped Org's", "3 MB"));
  });

  test("a file Send's allowance stays the server's, and the plan is asked first", async ({ request }) => {
    const api = new Api(request);
    const files = new Files(request, api);
    const person = await api.account("plans-caps-sender");

    expectRefused(await files.declareSend(person, MB + 1), SENDING_FILES_IS_PREMIUM);
    await operator.set("users", person.userId, paidUntil("premium", fromNow(30 * DAY)));
    // What the server has always said past its 1 MB.
    expectRefused(await files.declareSend(person, MB + 1), "Send storage limit exceeded with this file");
    expect((await files.declareSend(person, MB)).status).toBe(200);
    expectRefused(await files.declareSend(person, 1), "Send storage limit reached! Delete some sends to free up space");
  });

  test("with a key, the breach report is Premium's: Free is refused, and Premium reaches the lookup", async ({
    request,
  }) => {
    const api = new Api(request);
    const asked = "someone@example.test";
    const free = await api.account("plans-caps-breach-free");
    expectRefused(await breachReport(api, free, asked), BREACH_REPORT_IS_PREMIUM);
    expect((await breachReport(api, null, asked)).status).toBe(401);

    // Premium, and a place in an organization whose plan is in effect, get
    // past the plan to the lookup itself, which this server is told never to
    // make: it stops there, before anything leaves the machine.
    const premium = await api.account("plans-caps-breach-premium");
    await operator.set("users", premium.userId, paidUntil("premium", fromNow(30 * DAY)));
    const seat = await api.account("plans-caps-breach-seat");
    const orgId = await api.organization(seat, "Plans Breach Org");
    await operator.set("organizations", orgId, paidUntil("business", fromNow(30 * DAY)));
    for (const who of [premium, seat]) {
      expectRefused(await breachReport(api, who, asked), BLOCKED_LOOKUP);
    }
  });
});

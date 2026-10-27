// Event streaming (DESIGN.md, "Sending events to security tools"): an
// organization's events, and an MSP's, go to its security tools by a signed
// webhook, syslog over TLS, or Microsoft Sentinel, through a queue in the
// database. The receivers are stand-ins on 127.0.0.1 (siem.ts); the main
// test server is allowed private addresses for them, and the groups server
// keeps the default, which refuses them.
import { randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { groupsServerPort, siemPort } from "../../paths.mjs";

import { type MatrixRow, permissionMatrix } from "./matrix";
import {
  type Cert,
  type Received,
  httpsReceiver,
  parseSyslog,
  sentinelStandIn,
  syslogReceiver,
  throwawayCert,
  verifyWebhook,
  waitFor,
} from "./siem";
import { type Account, Api, withMasterPassword } from "./support";

const cert: Cert = throwawayCert();

const orgPath = (orgId: string) => `/api/keykeeper/organizations/${orgId}/event-streaming`;
const mspPath = (mspId: string) => `/api/keykeeper/msp/${mspId}/event-streaming`;

type Destination = {
  id: string;
  name: string;
  kind: string;
  status: string;
  target: string;
  queued: number;
  pausedReason: string | null;
  lastError: string | null;
  failures: number;
  retryAt: string | null;
  signingSecret?: string;
};

async function create(api: Api, who: Account, path: string, data: unknown): Promise<Destination> {
  const created = await api.call(who, "POST", path, withMasterPassword(who, data));
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body;
}

async function list(api: Api, who: Account, path: string): Promise<Destination[]> {
  const listed = await api.call(who, "GET", path);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.data;
}

const webhook = (url: string, more: Record<string, unknown> = {}) => ({
  name: "SIEM webhook",
  kind: "webhook",
  webhook: { url, caCertificate: cert.cert, ...more },
});

/** Renames an organization: one "Edited the organization's settings" event. */
async function touch(api: Api, owner: Account, orgId: string, name: string) {
  const edited = await api.call(owner, "PUT", `/api/organizations/${orgId}`, { name, billingEmail: owner.email });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
}

const ofType = (type: number) => (events: { type: number }[]) => events.filter((e) => e.type === type);

/** How many events a list of them stands for: merged ones carry a count. */
const counted = (events: { count?: number }[]) => events.reduce((n, e) => n + (e.count ?? 1), 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a webhook gets each event signed, with who did what and no secrets, and the console never shows them", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const receiver = await httpsReceiver(cert);
  try {
    const owner = await api.account("stream-owner");
    const orgId = await api.organization(owner, "Contoso");
    const added = await create(
      api,
      owner,
      orgPath(orgId),
      webhook(receiver.url("/hook?token=SECRET-IN-URL"), {
        headerName: "Authorization",
        headerValue: "Bearer collector-token",
      }),
    );
    expect(added).toMatchObject({ kind: "webhook", status: "on", target: `https://127.0.0.1:${receiver.port}/…` });
    const secret = added.signingSecret!;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);

    const events = () => receiver.received.map((r) => verifyWebhook(r, secret));
    // Adding it is an event, and the first it gets.
    const [addedEvent] = await waitFor(receiver.received, () => ofType(1690)(events()), "the 'added' event");
    expect(addedEvent).toMatchObject({
      type: 1690,
      name: "Added a place events are sent",
      category: "organization",
      severity: "high",
      organization: { id: orgId, name: "Contoso" },
      actor: { type: "user", id: owner.userId, email: owner.email },
      ip: "127.0.0.1",
      device: { type: 10, name: "Firefox" },
      // Which destination, and how it is now: never a secret.
      target: {
        type: "eventDestination",
        id: added.id,
        name: "SIEM webhook",
        kind: "webhook",
        shownTarget: `https://127.0.0.1:${receiver.port}/…`,
        enabled: true,
      },
      changes: [],
      detail: "Added, and on.",
    });
    const first = receiver.received[0];
    expect(first.path).toBe("/hook?token=SECRET-IN-URL");
    expect(first.headers.authorization).toBe("Bearer collector-token");
    expect(first.headers["content-type"]).toBe("application/json");

    // A member joins: invited, then confirmed, each about the member.
    const member = await api.account("stream-member");
    await api.addMember(owner, orgId, member, "user");
    const [confirmed] = await waitFor(receiver.received, () => ofType(1501)(events()), "the 'confirmed' event");
    expect(confirmed).toMatchObject({
      name: "Confirmed a member",
      category: "member",
      severity: "low",
      target: { type: "member", userId: member.userId, email: member.email },
    });
    expect(ofType(1500)(events())).toHaveLength(1);
    // Never anything encrypted, and so never vault data.
    for (const r of receiver.received) {
      expect(r.body).not.toMatch(/"2\.[A-Za-z0-9+/=]+\|/);
    }

    // What the console sees: the host, never the URL's token, the header's
    // value, or the signing secret.
    const listed = await api.call(owner, "GET", orgPath(orgId));
    const text = JSON.stringify(listed.body);
    for (const hidden of ["SECRET-IN-URL", "collector-token", secret, "/hook"]) {
      expect(text, hidden).not.toContain(hidden);
    }
    expect(listed.body.data[0].webhook).toMatchObject({ headerName: "Authorization" });

    // The Test button sends a sample event now.
    const tested = await api.call(owner, "POST", `${orgPath(orgId)}/${added.id}/test`);
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    const [sample] = await waitFor(receiver.received, () => ofType(9000)(events()), "the test event");
    expect(sample).toMatchObject({ id: tested.body.eventId, name: "Test event", organization: { id: orgId } });

    // A new signing secret: shown once, and later events are signed with it.
    const renewed = await api.call(owner, "POST", `${orgPath(orgId)}/${added.id}/secret`, withMasterPassword(owner));
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    const next = renewed.body.signingSecret as string;
    expect(next).not.toBe(secret);
    const before = receiver.received.length;
    await touch(api, owner, orgId, "Contoso Ltd");
    const later = await waitFor(
      receiver.received,
      (all) => all.slice(before).find((r) => JSON.parse(r.body).type === 1600),
      "the event after the new secret",
    );
    expect(verifyWebhook(later, next)).toMatchObject({ type: 1600, organization: { name: "Contoso Ltd" } });
    expect(() => verifyWebhook(later, secret)).toThrow();

    // The header's value stays with the URL, certificate authority, and
    // header it was entered for: changing any of them asks for it again.
    const changes: Record<string, string>[] = [
      { url: "https://collector.example.test/hook" },
      { url: receiver.url("/other-path") },
      { headerName: "X-Api-Key" },
      { url: receiver.url("/hook?token=SECRET-IN-URL"), caCertificate: "" },
    ];
    for (const change of changes) {
      const asked = await api.call(owner, "PUT", `${orgPath(orgId)}/${added.id}`, withMasterPassword(owner, { webhook: change }));
      expect(asked.status, JSON.stringify(change)).toBe(400);
      expect(asked.body.message).toMatch(/Enter the header's value again/);
    }
    // And trusting another certificate authority takes knowing the URL
    // (which can carry a token): it's asked for again too.
    const caOnly = await api.call(
      owner,
      "PUT",
      `${orgPath(orgId)}/${added.id}`,
      withMasterPassword(owner, { webhook: { caCertificate: "", headerValue: "Bearer collector-token" } }),
    );
    expect(caOnly.status).toBe(400);
    expect(caOnly.body.message).toMatch(/Enter the webhook's URL again/);

    // Pointed at another host: the old one hears so, and there's a new
    // signing secret for the new one.
    const other = await httpsReceiver(cert);
    try {
      const moved = await api.call(
        owner,
        "PUT",
        `${orgPath(orgId)}/${added.id}`,
        withMasterPassword(owner, { webhook: { url: other.url("/new"), headerValue: "Bearer collector-token-2" } }),
      );
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      const third = moved.body.signingSecret as string;
      expect(third).toMatch(/^whsec_/);
      expect(third).not.toBe(next);
      const notice = await waitFor(
        receiver.received,
        (all) => all.map((r) => JSON.parse(r.body)).find((e) => e.detail?.includes("pointed elsewhere")),
        "the notice that it was pointed elsewhere",
      );
      expect(notice).toMatchObject({ type: 1691, actor: { email: owner.email } });
      const arrived = await waitFor(other.received, (all) => all.find((r) => JSON.parse(r.body).type === 1691), "the change, at the new host");
      // Which destination changed, and what.
      expect(verifyWebhook(arrived, third)).toMatchObject({
        target: { type: "eventDestination", id: added.id, shownTarget: `https://127.0.0.1:${other.port}/…`, enabled: true },
        changes: ["where it sends", "new signing secret"],
        detail: "Changed: where it sends, new signing secret. It's on.",
      });
      expect(arrived.headers.authorization).toBe("Bearer collector-token-2");
    } finally {
      await other.close();
    }
  } finally {
    await receiver.close();
  }
});

test("a receiver that answers slowly is sent to less often, but isn't failing, and what it took isn't sent again", async ({
  request,
}) => {
  test.setTimeout(60_000);
  const api = new Api(request);
  const receiver = await httpsReceiver(cert, () => ({ status: 200, delayMs: 6000 }));
  try {
    const owner = await api.account("slow-owner");
    const orgId = await api.organization(owner, "Slowpoke");
    const d = await create(api, owner, orgPath(orgId), webhook(receiver.url("/slow")));
    await waitFor(receiver.received, (all) => (all.length > 0 ? all : undefined), "the first, slow delivery");
    const status = async () => (await list(api, owner, orgPath(orgId))).find((x) => x.id === d.id)!;
    await expect.poll(async () => (await status()).status, { timeout: 15_000 }).toBe("slow");
    const now = await status();
    expect(now.lastError).toMatch(/took 6 seconds to answer/);
    expect(now.failures).toBe(0);
    expect(now.retryAt).toBeTruthy();
    expect(now.queued).toBe(0);
    // Delivered once, not again.
    await sleep(3000);
    expect(receiver.received.filter((r) => JSON.parse(r.body).type === 1690)).toHaveLength(1);
  } finally {
    await receiver.close();
  }
});

test("one person's many slow destinations don't hold up anyone else's, and get two turns at a time at most", async ({
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  // Answers each delivery after 8 seconds: slow, but within the 10 a request may take.
  let busy = 0;
  let mostAtOnce = 0;
  const slow = await httpsReceiver(cert, () => {
    busy += 1;
    mostAtOnce = Math.max(mostAtOnce, busy);
    setTimeout(() => (busy -= 1), 8000);
    return { status: 200, delayMs: 8000 };
  });
  const fast = await httpsReceiver(cert);
  const hog = await api.account("hog");
  const made: [string, string][] = [];
  try {
    // As many organizations as one person can stream (20), each with a
    // slow destination and events waiting: more than the worker's 16 slots.
    for (let i = 0; i < 20; i++) {
      const orgId = await api.organization(hog, `Hog ${i}`);
      const d = await create(api, hog, orgPath(orgId), webhook(slow.url(`/hog/${i}`)));
      made.push([orgId, d.id]);
      await touch(api, hog, orgId, `Hog ${i} renamed`);
    }
    await waitFor(slow.received, (all) => (all.length >= 2 ? all : undefined), "the slow deliveries to start");

    // Someone else's destination keeps up meanwhile: its first event arrives
    // in a few seconds, not after the slow ones.
    const someone = await api.account("someone");
    const theirOrg = await api.organization(someone, "Fabrikam");
    const started = Date.now();
    const theirs = await create(api, someone, orgPath(theirOrg), webhook(fast.url("/fast")));
    await waitFor(fast.received, (all) => all.find((r) => JSON.parse(r.body).type === 1690), "the other person's event", 6_000);
    expect(Date.now() - started).toBeLessThan(6_000);
    await touch(api, someone, theirOrg, "Fabrikam 2");
    await waitFor(fast.received, (all) => all.find((r) => JSON.parse(r.body).type === 1600), "their next event", 6_000);
    verifyWebhook(fast.received[0], theirs.signingSecret!);

    // The slow person never has more than two turns at once, and their
    // destinations are slow, never failing or turned off.
    await sleep(12_000);
    expect(mostAtOnce).toBeLessThanOrEqual(2);
    const statuses = await Promise.all(
      made.map(async ([orgId, id]) => (await list(api, hog, orgPath(orgId))).find((x) => x.id === id)!.status),
    );
    expect(statuses).toContain("slow");
    expect(statuses.filter((st) => st !== "slow" && st !== "on")).toEqual([]);

    // One test at a time per person, across organizations.
    const first = api.call(hog, "POST", `${orgPath(made[0][0])}/${made[0][1]}/test`);
    await sleep(500);
    const second = await api.call(hog, "POST", `${orgPath(made[1][0])}/${made[1][1]}/test`);
    expect(second.status).toBe(429);
    expect(second.body.message).toMatch(/You have a test running/);
    expect((await first).status).toBe(200);
  } finally {
    for (const [orgId, id] of made) {
      await api.call(hog, "DELETE", `${orgPath(orgId)}/${id}`);
    }
    await slow.close();
    await fast.close();
  }
});

test("a destination stays, and keeps sending, when the person who set it up deletes their account", async ({
  request,
}) => {
  const api = new Api(request);
  const receiver = await httpsReceiver(cert);
  try {
    const owner = await api.account("leaver-owner");
    const orgId = await api.organization(owner, "Leaver Org");
    const leaver = await api.account("leaver");
    await api.addMember(owner, orgId, leaver, "admin");
    const d = await create(api, leaver, orgPath(orgId), webhook(receiver.url("/leaver")));
    const gone = await api.call(leaver, "DELETE", "/api/accounts", { masterPasswordHash: leaver.password });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect((await list(api, owner, orgPath(orgId))).find((x) => x.id === d.id)).toMatchObject({ status: "on" });
    await touch(api, owner, orgId, "Leaver Org renamed");
    const later = await waitFor(
      receiver.received,
      (all) => all.map((r) => verifyWebhook(r, d.signingSecret!)).find((e) => e.type === 1600),
      "an event after the account was deleted",
    );
    expect(later.organization.name).toBe("Leaver Org renamed");
  } finally {
    await receiver.close();
  }
});

test("one person sets up destinations in at most 20 organizations and MSPs", async ({ request }) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const busy = await api.account("busy-admin");
  const made: [string, string][] = [];
  try {
    for (let i = 0; i < 20; i++) {
      const orgId = await api.organization(busy, `Busy ${i}`);
      made.push([orgId, (await create(api, busy, orgPath(orgId), webhook(`https://127.0.0.1:9/busy-${i}`))).id]);
    }
    // More in one of those is fine (up to five there).
    made.push([made[0][0], (await create(api, busy, orgPath(made[0][0]), webhook("https://127.0.0.1:9/more"))).id]);
    // A 21st organization isn't, for this person; another admin there can.
    const another = await api.organization(busy, "Busy 21");
    const refused = await api.call(busy, "POST", orgPath(another), withMasterPassword(busy, webhook("https://127.0.0.1:9/busy-21")));
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/the most one person can/);
    const colleague = await api.account("busy-colleague");
    await api.addMember(busy, another, colleague, "admin");
    made.push([another, (await create(api, colleague, orgPath(another), webhook("https://127.0.0.1:9/colleague"))).id]);
  } finally {
    for (const [orgId, id] of made) {
      await api.call(busy, "DELETE", `${orgPath(orgId)}/${id}`);
    }
  }
});

test("syslog over TLS gets RFC 5424 messages, framed by octet counting, as JSON or CEF", async ({ request }) => {
  test.setTimeout(60_000);
  const api = new Api(request);
  const collector = await syslogReceiver(cert);
  try {
    const owner = await api.account("syslog-owner");
    const orgId = await api.organization(owner, "Fabrikam");
    for (const format of ["json", "cef"]) {
      const d = await create(api, owner, orgPath(orgId), {
        name: `Syslog ${format}`,
        kind: "syslog",
        syslog: { host: "127.0.0.1", port: collector.port, format, caCertificate: cert.cert },
      });
      expect(d).toMatchObject({ status: "on", target: `127.0.0.1:${collector.port}` });
    }
    await touch(api, owner, orgId, "Fabrikam Inc");
    const edits = await waitFor(
      collector.messages,
      (all) => {
        const found = all.map(parseSyslog).filter((m) => m.msgId === "1600");
        return found.length >= 2 ? found : undefined;
      },
      "the edit, in both formats",
    );
    for (const m of edits) {
      // Facility 13 (log audit), severity 5 (notice).
      expect(m).toMatchObject({ pri: 109, version: "1", host: "127.0.0.1", app: "passbundle", procId: "-" });
      expect(Date.parse(m.time)).toBeGreaterThan(Date.now() - 60_000);
    }
    const json = edits.find((m) => m.message.startsWith("{"))!;
    expect(JSON.parse(json.message)).toMatchObject({
      type: 1600,
      name: "Edited the organization's settings",
      organization: { id: orgId, name: "Fabrikam Inc" },
      actor: { email: owner.email },
    });
    const cef = edits.find((m) => m.message.startsWith("CEF:"))!;
    expect(cef.message).toMatch(/^CEF:0\|PassBundle\|PassBundle\|[^|]+\|1600\|Edited the organization's settings\|5\|rt=\d+ /);
    for (const part of [
      `suser=${owner.email}`,
      `suid=${owner.userId}`,
      "src=127.0.0.1",
      `cs1=${orgId} cs1Label=organizationId`,
      "cs2=Fabrikam Inc cs2Label=organizationName",
      "cat=organization",
    ]) {
      expect(cef.message, part).toContain(part);
    }
  } finally {
    await collector.close();
  }
});

test("an event queued just as the worker finishes with a destination isn't left behind", async ({ request }) => {
  // Adding a destination is an event the worker sends at once, so a rename
  // right after adding two is queued while the worker is finishing with
  // them. After each turn the worker sets when a destination next has
  // something due (DESIGN.md, "Finding work"). It once set that from a queue
  // it had read before the rename was in it, and the rename then waited,
  // unseen, until another event came. One organization hit that moment now
  // and then; 18 of them hit it in most runs.
  test.setTimeout(120_000);
  const api = new Api(request);
  const collector = await syslogReceiver(cert);
  try {
    const owner = await api.account("syslog-many");
    const orgs: string[] = [];
    for (let i = 0; i < 18; i++) {
      const orgId = await api.organization(owner, `Northwind ${i}`);
      orgs.push(orgId);
      for (const format of ["json", "cef"]) {
        await create(api, owner, orgPath(orgId), {
          name: `Syslog ${format}`,
          kind: "syslog",
          syslog: { host: "127.0.0.1", port: collector.port, format, caCertificate: cert.cert },
        });
      }
      await touch(api, owner, orgId, `Northwind ${i} Inc`);
    }
    // Each organization's rename, in each format, that hasn't arrived.
    const missing = () => {
      const arrived = new Set(
        collector.messages
          .map(parseSyslog)
          .filter((m) => m.msgId === "1600")
          .map((m) =>
            m.message.startsWith("{")
              ? `json ${JSON.parse(m.message).organization.id}`
              : `cef ${/ cs1=(\S+) cs1Label=organizationId/.exec(m.message)?.[1]}`,
          ),
      );
      return orgs.flatMap((o) => [`json ${o}`, `cef ${o}`]).filter((k) => !arrived.has(k));
    };
    await expect.poll(missing, { message: "renames that never arrived", timeout: 20_000 }).toEqual([]);
  } finally {
    await collector.close();
  }
});

test("a failing destination is retried, one that's gone is paused, and turning it back on sends what waited", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  let answer = 503;
  const receiver = await httpsReceiver(cert, () => ({ status: answer, body: answer === 200 ? "" : "busy" }));
  try {
    const owner = await api.account("retry-owner");
    const orgId = await api.organization(owner, "Northwind Traders");
    const d = await create(api, owner, orgPath(orgId), webhook(receiver.url("/events")));
    const status = async () => (await list(api, owner, orgPath(orgId))).find((x) => x.id === d.id)!;

    // The "added" event fails, and the console says why.
    await waitFor(receiver.received, (all) => (all.length > 0 ? all : undefined), "the first attempt");
    await expect.poll(async () => (await status()).status).toBe("failing");
    expect((await status()).lastError).toContain("503");
    expect((await status()).queued).toBe(1);

    // It's tried again about ten seconds later, and arrives.
    answer = 200;
    const tries = receiver.received.length;
    await waitFor(receiver.received, (all) => all.slice(tries), "the retry", 30_000);
    await expect.poll(async () => (await status()).status).toBe("on");
    expect((await status()).queued).toBe(0);

    // A second destination, which hears what happens to the first.
    const watching = await httpsReceiver(cert);
    try {
      const watcher = await create(api, owner, orgPath(orgId), webhook(watching.url("/watch")));
      await expect.poll(async () => (await status()).queued).toBe(0);

      // 410 Gone: the server stops sending there, and says so: in the
      // event log, as no one (the server did it), and to the other
      // destinations, saying which one and that it's off.
      answer = 410;
      await touch(api, owner, orgId, "Northwind 2");
      await expect.poll(async () => (await status()).status, { timeout: 20_000 }).toBe("paused");
      expect((await status()).pausedReason).toContain("410");
      const stopped = await waitFor(
        watching.received,
        (all) => all.map((r) => verifyWebhook(r, watcher.signingSecret!)).find((e) => e.type === 1693),
        "the 'stopped' event",
      );
      expect(stopped).toMatchObject({
        name: "The server stopped sending to a place events are sent",
        severity: "high",
        actor: { type: "system" },
        target: { type: "eventDestination", id: d.id, kind: "webhook", enabled: false },
        changes: ["turned off"],
      });
      expect(stopped.detail).toMatch(/^The server turned this destination off\. It answered HTTP 410\.$/);
      const log = await api.call(owner, "GET", `/api/organizations/${orgId}/events?start=2020-01-01T00:00:00Z&end=2099-01-01T00:00:00Z`);
      expect((log.body.data as { type: number }[]).map((e) => e.type)).toContain(1693);
      await api.call(owner, "DELETE", `${orgPath(orgId)}/${watcher.id}`);
    } finally {
      await watching.close();
    }
    // Events keep waiting while it's paused: the edit it was stopped on, the
    // 'stopped' event, the watcher's removal, and another edit.
    await touch(api, owner, orgId, "Northwind 3");
    await expect.poll(async () => (await status()).queued).toBe(4);

    // Turned back on, what waited goes.
    answer = 200;
    const resumed = await api.call(owner, "PUT", `${orgPath(orgId)}/${d.id}`, withMasterPassword(owner, { enabled: true }));
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const arrived = await waitFor(
      receiver.received,
      (all) => {
        const names = all.filter((r) => r.headers["webhook-id"]).map((r) => JSON.parse(r.body).organization?.name);
        return names.includes("Northwind 2") && names.includes("Northwind 3") ? names : undefined;
      },
      "the events that waited",
    );
    expect(arrived).toContain("Northwind 3");
    await expect.poll(async () => (await status()).queued).toBe(0);

    // Turned off on purpose: it's told so, then nothing waits and nothing goes.
    const off = await api.call(owner, "PUT", `${orgPath(orgId)}/${d.id}`, withMasterPassword(owner, { enabled: false }));
    expect(off.body).toMatchObject({ status: "off", enabled: false });
    const notice = await waitFor(
      receiver.received,
      (all) => all.map((r) => JSON.parse(r.body)).find((e) => e.type === 1691 && e.detail?.includes("was turned off")),
      "the notice that it's off",
    );
    expect(notice).toMatchObject({ type: 1691, actor: { email: owner.email }, organization: { id: orgId } });
    await touch(api, owner, orgId, "Northwind 4");
    await new Promise((r) => setTimeout(r, 2000));
    expect((await status()).queued).toBe(0);
    const names = receiver.received.map((r) => JSON.parse(r.body).organization?.name);
    expect(names).not.toContain("Northwind 4");
  } finally {
    await receiver.close();
  }
});

test("events never go to link-local or cloud metadata addresses, and private ones only where the server allows", async ({
  request,
  playwright,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const owner = await api.account("ssrf-owner");
  const orgId = await api.organization(owner, "Litware");
  const refuse = async (on: Api, who: Account, org: string, data: unknown, message: RegExp) => {
    const result = await on.call(who, "POST", orgPath(org), withMasterPassword(who, data as Record<string, unknown>));
    expect(result.status, JSON.stringify(data)).toBe(400);
    expect(String(result.body?.message), JSON.stringify(data)).toMatch(message);
  };

  // Even where some private addresses are allowed (127.0.0.1 only, here).
  await refuse(api, owner, orgId, webhook("https://10.0.0.5/hook"), /private address/);
  await refuse(api, owner, orgId, webhook("https://[::1]/hook"), /private address/);
  await refuse(api, owner, orgId, webhook("https://169.254.169.254/latest/meta-data/"), /metadata/);
  await refuse(api, owner, orgId, webhook("https://[::ffff:a9fe:a9fe]/"), /metadata/);
  await refuse(api, owner, orgId, webhook("https://[fd00:ec2::254]/"), /metadata/);
  await refuse(api, owner, orgId, webhook("http://siem.example.test/hook"), /https/);
  await refuse(api, owner, orgId, webhook("https://user:pass@siem.example.test/hook"), /credentials/);
  await refuse(
    api,
    owner,
    orgId,
    { name: "Syslog", kind: "syslog", syslog: { host: "100.100.100.200", port: 6514 } },
    /metadata/,
  );
  await refuse(
    api,
    owner,
    orgId,
    {
      name: "Sentinel",
      kind: "sentinel",
      sentinel: {
        tenantId: "contoso.onmicrosoft.com",
        clientId: randomUUID(),
        clientSecret: "secret",
        endpoint: "https://collector.example.test",
        ruleId: `dcr-${"a".repeat(32)}`,
        stream: "Custom-PassBundleEvents",
      },
    },
    /ending in/,
  );

  // A server with the default settings: no private addresses, by IP or by name.
  const defaultsRequest: APIRequestContext = await playwright.request.newContext({
    baseURL: `https://127.0.0.1:${groupsServerPort}`,
    ignoreHTTPSErrors: true,
  });
  try {
    const other = new Api(defaultsRequest);
    const otherOwner = await other.account("ssrf-default-owner");
    const otherOrg = await other.organization(otherOwner, "Litware Defaults");
    await refuse(other, otherOwner, otherOrg, webhook("https://127.0.0.1:8443/hook"), /private address/);
    await refuse(other, otherOwner, otherOrg, webhook("https://[::1]/hook"), /private address/);
    await refuse(
      other,
      otherOwner,
      otherOrg,
      { name: "Syslog", kind: "syslog", syslog: { host: "192.168.1.20", port: 6514 } },
      /private address/,
    );
    // A name is checked when it's used: localhost resolves to loopback. What
    // anyone's told is the same as for any place that can't be reached, so
    // tests can't map a network.
    // And it comes after the same time, whatever went wrong (a refused
    // address, a name that doesn't resolve), so a test can't time it either.
    const byName = await create(other, otherOwner, orgPath(otherOrg), webhook("https://localhost:9/hook"));
    let started = Date.now();
    const tested = await other.call(otherOwner, "POST", `${orgPath(otherOrg)}/${byName.id}/test`);
    const refusedTook = Date.now() - started;
    expect(tested.status).toBe(400);
    expect(tested.body.message).toMatch(/^Couldn't connect or complete TLS with localhost\./);
    expect(tested.body.message).not.toMatch(/127\.0\.0\.1|::1/);
    const closed = await create(other, otherOwner, orgPath(otherOrg), webhook("https://collector.example.test:9/hook"));
    started = Date.now();
    const unreachable = await other.call(otherOwner, "POST", `${orgPath(otherOrg)}/${closed.id}/test`);
    const unresolvedTook = Date.now() - started;
    expect(unreachable.body.message).toMatch(/^Couldn't connect or complete TLS with collector\.example\.test\./);
    for (const took of [refusedTook, unresolvedTook]) {
      expect(took).toBeGreaterThanOrEqual(15_900);
      expect(took).toBeLessThan(20_000);
    }
  } finally {
    await defaultsRequest.dispose();
  }
});

test("an MSP's feed gets every client's events and the MSP's own activity, each tagged with the MSP and client", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const api = new Api(request);
  const receiver = await httpsReceiver(cert);
  try {
    const admin = await api.account("feed-admin");
    const mspId = await api.msp(admin, "Northwind IT");
    const dental = await api.client(admin, mspId, "Acme Dental");
    const law = await api.client(admin, mspId, "Baker Law");
    const feed = await create(api, admin, mspPath(mspId), webhook(receiver.url("/soc")));
    const events = () => receiver.received.map((r) => verifyWebhook(r, feed.signingSecret!));

    const [added] = await waitFor(receiver.received, () => ofType(9170)(events()), "the feed's own 'added' entry");
    expect(added).toMatchObject({
      category: "msp",
      action: "event_stream_added",
      msp: { id: mspId, name: "Northwind IT" },
      actor: { email: admin.email },
    });
    expect(added.detail).toContain(`https://127.0.0.1:${receiver.port}/…`);

    await touch(api, admin, dental, "Acme Dental Group");
    await touch(api, admin, law, "Baker Law LLP");
    const edits = await waitFor(
      receiver.received,
      () => {
        const e = ofType(1600)(events());
        return e.length >= 2 ? e : undefined;
      },
      "both clients' edits",
    );
    expect(edits.map((e) => e.organization.id).sort()).toEqual([dental, law].sort());
    for (const e of edits) {
      expect(e.msp).toEqual({ id: mspId, name: "Northwind IT" });
    }

    // The MSP's activity: a technician invited.
    const tech = await api.account("feed-tech");
    await api.addStaff(admin, mspId, tech, "technician");
    const [invited] = await waitFor(receiver.received, () => ofType(9110)(events()), "the staff invitation");
    expect(invited).toMatchObject({ target: { type: "person", email: tech.email }, severity: "medium" });

    // A client's own destination, set up by the MSP's admin: the client's
    // event goes to both.
    const own = await httpsReceiver(cert);
    try {
      const clientDest = await create(api, admin, orgPath(dental), webhook(own.url("/client")));
      await waitFor(own.received, (all) => all.find((r) => JSON.parse(r.body).type === 1690), "the client's own copy");
      const [both] = await waitFor(
        receiver.received,
        () => ofType(1690)(events()).filter((e) => e.organization?.id === dental),
        "the MSP's copy",
      );
      expect(both.msp.name).toBe("Northwind IT");
      // The client's own copy doesn't say which MSP.
      const ownCopy = own.received.map((r) => verifyWebhook(r, clientDest.signingSecret!)).find((e) => e.type === 1690);
      expect(ownCopy.msp).toBeUndefined();
    } finally {
      await own.close();
    }
  } finally {
    await receiver.close();
  }
});

test("one client's member can't flood the MSP's feed: what apps report is capped, limited, and merged, and so are failed logins", async ({
  request,
}) => {
  test.setTimeout(300_000);
  const api = new Api(request);
  let answer = 503;
  // What the feed took (answered 200): attempts it answered 503 aren't
  // deliveries, and the same event is tried again later.
  const delivered: Received[] = [];
  const receiver = await httpsReceiver(cert, (r) => {
    if (answer === 200) {
      delivered.push(r);
    }
    return { status: answer };
  });
  try {
    const admin = await api.account("flood-admin");
    const mspId = await api.msp(admin, "Flood MSP");
    const noisy = await api.client(admin, mspId, "Noisy Client");
    const quiet = await api.client(admin, mspId, "Quiet Client");
    const member = await api.account("flood-member");
    await api.addMember(admin, noisy, member, "user");
    // Also in the other client: their failed logins are logged in both.
    await api.addMember(admin, quiet, member, "user");
    const feed = await create(api, admin, mspPath(mspId), webhook(receiver.url("/feed")));
    const status = async () => (await list(api, admin, mspPath(mspId))).find((x) => x.id === feed.id)!;
    // The feed is down for a while, so what follows waits in its queue.
    await waitFor(receiver.received, (all) => (all.length > 0 ? all : undefined), "the first attempt");
    await expect.poll(async () => (await status()).status).toBe("failing");

    // The member's app reports 2,000 exports at once: refused, and nothing
    // recorded. In batches of 500 (as PassBundle's apps send), they're taken.
    const now = new Date().toISOString();
    const exported = (n: number) => Array.from({ length: n }, () => ({ type: 1602, date: now, organizationId: noisy }));
    const tooMany = await api.call(member, "POST", "/events/collect", exported(2000));
    expect(tooMany.status).toBe(413);
    expect(tooMany.body.message).toMatch(/at most 500 events at once; this had 2000\. Nothing was recorded/);
    for (let i = 0; i < 2; i++) {
      const collected = await api.call(member, "POST", "/events/collect", exported(500));
      expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    }
    // And it can't keep that up: a burst, then 429.
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push((await api.call(member, "POST", "/events/collect", [])).status);
    }
    expect(statuses).toContain(429);
    // Failed logins, as anyone can make for any account: 30 of them.
    const tries = await Promise.all(
      Array.from({ length: 30 }, () =>
        request.post("/identity/connect/token", {
          form: {
            grant_type: "password",
            username: member.email,
            password: "wrong",
            scope: "api offline_access",
            client_id: "web",
            deviceType: "10",
            deviceIdentifier: randomUUID(),
            deviceName: "flood-test",
          },
        }),
      ),
    );
    expect(tries.map((t) => t.status())).toEqual(Array(30).fill(400));
    // Something that matters, from the other client, meanwhile.
    const newcomer = await api.account("flood-newcomer");
    await api.addMember(admin, quiet, newcomer, "admin");

    // A few events, each with a count, stand for all of it. The feed takes
    // them at its next retry: 10 seconds after it first failed, or 30 (or
    // more) if the flood took longer than that.
    answer = 200;
    const events = () => delivered.map((r) => verifyWebhook(r, feed.signingSecret!));
    const exports = await waitFor(
      delivered,
      () => {
        const e = ofType(1602)(events());
        return counted(e) >= 1000 ? e : undefined;
      },
      "the merged exports",
      200_000,
    );
    expect(counted(exports)).toBe(1000);
    // One per person and minute, or a few more where the feed took one to
    // send while more came (it then stops taking more).
    expect(exports.length).toBeLessThanOrEqual(6);
    expect(exports[0]).toMatchObject({ organization: { id: noisy }, actor: { email: member.email }, severity: "high" });
    expect(exports.find((e) => e.count)?.lastTime).toBeTruthy();
    const failed = await waitFor(
      delivered,
      () => {
        const e = ofType(1005)(events()).filter((x) => x.organization?.id === noisy);
        return counted(e) >= 30 ? e : undefined;
      },
      "the merged failed logins",
    );
    expect(counted(failed)).toBe(30);
    expect(failed.length).toBeLessThanOrEqual(6);
    // The same failed logins in the other client are its own events: they
    // never merge with the first client's.
    const failedThere = await waitFor(
      delivered,
      () => {
        const e = ofType(1005)(events()).filter((x) => x.organization?.id === quiet);
        return counted(e) >= 30 ? e : undefined;
      },
      "the other client's failed logins",
    );
    expect(counted(failedThere)).toBe(30);
    expect(counted(ofType(1005)(events()))).toBe(60);
    // The other client's change arrived as itself.
    const confirmed = await waitFor(
      delivered,
      () => ofType(1501)(events()).filter((e) => e.organization?.id === quiet),
      "the quiet client's new admin",
    );
    expect(confirmed[0]).toMatchObject({ target: { email: newcomer.email } });
    expect(confirmed[0].count).toBeUndefined();
  } finally {
    await receiver.close();
  }
});

test("Sentinel gets rows through the Logs Ingestion API with a token from Microsoft Entra", async ({ request }) => {
  test.setTimeout(60_000);
  const api = new Api(request);
  const azure = await sentinelStandIn();
  try {
    const owner = await api.account("sentinel-owner");
    const orgId = await api.organization(owner, "Tailspin");
    const clientId = randomUUID();
    const rule = `dcr-${"0123456789abcdef".repeat(2)}`;
    const d = await create(api, owner, orgPath(orgId), {
      name: "Sentinel",
      kind: "sentinel",
      sentinel: {
        tenantId: "tailspin.onmicrosoft.com",
        clientId,
        clientSecret: "app-secret-value",
        endpoint: `https://127.0.0.1:${siemPort}`,
        ruleId: rule,
        stream: "Custom-PassBundleEvents",
      },
    });
    expect(d).toMatchObject({ kind: "sentinel", status: "on" });
    const upload = await waitFor(
      azure.uploads,
      (all) => all.find((u) => u.rows.some((r) => r.EventType === 1690)),
      "an upload",
    );
    expect(upload.path).toBe(`/dataCollectionRules/${rule}/streams/Custom-PassBundleEvents?api-version=2023-01-01`);
    expect(upload.authorization).toBe("Bearer stand-in-token");
    expect(upload.rows[0]).toMatchObject({
      EventName: "Added a place events are sent",
      OrganizationId: orgId,
      OrganizationName: "Tailspin",
      ActorEmail: owner.email,
      IpAddress: "127.0.0.1",
    });
    expect(Date.parse(String(upload.rows[0].TimeGenerated))).toBeGreaterThan(Date.now() - 60_000);
    expect(azure.tokens[0]).toMatchObject({
      path: "/tailspin.onmicrosoft.com/oauth2/v2.0/token",
      grant_type: "client_credentials",
      client_id: clientId,
      scope: "https://monitor.azure.com//.default",
    });

    const listed = await list(api, owner, orgPath(orgId));
    expect(JSON.stringify(listed)).not.toContain("app-secret-value");
    expect(listed[0]).toMatchObject({ sentinel: { hasClientSecret: true, ruleId: rule, clientId } });

    // Sentinel trusts only the system's certificate authorities (here, the
    // server's test setting): a destination can't bring its own.
    const ownCa = await api.call(
      owner,
      "PUT",
      `${orgPath(orgId)}/${d.id}`,
      withMasterPassword(owner, { sentinel: { caCertificate: cert.cert } }),
    );
    expect(ownCa.status).toBe(400);
    expect(ownCa.body.message).toMatch(/doesn't take one of its own/);

    // A wrong secret: the test says Entra refused it.
    await api.call(owner, "PUT", `${orgPath(orgId)}/${d.id}`, withMasterPassword(owner, { sentinel: { clientSecret: "wrong" } }));
    const tested = await api.call(owner, "POST", `${orgPath(orgId)}/${d.id}/test`);
    expect(tested.status).toBe(400);
    expect(tested.body.message).toMatch(/Microsoft Entra refused/);
  } finally {
    await azure.close();
  }
});

test("people the directory provisions arrive with the system as the actor", async ({ request }) => {
  const api = new Api(request);
  const receiver = await httpsReceiver(cert);
  try {
    const owner = await api.account("scim-stream-owner");
    const orgId = await api.organization(owner, "Proseware");
    const d = await create(api, owner, orgPath(orgId), webhook(receiver.url("/scim")));
    const made = await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`, withMasterPassword(owner));
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const email = `scim-${randomUUID().slice(0, 8)}@api.example.test`;
    const created = await request.fetch(`/scim/v2/${orgId}/Users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${made.body.newToken}`,
        Accept: "application/scim+json",
        "Content-Type": "application/scim+json",
      },
      data: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: randomUUID(),
        userName: email,
        active: true,
        emails: [{ primary: true, type: "work", value: email }],
      }),
    });
    expect(created.status(), await created.text()).toBe(201);
    const [invited] = await waitFor(
      receiver.received,
      () => receiver.received.map((r) => verifyWebhook(r, d.signingSecret!)).filter((e) => e.type === 1500),
      "the provisioned invitation",
    );
    expect(invited).toMatchObject({
      actor: { type: "system", name: "scim" },
      target: { type: "member", email },
      organization: { id: orgId },
    });
  } finally {
    await receiver.close();
  }
});

test("each organization has at most five destinations, and a destination's kind can't change", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("limits-owner");
  const orgId = await api.organization(owner, "Woodgrove");
  const nameless = await api.call(
    owner,
    "POST",
    orgPath(orgId),
    withMasterPassword(owner, { kind: "webhook", webhook: { url: "https://x.example" } }),
  );
  expect(nameless.status).toBe(400);
  expect(nameless.body.message).toMatch(/Name must be/);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push((await create(api, owner, orgPath(orgId), webhook(`https://127.0.0.1:${9000 + i}/hook`))).id);
  }
  const sixth = await api.call(owner, "POST", orgPath(orgId), withMasterPassword(owner, webhook("https://127.0.0.1:9100/hook")));
  expect(sixth.status).toBe(400);
  expect(sixth.body.message).toMatch(/at most 5/);
  const changed = await api.call(owner, "PUT", `${orgPath(orgId)}/${ids[0]}`, withMasterPassword(owner, { kind: "syslog" }));
  expect(changed.status).toBe(400);
  expect(changed.body.message).toMatch(/kind can't change/);
  // Removed: it's gone, and that's in the log.
  const removed = await api.call(owner, "DELETE", `${orgPath(orgId)}/${ids[0]}`);
  expect(removed.status).toBe(200);
  expect((await list(api, owner, orgPath(orgId))).map((d) => d.id)).not.toContain(ids[0]);
  const log = await api.call(owner, "GET", `/api/organizations/${orgId}/events?start=2020-01-01T00:00:00Z&end=2099-01-01T00:00:00Z`);
  const types = (log.body.data as { type: number }[]).map((e) => e.type);
  expect(types).toContain(1690);
  expect(types).toContain(1692);
});

test("a destination is reached only through its own organization or MSP", async ({ request }) => {
  const api = new Api(request);
  const ownerA = await api.account("idor-a");
  const orgA = await api.organization(ownerA, "Org A");
  const ownerB = await api.account("idor-b");
  const orgB = await api.organization(ownerB, "Org B");
  const mspB = await api.msp(ownerB, "MSP B");
  const dest = await create(api, ownerA, orgPath(orgA), webhook("https://127.0.0.1:9/a"));
  const tries: ["PUT" | "DELETE" | "POST", string, unknown][] = [
    ["PUT", "", { name: "Mine now" }],
    ["PUT", "", { enabled: false }],
    ["POST", "/test", undefined],
    ["POST", "/secret", undefined],
    ["DELETE", "", undefined],
  ];
  for (const base of [`${orgPath(orgB)}/${dest.id}`, `${mspPath(mspB)}/${dest.id}`]) {
    for (const [method, suffix, data] of tries) {
      const tried = await api.call(ownerB, method, `${base}${suffix}`, data);
      expect(tried.status, `${method} ${base}${suffix}`).toBe(404);
    }
  }
  expect((await list(api, ownerB, orgPath(orgB))).map((d) => d.id)).not.toContain(dest.id);
  expect((await list(api, ownerA, orgPath(orgA))).find((d) => d.id === dest.id)).toMatchObject({
    name: "SIEM webhook",
    enabled: true,
  });

  // The other way: an MSP's feed isn't reached through one of its clients
  // (even by the MSP's admin, who manages both), nor through another MSP;
  // and a client's own destination isn't reached through its MSP.
  const clientB = await api.client(ownerB, mspB, "Client of MSP B");
  const feed = await create(api, ownerB, mspPath(mspB), webhook("https://127.0.0.1:9/feed"));
  const clientDest = await create(api, ownerB, orgPath(clientB), webhook("https://127.0.0.1:9/client"));
  const mspA = await api.msp(ownerA, "MSP A");
  const crossings: [Account, string][] = [
    [ownerB, `${orgPath(clientB)}/${feed.id}`],
    [ownerA, `${mspPath(mspA)}/${feed.id}`],
    [ownerB, `${mspPath(mspB)}/${clientDest.id}`],
    [ownerA, `${mspPath(mspA)}/${clientDest.id}`],
  ];
  for (const [who, base] of crossings) {
    for (const [method, suffix, data] of tries) {
      const tried = await api.call(who, method, `${base}${suffix}`, data);
      expect(tried.status, `${method} ${base}${suffix}`).toBe(404);
    }
  }
  expect((await list(api, ownerB, orgPath(clientB))).map((d) => d.id)).toEqual([clientDest.id]);
  expect((await list(api, ownerB, mspPath(mspB))).map((d) => d.id)).toEqual([feed.id]);
  await api.call(ownerA, "DELETE", `${orgPath(orgA)}/${dest.id}`);
  await api.call(ownerB, "DELETE", `${mspPath(mspB)}/${feed.id}`);
  await api.call(ownerB, "DELETE", `${orgPath(clientB)}/${clientDest.id}`);
});

type OrgActor = "owner" | "admin" | "manager" | "user" | "custom" | "stranger" | "anonymous";
const ORG_ACTORS: readonly OrgActor[] = ["owner", "admin", "manager", "user", "custom", "stranger", "anonymous"];
type OrgCtx = { api: Api; orgId: string; owner: Account; url: string };

/** Removes every destination in a path, so each caller starts under the limit. */
async function clear(api: Api, who: Account, path: string) {
  for (const d of await list(api, who, path)) {
    await api.call(who, "DELETE", `${path}/${d.id}`);
  }
}

/** A destination to act on, made by the owner. */
async function fresh(ctx: OrgCtx): Promise<string> {
  await clear(ctx.api, ctx.owner, orgPath(ctx.orgId));
  return (await create(ctx.api, ctx.owner, orgPath(ctx.orgId), webhook(ctx.url))).id;
}

const orgRows: MatrixRow<OrgActor, OrgCtx>[] = [
  {
    name: "see the organization's destinations",
    allowed: ["owner", "admin"],
    request: async ({ orgId }) => ({ method: "GET", path: orgPath(orgId) }),
  },
  {
    name: "add a destination",
    allowed: ["owner", "admin"],
    request: async (ctx, _, account) => {
      await clear(ctx.api, ctx.owner, orgPath(ctx.orgId));
      return { method: "POST", path: orgPath(ctx.orgId), data: withMasterPassword(account, webhook(ctx.url)) };
    },
  },
  {
    name: "change a destination",
    allowed: ["owner", "admin"],
    request: async (ctx, _, account) => ({
      method: "PUT",
      path: `${orgPath(ctx.orgId)}/${await fresh(ctx)}`,
      data: withMasterPassword(account, { name: "Renamed" }),
    }),
  },
  {
    name: "send a test event",
    allowed: ["owner", "admin"],
    request: async (ctx) => ({ method: "POST", path: `${orgPath(ctx.orgId)}/${await fresh(ctx)}/test` }),
  },
  {
    name: "make a new signing secret",
    allowed: ["owner", "admin"],
    request: async (ctx, _, account) => ({
      method: "POST",
      path: `${orgPath(ctx.orgId)}/${await fresh(ctx)}/secret`,
      data: withMasterPassword(account),
    }),
  },
  {
    name: "remove a destination",
    allowed: ["owner", "admin"],
    request: async (ctx) => {
      const id = await fresh(ctx);
      return {
        method: "DELETE",
        path: `${orgPath(ctx.orgId)}/${id}`,
        check: async (allowed) => {
          const left = await list(ctx.api, ctx.owner, orgPath(ctx.orgId));
          expect(left.some((d) => d.id === id)).toBe(!allowed);
        },
      };
    },
  },
];

test.describe("Event streaming permissions in an organization", () => {
  let receiver: Awaited<ReturnType<typeof httpsReceiver>>;
  test.beforeAll(async () => {
    receiver = await httpsReceiver(cert);
  });
  test.afterAll(async () => {
    await receiver.close();
  });
  permissionMatrix(
    ORG_ACTORS,
    async (api) => {
      const owner = await api.account("owner");
      const orgId = await api.organization(owner, "Streaming Org");
      const admin = await api.account("admin");
      await api.addMember(owner, orgId, admin, "admin");
      const user = await api.account("user");
      await api.addMember(owner, orgId, user, "user");
      const manager = await api.account("manager");
      await api.addMember(owner, orgId, manager, "manager");
      // A custom role that sees the event log still can't send it anywhere.
      const custom = await api.account("custom");
      await api.addCustomMember(owner, orgId, custom, { accessEventLogs: true, manageUsers: true });
      return {
        ctx: { api, orgId, owner, url: receiver.url("/matrix") },
        callers: { owner, admin, manager, user, custom, stranger: await api.account("stranger"), anonymous: null },
      };
    },
    orgRows,
  );
});

type MspActor = "mspAdmin" | "technician" | "clientOwner" | "otherMspAdmin" | "anonymous";
const MSP_ACTORS: readonly MspActor[] = ["mspAdmin", "technician", "clientOwner", "otherMspAdmin", "anonymous"];
type MspCtx = { api: Api; mspId: string; clientId: string; admin: Account; url: string };

/** The MSP's destination to act on, made by its admin. */
async function freshMsp(ctx: MspCtx): Promise<string> {
  await clear(ctx.api, ctx.admin, mspPath(ctx.mspId));
  return (await create(ctx.api, ctx.admin, mspPath(ctx.mspId), webhook(ctx.url))).id;
}

const mspRows: MatrixRow<MspActor, MspCtx>[] = [
  {
    name: "see the MSP's destinations",
    allowed: ["mspAdmin"],
    request: async ({ mspId }) => ({ method: "GET", path: mspPath(mspId) }),
  },
  {
    name: "add a destination for the MSP",
    allowed: ["mspAdmin"],
    request: async (ctx, _, account) => {
      await clear(ctx.api, ctx.admin, mspPath(ctx.mspId));
      return { method: "POST", path: mspPath(ctx.mspId), data: withMasterPassword(account, webhook(ctx.url)) };
    },
  },
  {
    name: "change the MSP's destination",
    allowed: ["mspAdmin"],
    request: async (ctx, _, account) => ({
      method: "PUT",
      path: `${mspPath(ctx.mspId)}/${await freshMsp(ctx)}`,
      data: withMasterPassword(account, { name: "Renamed" }),
    }),
  },
  {
    name: "test the MSP's destination",
    allowed: ["mspAdmin"],
    request: async (ctx) => ({ method: "POST", path: `${mspPath(ctx.mspId)}/${await freshMsp(ctx)}/test` }),
  },
  {
    name: "remove the MSP's destination",
    allowed: ["mspAdmin"],
    request: async (ctx) => {
      const id = await freshMsp(ctx);
      return {
        method: "DELETE",
        path: `${mspPath(ctx.mspId)}/${id}`,
        check: async (allowed) => {
          const left = await list(ctx.api, ctx.admin, mspPath(ctx.mspId));
          expect(left.some((d) => d.id === id)).toBe(!allowed);
        },
      };
    },
  },
  {
    // A technician is an admin in the client, but can't send its events anywhere.
    name: "manage a client's own destinations",
    allowed: ["mspAdmin", "clientOwner"],
    request: async (ctx, _, account) => {
      await clear(ctx.api, ctx.admin, orgPath(ctx.clientId));
      return { method: "POST", path: orgPath(ctx.clientId), data: withMasterPassword(account, webhook(ctx.url)) };
    },
  },
  {
    name: "see a client's own destinations",
    allowed: ["mspAdmin", "clientOwner"],
    request: async (ctx) => ({ method: "GET", path: orgPath(ctx.clientId) }),
  },
];

test.describe("Event streaming permissions in an MSP", () => {
  let receiver: Awaited<ReturnType<typeof httpsReceiver>>;
  test.beforeAll(async () => {
    receiver = await httpsReceiver(cert);
  });
  test.afterAll(async () => {
    await receiver.close();
  });
  permissionMatrix(
    MSP_ACTORS,
    async (api) => {
      const admin = await api.account("msp-admin");
      const mspId = await api.msp(admin, "Streaming MSP");
      const clientId = await api.client(admin, mspId, "Streaming Client");
      const technician = await api.account("technician");
      await api.addStaff(admin, mspId, technician, "technician");
      await api.confirmPending(admin, mspId);
      const clientOwner = await api.account("client-owner");
      await api.addMember(admin, clientId, clientOwner, "owner");
      const otherAdmin = await api.account("other-msp-admin");
      await api.msp(otherAdmin, "Other MSP");
      return {
        ctx: { api, mspId, clientId, admin, url: receiver.url("/msp-matrix") },
        callers: { mspAdmin: admin, technician, clientOwner, otherMspAdmin: otherAdmin, anonymous: null },
      };
    },
    mspRows,
  );
});

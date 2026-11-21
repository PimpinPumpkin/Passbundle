// Event streaming (DESIGN.md, "Sending events to security tools") across a
// server's restarts, and with two servers on one database. Events wait in
// the database (event_deliveries), delivery is at least once, and a worker
// holds a lease on a destination while it sends, so:
// - events that wait while a receiver is down are all sent, once each, after
//   the server is stopped and started again;
// - a server stopped normally in the middle of sending gives back its lease,
//   so once it's started again it sends again at once what it hadn't marked
//   sent, rather than after the lease would have run out;
// - a server killed in the middle of sending sends again, after a restart,
//   what it hadn't marked sent, once its lease runs out: what the receiver
//   never answered, and what it answered just before the kill, which then
//   arrives twice with the same id (receivers drop repeats by the id);
// - two servers on one database both send, and each event goes once, never
//   once per server.
// The restarts are on a server of these tests' own, which keeps its data
// (its SQLite file, or a PostgreSQL database of its own in the PostgreSQL
// job) and may send to 127.0.0.1 (server.mjs, KK_EVENT_STREAMING). The
// second server shares the main test server's database (its SQLite file, or
// PostgreSQL in the PostgreSQL job) and RSA key (KK_SHARES_DATABASE_OF).
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, request as apiRequest, test } from "@playwright/test";

import { port, streamingSecondServerPort, streamingServerPort } from "../../paths.mjs";

import {
  type Cert,
  type Received,
  httpsReceiver,
  parseSyslog,
  syslogReceiver,
  throwawayCert,
  verifyWebhook,
  waitFor,
} from "./siem";
import { type Account, Api, withMasterPassword } from "./support";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const cert: Cert = throwawayCert();

const orgPath = (orgId: string) => `/api/keykeeper/organizations/${orgId}/event-streaming`;

type Destination = {
  id: string;
  status: string;
  queued: number;
  failures: number;
  signingSecret?: string;
};

async function create(api: Api, who: Account, orgId: string, data: Record<string, unknown>): Promise<Destination> {
  const created = await api.call(who, "POST", orgPath(orgId), withMasterPassword(who, data));
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body;
}

/** How a destination is doing, as the console shows it. */
async function state(api: Api, who: Account, orgId: string, id: string) {
  const listed = await api.call(who, "GET", orgPath(orgId));
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const d = (listed.body.data as Destination[]).find((x) => x.id === id)!;
  return { status: d.status, queued: d.queued, failures: d.failures };
}

const webhook = (url: string) => ({ name: "SIEM webhook", kind: "webhook", webhook: { url, caCertificate: cert.cert } });

/** Renames an organization: one "Edited the organization's settings" event (1600). */
async function touch(api: Api, owner: Account, orgId: string, name: string) {
  const edited = await api.call(owner, "PUT", `/api/organizations/${orgId}`, { name, billingEmail: owner.email });
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
}

/** A port with nothing listening on it, for a receiver that's down. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const free = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

/**
 * A test server of these tests' own (server.mjs with `env`), which they stop
 * as an operator would, or freeze and kill as a crash would, and start again.
 */
class OwnServer {
  private launcher: ChildProcess | undefined;
  private dataDir: string | undefined;

  constructor(
    readonly port: string,
    private readonly env: Record<string, string>,
    private readonly keepsData: boolean,
  ) {}

  get url() {
    return `https://127.0.0.1:${this.port}`;
  }

  async start() {
    if (this.keepsData) {
      this.dataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-streaming-"));
    }
    const launcher = spawn(process.execPath, ["server.mjs"], {
      cwd: e2eDir,
      env: {
        ...process.env,
        ...this.env,
        KK_PORT: this.port,
        ...(this.dataDir ? { KK_DATA_DIR: this.dataDir } : {}),
      },
      stdio: "ignore",
    });
    this.launcher = launcher;
    const http = await apiRequest.newContext({ baseURL: this.url, ignoreHTTPSErrors: true });
    try {
      await expect
        .poll(
          async () => {
            expect(launcher.exitCode, "the server stopped while starting").toBeNull();
            return (await http.get("/alive").catch(() => null))?.status() ?? 0;
          },
          { timeout: 60_000 },
        )
        .toBe(200);
    } finally {
      await http.dispose();
    }
  }

  /** A fresh connection to it (after a restart, the old one's are gone). */
  request(): Promise<APIRequestContext> {
    return apiRequest.newContext({ baseURL: this.url, ignoreHTTPSErrors: true });
  }

  /** The server's own process, not its launcher's. */
  private pid(): number {
    return Number(fs.readFileSync(path.join(os.tmpdir(), `keykeeper-e2e-pid-${this.port}`), "utf8"));
  }

  /** Stops it as an operator would: SIGTERM, and it shuts down. */
  async stop() {
    const launcher = this.launcher;
    if (!launcher) {
      return;
    }
    this.launcher = undefined;
    const exited = new Promise((resolve) => launcher.once("exit", resolve));
    try {
      // In case it's frozen.
      process.kill(this.pid(), "SIGCONT");
    } catch {
      // Already gone.
    }
    launcher.kill("SIGTERM");
    await exited;
  }

  /** Freezes it mid-whatever-it's-doing: it reads and writes nothing until killed. */
  freeze() {
    process.kill(this.pid(), "SIGSTOP");
  }

  /** Kills it as a crash would: nothing it was doing finishes. */
  async kill() {
    const launcher = this.launcher!;
    this.launcher = undefined;
    const exited = new Promise((resolve) => launcher.once("exit", resolve));
    process.kill(this.pid(), "SIGKILL");
    await exited;
  }

  /** Stops it and removes its data. */
  async remove() {
    await this.stop();
    if (this.dataDir) {
      fs.rmSync(this.dataDir, { recursive: true, force: true });
      this.dataDir = undefined;
    }
  }
}

type Request = Received & {
  /** When it arrived (this machine's clock). */
  at: number;
  /** The status it was answered with, once the answer was handed to the network. */
  answered?: number;
  answer: (status: number) => Promise<void>;
};

/**
 * A webhook receiver that answers 200 at once, or, while holding, keeps each
 * request waiting until the test answers it.
 */
async function holdingReceiver() {
  const requests: Request[] = [];
  let holding = false;
  const server = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const r: Request = {
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        at: Date.now(),
        answer: (status) =>
          new Promise<void>((resolve) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end("", () => {
              r.answered = status;
              resolve();
            });
          }),
      };
      requests.push(r);
      if (!holding) {
        void r.answer(200);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const listeningOn = (server.address() as AddressInfo).port;
  return {
    requests,
    url: (p: string) => `https://127.0.0.1:${listeningOn}${p}`,
    /** Of one type, in the order they arrived. */
    ofType: (type: number) => requests.filter((r) => JSON.parse(r.body).type === type),
    hold: () => {
      holding = true;
    },
    answerAtOnce: () => {
      holding = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test.describe("Event streaming across a restart", () => {
  test("events that wait while a receiver is down, through a restart, all arrive once it's back, each once", async () => {
    test.setTimeout(180_000);
    const server = new OwnServer(streamingServerPort, { KK_EVENT_STREAMING: "1" }, true);
    await server.start();
    const down = await freePort();
    let http = await server.request();
    let receiver: Awaited<ReturnType<typeof httpsReceiver>> | undefined;
    try {
      let api = new Api(http);
      const owner = await api.account("restart-owner");
      const orgId = await api.organization(owner, "Tailspin");
      const d = await create(api, owner, orgId, webhook(`https://127.0.0.1:${down}/events`));
      for (const name of ["Tailspin 1", "Tailspin 2", "Tailspin 3"]) {
        await touch(api, owner, orgId, name);
      }
      // Nothing gets through: "added" and the three renames wait.
      await expect
        .poll(async () => {
          const now = await state(api, owner, orgId, d.id);
          return [now.status, now.queued];
        })
        .toEqual(["failing", 4]);

      await server.stop();
      receiver = await httpsReceiver(cert, () => ({ status: 200 }), down);
      await server.start();
      await http.dispose();
      http = await server.request();
      api = new Api(http);

      const sent = () => receiver!.received.map((r) => verifyWebhook(r, d.signingSecret!));
      await waitFor(receiver.received, (all) => (all.length >= 4 ? all : undefined), "the events that waited", 60_000);
      await expect
        .poll(async () => {
          const now = await state(api, owner, orgId, d.id);
          return [now.status, now.queued];
        })
        .toEqual(["on", 0]);
      // Each once: none had been taken before the restart, and each was
      // taken once after it.
      const events = sent();
      expect(events.map((e) => `${e.type} ${e.organization.name}`).sort()).toEqual([
        "1600 Tailspin 1",
        "1600 Tailspin 2",
        "1600 Tailspin 3",
        "1690 Tailspin",
      ]);
      expect(new Set(events.map((e) => e.id)).size).toBe(4);
    } finally {
      await http.dispose();
      await receiver?.close();
      await server.remove();
    }
  });

  test("a server stopped normally mid-send gives back its lease, so once started again it sends again at once", async () => {
    test.setTimeout(180_000);
    const server = new OwnServer(streamingServerPort, { KK_EVENT_STREAMING: "1" }, true);
    await server.start();
    const receiver = await holdingReceiver();
    let http = await server.request();
    try {
      let api = new Api(http);
      const owner = await api.account("stop-owner");
      const orgId = await api.organization(owner, "Fabrikam");
      const d = await create(api, owner, orgId, webhook(receiver.url("/events")));
      await waitFor(receiver.requests, () => receiver.ofType(1690).filter((x) => x.answered === 200), "the 'added' event");

      // A rename, and the destination's turn starts: its request waits at
      // the receiver, and the server holds the destination's lease.
      receiver.hold();
      await touch(api, owner, orgId, "Fabrikam 2");
      const [first] = await waitFor(receiver.requests, () => receiver.ofType(1600), "the rename, held");

      // Stopped as an operator would (SIGTERM), while that request waits:
      // the send is cut off, so the rename isn't marked sent.
      await server.stop();
      receiver.answerAtOnce();
      await server.start();
      await http.dispose();
      http = await server.request();
      api = new Api(http);

      // It comes again soon after the restart, not once a two-minute lease
      // would have run out, as after a crash.
      const again = await waitFor(
        receiver.requests,
        () => receiver.ofType(1600).filter((r) => r.answered === 200),
        "the rename, again",
        60_000,
      );
      expect(again).toHaveLength(1);
      expect(first.answered).toBeUndefined();
      expect(again[0].at - first.at).toBeLessThan(60_000);
      // The same event, with the same id, so a receiver that drops repeats
      // keeps one.
      expect(again[0].headers["webhook-id"]).toBe(first.headers["webhook-id"]);
      const resent = verifyWebhook(again[0], d.signingSecret!);
      expect(resent).toEqual(verifyWebhook(first, d.signingSecret!));
      expect(resent).toMatchObject({ type: 1600, organization: { name: "Fabrikam 2" } });
      await expect
        .poll(async () => {
          const now = await state(api, owner, orgId, d.id);
          return [now.status, now.queued, now.failures];
        })
        .toEqual(["on", 0, 0]);
      expect(receiver.ofType(1600)).toHaveLength(2);
      expect(receiver.ofType(1690)).toHaveLength(1);
    } finally {
      await http.dispose();
      await server.remove();
      await receiver.close();
    }
  });

  test("a server killed mid-send sends again what it hadn't marked sent, once its lease runs out, with the same id", async () => {
    // The restarted server waits out the lease the killed one held (two
    // minutes), so this test takes that long.
    test.setTimeout(300_000);
    const server = new OwnServer(streamingServerPort, { KK_EVENT_STREAMING: "1" }, true);
    await server.start();
    // One receiver that never answers before the kill, and one that answers
    // while the server is frozen, so the server never reads that answer.
    const unanswered = await holdingReceiver();
    const answered = await holdingReceiver();
    let http = await server.request();
    try {
      let api = new Api(http);
      const owner = await api.account("crash-owner");
      const wingtip = await api.organization(owner, "Wingtip");
      const litware = await api.organization(owner, "Litware");
      const toUnanswered = await create(api, owner, wingtip, webhook(unanswered.url("/events")));
      const toAnswered = await create(api, owner, litware, webhook(answered.url("/events")));
      for (const r of [unanswered, answered]) {
        await waitFor(r.requests, () => r.ofType(1690).filter((x) => x.answered === 200), "the 'added' event");
      }

      // A rename in each, and each destination's turn starts: its request
      // waits at its receiver (well within the 10 seconds a webhook gets).
      unanswered.hold();
      answered.hold();
      await touch(api, owner, wingtip, "Wingtip 2");
      await touch(api, owner, litware, "Litware 2");
      const [first] = await waitFor(unanswered.requests, () => unanswered.ofType(1600), "the rename, held");
      const [acknowledged] = await waitFor(answered.requests, () => answered.ofType(1600), "the other rename, held");

      // Frozen: one receiver answers 200, which the server never reads.
      // Then killed, before it could mark either rename sent.
      server.freeze();
      await acknowledged.answer(200);
      await server.kill();

      unanswered.answerAtOnce();
      answered.answerAtOnce();
      await server.start();
      await http.dispose();
      http = await server.request();
      api = new Api(http);

      // Both renames come again, once the lease the killed server held runs
      // out (whoever holds a lease may still be sending, so nobody else
      // sends until it ends).
      const again = await waitFor(
        unanswered.requests,
        () => unanswered.ofType(1600).filter((r) => r.answered === 200),
        "the unanswered rename, again",
        180_000,
      );
      const twice = await waitFor(
        answered.requests,
        () => {
          const renames = answered.ofType(1600).filter((r) => r.answered === 200);
          return renames.length >= 2 ? renames : undefined;
        },
        "the answered rename, again",
        180_000,
      );
      for (const [org, d] of [
        [wingtip, toUnanswered],
        [litware, toAnswered],
      ] as const) {
        await expect
          .poll(async () => {
            const now = await state(api, owner, org, d.id);
            return [now.status, now.queued, now.failures];
          })
          .toEqual(["on", 0, 0]);
      }

      // What the receiver never answered arrives once more, the same event.
      expect(unanswered.ofType(1600)).toHaveLength(2);
      expect(first.answered).toBeUndefined();
      expect(again).toHaveLength(1);
      const resent = verifyWebhook(again[0], toUnanswered.signingSecret!);
      expect(resent).toEqual(verifyWebhook(first, toUnanswered.signingSecret!));
      expect(resent).toMatchObject({ type: 1600, organization: { name: "Wingtip 2" } });
      expect(again[0].at - first.at).toBeGreaterThan(110_000);

      // What it answered just before the kill arrives a second time (at
      // least once, as the design says): the same id in webhook-id and the
      // body, so a receiver that drops repeats by id keeps one.
      expect(twice).toHaveLength(2);
      const [one, two] = twice.map((r) => verifyWebhook(r, toAnswered.signingSecret!));
      expect(twice[0]).toBe(acknowledged);
      expect(twice[1].headers["webhook-id"]).toBe(twice[0].headers["webhook-id"]);
      expect(two).toEqual(one);
      expect(two).toMatchObject({ type: 1600, organization: { name: "Litware 2" } });
      expect(twice[1].at - twice[0].at).toBeGreaterThan(110_000);
      // The events before were sent once.
      expect(unanswered.ofType(1690)).toHaveLength(1);
      expect(answered.ofType(1690)).toHaveLength(1);
    } finally {
      await http.dispose();
      await server.remove();
      await unanswered.close();
      await answered.close();
    }
  });
});

test("two servers on one database both send, and each event goes once, never once per server", async ({
  request,
}) => {
  test.setTimeout(300_000);
  // A second server on the main one's database, under another name: syslog's
  // HOSTNAME says which server sent each message.
  const second = new OwnServer(
    streamingSecondServerPort,
    { KK_SHARES_DATABASE_OF: port, KK_DOMAIN: `https://localhost:${streamingSecondServerPort}` },
    false,
  );
  // Each send takes at least a second and a half, and each server sends to
  // at most two of one person's destinations at once, so with twelve the
  // main server can't take every turn before the second one looks for work
  // (every five seconds).
  const collector = await syslogReceiver(cert, { handshakeDelayMs: 1500 });
  await second.start();
  try {
    const api = new Api(request);
    const owner = await api.account("two-servers");
    const orgs: string[] = [];
    const expected = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const orgId = await api.organization(owner, `Adventure Works ${i}`);
      await create(api, owner, orgId, {
        name: "Syslog",
        kind: "syslog",
        syslog: { host: "127.0.0.1", port: collector.port, format: "json", caCertificate: cert.cert },
      });
      orgs.push(orgId);
      expected.add(`${orgId} 1690`);
    }
    for (let round = 1; round <= 4; round++) {
      for (const [i, orgId] of orgs.entries()) {
        const name = `Adventure Works ${i}.${round}`;
        await touch(api, owner, orgId, name);
        expected.add(`${orgId} 1600 ${name}`);
      }
    }

    const arrived = () =>
      collector.messages.map((text) => {
        const m = parseSyslog(text);
        const event = JSON.parse(m.message);
        const key =
          event.type === 1690
            ? `${event.organization.id} 1690`
            : `${event.organization.id} ${event.type} ${event.organization.name}`;
        return { host: m.host, id: event.id as string, key };
      });
    await expect
      .poll(() => [...expected].filter((k) => !arrived().some((a) => a.key === k)), {
        message: "events that never arrived",
        timeout: 120_000,
      })
      .toEqual([]);
    // Nothing waits any more, and nothing is still being sent.
    await expect
      .poll(
        async () => {
          for (const orgId of orgs) {
            const listed = await api.call(owner, "GET", orgPath(orgId));
            if ((listed.body.data as Destination[]).some((d) => d.queued > 0)) {
              return "events waiting";
            }
          }
          return collector.open() > 0 ? "a send under way" : "done";
        },
        { timeout: 60_000 },
      )
      .toBe("done");

    const all = arrived();
    const seen = new Map<string, number>();
    for (const a of all) {
      seen.set(a.id, (seen.get(a.id) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1), "events sent more than once").toEqual([]);
    expect(all.filter((a) => expected.has(a.key))).toHaveLength(expected.size);
    // Both servers sent some.
    expect([...new Set(all.map((a) => a.host))].sort()).toEqual(["127.0.0.1", "localhost"]);
  } finally {
    await second.remove();
    await collector.close();
  }
});

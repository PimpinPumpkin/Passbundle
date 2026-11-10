// For the tests of what a server says when it isn't taking new accounts
// (DESIGN.md, "New accounts on a closed server"): a server of their own,
// which they start again with other sign-up settings over the same data, so
// accounts made while it was open are still there once it's closed.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, request as apiRequest } from "@playwright/test";

import { closedServerPort } from "../../paths.mjs";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const closedServer = `https://127.0.0.1:${closedServerPort}`;

/** Who can make an account: anyone, nobody, or addresses at some email domains. */
export type SignUps = "open" | "closed" | { domains: string[] };

export type Settings = {
  /** Whether the server sends email (to the mail catcher). */
  mail: boolean;
  /** Whether the sign-up form's first step sends its link by email. */
  verify?: boolean;
};

export class ClosedServer {
  private child: ChildProcess | undefined;
  private dataDir: string | undefined;

  /** Starts the server with these settings over the same data, stopping it first if it's running. */
  async start(signUps: SignUps, settings: Settings) {
    await this.stop();
    this.dataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-closed-"));
    this.child = spawn(process.execPath, ["server.mjs"], {
      cwd: e2eDir,
      env: {
        ...process.env,
        KK_PORT: closedServerPort,
        KK_DATA_DIR: this.dataDir,
        ...(settings.mail ? { KK_MAIL: "1" } : {}),
        ...(settings.verify ? { KK_SIGNUPS_VERIFY: "1" } : {}),
        KK_SIGNUPS: signUps === "open" ? "open" : "closed",
        KK_SIGNUPS_DOMAINS: typeof signUps === "string" ? "" : signUps.domains.join(","),
      },
      stdio: "ignore",
    });
    const http = await apiRequest.newContext({ baseURL: closedServer, ignoreHTTPSErrors: true });
    try {
      await expect
        .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
        .toBe(200);
    } finally {
      await http.dispose();
    }
  }

  async stop() {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }

  /** Stops the server and removes its data. */
  async remove() {
    await this.stop();
    if (this.dataDir) {
      fs.rmSync(this.dataDir, { recursive: true, force: true });
      this.dataDir = undefined;
    }
  }
}

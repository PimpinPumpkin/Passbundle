// For the tests of MSPs signing up by themselves (DESIGN.md, "MSP console",
// "Getting there"): a server of their own that doesn't let anyone set up an
// MSP (MSP_SIGNUPS_ALLOWED off, as on a server someone runs for themselves),
// where every other test server allows it, as the hosted service does. It
// takes new accounts and sends no email, like the main test server.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, request as apiRequest } from "@playwright/test";

import { mspSignupsOffServerPort } from "../../paths.mjs";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const mspSignupsOffServer = `https://127.0.0.1:${mspSignupsOffServerPort}`;

/** The server's sentence where someone would set up an MSP. */
export const SET_UP_REFUSED = "This server doesn't allow setting up an MSP. Ask the person who runs it.";

export class MspSignupsOffServer {
  private child: ChildProcess | undefined;
  private dataDir: string | undefined;

  async start() {
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-msp-signups-off-"));
    this.child = spawn(process.execPath, ["server.mjs"], {
      cwd: e2eDir,
      env: {
        ...process.env,
        KK_PORT: mspSignupsOffServerPort,
        KK_DATA_DIR: this.dataDir,
        KK_MSP_SIGNUPS: "off",
      },
      stdio: "ignore",
    });
    const http = await apiRequest.newContext({ baseURL: mspSignupsOffServer, ignoreHTTPSErrors: true });
    try {
      await expect
        .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
        .toBe(200);
    } finally {
      await http.dispose();
    }
  }

  /** Stops the server and removes its data. */
  async remove() {
    const child = this.child;
    this.child = undefined;
    if (child) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    if (this.dataDir) {
      fs.rmSync(this.dataDir, { recursive: true, force: true });
      this.dataDir = undefined;
    }
  }
}

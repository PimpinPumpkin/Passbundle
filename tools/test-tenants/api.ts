// The server's API as the test tenants tool calls it: signing in as a
// command-line tool, and requests with an account's session. Errors say what
// was asked and what the server answered, never what was sent.
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

import type { APIRequestContext, APIResponse } from "@playwright/test";

// Playwright's HTTP client, from the end-to-end tests' packages: the crypto
// helpers this tool shares with them take its request contexts.
const requireFromE2e = createRequire(new URL("../../e2e/package.json", import.meta.url));
const playwright = requireFromE2e("@playwright/test") as typeof import("@playwright/test");

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(what: string, status: number, body: any) {
    const said =
      typeof body === "object" && body
        ? (body.message ?? body.error_description ?? body.errorModel?.message ?? body.error ?? "")
        : String(body ?? "").slice(0, 200);
    super(`${what}: ${status}${said ? ` (${said})` : ""}`);
    this.status = status;
    this.body = body;
  }
}

/** Someone's sign-in details, as the state file keeps them. */
export type Credentials = {
  name: string;
  email: string;
  /** What the apps send for the master password: its hash. */
  passwordHash: string;
  /** This tool's device for the account. */
  device: string;
  /** What the server gave this device: the new-device check's token, or two-step login's "remember" token. */
  deviceToken?: string;
  totpKey?: string;
  /** The last 30-second step whose code the server took. */
  totpStep?: number;
};

export type Session = { token: string };

// The CLI's device types (upstream's DeviceType): the server never lets one
// approve another device's sign-in (DESIGN.md, "New-device check").
const CLI_DEVICE_TYPE = process.platform === "win32" ? "23" : process.platform === "darwin" ? "24" : "25";

async function parse(response: APIResponse): Promise<any> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** The code for an authenticator key at a time (RFC 6238: SHA-1, 30 seconds, 6 digits). */
export function totp(base32Key: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32Key.replace(/=+$/, "").replace(/\s/g, "").toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

export const stepOf = (ms: number) => Math.floor(ms / 30_000);

/**
 * A code the server hasn't taken from this account yet: the current step's,
 * or the next one's (the server allows one step of drift), waiting for the
 * next step when both are used. Records the step it used.
 */
export async function freshCode(who: Credentials): Promise<string> {
  let step = Math.max(stepOf(Date.now()), (who.totpStep ?? -1) + 1);
  while (step > stepOf(Date.now()) + 1) {
    await sleep(1_000);
  }
  step = Math.max(step, stepOf(Date.now()));
  who.totpStep = step;
  return totp(who.totpKey!, step * 30_000 + 1_000);
}

export class NewDeviceHeld extends Error {}

export class Api {
  readonly http: APIRequestContext;
  readonly origin: string;

  private constructor(http: APIRequestContext, origin: string) {
    this.http = http;
    this.origin = origin;
  }

  /** A client for a server; a local one's own certificate is taken as it is. */
  static async open(origin: string, local: boolean): Promise<Api> {
    const http = await playwright.request.newContext({
      baseURL: origin,
      ignoreHTTPSErrors: local,
      timeout: 60_000,
    });
    return new Api(http, origin);
  }

  async close() {
    await this.http.dispose();
  }

  /**
   * Sends a request, waiting and trying again while the server says too many
   * requests (its login and signup limits), up to about two minutes.
   */
  private async send(make: () => Promise<APIResponse>): Promise<APIResponse> {
    for (let attempt = 0; ; attempt++) {
      const response = await make();
      if (response.status() !== 429 || attempt >= 20) {
        return response;
      }
      await sleep(6_000);
    }
  }

  /** Calls the API as someone (or no one) and returns the parsed answer, or throws. */
  async call(
    as: Session | null,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    data?: unknown,
    what = `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>")}`,
  ): Promise<any> {
    const response = await this.send(() =>
      this.http.fetch(path, {
        method,
        data,
        headers: as ? { Authorization: `Bearer ${as.token}` } : {},
      }),
    );
    const body = await parse(response);
    if (!response.ok()) {
      throw new ApiError(what, response.status(), body);
    }
    return body;
  }

  /** Whether the server answers at all. */
  async alive(): Promise<boolean> {
    try {
      return (await this.http.get("/alive")).ok();
    } catch {
      return false;
    }
  }

  private async tokenRequest(who: Credentials, extra: Record<string, string>) {
    const response = await this.send(() =>
      this.http.post("/identity/connect/token", {
        form: {
          grant_type: "password",
          username: who.email,
          password: who.passwordHash,
          scope: "api offline_access",
          client_id: "cli",
          deviceType: CLI_DEVICE_TYPE,
          deviceIdentifier: who.device,
          deviceName: "test-tenants",
          ...extra,
        },
      }),
    );
    return { status: response.status(), body: await parse(response) };
  }

  /**
   * Signs in as someone from this tool's device for them: with the token the
   * server gave the device last time, else with a fresh two-step code. Keeps
   * whatever token the server gives back for next time.
   */
  async signIn(who: Credentials): Promise<Session> {
    let answer = await this.tokenRequest(
      who,
      who.deviceToken ? { twoFactorProvider: "5", twoFactorToken: who.deviceToken } : {},
    );
    const twoStepAsked = (a: { status: number; body: any }) =>
      a.status === 400 && a.body && typeof a.body === "object" && a.body.TwoFactorProviders2 != null;
    if (twoStepAsked(answer) && who.totpKey) {
      answer = await this.tokenRequest(who, {
        twoFactorProvider: "0",
        twoFactorToken: await freshCode(who),
        twoFactorRemember: "1",
      });
    }
    if (answer.status === 200) {
      if (typeof answer.body?.TwoFactorToken === "string") {
        who.deviceToken = answer.body.TwoFactorToken;
      }
      return { token: answer.body.access_token };
    }
    if (answer.body && typeof answer.body === "object" && answer.body.KeykeeperNewDeviceCheck) {
      throw new NewDeviceHeld(
        `The server holds ${who.name}'s sign-in from this computer for the new-device check (this computer's record of the device is gone or out of date)`,
      );
    }
    throw new ApiError(`Signing in as ${who.name}`, answer.status, answer.body);
  }
}

// A server of its own for tests of what the apps show on each plan (DESIGN.md,
// "Plans and billing"), with the admin page on so the operator can set and
// take away plans. As the API tests' (tests/api/plans.spec.ts), it takes an
// admin token made up for the run and kept in memory only, and its data lives
// in a directory of its own, removed when it stops.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, type Page } from "@playwright/test";

import { newItem } from "./web";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DAY = 86_400_000;

/** A moment this far from now, to the second, as the operator's route takes dates. */
const fromNow = (ms: number) => new Date(Math.floor((Date.now() + ms) / 1000) * 1000).toISOString();

/** The operator, signed in to one server's admin page. */
export class Operator {
  constructor(private readonly http: APIRequestContext) {}

  /** The id of the account with this email address. */
  async userId(email: string): Promise<string> {
    const users = await this.http.get("/admin/users");
    expect(users.status(), "the admin page's list of accounts").toBe(200);
    const found = ((await users.json()) as { id: string; email: string }[]).find(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    );
    expect(found, `an account for ${email}`).toBeTruthy();
    return found!.id;
  }

  /** Gives a person Premium, paid for a month ahead. */
  async givePremium(email: string) {
    const id = await this.userId(email);
    const written = await this.http.post(`/admin/plans/users/${id}`, {
      data: { plan: "premium", standing: "until", until: fromNow(30 * DAY), renews: true },
    });
    expect(written.status(), await written.text()).toBe(200);
  }

  /** Takes a person's plan away, which leaves them on Free. */
  async takePlanAway(email: string) {
    const id = await this.userId(email);
    const removed = await this.http.post(`/admin/plans/users/${id}/remove`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(removed.status(), await removed.text()).toBe(200);
  }

  async dispose() {
    await this.http.dispose();
  }
}

export type PlansServer = {
  url: string;
  operator: Operator;
  stop(): Promise<void>;
};

/**
 * Starts a server on a port of its own, with plans enforced or not, and signs
 * the operator in to its admin page.
 */
export async function startPlansServer(
  playwright: { request: { newContext(options: object): Promise<APIRequestContext> } },
  port: string,
  enforced: boolean,
): Promise<PlansServer> {
  const adminToken = randomBytes(32).toString("base64url");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-plans-ui-"));
  const child: ChildProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: port,
      KK_DATA_DIR: dataDir,
      KK_ADMIN_TOKEN: adminToken,
      ...(enforced ? { KK_PLANS_ENFORCED: "1" } : {}),
    },
    stdio: "ignore",
  });
  const url = `https://127.0.0.1:${port}`;
  const http = await playwright.request.newContext({ baseURL: url, ignoreHTTPSErrors: true });
  await expect
    .poll(async () => (await http.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
    .toBe(200);
  const signedIn = await http.post("/admin", { form: { token: adminToken } });
  expect(signedIn.status(), "the operator's sign-in to the admin page").toBe(200);
  const operator = new Operator(http);
  return {
    url,
    operator,
    async stop() {
      await operator.dispose();
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Saves a login in the web vault, which opens its view, and closes the view. */
export async function saveLogin(page: Page, name: string) {
  await newItem(page, "Login");
  const create = page.getByRole("dialog", { name: "Add login" });
  await create.getByRole("textbox", { name: /Item name/ }).fill(name);
  await create.getByRole("button", { name: "Save" }).click();
  await expect(create).toBeHidden();
  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view).toBeVisible();
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

/** Opens a login's attachments in the web vault, from its edit window, which it returns. */
export async function openAttachments(page: Page, name: string) {
  await page.getByText(name, { exact: true }).first().click();
  const view = page.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: /Edit login/i });
  await edit.getByRole("button", { name: /^Attachments/ }).click();
  return edit;
}

/** Attaches a small text file to a login in the web vault, through its edit window. */
export async function attachFile(page: Page, name: string, fileName: string) {
  const edit = await openAttachments(page, name);
  const adding = page.getByRole("dialog", { name: "Add attachment" });
  await adding.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from(`The contents of ${fileName}.`),
  });
  await adding.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText("Attachment saved")).toBeVisible();
  await expect(adding).toBeHidden();
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeHidden();
}

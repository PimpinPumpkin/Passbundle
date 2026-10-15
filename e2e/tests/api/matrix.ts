// Permission matrices: each row is one request and the callers allowed to make
// it; every other caller must be refused, and for requests that change
// something, the change must happen only when allowed. Every row needs someone
// allowed, which proves the request itself is valid, so a refusal can't come
// from a malformed request.
import { type APIRequestContext, expect, test } from "@playwright/test";

import { port } from "../../paths.mjs";

import { type Account, Api, type Result } from "./support";

export type MatrixRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  data?: unknown;
  /** Checks the effect after the call, given whether it was allowed. */
  check?: (allowed: boolean) => Promise<void>;
};

export type MatrixRow<A extends string, C> = {
  name: string;
  allowed: readonly A[];
  /** A fresh request for one caller, with anything it needs set up first. */
  request: (
    ctx: C,
    caller: A,
    account: Account | null,
  ) => Promise<MatrixRequest>;
};

/** Refused: not logged in, forbidden, or not found, never a success or a malformed request. */
export function expectRefused(result: Result, label: string) {
  const message = String(result.body?.message ?? "");
  const refused =
    [401, 403, 404].includes(result.status) ||
    (result.status === 400 &&
      /permission|not found|not allowed|access|only|no rights|not owned|can't be deleted/i.test(
        message,
      ));
  expect(
    refused,
    `${label}: expected a refusal, got ${result.status} ${message}`,
  ).toBe(true);
}

export function permissionMatrix<A extends string, C extends { api: Api }>(
  actors: readonly A[],
  setup: (api: Api) => Promise<{ ctx: C; callers: Record<A, Account | null> }>,
  rows: MatrixRow<A, C>[],
) {
  let request: APIRequestContext;
  let ctx: C;
  let callers: Record<A, Account | null>;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(180_000);
    request = await playwright.request.newContext({
      baseURL: `https://127.0.0.1:${port}`,
      ignoreHTTPSErrors: true,
    });
    ({ ctx, callers } = await setup(new Api(request)));
  });

  test.afterAll(async () => {
    await request.dispose();
  });

  for (const row of rows) {
    test(row.name, async () => {
      test.setTimeout(180_000);
      expect(
        row.allowed.length,
        "every row needs someone allowed",
      ).toBeGreaterThan(0);
      for (const actor of actors) {
        const allowed = row.allowed.includes(actor);
        const { check, ...req } = await row.request(ctx, actor, callers[actor]);
        const result = await ctx.api.call(
          callers[actor],
          req.method,
          req.path,
          req.data,
        );
        const label = `${actor} ${req.method} ${req.path}`;
        if (allowed) {
          expect(
            result.status,
            `${label}: ${JSON.stringify(result.body)}`,
          ).toBe(200);
        } else {
          expectRefused(result, label);
        }
        await check?.(allowed);
      }
    });
  }
}

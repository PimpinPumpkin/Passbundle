// The server's mirror of a site rules feed (DESIGN.md, "Fill rules for
// everyone", "Shipping: a signed feed"): who may read it. It's the same for
// everyone signed in to the server, whatever their role, and nothing for
// anyone else. The test servers mirror no feed (SITE_RULES_FEED=none, so none
// fetches PassBundle's from the internet); the mirror with a feed is
// tests/site-rules.spec.ts, end to end.
import { expect, test } from "@playwright/test";

import { type MatrixRow, permissionMatrix } from "./matrix";
import { type Account, Api } from "./support";

test("a server that mirrors no feed says so, and has no files", async ({ request }) => {
  const api = new Api(request);
  const person = await api.account("rules-none");
  const source = await api.call(person, "GET", "/api/keykeeper/site-rules");
  expect(source.status).toBe(200);
  expect(source.body).toEqual({ feed: "none" });
  for (const name of ["manifest.json", "manifest.json.sig", "forms-0123456789abcdef.json", "..%2Fconfig.json"]) {
    expect((await api.call(person, "GET", `/api/keykeeper/site-rules/${name}`)).status, name).toBe(404);
  }
});

test.describe("Site rules feed permissions", () => {
  type Actor = "owner" | "admin" | "manager" | "user" | "otherOrg" | "noOrg" | "anonymous";
  type Context = { api: Api };
  const everyone: Actor[] = ["owner", "admin", "manager", "user", "otherOrg", "noOrg"];
  const rows: MatrixRow<Actor, Context>[] = [
    {
      name: "see whose site rules feed the server mirrors",
      allowed: everyone,
      request: async () => ({ method: "GET", path: "/api/keykeeper/site-rules" }),
    },
  ];
  permissionMatrix<Actor, Context>(
    [...everyone, "anonymous"],
    async (api) => {
      const owner = await api.account("rules-owner");
      const orgId = await api.organization(owner, "Rules Org");
      const member = async (prefix: string, type: "admin" | "manager" | "user"): Promise<Account> => {
        const account = await api.account(prefix);
        await api.addMember(owner, orgId, account, type);
        return account;
      };
      const otherOwner = await api.account("rules-other-owner");
      const otherOrg = await api.organization(otherOwner, "Other Rules Org");
      const otherMember = await api.account("rules-other-member");
      await api.addMember(otherOwner, otherOrg, otherMember, "user");
      return {
        ctx: { api },
        callers: {
          owner,
          admin: await member("rules-admin", "admin"),
          manager: await member("rules-manager", "manager"),
          user: await member("rules-user", "user"),
          otherOrg: otherMember,
          noOrg: await api.account("rules-no-org"),
          anonymous: null,
        },
      };
    },
    rows,
  );
});

test("someone not signed in gets no file either", async ({ request }) => {
  const api = new Api(request);
  expect((await api.call(null, "GET", "/api/keykeeper/site-rules/manifest.json")).status).toBe(401);
});

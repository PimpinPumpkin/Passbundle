// Site fixes on the server that sends email (DESIGN.md, "Site fixes
// (opt-in)"): a fix fills for everyone once three different people who
// verified their email addresses shared it, each counted once. Someone who
// hasn't verified isn't counted, so accounts made for it can't push a fix
// through.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type Account, Api } from "../api/support";

import { verifyEmail } from "./mailbox";

const fixFor = (host: string) => ({
  host,
  field: { id: "username", name: "username", label: "username" },
  fill: "never",
});

test("a fix fills for everyone once three people with verified email addresses shared it, each counted once", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const host = `fix-${randomUUID().slice(0, 8)}.example.test`;
  const fix = fixFor(host);
  const [ana, ben, cy, dee, unverified] = await Promise.all(
    ["ana", "ben", "cy", "dee", "unverified"].map((n) => api.account(`fix-${n}`)),
  );
  for (const who of [ana, ben, cy]) {
    await verifyEmail(api, who);
  }
  const share = async (who: Account) => {
    const shared = await api.call(who, "POST", "/api/keykeeper/site-fixes", fix);
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    return shared.body;
  };
  const listed = async () =>
    ((await api.call(dee, "GET", "/api/keykeeper/site-fixes")).body.fixes as { host: string }[]).filter(
      (f) => f.host === host,
    );

  expect(await share(ana)).toEqual({ applies: false, counted: true });
  // The same person again still counts once.
  expect(await share(ana)).toEqual({ applies: false, counted: true });
  expect(await share(ben)).toEqual({ applies: false, counted: true });
  // Someone who hasn't verified their address doesn't make the third.
  expect(await share(unverified)).toEqual({ applies: false, counted: false });
  expect(await listed()).toEqual([]);
  expect(await share(cy)).toEqual({ applies: true, counted: true });
  expect(await listed()).toEqual([fix]);
});

// The change-password page lookup upstream's apps ask the icons service for
// (DESIGN.md, "Health (better than Watchtower)"). The test server has icon
// downloads off, so it must never reach a site: it answers null for anything,
// which sends the apps to the site itself. The server's unit tests cover the
// standard's check, which websites and ports it may reach, and that people
// asking about one site at once share one lookup.
import { expect, test } from "@playwright/test";

import { limitsServerPort } from "../../paths.mjs";

test("the change-password lookup answers null, without reaching sites, when icon downloads are off", async ({
  request,
}) => {
  for (const uri of [
    "https://example.com/login",
    "example.com",
    "https://127.0.0.1/",
    "androidapp://com.example.app",
    "not a website",
  ]) {
    const response = await request.get(`/icons/change-password-uri?uri=${encodeURIComponent(uri)}`);
    expect(response.status(), uri).toBe(200);
    expect(await response.json(), uri).toEqual({ uri: null });
  }
  const withoutUri = await request.get("/icons/change-password-uri");
  expect(withoutUri.status()).toBe(200);
  expect(await withoutUri.json()).toEqual({ uri: null });
});

// Anyone may ask, as for icons, so an address gets 30 answers at once and
// then one every 2 seconds. On the server that keeps real limits, so other
// tests asking here can't run into it.
test.describe("on the server that keeps real limits", () => {
  test.use({ baseURL: `https://127.0.0.1:${limitsServerPort}` });

  test("one address gets 30 lookups at once, then waits", async ({ request }) => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const site = `https://site-${i}.example.com:8443/login`;
      statuses.push((await request.get(`/icons/change-password-uri?uri=${encodeURIComponent(site)}`)).status());
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

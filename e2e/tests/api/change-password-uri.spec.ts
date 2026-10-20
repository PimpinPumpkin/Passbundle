// The change-password page lookup upstream's apps ask the icons service for
// (DESIGN.md, "Health (better than Watchtower)"). The test server has icon
// downloads off, so it must never reach a site: it answers null for anything,
// which sends the apps to the site itself. The server's unit tests cover the
// standard's check and which websites it may reach.
import { expect, test } from "@playwright/test";

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

// MSPs signing up by themselves (DESIGN.md, "MSP console", "Getting there"):
// the website's link only says someone wants to set up an MSP, and the
// server's MSP_SIGNUPS_ALLOWED still decides. The list of someone's MSPs says
// whether they may, so the console can say so before anyone types a name, and
// a server that doesn't allow it refuses with its sentence in a 400, never a
// 403, which would sign the web vault out. The main test server allows it, as
// the hosted service does; the refusal is on a server of its own with the
// setting off, as a self-hosted server has it.
import { type APIRequestContext, expect, request as apiRequest, test } from "@playwright/test";

import { MspSignupsOffServer, mspSignupsOffServer, SET_UP_REFUSED } from "../support/msp-signups-off";

import { Api } from "./support";

test("a server that allows it says so, and someone sets up an MSP", async ({ request }) => {
  const api = new Api(request);
  const person = await api.account("msp-signup-allowed");

  const before = await api.call(person, "GET", "/api/keykeeper/msp");
  expect(before.status).toBe(200);
  expect(before.body).toEqual({ data: [], setUpAllowed: true });

  const mspId = await api.msp(person, "Signup Allowed IT");
  const after = await api.call(person, "GET", "/api/keykeeper/msp");
  expect(after.body).toEqual({
    data: [{ id: mspId, name: "Signup Allowed IT", role: "admin" }],
    setUpAllowed: true,
  });
});

test.describe("on a server that doesn't allow setting up an MSP", () => {
  const server = new MspSignupsOffServer();
  let http: APIRequestContext;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await server.start();
    http = await apiRequest.newContext({ baseURL: mspSignupsOffServer, ignoreHTTPSErrors: true });
  });

  test.afterAll(async () => {
    await http?.dispose();
    await server.remove();
  });

  test("the list says so, setting one up is refused with the sentence and a 400, and the session goes on", async () => {
    const api = new Api(http);
    const person = await api.account("msp-signup-refused");

    const listed = await api.call(person, "GET", "/api/keykeeper/msp");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ data: [], setUpAllowed: false });

    // Without two-step login, and with it: the setting decides first, so
    // nobody is told to set up two-step login for an MSP they can't make.
    const refused = await api.call(person, "POST", "/api/keykeeper/msp", { name: "Refused IT" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.message).toBe(SET_UP_REFUSED);
    await api.giveAuthenticator(person);
    const again = await api.call(person, "POST", "/api/keykeeper/msp", { name: "Refused IT" });
    expect(again.status, JSON.stringify(again.body)).toBe(400);
    expect(again.body.message).toBe(SET_UP_REFUSED);

    // Nothing was made, and the same session still works: a 400 never signs
    // the web vault out.
    expect((await api.call(person, "GET", "/api/keykeeper/msp")).body).toEqual({
      data: [],
      setUpAllowed: false,
    });
    expect((await api.call(person, "GET", "/api/accounts/profile")).status).toBe(200);

    // Signed out, it's the sign-in the server asks for, as for every MSP route.
    expect((await api.call(null, "GET", "/api/keykeeper/msp")).status).toBe(401);
    expect((await api.call(null, "POST", "/api/keykeeper/msp", { name: "Refused IT" })).status).toBe(401);
  });
});

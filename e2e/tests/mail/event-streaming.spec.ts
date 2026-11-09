// A place an organization's events are sent that's gone (or keeps failing
// for a day) is turned off, and its owners and admins hear it by email
// (DESIGN.md, "Sending events to security tools").
import { expect, test } from "@playwright/test";

import { httpsReceiver, throwawayCert, waitFor } from "../api/siem";
import { Api, withMasterPassword } from "../api/support";

import { joinByEmail, waitForMessage } from "./mailbox";

// The master password these changes need is checked the way a sign-in is
// (600,000 rounds of PBKDF2 on the server, slow in its debug build), so tests
// that make several get more time.
test.describe.configure({ timeout: 120_000 });

test("owners and admins hear by email when the server stops sending to a destination", async ({ request }) => {
  const api = new Api(request);
  const cert = throwawayCert();
  const receiver = await httpsReceiver(cert, () => ({ status: 410, body: "unsubscribed" }));
  try {
    const owner = await api.account("paused-owner");
    const orgId = await api.organization(owner, "Adatum");
    const admin = await api.account("paused-admin");
    await joinByEmail(api, owner, orgId, "Adatum", admin, { type: 1 });
    const created = await api.call(
      owner,
      "POST",
      `/api/keykeeper/organizations/${orgId}/event-streaming`,
      withMasterPassword(owner, {
        name: "Old SIEM",
        kind: "webhook",
        webhook: { url: receiver.url("/hook"), caCertificate: cert.cert },
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    await waitFor(receiver.received, (all) => (all.length > 0 ? all : undefined), "an attempt");

    for (const to of [owner.email, admin.email]) {
      const message = await waitForMessage(to, /Events from Adatum stopped going to Old SIEM/);
      // Only the status, never what the receiver said.
      expect(message.text).toContain("It answered HTTP 410.");
      // Turned off for failing, never for being slow.
      expect(message.text).toContain("It was turned off because sending to it failed.");
      expect(message.text).toContain("A destination that's only slow is never turned off");
      expect(message.text).not.toContain("unsubscribed");
      expect(message.text).toContain(`/#/organizations/${orgId}/reporting/event-streaming`);
    }
    const listed = await api.call(owner, "GET", `/api/keykeeper/organizations/${orgId}/event-streaming`);
    expect(listed.body.data[0]).toMatchObject({ status: "paused", enabled: false });
  } finally {
    await receiver.close();
  }
});

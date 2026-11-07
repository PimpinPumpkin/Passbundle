// The install command's join asks first, in a window from the extension.
// "Not now" joins nothing and isn't asked again at the next unlock, and a
// token meant for another server never leaves the browser; the person is
// told once which server to sign in to instead. The recovery test
// covers saying yes. See DESIGN.md, "Onboarding through the RMM".
import type { Page } from "@playwright/test";

import { Api } from "./api/support";
import {
  answerAndClose,
  createAccount,
  expect,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
} from "./support/extension";

test("the install command's join asks first; Not now joins nothing, and a token for another server goes nowhere and says where to sign in", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("prompt-admin");
  const mspId = await api.msp(admin, "Prompt IT");
  const orgId = await api.client(admin, mspId, "Prompt Dental");
  const enrollment = await api.call(
    admin,
    "GET",
    `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`,
  );
  expect(enrollment.status, JSON.stringify(enrollment.body)).toBe(200);
  const token = enrollment.body.token as string;

  const person = userFor("prompt-person", testInfo.repeatEachIndex);
  const web = await createAccount(context, person);
  await web.close();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, person);

  // The install command hands the extension the token and the server through
  // browser policy; here the test hands them over, then runs the same join.
  const run = (server: string) =>
    context.serviceWorkers()[0].evaluate(
      async ({ enrollmentToken, server }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const main = (self as any).bitwardenMain;
        const userId = await new Promise<string>((resolve) => {
          const subscription = main.accountService.activeAccount$.subscribe(
            (account: { id: string } | null) => {
              if (account) {
                resolve(account.id);
                setTimeout(() => subscription.unsubscribe());
              }
            },
          );
        });
        const enrollment = main.keykeeperEnrollment;
        // Let the run the unlock started, with the real (empty) policy, finish first.
        await enrollment.run(userId);
        // What the extension tells the person, kept here to read back.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const notices: [string, string][] = ((self as any).joinNotices ??= []);
        enrollment.platform = {
          ...enrollment.platform,
          managedToken: async () => enrollmentToken,
          managedServer: async () => server,
          notify: async (title: string, message: string) => {
            notices.push([title, message]);
          },
        };
        return enrollment.run(userId);
      },
      { enrollmentToken: token, server },
    );
  const prompts = () => context.pages().filter((p) => p.url().includes("keykeeper-join"));

  // A token for another server isn't sent anywhere, and nothing asks, but
  // the person hears why, once, rather than nothing happening.
  const notices = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context.serviceWorkers()[0].evaluate(() => (self as any).joinNotices as [string, string][]);
  const elsewhere = "https://vault.elsewhere.example.test";
  expect(await run(elsewhere)).toBe("other-server");
  expect(prompts()).toHaveLength(0);
  const signedInTo = new URL(serverUrl).host;
  expect(await notices()).toEqual([
    [
      "Sign in to vault.elsewhere.example.test to join your organization",
      `Your IT set up this browser for vault.elsewhere.example.test, but you're signed in to ${signedInTo}. To join your organization, sign in to vault.elsewhere.example.test instead.`,
    ],
  ]);
  expect(await run(elsewhere)).toBe("other-server");
  expect(await notices()).toHaveLength(1);

  // For this server, it asks first.
  const outcome = run(serverUrl);
  let prompt: Page | undefined;
  await expect.poll(() => (prompt = prompts()[0])).toBeTruthy();
  await expect(prompt!.getByTestId("keykeeper-join")).toContainText(
    "Your IT set up this browser so you can join Prompt Dental.",
  );
  await expect(prompt!.getByTestId("keykeeper-join-later")).toHaveText(
    "Not now asks again in 7 days.",
  );
  // This test server sends no email, so the client offers no account recovery.
  await expect(prompt!.getByText("Account recovery")).toHaveCount(0);
  // The answer closes the window.
  await answerAndClose(prompt!, prompt!.getByRole("button", { name: "Not now" }));
  expect(await outcome).toBe("declined");

  // Nobody joined, and the next unlock doesn't ask again.
  expect((await api.members(admin, orgId)).map((m) => m.email)).not.toContain(person.email);
  expect(await run(serverUrl)).toBe("declined");
  expect(prompts()).toHaveLength(0);
});

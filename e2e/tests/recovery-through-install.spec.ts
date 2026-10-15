// The whole path from an MSP's install command to account recovery, with real
// keys: someone joins a Business client from the extension, which encrypts
// their user key to the client's public key; the MSP console confirms them;
// an MSP admin recovers their account; and they sign in with the new password
// to an intact vault. If the extension's recovery key were wrong in any way,
// the last step would fail. Runs on the server that sends email, since the
// server only offers account recovery with email.
import { mailServerPort } from "../paths.mjs";

import { addLogin } from "./support/autofill";
import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
} from "./support/extension";
import { signUp, webUserFor } from "./support/web";

const mailServer = `https://127.0.0.1:${mailServerPort}`;
const newPassword = "a brand new passphrase for 2026";

test("an MSP admin recovers the account of someone who joined through the install command", async ({
  browser,
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(240_000);

  // The MSP admin sets up a Business client and copies its install command.
  const adminContext = await browser.newContext({
    baseURL: mailServer,
    ignoreHTTPSErrors: true,
  });
  const admin = await adminContext.newPage();
  await signUp(admin, webUserFor("recovery-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin
    .getByRole("textbox", { name: "Your MSP's name" })
    .fill("Recovery IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin
    .getByRole("textbox", { name: "New client's name" })
    .fill("Recovery Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  const client = admin.getByTestId("msp-client-Recovery Dental");
  await client.getByRole("button", { name: "Install command" }).click();
  const command = await admin.getByTestId("msp-install-command").textContent();
  const token = /-EnrollmentToken (\S+)/.exec(command ?? "")?.[1];
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // The person has an account with an item, and signs in to the extension.
  const person = userFor("recovery-person", testInfo.repeatEachIndex);
  const web = await createAccount(context, person, mailServer);
  await addLogin(web, {
    name: "Before recovery",
    username: "person",
    password: "item-secret",
    uri: "https://bank.example.test",
  });
  await web.close();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, person, mailServer);

  // The install command hands the extension the token through browser policy;
  // here the test hands it over directly, then runs the same join.
  const outcome = await context
    .serviceWorkers()[0]
    .evaluate(async (enrollmentToken) => {
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
      enrollment.platform = {
        ...enrollment.platform,
        managedToken: async () => enrollmentToken,
      };
      return enrollment.run(userId);
    }, token);
  expect(outcome).toBe("joined");

  // The MSP console confirms them when it opens.
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  await expect(
    admin.getByText("Confirmed 1 member", { exact: true }),
  ).toBeVisible();

  // The admin recovers the person's account with a new master password.
  await admin
    .getByTestId("msp-client-Recovery Dental")
    .getByRole("link", { name: "Open" })
    .click();
  const row = admin.getByRole("row").filter({ hasText: person.email });
  await row.getByRole("button", { name: "Options" }).click();
  await admin.getByRole("menuitem", { name: "Recover account" }).click();
  const dialog = admin.getByRole("dialog", { name: /Recover account/ });
  const reset = dialog.getByRole("checkbox", { name: /Reset master password/ });
  if (!(await reset.isChecked())) {
    await reset.check();
  }
  await dialog.getByLabel(/^New master password/).fill(newPassword);
  await dialog.getByLabel(/^Confirm new master password/).fill(newPassword);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // The person signs in with the new password, and their item decrypts.
  const later = await (
    await browser.newContext({ baseURL: mailServer, ignoreHTTPSErrors: true })
  ).newPage();
  await later.goto("/#/login");
  await later.getByLabel(/Email address/).fill(person.email);
  await later.getByRole("button", { name: "Continue" }).click();
  await later
    .getByRole("textbox", { name: /^Master password/ })
    .fill(newPassword);
  await later.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(later.getByText("Before recovery").first()).toBeVisible({
    timeout: 30_000,
  });
});

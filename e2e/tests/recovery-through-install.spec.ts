// The whole path from an MSP's install command to account recovery, with real
// keys: the extension asks someone whether to join a Business client, saying
// its admins could then reset their master password; they join, and the
// extension encrypts their user key to the client's public key; an MSP admin
// approves them and recovers their account; and they sign in with the new
// password to an intact vault. If the extension's recovery key were wrong in any way,
// the last step would fail. Runs on the server that sends email, since the
// server only offers account recovery with email.
import type { Page } from "@playwright/test";

import { mailServerPort } from "../paths.mjs";

import { addLogin } from "./support/autofill";
import {
  answerAndClose,
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
} from "./support/extension";
import { confirmMember, signUp, webUserFor } from "./support/web";

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
  const part = (name: string) =>
    new RegExp(`-${name} '([A-Za-z0-9_-]{43})'`).exec(command ?? "")?.[1] ?? null;
  const token = part("EnrollmentToken");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // The command also carries the join secret and the client's key fingerprint.
  const joinParts = { secret: part("JoinSecret"), orgKey: part("OrgKey") };
  expect(joinParts.secret).not.toBeNull();
  expect(joinParts.orgKey).not.toBeNull();

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

  // The install command hands the extension the token and the server through
  // browser policy; here the test hands them over directly, then runs the same
  // join, which asks first.
  const outcome = context
    .serviceWorkers()[0]
    .evaluate(async ({ enrollmentToken, server, parts }) => {
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
      enrollment.platform = {
        ...enrollment.platform,
        managedToken: async () => enrollmentToken,
        managedServer: async () => server,
        managedJoinParts: async () => parts,
      };
      return enrollment.run(userId);
    }, { enrollmentToken: token, server: mailServer, parts: joinParts });
  let prompt: Page | undefined;
  await expect
    .poll(() => (prompt = context.pages().find((p) => p.url().includes("keykeeper-join"))))
    .toBeTruthy();
  const question = prompt!.getByTestId("keykeeper-join");
  await expect(question).toContainText("so you can join Recovery Dental");
  await expect(question).toContainText(
    "Recovery Dental's admins will be able to reset your master password",
  );
  await expect(prompt!.getByTestId("keykeeper-join-fingerprint")).toHaveText(/^\w+(-\w+){4}$/);
  // The answer closes the window.
  await answerAndClose(prompt!, prompt!.getByRole("button", { name: "Join", exact: true }));
  expect(await outcome).toBe("joined");

  // The command isn't limited to email domains, so an MSP admin approves
  // them on the client's Members page: the console doesn't.
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  await admin
    .getByTestId("msp-client-Recovery Dental")
    .getByRole("link", { name: "Open" })
    .click();
  await confirmMember(admin, person.email);

  // The admin recovers the person's account with a new master password.
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

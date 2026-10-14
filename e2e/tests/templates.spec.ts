// Item templates: New, From template, pick one, and the new item starts with
// that template's fields and remembers which template it came from.
import { expect, test } from "@playwright/test";

import { signUp, webUserFor } from "./support/web";

test("a new item from the API key template starts with its fields and shows its template", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("template", testInfo.repeatEachIndex));

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "From template" }).click();
  const picker = page.getByRole("dialog", { name: "New item from a template" });
  for (const name of ["API key", "Server", "Wi-Fi network", "Software license", "Certificate"]) {
    await expect(picker.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await picker.getByRole("button", { name: "API key", exact: true }).click();

  // An API key builds on a note, with its own fields ready to fill.
  const editor = page.getByRole("dialog", { name: /^New/ });
  await editor.getByRole("textbox", { name: /Item name/ }).fill("Payments API");
  await editor.getByRole("textbox", { name: "Key", exact: true }).fill("pk-test-not-real");
  await editor.getByRole("textbox", { name: "Secret", exact: true }).fill("sk-test-not-real");
  await editor.getByRole("textbox", { name: "Service URL", exact: true }).fill("https://payments.example.test");
  await expect(editor.getByText("keykeeper.template")).toHaveCount(0);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();

  // Saving opens the item's view.
  const view = page.getByRole("dialog", { name: /^View/ });
  await expect(view.getByTestId("keykeeper-template")).toHaveText("API key");
  await expect(view.getByRole("textbox", { name: "Service URL" })).toHaveValue("https://payments.example.test");
  await expect(view.getByRole("textbox", { name: "Key" })).toBeVisible();
  await expect(view.getByRole("textbox", { name: "Scopes" })).toBeVisible();
  await expect(view.getByText("keykeeper.template")).toHaveCount(0);
});

test("a login-based template keeps the login fields too", async ({ page }, testInfo) => {
  await signUp(page, webUserFor("template-login", testInfo.repeatEachIndex));

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "From template" }).click();
  await page
    .getByRole("dialog", { name: "New item from a template" })
    .getByRole("button", { name: "Server", exact: true })
    .click();

  const editor = page.getByRole("dialog", { name: "New Login" });
  await editor.getByRole("textbox", { name: /Item name/ }).fill("Build server");
  await editor.getByRole("textbox", { name: "Username", exact: true }).fill("deploy");
  await editor.getByRole("textbox", { name: "Hostname", exact: true }).fill("build1.example.test");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();

  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByTestId("keykeeper-template")).toHaveText("Server");
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("deploy");
  await expect(view.getByRole("textbox", { name: "Hostname" })).toHaveValue("build1.example.test");
});

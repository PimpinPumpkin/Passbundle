// Item templates: New, From template, pick one, and the new item starts with
// that template's fields and remembers which template it came from. Custom
// templates, made in the editor or with "Save as template" from an item.
import { expect, test } from "@playwright/test";

import { addLogin } from "./support/autofill";
import { newTemplate, signUp, templatePicker, webUserFor } from "./support/web";

test("a new item from the API key template starts with its fields and shows its template", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("template", testInfo.repeatEachIndex));

  const picker = await templatePicker(page);
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

  await (await templatePicker(page)).getByRole("button", { name: "Server", exact: true }).click();

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

test("a custom template is made in the ordinary editor, and new items start with its fields and defaults", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("template-custom", testInfo.repeatEachIndex));

  await newTemplate(page, "logins");

  // A template is a note: its name is the template's, its custom fields are the template's.
  const editor = page.getByRole("dialog", { name: /^New/ });
  await expect(editor.getByTestId("keykeeper-template-hint")).toContainText("template for new logins");
  await editor.getByRole("textbox", { name: /Item name/ }).fill("Client laptop");
  for (const [label, type] of [
    ["Asset tag", null],
    ["BitLocker recovery key", "Hidden"],
    ["Site", null],
  ] as const) {
    await editor.getByRole("button", { name: "Add field" }).click();
    const addField = page.getByRole("dialog", { name: "Add field" });
    if (type) {
      await addField.getByRole("combobox", { name: /Field type/ }).click();
      await page.getByRole("option", { name: type, exact: true }).click();
    }
    await addField.getByRole("textbox", { name: /Field label/ }).fill(label);
    await addField.getByRole("button", { name: "Add", exact: true }).click();
    await expect(addField).toBeHidden();
  }
  // A value in the template is a default for new items.
  await editor.getByRole("textbox", { name: "Site", exact: true }).fill("Main office");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();

  const templateView = page.getByRole("dialog", { name: /^View/ });
  await expect(templateView.getByTestId("keykeeper-template-definition")).toContainText(
    "New logins from this template",
  );
  await expect(templateView.getByText("keykeeper.template-definition")).toHaveCount(0);
  await templateView.getByRole("button", { name: "Close" }).first().click();
  await expect(
    page.getByRole("row").filter({ hasText: "Client laptop" }).getByTestId("keykeeper-template-badge"),
  ).toHaveText("Template");

  // The picker lists it under the person's own templates.
  await (await templatePicker(page))
    .getByRole("region", { name: "My templates" })
    .getByRole("button", { name: "Client laptop", exact: true })
    .click();

  const item = page.getByRole("dialog", { name: "New Login" });
  await expect(item.getByTestId("keykeeper-template-hint")).toHaveCount(0);
  await expect(item.getByRole("textbox", { name: "Site", exact: true })).toHaveValue("Main office");
  await expect(item.getByLabel("BitLocker recovery key", { exact: true })).toHaveValue("");
  await item.getByRole("textbox", { name: /Item name/ }).fill("Front desk PC");
  await item.getByRole("textbox", { name: "Username", exact: true }).fill("frontdesk");
  await item.getByRole("textbox", { name: "Asset tag", exact: true }).fill("A-1001");
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item).toBeHidden();

  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByTestId("keykeeper-template")).toHaveText("Client laptop");
  await expect(view.getByTestId("keykeeper-template-definition")).toHaveCount(0);
  await expect(view.getByRole("textbox", { name: "Asset tag" })).toHaveValue("A-1001");
  await expect(view.getByRole("textbox", { name: "Site" })).toHaveValue("Main office");
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("frontdesk");
  await view.getByRole("button", { name: "Close" }).first().click();
  // Only the template is marked as one.
  await expect(
    page.getByRole("row").filter({ hasText: "Front desk PC" }).getByTestId("keykeeper-template-badge"),
  ).toHaveCount(0);
});

test("Save as template turns an item's custom fields into a new template, without their values", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("template-from-item", testInfo.repeatEachIndex));
  await addLogin(page, {
    name: "Contoso 365 admin",
    username: "admin@contoso.example",
    password: "not-a-real-password-1",
    uri: "https://admin.contoso.example",
    customFields: { Tenant: "contoso.onmicrosoft.com" },
  });
  const view = page.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();

  await page.getByRole("row").filter({ hasText: "Contoso 365 admin" }).getByRole("button", { name: "Options" }).click();
  await page.getByRole("menuitem", { name: "Save as template" }).click();

  // A new template for logins, named after the item, with its field and not its value.
  const editor = page.getByRole("dialog", { name: /^New/ });
  await expect(editor.getByTestId("keykeeper-template-hint")).toContainText("template for new logins");
  const name = editor.getByRole("textbox", { name: /Item name/ });
  await expect(name).toHaveValue("Contoso 365 admin");
  await expect(editor.getByRole("textbox", { name: "Tenant", exact: true })).toHaveValue("");
  await name.fill("Microsoft 365 admin");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await page.getByRole("dialog", { name: /^View/ }).getByRole("button", { name: "Close" }).first().click();

  // New logins start from it.
  await (await templatePicker(page))
    .getByRole("button", { name: "Microsoft 365 admin", exact: true })
    .click();
  const login = page.getByRole("dialog", { name: "New Login" });
  await expect(login.getByRole("textbox", { name: "Tenant", exact: true })).toHaveValue("");
});

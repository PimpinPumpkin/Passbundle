// Item templates in the browser extension: New, From template, then built-in
// and custom templates work as in the web vault, and a custom template can be
// made right in the popup.
import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";
import type { Page } from "@playwright/test";

async function openTemplates(popup: Page) {
  // The plus icon's glyph is part of the button's accessible name.
  await popup.getByRole("button", { name: /^\W*New$/ }).click();
  await popup.getByRole("menuitem", { name: "From template" }).click();
  await expect(popup.getByRole("heading", { name: "New item from a template" })).toBeVisible();
}

test("the popup starts items from built-in and custom templates, and makes templates", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("template-ext", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.close();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  const vaultUrl = popup.url();

  // A built-in template.
  await openTemplates(popup);
  await popup.getByRole("button", { name: "API key", exact: true }).click();
  await expect(popup.getByRole("textbox", { name: "Service URL", exact: true })).toBeVisible();
  await expect(popup.getByTestId("keykeeper-template-hint")).toHaveCount(0);
  await popup.goto(vaultUrl);

  // A custom template for notes, made in the popup.
  await openTemplates(popup);
  await popup.getByRole("button", { name: "Create template" }).click();
  await expect(popup.getByRole("heading", { name: "New template" })).toBeVisible();
  await popup.getByRole("button", { name: "Notes" }).click();
  await expect(popup.getByTestId("keykeeper-template-hint")).toContainText("template for new notes");
  await popup.getByRole("textbox", { name: /Item name/ }).fill("Office Wi-Fi");
  await popup.getByRole("button", { name: "Add field" }).click();
  const addField = popup.getByRole("dialog", { name: "Add field" });
  await addField.getByRole("textbox", { name: /Field label/ }).fill("Network name");
  await addField.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addField).toBeHidden();
  await popup.getByRole("textbox", { name: "Network name", exact: true }).fill("Office-5G");
  await popup.getByRole("button", { name: "Save" }).click();
  await expect(popup.getByTestId("keykeeper-template-definition")).toContainText(
    "New notes from this template",
  );

  await popup.goto(vaultUrl);
  await expect(
    popup.getByRole("button", { name: /Office Wi-Fi/ }).getByTestId("keykeeper-template-badge"),
  ).toHaveText("Template");

  // And used from the popup, with its default.
  await openTemplates(popup);
  await popup
    .getByRole("region", { name: "My templates" })
    .getByRole("button", { name: "Office Wi-Fi", exact: true })
    .click();
  await expect(popup.getByRole("textbox", { name: "Network name", exact: true })).toHaveValue("Office-5G");
  await popup.getByRole("textbox", { name: /Item name/ }).fill("Front office Wi-Fi");
  await popup.getByRole("button", { name: "Save" }).click();
  await expect(popup.getByTestId("keykeeper-template")).toHaveText("Office Wi-Fi");
  await expect(popup.getByTestId("keykeeper-template-definition")).toHaveCount(0);
});

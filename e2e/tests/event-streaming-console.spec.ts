// Event streaming in the web vault (DESIGN.md, "Sending events to security
// tools"): an owner adds a webhook on Reporting > Event streaming, sees its
// signing secret once, the receiver gets signed events, Test sends one, and
// the event log names the change and exports it as JSON. An MSP's admin has
// the same section in the MSP console for the MSP's feed. Each change asks
// for the master password first.
import fs from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { httpsReceiver, throwawayCert, verifyWebhook, waitFor } from "./api/siem";
import { confirmWithPassword, signUp, webUserFor } from "./support/web";

const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

async function createOrganization(owner: Page, name: string): Promise<string> {
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("radio", { name: /A family or a group/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(owner, `Created ${name}`)).toBeVisible();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
}

test("an owner sends the organization's events to a webhook, tests it, and finds the change in the event log", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const cert = throwawayCert();
  const receiver = await httpsReceiver(cert);
  try {
    const owner = webUserFor("stream-console-owner", testInfo.repeatEachIndex);
    await signUp(page, owner);
    const orgId = await createOrganization(page, "Contoso");

    // Under Reporting, for owners and admins.
    await page.getByRole("link", { name: "Reporting" }).click();
    await page.getByRole("link", { name: "Event streaming" }).click();
    await page.waitForURL(new RegExp(`organizations/${orgId}/reporting/event-streaming`));
    const section = page.getByTestId("event-streaming");
    await expect(section.getByText("Events aren't sent anywhere yet.")).toBeVisible();

    await section.getByRole("button", { name: "Add a destination" }).click();
    const form = section.getByRole("form", { name: "New destination" });
    await form.getByRole("textbox", { name: "Name" }).fill("SOC");
    await form.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Webhook (HTTPS)" });
    // Hidden like a password, since it can carry a token.
    await expect(form.getByLabel("URL", { exact: true })).toHaveAttribute("type", "password");
    await expect(form.getByLabel("URL", { exact: true })).toHaveAttribute("autocomplete", "new-password");
    await form.getByLabel("URL", { exact: true }).fill(receiver.url("/hook?token=in-the-url"));
    await form.getByRole("textbox", { name: "Header (optional)" }).fill("Authorization");
    await form.getByLabel("Header value").fill("Bearer collector-token");
    // Each secret field hides what's typed, with a button to show it.
    const headerValue = form.getByLabel("Header value");
    await expect(headerValue).toHaveAttribute("type", "password");
    await expect(form.getByRole("button", { name: "Toggle visibility" })).toHaveCount(2);
    await form.getByRole("button", { name: "Toggle visibility" }).nth(1).click();
    await expect(headerValue).toHaveAttribute("type", "text");
    await form.getByRole("button", { name: "Toggle visibility" }).nth(1).click();
    await expect(headerValue).toHaveAttribute("type", "password");
    await form.getByRole("textbox", { name: "Certificate authority (optional)" }).fill(cert.cert);
    await form.getByRole("button", { name: "Add" }).click();
    await confirmWithPassword(page, owner.password);
    await expect(toast(page, "Events now go to SOC")).toBeVisible();

    // The signing secret, once.
    const secret = (await section.getByTestId("event-streaming-secret-value").textContent())!.trim();
    expect(secret).toMatch(/^whsec_/);
    const row = section.getByTestId("destination-SOC");
    await expect(row.getByTestId("destination-status")).toHaveText("On");
    await expect(row).toContainText(`https://127.0.0.1:${receiver.port}/…`);
    await expect(row).not.toContainText("in-the-url");
    await section.getByRole("button", { name: "Done" }).click();
    await expect(section.getByTestId("event-streaming-secret")).toBeHidden();

    // The receiver gets the change, signed with that secret.
    const events = () => receiver.received.map((r) => verifyWebhook(r, secret));
    await waitFor(receiver.received, () => events().find((e) => e.type === 1690), "the 'added' event");
    expect(receiver.received[0].headers.authorization).toBe("Bearer collector-token");

    await row.getByRole("button", { name: "Send a test event to SOC" }).click();
    await expect(toast(page, "Sent a test event to SOC")).toBeVisible();
    await waitFor(receiver.received, () => events().find((e) => e.type === 9000), "the test event");
    await expect(row).not.toContainText("Not yet");

    // Editing keeps the secrets it leaves blank.
    await row.getByRole("button", { name: "Edit SOC" }).click();
    const edit = section.getByRole("form", { name: "Edit destination" });
    await expect(edit.getByLabel("URL", { exact: true })).toHaveValue("");
    await expect(edit.getByRole("combobox", { name: "Kind" })).toBeDisabled();
    await edit.getByRole("textbox", { name: "Name" }).fill("SOC webhook");
    await edit.getByRole("button", { name: "Save" }).click();
    await confirmWithPassword(page, owner.password);
    await expect(toast(page, "Saved SOC webhook")).toBeVisible();
    const before = receiver.received.length;
    await section
      .getByTestId("destination-SOC webhook")
      .getByRole("button", { name: "Send a test event to SOC webhook" })
      .click();
    await waitFor(receiver.received, (all) => all.slice(before).find((r) => r.path === "/hook?token=in-the-url"), "a test after editing");

    // Turning it off and on, and a new signing secret, ask for it too.
    const renamed = section.getByTestId("destination-SOC webhook");
    await renamed.getByRole("button", { name: "Turn off SOC webhook" }).click();
    await page.getByRole("dialog", { name: "Turn off SOC webhook?" }).getByRole("button", { name: "Turn off" }).click();
    await confirmWithPassword(page, owner.password);
    await expect(toast(page, "SOC webhook is off")).toBeVisible();
    await expect(renamed.getByTestId("destination-status")).toHaveText("Off");
    await renamed.getByRole("button", { name: "Turn on SOC webhook" }).click();
    await confirmWithPassword(page, owner.password);
    await expect(toast(page, "SOC webhook is on")).toBeVisible();
    await expect(renamed.getByTestId("destination-status")).toHaveText("On");
    await renamed.getByRole("button", { name: "New signing secret for SOC webhook" }).click();
    await page
      .getByRole("dialog", { name: "New signing secret for SOC webhook?" })
      .getByRole("button", { name: "Make a new secret" })
      .click();
    await confirmWithPassword(page, owner.password);
    const newSecret = (await section.getByTestId("event-streaming-secret-value").textContent())!.trim();
    expect(newSecret).toMatch(/^whsec_/);
    expect(newSecret).not.toBe(secret);
    await section.getByRole("button", { name: "Done" }).click();

    // Sentinel's client secret has the same button.
    await section.getByRole("button", { name: "Add a destination" }).click();
    const sentinel = section.getByRole("form", { name: "New destination" });
    await sentinel.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Microsoft Sentinel" });
    await expect(sentinel.getByLabel("Client secret")).toHaveAttribute("type", "password");
    await sentinel.getByRole("button", { name: "Toggle visibility" }).click();
    await expect(sentinel.getByLabel("Client secret")).toHaveAttribute("type", "text");
    await sentinel.getByRole("button", { name: "Cancel" }).click();

    // The event log names it, and exports it as JSON.
    await page.goto(`/#/organizations/${orgId}/reporting/events`);
    await expect(page.getByText("Started sending the organization's events to a new place.")).toBeVisible();
    await expect(page.getByText("Changed a place the organization's events are sent.").first()).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSON" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.json$/);
    const exported = JSON.parse(fs.readFileSync((await file.path())!, "utf8"));
    expect(exported.map((e: { message: string }) => e.message)).toContain(
      "Started sending the organization's events to a new place.",
    );
  } finally {
    await receiver.close();
  }
});

test("an MSP's admin sets up the MSP's feed in the console", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const cert = throwawayCert();
  const receiver = await httpsReceiver(cert);
  try {
    const admin = webUserFor("stream-console-msp", testInfo.repeatEachIndex);
    await signUp(page, admin);
    await page.goto("/#/msp");
    await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Northwind IT");
    await page.getByRole("button", { name: "Create MSP" }).click();
    await expect(page.getByTestId("msp-name")).toContainText("Northwind IT");

    const section = page.getByTestId("event-streaming");
    await expect(section.getByText("Send every client's events")).toBeVisible();
    await section.getByRole("button", { name: "Add a destination" }).click();
    const form = section.getByRole("form", { name: "New destination" });
    await form.getByRole("textbox", { name: "Name" }).fill("SOC feed");
    await form.getByRole("combobox", { name: "Kind" }).selectOption({ label: "Webhook (HTTPS)" });
    await form.getByLabel("URL", { exact: true }).fill(receiver.url("/soc"));
    await form.getByRole("textbox", { name: "Certificate authority (optional)" }).fill(cert.cert);
    await form.getByRole("button", { name: "Add" }).click();
    await confirmWithPassword(page, admin.password);
    await expect(toast(page, "Events now go to SOC feed")).toBeVisible();
    const secret = (await section.getByTestId("event-streaming-secret-value").textContent())!.trim();

    // The MSP's own activity reaches it, and the console's activity log says so.
    const [added] = await waitFor(
      receiver.received,
      () => receiver.received.map((r) => verifyWebhook(r, secret)).filter((e) => e.type === 9170),
      "the feed's 'added' entry",
    );
    expect(added.msp.name).toBe("Northwind IT");
    await expect(
      page.getByTestId("msp-activity").getByText(/started sending the MSP's events to SOC feed/),
    ).toBeVisible();
  } finally {
    await receiver.close();
  }
});

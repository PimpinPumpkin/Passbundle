// Reads messages from the mail catcher (mail-server.mjs).
import { expect } from "@playwright/test";

import { mailHttpPort } from "../../paths.mjs";

export type Message = {
  to: string[];
  subject: string;
  text: string;
  html: string;
};

/** Waits for a message to this address whose subject matches, and returns the newest. */
export async function waitForMessage(
  to: string,
  subject: RegExp,
): Promise<Message> {
  let found: Message | undefined;
  await expect(async () => {
    const response = await fetch(
      `http://127.0.0.1:${mailHttpPort}/messages?to=${encodeURIComponent(to)}`,
    );
    const messages: Message[] = await response.json();
    found = messages.filter((m) => subject.test(m.subject)).at(-1);
    expect(found, `a message to ${to} matching ${subject}`).toBeTruthy();
  }).toPass({ timeout: 15_000 });
  return found!;
}

/** The parameters of the join link in an organization invite. */
export function inviteParams(message: Message): URLSearchParams {
  const link = /https?:\/\/\S*accept-organization\S*/.exec(message.text)?.[0];
  expect(link, `a join link in: ${message.text}`).toBeTruthy();
  return new URLSearchParams(link!.slice(link!.indexOf("?") + 1));
}

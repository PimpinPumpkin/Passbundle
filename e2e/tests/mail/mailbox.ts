// Reads messages from the mail catcher (mail-server.mjs).
import { expect } from "@playwright/test";

import { mailHttpPort } from "../../paths.mjs";
import { type Account, type Api } from "../api/support";

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

/**
 * Invites an existing account by email and has them join through the emailed
 * link, enrolling in account recovery when the organization asks for it, then
 * confirms them. Returns their membership id.
 */
export async function joinByEmail(
  api: import("../api/support").Api,
  owner: import("../api/support").Account,
  orgId: string,
  orgName: string,
  member: import("../api/support").Account,
  role: { type: number; permissions?: Record<string, boolean> },
): Promise<string> {
  const { encString } = await import("../api/support");
  const invited = await api.call(
    owner,
    "POST",
    `/api/organizations/${orgId}/users/invite`,
    {
      emails: [member.email],
      type: role.type,
      collections: [],
      groups: [],
      permissions: role.permissions ?? {},
    },
  );
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const link = inviteParams(
    await waitForMessage(member.email, new RegExp(`Join ${orgName}`)),
  );
  const memberId = link.get("organizationUserId")!;
  const accepted = await api.call(
    member,
    "POST",
    `/api/organizations/${orgId}/users/${memberId}/accept`,
    {
      token: link.get("token"),
      resetPasswordKey: encString(`recovery-key-${member.email}`),
    },
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const confirmed = await api.call(
    owner,
    "POST",
    `/api/organizations/${orgId}/users/${memberId}/confirm`,
    {
      key: encString(`org-key-for-${member.email}`),
    },
  );
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return memberId;
}

/** Verifies an account's email the way a person does: from the link the server emails. */
export async function verifyEmail(api: Api, account: Account) {
  const sent = await api.call(account, "POST", "/api/accounts/verify-email");
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const message = await waitForMessage(account.email, /Verify Your Email/);
  const link = /verify-email\/\?userId=([^&\s]+)&token=(\S+)/.exec(message.text);
  expect(link, message.text).toBeTruthy();
  const verified = await api.call(account, "POST", "/api/accounts/verify-email-token", {
    userId: link![1],
    token: link![2],
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
}

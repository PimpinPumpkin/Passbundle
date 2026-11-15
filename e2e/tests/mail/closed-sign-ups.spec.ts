// What the server answers when someone asks for a new account it isn't
// giving (DESIGN.md, "New accounts on a closed server"), on a server of its
// own that's started again with other sign-up settings over the same data:
// the sign-up form's first step is turned down in plain words with its
// reason, the same for an address that has an account and one that doesn't,
// with no email to either; the allowed email domains are never sent; the last
// step keeps upstream's one answer for both; and a person invited to an
// organization or as a legacy contact still makes their account, from the
// emailed link, or from the form on a server that sends no email.
import { randomUUID } from "node:crypto";

import { type APIRequestContext, expect, request as apiRequest, test } from "@playwright/test";

import { mailHttpPort } from "../../paths.mjs";
import { type Account, Api, encString, publicKey } from "../api/support";
import { ClosedServer, closedServer } from "../support/closed-server";

import { inviteParams, type Message, waitForMessage } from "./mailbox";

test.describe.configure({ mode: "serial" });

const run = randomUUID().slice(0, 8);
// The one email domain the last test's server takes new accounts at.
const ALLOWED = "allowed.example.test";
const at = (name: string, domain: string) => `${name}-${run}@${domain}`;
// Two addresses at a domain that's never allowed: one with an account, made
// while the server was open, and one nobody has ever used here.
const withAccount = at("has-account", "elsewhere.example.test");
const noAccount = at("no-account", "elsewhere.example.test");

const CLOSED = "This server isn't taking new accounts.";
const NOT_THAT_ADDRESS = "New accounts aren't open for that address.";
const UPSTREAM = "Registration not allowed or user already exists";

/** The whole answer to a refused first step: every other error's shape, plus the reason. */
const refusal = (reason: "closed" | "address", message: string) => ({
  message,
  validationErrors: { "": [message] },
  errorModel: { message, object: "error" },
  error: "",
  error_description: "",
  exceptionMessage: null,
  exceptionStackTrace: null,
  innerExceptionMessage: null,
  keykeeperNewAccounts: reason,
  object: "error",
});

let server: ClosedServer;
let http: APIRequestContext;
let api: Api;
let owner: Account;
let orgId: string;
// The first step's tokens for the two addresses, from while the server was open.
let tokens: Record<string, string>;

type Answer = { status: number; text: string };

/** The sign-up form's first step, as the apps send it. Nobody is signed in. */
async function firstStep(email: string): Promise<Answer> {
  const response = await http.post("/identity/accounts/register/send-verification-email", {
    data: { email, name: "New Person", receiveMarketingEmails: false },
    headers: { Accept: "application/json" },
  });
  return { status: response.status(), text: await response.text() };
}

/** The form's last step: the account's password and keys, with what proves the address. */
async function lastStep(email: string, proof: Record<string, string>): Promise<Answer> {
  const response = await http.post("/identity/accounts/register/finish", {
    data: {
      email,
      ...proof,
      masterPasswordHash: passwordOf(email),
      masterPasswordHint: null,
      userSymmetricKey: encString(`user-key-${email}`),
      userAsymmetricKeys: {
        publicKey: publicKey(email),
        encryptedPrivateKey: encString(`private-key-${email}`),
      },
      kdf: 0,
      kdfIterations: 600000,
    },
  });
  return { status: response.status(), text: await response.text() };
}

const passwordOf = (email: string) => Buffer.from(`hash-${email}`).toString("base64");

/** Every message the mail catcher holds for an address. */
async function messagesTo(address: string): Promise<Message[]> {
  const response = await fetch(`http://127.0.0.1:${mailHttpPort}/messages?to=${encodeURIComponent(address)}`);
  return response.json();
}

async function config(): Promise<{ text: string; body: any }> {
  const response = await http.get("/api/config");
  expect(response.status()).toBe(200);
  const text = await response.text();
  return { text, body: JSON.parse(text) };
}

test.beforeAll(async () => {
  test.setTimeout(3 * 60_000);
  server = new ClosedServer();
  // Open to everyone first, to make the accounts a closed server already has.
  await server.start("open", { mail: true });
  http = await apiRequest.newContext({ baseURL: closedServer, ignoreHTTPSErrors: true });
  api = new Api(http);
  owner = await api.account("Closed Owner", at("owner", "elsewhere.example.test"));
  orgId = await api.organization(owner, "Closed Co");
  await api.account("Has Account", withAccount);

  // An open server gives both addresses the same first step, a token each.
  tokens = {};
  for (const email of [withAccount, noAccount]) {
    const answer = await firstStep(email);
    expect(answer.status, answer.text).toBe(200);
    tokens[email] = JSON.parse(answer.text);
  }
  expect((await config()).body.settings.disableUserRegistration).toBe(false);
});

test.afterAll(async () => {
  await http?.dispose();
  await server?.remove();
});

test("a server closed to everyone turns the sign-up form's first step down in plain words, the same with or without an account, and emails nobody", async () => {
  await server.start("closed", { mail: true });
  // What tells the web vault and the extension not to offer "Create account".
  expect((await config()).body.settings.disableUserRegistration).toBe(true);

  const before = await messagesTo(withAccount);
  const taken = await firstStep(withAccount);
  const free = await firstStep(noAccount);
  expect(taken.status).toBe(400);
  expect(JSON.parse(taken.text)).toEqual(refusal("closed", CLOSED));
  // Not one byte tells the two apart.
  expect(free).toEqual(taken);
  // The address's spelling doesn't either.
  expect(await firstStep(withAccount.toUpperCase())).toEqual(taken);

  // The last step keeps upstream's one answer for both, with a first step's
  // token from while the server was open.
  const takenLast = await lastStep(withAccount, { emailVerificationToken: tokens[withAccount] });
  const freeLast = await lastStep(noAccount, { emailVerificationToken: tokens[noAccount] });
  expect(takenLast.status).toBe(400);
  expect(JSON.parse(takenLast.text).message).toBe(UPSTREAM);
  expect(JSON.parse(takenLast.text).keykeeperNewAccounts).toBeUndefined();
  expect(freeLast).toEqual(takenLast);

  // No email for any of it. The server sends before it answers, and an
  // invitation sent afterwards arrives, so nothing else is on its way.
  const marker = at("marker", "elsewhere.example.test");
  await invite(marker);
  await waitForMessage(marker, /Join Closed Co/);
  expect(await messagesTo(withAccount)).toEqual(before);
  expect(await messagesTo(noAccount)).toEqual([]);
});

/** Invites an address to the organization, as its owner. */
async function invite(email: string) {
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [email],
    type: 2,
    collections: [],
    groups: [],
    accessSecretsManager: false,
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
}

test("while sign-ups are closed, a person invited to an organization makes their account from the emailed link and joins", async () => {
  await server.start("closed", { mail: true });
  const email = at("invited", "elsewhere.example.test");
  await invite(email);
  const link = inviteParams(await waitForMessage(email, /Join Closed Co/));
  expect(link.get("email")).toBe(email);

  // The sign-up form isn't their way in: typed there, their address gets the
  // answer everyone gets.
  const typed = await firstStep(email);
  expect(typed.status).toBe(400);
  expect(JSON.parse(typed.text)).toEqual(refusal("closed", CLOSED));

  // The link's page finishes the account with the invitation as its proof.
  const made = await lastStep(email, {
    organizationUserId: link.get("organizationUserId")!,
    orgInviteToken: link.get("token")!,
  });
  expect(made.status, made.text).toBe(200);

  const token = await api.logIn(email, passwordOf(email));
  const accepted = await api.call(
    { token },
    "POST",
    `/api/organizations/${orgId}/users/${link.get("organizationUserId")}/accept`,
    { token: link.get("token") },
  );
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const member = (await api.members(owner, orgId)).find((m) => m.email === email);
  expect(member?.id).toBe(link.get("organizationUserId"));

  // Someone else's invitation doesn't make an account for another address.
  const other = at("not-invited", "elsewhere.example.test");
  const borrowed = await lastStep(other, {
    organizationUserId: link.get("organizationUserId")!,
    orgInviteToken: link.get("token")!,
  });
  expect(borrowed.status).toBe(400);
});

test("while sign-ups are closed, a person invited as a legacy contact makes their account from the emailed link", async () => {
  await server.start("closed", { mail: true });
  const email = at("contact", "elsewhere.example.test");
  const invited = await api.call(owner, "POST", "/api/emergency-access/invite", {
    email,
    type: 1,
    waitTimeDays: 1,
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  const message = await waitForMessage(email, /Emergency access for Closed Owner/);
  const address = /https?:\/\/\S*accept-emergency\S*/.exec(message.text)?.[0];
  expect(address, message.text).toBeTruthy();
  const link = new URLSearchParams(address!.slice(address!.indexOf("?") + 1));
  expect(link.get("email")).toBe(email);

  const made = await lastStep(email, {
    acceptEmergencyAccessId: link.get("id")!,
    acceptEmergencyAccessInviteToken: link.get("token")!,
  });
  expect(made.status, made.text).toBe(200);

  const token = await api.logIn(email, passwordOf(email));
  const accepted = await api.call({ token }, "POST", `/api/emergency-access/${link.get("id")}/accept`, {
    token: link.get("token"),
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const trusted = await api.call(owner, "GET", "/api/emergency-access/trusted");
  expect(trusted.status, JSON.stringify(trusted.body)).toBe(200);
  expect(trusted.body.data.map((contact: { email: string }) => contact.email)).toContain(email);
});

test("a server that takes new accounts at some email domains never says which, and turns other addresses down the same with or without an account", async () => {
  // The first step sends its link by email here, so an address that's let
  // through gets a message, and one that's turned down must not.
  await server.start({ domains: [ALLOWED] }, { mail: true, verify: true });

  // The form stays, and the apps aren't told the domains.
  const settings = await config();
  expect(settings.body.settings.disableUserRegistration).toBe(false);
  expect(settings.text).not.toContain(ALLOWED);
  expect(settings.text).not.toContain("allowed.example");

  const before = await messagesTo(withAccount);
  const taken = await firstStep(withAccount);
  const free = await firstStep(noAccount);
  expect(taken.status).toBe(400);
  expect(JSON.parse(taken.text)).toEqual(refusal("address", NOT_THAT_ADDRESS));
  expect(taken.text).not.toContain("allowed.example");
  // Not one byte tells the two apart.
  expect(free).toEqual(taken);
  // Close to the allowed domain is still outside it.
  for (const near of [at("near", `sub.${ALLOWED}`), at("near", `${ALLOWED}.example`), `near-${run}`]) {
    expect(await firstStep(near), near).toEqual(taken);
  }

  // The last step keeps upstream's one answer for both.
  const takenLast = await lastStep(withAccount, { emailVerificationToken: tokens[withAccount] });
  const freeLast = await lastStep(noAccount, { emailVerificationToken: tokens[noAccount] });
  expect(takenLast.status).toBe(400);
  expect(JSON.parse(takenLast.text).message).toBe(UPSTREAM);
  expect(freeLast).toEqual(takenLast);

  // An address at the allowed domain is let through: no token in the answer,
  // and the link by email.
  const welcome = at("welcome", ALLOWED);
  const through = await firstStep(welcome);
  expect(through).toEqual({ status: 204, text: "" });
  const sent = await waitForMessage(welcome, /Verify Your Email/);
  expect(sent.text).toContain("finish-signup");

  // And no email for the addresses turned down. The server sends before it
  // answers, and the message above came after, so nothing else is on its way.
  expect(await messagesTo(withAccount)).toEqual(before);
  expect(await messagesTo(noAccount)).toEqual([]);
});

test("a closed server that sends no email still lets an invited person through the sign-up form, and turns everyone else down the same with or without an account", async () => {
  await server.start("closed", { mail: false });
  // No emailed link to come in by, so the form is how an invited person makes
  // their account, and the apps keep offering it.
  expect((await config()).body.settings.disableUserRegistration).toBe(false);

  const taken = await firstStep(withAccount);
  const free = await firstStep(noAccount);
  expect(taken.status).toBe(400);
  expect(JSON.parse(taken.text)).toEqual(refusal("closed", CLOSED));
  expect(free).toEqual(taken);

  // The invitation is what lets an address through, as it always has here.
  const email = at("invited-no-email", "elsewhere.example.test");
  await invite(email);
  const through = await firstStep(email);
  expect(through.status, through.text).toBe(200);
  const made = await lastStep(email, { emailVerificationToken: JSON.parse(through.text) });
  expect(made.status, made.text).toBe(200);
  await api.logIn(email, passwordOf(email));
  expect((await api.members(owner, orgId)).map((m) => m.email)).toContain(email);

  // With their account made, their address gets the answer everyone gets.
  expect(await firstStep(email)).toEqual(taken);
});

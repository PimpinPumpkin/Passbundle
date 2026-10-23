// Provisioning from Microsoft Entra ID on the server that sends email
// (DESIGN.md, "Provisioning from Entra ID"): someone the directory adds gets
// the usual invitation email and accepts it, and still waits for an owner or
// admin to let them in; with the client's install command, its email domains
// apply to the directory's invitations, so a provisioning token and a copied
// command together don't let in an address outside them.
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { Api, encString } from "../api/support";

import { inviteParams, verifyEmail, waitForMessage } from "./mailbox";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";

async function provision(request: import("@playwright/test").APIRequestContext, token: string, orgId: string, email: string) {
  const response = await request.fetch(`/scim/v2/${orgId}/Users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/scim+json" },
    data: JSON.stringify({
      schemas: [USER],
      externalId: randomUUID(),
      userName: `${randomUUID()}@contoso.onmicrosoft.com`,
      active: true,
      emails: [{ primary: true, type: "work", value: email }],
    }),
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).id as string;
}

test("someone the directory adds is invited by email, accepts, and waits to be let in", async ({ request }) => {
  const api = new Api(request);
  const owner = await api.account("mail-prov-owner");
  const orgName = `Mail Provisioning ${randomUUID().slice(0, 6)}`;
  const orgId = await api.organization(owner, orgName);
  const made = await api.call(owner, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.mailEnabled).toBe(true);

  const email = `mail-prov-${randomUUID().slice(0, 8)}@api.example.test`;
  const id = await provision(request, made.body.newToken, orgId, email);
  const link = inviteParams(await waitForMessage(email, new RegExp(`Join ${orgName}`)));
  expect(link.get("organizationUserId")).toBe(id);

  const person = await api.account("mail-prov-person", email);
  const accepted = await api.call(person, "POST", `/api/organizations/${orgId}/users/${id}/accept`, {
    token: link.get("token"),
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  // Nothing vouches for the directory's choice, so the owner hears that
  // someone accepted and is waiting, not that they're in.
  await waitForMessage(owner.email, new RegExp(`Invitation to ${orgName} accepted`));
  const pending = await api.call(owner, "GET", "/api/keykeeper/organizations/pending");
  expect(pending.body.data.find((p: { email: string }) => p.email === email)).toMatchObject({
    autoConfirm: false,
    inviteSeal: null,
  });
});

test("the install command's email domains apply to the directory's invitations", async ({ request }) => {
  const api = new Api(request);
  const admin = await api.account("mail-prov-msp");
  const mspId = await api.msp(admin, `Prov Domains IT ${randomUUID().slice(0, 6)}`);
  const orgId = await api.client(admin, mspId, `Prov Domains ${randomUUID().slice(0, 6)}`);
  const install = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment`);
  const command = install.body.token as string;
  const domains = await api.call(admin, "PUT", `/api/keykeeper/msp/${mspId}/clients/${orgId}/enrollment/domains`, {
    domains: ["api.example.test"],
  });
  expect(domains.status, JSON.stringify(domains.body)).toBe(200);
  const made = await api.call(admin, "POST", `/api/keykeeper/organizations/${orgId}/provisioning/token`);
  const token = made.body.newToken as string;
  const join = (who: import("../api/support").Account) =>
    api.call(who, "POST", "/api/keykeeper/enrollment/join", {
      token: command,
      proof: Buffer.alloc(32, 9).toString("base64"),
      resetPasswordKey: encString(`recovery-${who.email}`),
    });

  // Outside the domains: the directory invited them, but no admin chose them,
  // so the command refuses them, as it refuses anyone outside its domains.
  const outsider = await api.account("prov-outsider", `prov-outsider-${randomUUID().slice(0, 8)}@elsewhere.example.test`);
  await verifyEmail(api, outsider);
  await provision(request, token, orgId, outsider.email);
  const info = await api.call(outsider, "POST", "/api/keykeeper/enrollment/info", { token: command });
  expect(info.status).toBe(400);
  expect(info.body.message).toContain("install link is for api.example.test accounts");
  const refused = await join(outsider);
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain("install link is for api.example.test accounts");

  // At the domains, with a verified address: they join with the command and
  // its proof, and apps may let them in on their own.
  const insider = await api.account("prov-insider");
  await verifyEmail(api, insider);
  const insiderId = await provision(request, token, orgId, insider.email);
  const joined = await join(insider);
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  const pending = await api.call(admin, "GET", "/api/keykeeper/organizations/pending");
  expect(pending.body.data.find((p: { email: string }) => p.email === insider.email)).toMatchObject({
    memberId: insiderId,
    autoConfirm: true,
    joinProof: Buffer.alloc(32, 9).toString("base64"),
  });

  // Once an admin lets the outsider in (sealing their invitation), they're an
  // admin's choice, and the command takes them from any address.
  const seal = Buffer.alloc(32, 3).toString("base64");
  const letIn = await api.call(admin, "PUT", `/api/keykeeper/organizations/${orgId}/provisioning/seals`, {
    seals: [{ email: outsider.email, seal }],
  });
  expect(letIn.status, JSON.stringify(letIn.body)).toBe(200);
  expect((await join(outsider)).status).toBe(200);
});

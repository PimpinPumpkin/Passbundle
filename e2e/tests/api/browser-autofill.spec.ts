// The browsers' own card and address autofill, as an organization sets it
// (DESIGN.md, "Addresses and cards", "IT control of the browsers' own
// autofill"): leave as is (the default), off, or off with the offer to bring
// them in. Its owners, admins, and its MSP's admins change it; members learn
// it in sync; the install command carries it; an MSP sets it as a default
// policy, with the offer as its one option, and can require it.
import { expect, test } from "@playwright/test";

import { type Account, Api } from "./support";

const BROWSER_AUTOFILL_OFF = 1003;
const LEFT_AS_IS = 1682;
const TURNED_OFF = 1683;
const TURNED_OFF_WITH_OFFER = 1684;

type Mode = "unchanged" | "off" | "offAndImport";

const setting = (api: Api, who: Account, orgId: string) =>
  api.call(who, "GET", `/api/keykeeper/organizations/${orgId}/browser-autofill`);
const setTo = (api: Api, who: Account, orgId: string, mode: Mode | string) =>
  api.call(who, "PUT", `/api/keykeeper/organizations/${orgId}/browser-autofill`, { mode });

/** What a member's apps learn in sync. */
async function inSync(api: Api, who: Account, orgId: string): Promise<unknown> {
  const profile = await api.call(who, "GET", "/api/accounts/profile");
  return profile.body.organizations.find((o: { id: string }) => o.id === orgId)?.keykeeperBrowserAutofill;
}

const range = () => {
  const now = Date.now();
  return `start=${new Date(now - 3_600_000).toISOString()}&end=${new Date(now + 3_600_000).toISOString()}`;
};

async function orgEvents(api: Api, owner: Account, orgId: string) {
  const events = await api.call(owner, "GET", `/api/organizations/${orgId}/events?${range()}`);
  expect(events.status, JSON.stringify(events.body)).toBe(200);
  return events.body.data as { type: number; actingUserId: string }[];
}

test("an organization leaves them as they are by default, and its owners and admins change it, in sync and in its event log", async ({
  request,
}) => {
  const api = new Api(request);
  const owner = await api.account("ba-owner");
  const admin = await api.account("ba-admin");
  const member = await api.account("ba-member");
  const manager = await api.account("ba-manager");
  const invited = await api.account("ba-invited");
  const outsider = await api.account("ba-outsider");
  const orgId = await api.organization(owner, "Browser Autofill Org");
  await api.addMember(owner, orgId, admin, "admin");
  await api.addMember(owner, orgId, member, "user");
  await api.addMember(owner, orgId, manager, "manager");
  // The outsider owns an organization of their own.
  await api.organization(outsider, "Another Org");

  expect((await setting(api, owner, orgId)).body).toMatchObject({
    mode: "unchanged",
    msp: null,
    requiredByMsp: false,
  });
  expect(await inSync(api, member, orgId)).toBe("unchanged");

  // Only owners and admins read or change it; anyone else, another
  // organization's owner included, gets "not found".
  for (const who of [member, manager, invited, outsider]) {
    expect((await setting(api, who, orgId)).status).toBe(404);
    expect((await setTo(api, who, orgId, "off")).status).toBe(404);
  }
  expect(await inSync(api, member, orgId)).toBe("unchanged");

  // A value it doesn't know is refused, and changes nothing.
  const bad = await setTo(api, owner, orgId, "OFF");
  expect(bad.status).toBe(400);
  expect(bad.body.message).toMatch(/unchanged, off, or offAndImport/);
  expect((await setting(api, owner, orgId)).body.mode).toBe("unchanged");

  const off = await setTo(api, admin, orgId, "off");
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.mode).toBe("off");
  expect(await inSync(api, member, orgId)).toBe("off");
  // The same again changes nothing, and logs nothing more.
  expect((await setTo(api, admin, orgId, "off")).status).toBe(200);
  const offer = await setTo(api, owner, orgId, "offAndImport");
  expect(offer.body.mode).toBe("offAndImport");
  expect(await inSync(api, member, orgId)).toBe("offAndImport");
  const back = await setTo(api, owner, orgId, "unchanged");
  expect(back.body.mode).toBe("unchanged");
  expect(await inSync(api, member, orgId)).toBe("unchanged");

  const events = (await orgEvents(api, owner, orgId)).filter((e) =>
    [LEFT_AS_IS, TURNED_OFF, TURNED_OFF_WITH_OFFER].includes(e.type),
  );
  expect(events.map((e) => [e.type, e.actingUserId]).sort()).toEqual(
    [
      [TURNED_OFF, admin.userId],
      [TURNED_OFF_WITH_OFFER, owner.userId],
      [LEFT_AS_IS, owner.userId],
    ].sort(),
  );
});

test("an MSP's admins change it in a client, technicians don't, and an MSP turns them off by default, with the offer, and can require it", async ({
  request,
}) => {
  const api = new Api(request);
  const mspAdmin = await api.account("ba-msp-admin");
  const technician = await api.account("ba-msp-tech");
  const member = await api.account("ba-client-member");
  const mspId = await api.msp(mspAdmin, "Browser Autofill MSP");
  await api.addStaff(mspAdmin, mspId, technician, "technician");
  const clientId = await api.client(mspAdmin, mspId, "Lakeside Clinic");
  await api.addMember(mspAdmin, clientId, member, "user");

  // A client starts leaving them as they are, following the MSP (which has
  // no such default), and the MSP's install command for it says so.
  expect((await setting(api, mspAdmin, clientId)).body).toMatchObject({
    mode: "unchanged",
    msp: { id: mspId, name: "Browser Autofill MSP" },
  });
  const enrollment = async () =>
    (await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/clients/${clientId}/enrollment`)).body;
  expect((await enrollment()).browserAutofill).toBe("unchanged");
  const overview = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`);
  expect(overview.body.types).toContain(BROWSER_AUTOFILL_OFF);
  const own = async () =>
    (
      (await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`)).body.clients.find(
        (c: { id: string }) => c.id === clientId,
      ).own as { type: number }[]
    ).map((p) => p.type);
  expect(await own()).not.toContain(BROWSER_AUTOFILL_OFF);
  expect((await setting(api, technician, clientId)).status).toBe(404);
  expect((await setTo(api, technician, clientId, "off")).status).toBe(404);

  // An MSP admin turns them off in the client's own settings: its own
  // setting from then on, in the MSP's activity log.
  expect((await setTo(api, mspAdmin, clientId, "off")).status).toBe(200);
  expect(await inSync(api, member, clientId)).toBe("off");
  expect((await enrollment()).browserAutofill).toBe("off");
  expect(await own()).toContain(BROWSER_AUTOFILL_OFF);
  const activity = await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/events`);
  expect(
    (activity.body.data as { event: string; detail: string | null }[]).map((e) => `${e.event}:${e.detail}`),
  ).toContain("client_browser_autofill_set:off");

  // Use default puts it back as the MSP has it: left as is.
  const back = await api.call(mspAdmin, "POST", `/api/keykeeper/msp/${mspId}/policies/${BROWSER_AUTOFILL_OFF}/apply`, {
    clients: [clientId],
  });
  expect(back.status, JSON.stringify(back.body)).toBe(200);
  expect(await inSync(api, member, clientId)).toBe("unchanged");

  // A default that turns them off, with the offer, reaches every client that
  // follows; any other option is dropped.
  const offByDefault = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${BROWSER_AUTOFILL_OFF}`, {
    enabled: true,
    data: { offer: true, surprise: 1 },
  });
  expect(offByDefault.status, JSON.stringify(offByDefault.body)).toBe(200);
  expect(offByDefault.body.changed.map((c: { id: string }) => c.id)).toEqual([clientId]);
  expect(await inSync(api, member, clientId)).toBe("offAndImport");
  expect(await own()).not.toContain(BROWSER_AUTOFILL_OFF);
  const saved = (await api.call(mspAdmin, "GET", `/api/keykeeper/msp/${mspId}/policies`)).body.defaults.find(
    (d: { type: number }) => d.type === BROWSER_AUTOFILL_OFF,
  );
  expect(saved.data).toEqual({ offer: true });

  // A client without the offer has its own setting.
  expect((await setTo(api, mspAdmin, clientId, "off")).status).toBe(200);
  expect(await own()).toContain(BROWSER_AUTOFILL_OFF);

  // Required for every client: it reaches that client too, and nobody
  // changes it there.
  const required = await api.call(mspAdmin, "PUT", `/api/keykeeper/msp/${mspId}/policies/${BROWSER_AUTOFILL_OFF}`, {
    enabled: true,
    data: { offer: true },
    required: true,
  });
  expect(required.status, JSON.stringify(required.body)).toBe(200);
  expect(await inSync(api, member, clientId)).toBe("offAndImport");
  const refused = await setTo(api, mspAdmin, clientId, "unchanged");
  expect(refused.status).toBe(400);
  expect(refused.body.message).toMatch(/requires this policy for every client/);
  expect((await setting(api, mspAdmin, clientId)).body).toMatchObject({
    mode: "offAndImport",
    requiredByMsp: true,
  });
});

// Item templates an MSP sends to its clients. The console writes encrypted
// copies into each client's Templates collection; the server records the
// source, which clients get it, each copy, and each client's Templates
// collection, and never sees what's in a template. See DESIGN.md, "MSP
// templates".
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { type Account, Api, encString } from "./support";

type Templates = {
  templates: {
    templateId: string;
    sourceCipherId: string;
    allClients: boolean;
    clients: string[];
  }[];
  copies: {
    organizationId: string;
    templateId: string;
    cipherId: string;
    sourceRevision: string;
  }[];
  collections: Record<string, string | null>;
};

async function templates(api: Api, who: Account, mspId: string) {
  const result = await api.call(
    who,
    "GET",
    `/api/keykeeper/msp/${mspId}/templates`,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as Templates;
}

async function setTemplate(
  api: Api,
  admin: Account,
  mspId: string,
  templateId: string,
  data: { sourceCipherId: string; allClients: boolean; clients?: string[] },
) {
  return api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/templates/${templateId}`,
    data,
  );
}

test("an MSP admin sends a template to every client, records each client's copy and Templates collection, narrows it to chosen clients, and stops it", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const law = await api.client(admin, mspId, "Baker Law", "business");
  const source = await api.personalItem(admin);
  const id = randomUUID();

  const added = await setTemplate(api, admin, mspId, id, {
    sourceCipherId: source,
    allClients: true,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  let seen = await templates(api, admin, mspId);
  expect(seen.templates).toEqual([
    expect.objectContaining({
      templateId: id,
      sourceCipherId: source,
      allClients: true,
      clients: [],
    }),
  ]);
  expect(seen.copies).toEqual([]);
  expect(seen.collections).toEqual({ [dental]: null, [law]: null });

  // The console makes Acme Dental's Templates collection and a copy in it.
  const collection = await api.collection(admin, dental);
  const recorded = await api.call(
    admin,
    "PUT",
    `/api/keykeeper/msp/${mspId}/clients/${dental}/templates-collection`,
    { collectionId: collection },
  );
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
  const copy = await api.orgItem(admin, dental, collection);
  const sent = await api.call(
    admin,
    "POST",
    `/api/keykeeper/msp/${mspId}/templates/${id}/copies`,
    {
      copies: [
        {
          organizationId: dental,
          cipherId: copy,
          sourceRevision: "2026-10-16T10:00:00.000Z",
        },
      ],
    },
  );
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  seen = await templates(api, admin, mspId);
  expect(seen.collections[dental]).toBe(collection);
  expect(seen.copies).toEqual([
    {
      organizationId: dental,
      templateId: id,
      cipherId: copy,
      sourceRevision: "2026-10-16T10:00:00.000Z",
    },
  ]);

  // Narrowed to Baker Law, then stopped. The copy itself stays in Acme Dental.
  const narrowed = await setTemplate(api, admin, mspId, id, {
    sourceCipherId: source,
    allClients: false,
    clients: [law, law],
  });
  expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
  expect((await templates(api, admin, mspId)).templates[0]).toMatchObject({
    allClients: false,
    clients: [law],
  });
  const stopped = await api.call(
    admin,
    "DELETE",
    `/api/keykeeper/msp/${mspId}/templates/${id}`,
  );
  expect(stopped.status).toBe(200);
  seen = await templates(api, admin, mspId);
  expect(seen.templates).toEqual([]);
  expect(seen.copies).toEqual([]);
  expect(
    (await api.call(admin, "GET", `/api/ciphers/${copy}/admin`)).status,
  ).toBe(200);

  // The audit log names the template only by id.
  const events = (
    await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/events`)
  ).body.data as {
    event: string;
    organizationName: string | null;
    detail: string;
  }[];
  expect(
    events
      .filter((e) => e.event.startsWith("template_"))
      .map((e) => [e.event, e.organizationName, e.detail]),
  ).toEqual([
    ["template_stopped", null, id],
    ["template_changed", null, `${id}:1 client`],
    ["template_sent", "Acme Dental", `${id}:1 client`],
    ["template_added", null, `${id}:every client`],
  ]);
});

test("a template's source is an item the admin can see and share and never a client's copy, and copies must be items in the MSP's own clients", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const other = await api.account("other-msp-admin");
  const otherMsp = await api.msp(other, "Other IT");
  const theirs = await api.client(other, otherMsp, "Not Yours Inc", "business");
  const source = await api.personalItem(admin);
  const strangers = await api.personalItem(other);
  const dentalCollection = await api.collection(admin, dental);
  const copyInDental = await api.orgItem(admin, dental, dentalCollection);
  const theirCollection = await api.collection(other, theirs);
  const theirItem = await api.orgItem(other, theirs, theirCollection);
  const id = randomUUID();

  const refused = async (
    method: string,
    path: string,
    data: unknown,
    status: number,
    message: RegExp,
  ) => {
    const result = await api.call(admin, method, path, data);
    expect(result.status, JSON.stringify(result.body)).toBe(status);
    expect(result.body.message).toMatch(message);
  };
  const templatePath = `/api/keykeeper/msp/${mspId}/templates`;
  await refused(
    "PUT",
    `${templatePath}/not%20an%20id`,
    { sourceCipherId: source, allClients: true },
    400,
    /Invalid template id/,
  );
  await refused(
    "PUT",
    `${templatePath}/${id}`,
    { sourceCipherId: strangers, allClients: true },
    400,
    /Template not found/,
  );
  await refused(
    "PUT",
    `${templatePath}/${id}`,
    { sourceCipherId: copyInDental, allClients: true },
    400,
    /copy in one of your clients/,
  );
  // An item the admin can see but not share, which a template would copy
  // into other organizations: someone else's organization gives them Can
  // view on its folder (DESIGN.md, "Folders and permissions").
  const partner = await api.organization(other, "Partner Org");
  const partnerFolder = await api.collection(other, partner);
  const viewOnly = await api.orgItem(other, partner, partnerFolder);
  const adminThere = await api.addMember(other, partner, admin, "user");
  const granted = await api.call(
    other,
    "PUT",
    `/api/organizations/${partner}/collections/${partnerFolder}`,
    {
      name: encString("Partner folder"),
      users: [
        { id: adminThere, readOnly: true, hidePasswords: false, manage: false },
      ],
      groups: [],
    },
  );
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  await refused(
    "PUT",
    `${templatePath}/${id}`,
    { sourceCipherId: viewOnly, allClients: true },
    400,
    /permission to share/,
  );
  await refused(
    "PUT",
    `${templatePath}/${id}`,
    { sourceCipherId: source, allClients: false, clients: [dental, theirs] },
    400,
    /Client not found/,
  );
  await refused(
    "PUT",
    `${templatePath}/${id}`,
    { sourceCipherId: source, allClients: false, clients: [] },
    400,
    /at least one client/,
  );
  await refused(
    "POST",
    `${templatePath}/${id}/copies`,
    {
      copies: [
        { organizationId: dental, cipherId: copyInDental, sourceRevision: "r" },
      ],
    },
    404,
    /Template not found/,
  );

  expect(
    (
      await setTemplate(api, admin, mspId, id, {
        sourceCipherId: source,
        allClients: true,
      })
    ).status,
  ).toBe(200);
  const copies = (organizationId: string, cipherId: string) => ({
    copies: [{ organizationId, cipherId, sourceRevision: "r1" }],
  });
  await refused(
    "POST",
    `${templatePath}/${id}/copies`,
    copies(theirs, theirItem),
    400,
    /Client not found/,
  );
  await refused(
    "POST",
    `${templatePath}/${id}/copies`,
    copies(dental, theirItem),
    400,
    /Copy not found/,
  );
  await refused(
    "POST",
    `${templatePath}/${id}/copies`,
    copies(dental, source),
    400,
    /Copy not found/,
  );
  await refused(
    "PUT",
    `/api/keykeeper/msp/${mspId}/clients/${dental}/templates-collection`,
    { collectionId: theirCollection },
    400,
    /Collection not found/,
  );
  await refused(
    "PUT",
    `/api/keykeeper/msp/${mspId}/clients/${theirs}/templates-collection`,
    { collectionId: theirCollection },
    400,
    /Client not found/,
  );

  // Nothing was recorded.
  const seen = await templates(api, admin, mspId);
  expect(seen.copies).toEqual([]);
  expect(seen.collections[dental]).toBeNull();
});

test("copies are recorded only by an admin who can share the template's source now", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const dentalCollection = await api.collection(admin, dental);
  const copyInDental = await api.orgItem(admin, dental, dentalCollection);
  // The source is in another organization's folder, where the admin can edit
  // (and so share) to begin with.
  const partnerOwner = await api.account("partner-owner");
  const partner = await api.organization(partnerOwner, "Partner Org");
  const partnerFolder = await api.collection(partnerOwner, partner);
  const source = await api.orgItem(partnerOwner, partner, partnerFolder);
  const adminThere = await api.addMember(partnerOwner, partner, admin, "user");
  const grant = (readOnly: boolean) =>
    api.call(
      partnerOwner,
      "PUT",
      `/api/organizations/${partner}/collections/${partnerFolder}`,
      {
        name: encString("Partner folder"),
        users: [
          { id: adminThere, readOnly, hidePasswords: false, manage: false },
        ],
        groups: [],
      },
    );
  expect((await grant(false)).status).toBe(200);
  const id = randomUUID();
  expect(
    (
      await setTemplate(api, admin, mspId, id, {
        sourceCipherId: source,
        allClients: true,
      })
    ).status,
  ).toBe(200);
  const record = (who: Account, sourceRevision: string) =>
    api.call(who, "POST", `/api/keykeeper/msp/${mspId}/templates/${id}/copies`, {
      copies: [{ organizationId: dental, cipherId: copyInDental, sourceRevision }],
    });
  const recorded = async () =>
    (await templates(api, admin, mspId)).copies.map((c) => c.sourceRevision);

  expect((await record(admin, "r1")).status).toBe(200);
  expect(await recorded()).toEqual(["r1"]);

  // Another MSP admin, who can't see the source, can't record its copies.
  const second = await api.account("second-admin");
  await api.addStaff(admin, mspId, second, "admin");
  const unseen = await record(second, "r2");
  expect(unseen.status, JSON.stringify(unseen.body)).toBe(400);
  expect(unseen.body.message).toMatch(/permission to share/);

  // Nor can the admin who chose it, once the partner takes share away.
  expect((await grant(true)).status).toBe(200);
  const narrowed = await record(admin, "r2");
  expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(400);
  expect(narrowed.body.message).toMatch(/permission to share/);
  expect(await recorded()).toEqual(["r1"]);

  // Given share back, they can again.
  expect((await grant(false)).status).toBe(200);
  expect((await record(admin, "r3")).status).toBe(200);
  expect(await recorded()).toEqual(["r3"]);
});

test("a technician limited to chosen clients sees only the templates and copies in their clients, and can't send templates", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("msp-admin");
  const tech = await api.account("tech");
  const mspId = await api.msp(admin, "Northwind IT");
  const dental = await api.client(admin, mspId, "Acme Dental", "business");
  const law = await api.client(admin, mspId, "Baker Law", "business");
  await api.addStaff(admin, mspId, tech, "technician", {
        allClients: false,
        clients: [dental],
        custom: null,
        installCommands: true,
      });

  const source = await api.personalItem(admin);
  const everywhere = randomUUID();
  const lawOnly = randomUUID();
  for (const [id, data] of [
    [everywhere, { sourceCipherId: source, allClients: true }],
    [lawOnly, { sourceCipherId: source, allClients: false, clients: [law] }],
  ] as const) {
    expect((await setTemplate(api, admin, mspId, id, data)).status).toBe(200);
  }
  for (const org of [dental, law]) {
    const collection = await api.collection(admin, org);
    const copy = await api.orgItem(admin, org, collection);
    const sent = await api.call(
      admin,
      "POST",
      `/api/keykeeper/msp/${mspId}/templates/${everywhere}/copies`,
      {
        copies: [{ organizationId: org, cipherId: copy, sourceRevision: "r1" }],
      },
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  }

  const seen = await templates(api, tech, mspId);
  expect(seen.templates.map((t) => t.templateId)).toEqual([everywhere]);
  expect(seen.copies.map((c) => c.organizationId)).toEqual([dental]);
  expect(Object.keys(seen.collections)).toEqual([dental]);

  const changed = await setTemplate(api, tech, mspId, everywhere, {
    sourceCipherId: source,
    allClients: false,
    clients: [dental],
  });
  expect(changed.status).toBe(403);
});

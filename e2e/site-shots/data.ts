// Made-up people and items for the website's screenshots, as unencrypted
// Bitwarden JSON exports the web vault imports. Every name, address, and
// number is fictional; domains are reserved example names.

type Field = { name: string; value: string; type: 0 | 1 };

const inDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** PassBundle's expiration date field (see DESIGN.md, "Expiration dates"). */
const expires = (days: number): Field => ({ name: "keykeeper.expires", value: inDays(days), type: 0 });

function login(
  name: string,
  username: string,
  password: string,
  uri: string,
  extra: { folderId?: string; favorite?: boolean; totp?: string; fields?: Field[] } = {},
) {
  return {
    type: 1,
    name,
    folderId: extra.folderId ?? null,
    favorite: extra.favorite ?? false,
    notes: null,
    fields: extra.fields ?? [],
    reprompt: 0,
    login: { username, password, totp: extra.totp ?? null, uris: [{ match: null, uri }] },
    collectionIds: null,
  };
}

function note(name: string, fields: Field[], folderId: string | null = null) {
  return {
    type: 2,
    name,
    folderId,
    favorite: false,
    notes: null,
    fields,
    reprompt: 0,
    secureNote: { type: 0 },
    collectionIds: null,
  };
}

/** Sam's own vault: what a person or family keeps. */
export function personalVault() {
  return JSON.stringify({
    encrypted: false,
    folders: [
      { id: "8f1d3c55-0f6e-4b8e-9d0a-5b8f3a1c0001", name: "Bills" },
      { id: "8f1d3c55-0f6e-4b8e-9d0a-5b8f3a1c0002", name: "Family" },
    ],
    items: [
      login("Hometown Credit Union", "sam.rivera", "Tq7#vP2m!Lr9xWc4", "https://bank.example", {
        folderId: "8f1d3c55-0f6e-4b8e-9d0a-5b8f3a1c0001",
        favorite: true,
        totp: "JBSWY3DPEHPK3PXP",
      }),
      login("Family email", "sam@example.com", "orbit-canyon-velvet-73", "https://mail.example.com", {
        favorite: true,
      }),
      login("City Power & Light", "sam@example.com", "Hk4$wN8q@Zp2", "https://power.example", {
        folderId: "8f1d3c55-0f6e-4b8e-9d0a-5b8f3a1c0001",
      }),
      login("Water and sewer", "sam@example.com", "Bx9!rT5k#Qm3", "https://water.example", {
        folderId: "8f1d3c55-0f6e-4b8e-9d0a-5b8f3a1c0001",
      }),
      login("Lincoln Elementary parents", "rivera.family", "maple-harbor-quilt-18", "https://school.example", {
        folderId: "8f1d3c55-0f6e-4b8e-9d0a-5b8f3a1c0002",
      }),
      login("Streaming at home", "sam@example.com", "Wd3^yH7n$Cv6", "https://watch.example", {
        folderId: "8f1d3c55-0f6e-4b8e-9d0a-5b8f3a1c0002",
      }),
      login("Corner pharmacy", "sam@example.com", "Jm6&pL2s!Xr8", "https://pharmacy.example"),
      login("Dr. Okafor's patient portal", "sam.rivera", "Fz5@tK9w%Nb1", "https://clinic.example"),
      login("Mobile carrier", "sam@example.com", "Ru2*eM6x#Vq4", "https://mobile.example"),
      {
        type: 3,
        name: "Everyday Visa",
        folderId: null,
        favorite: false,
        notes: null,
        fields: [],
        reprompt: 0,
        card: {
          cardholderName: "Sam Rivera",
          brand: "Visa",
          number: "4111111111111111",
          expMonth: "9",
          expYear: "2029",
          code: "123",
        },
        collectionIds: null,
      },
      note("Passport", [
        { name: "Passport number", value: "X00000000", type: 1 },
        expires(12),
      ]),
      note(
        "Home Wi-Fi",
        [
          { name: "Network", value: "Rivera Home", type: 0 },
          { name: "Password", value: "lantern-meadow-ripple-42", type: 1 },
        ],
        "8f1d3c55-0f6e-4b8e-9d0a-5b8f3a1c0002",
      ),
    ],
  });
}

/** One of an MSP's clients: its people, and what it keeps in the shared vault. */
export type Client = {
  name: string;
  domain: string;
  people: string[];
  /** Logins with weak passwords, reused passwords, and expiring items, for the console's health columns. */
  weak: number;
  reused: number;
  expiring: number;
};

export const clients: Client[] = [
  {
    name: "Acme Dental",
    domain: "acmedental.example",
    people: ["Maria Lopez", "Dev Patel", "Grace Kim", "Tom Becker", "Aisha Bello", "Luis Ortega", "Emma Novak", "Ben Carter", "Priya Shah"],
    weak: 2,
    reused: 3,
    expiring: 1,
  },
  {
    name: "Baker & Hale Law",
    domain: "bakerhale.example",
    people: ["Helen Baker", "Marcus Hale", "Sofia Rossi", "James Wu", "Nina Petrova", "Owen Clark"],
    weak: 0,
    reused: 0,
    expiring: 2,
  },
  {
    name: "Cedar Pediatrics",
    domain: "cedarpeds.example",
    people: [
      "Rachel Green", "Ahmed Hassan", "Lily Chen", "Carlos Diaz", "Hannah Weber", "Kofi Mensah", "Zoe Martin",
      "Ravi Iyer", "Chloe Dubois", "Sam Taylor", "Ines Silva", "Noah Brooks", "Mei Tanaka", "Lucas Moreau",
    ],
    weak: 1,
    reused: 0,
    expiring: 0,
  },
  {
    name: "Linden Realty",
    domain: "lindenrealty.example",
    people: ["Paul Linden", "Erin Walsh", "Victor Huang", "Dana Fox"],
    weak: 4,
    reused: 2,
    expiring: 0,
  },
  {
    name: "Maple Street Bakery",
    domain: "maplestreet.example",
    people: ["Rosa Alvarez", "Finn O'Brien", "Kate Morgan"],
    weak: 0,
    reused: 0,
    expiring: 1,
  },
];

/** What a client keeps in its organization: shared logins, some weak, reused, or expiring. */
export function clientVault(client: Client) {
  const strong = (i: number) => `Kp${i}#mW8z!Qr${i}Lt4v`;
  const items = [
    login("Practice software", `admin@${client.domain}`, strong(1), `https://app.${client.domain}`),
    login("Microsoft 365 admin", `it@${client.domain}`, strong(2), "https://admin.example.com"),
    login("Firewall", "admin", strong(3), "https://192.0.2.1"),
    login("Business bank", "office", strong(4), "https://bank.example"),
    note("Office Wi-Fi", [
      { name: "Network", value: `${client.name} Office`, type: 0 },
      { name: "Password", value: "copper-river-lantern-55", type: 1 },
    ]),
  ];
  for (let i = 0; i < client.weak; i++) {
    items.push(login(["Front desk PC", "Copier", "Door system", "Voicemail"][i], "frontdesk", `office${i + 1}`, `https://device${i}.${client.domain}`));
  }
  for (let i = 0; i < client.reused; i++) {
    items.push(login(["Supplier portal", "Shipping account", "Payroll"][i], `office@${client.domain}`, "Summer-Harbor-2026!x", `https://vendor${i}.example`));
  }
  for (let i = 0; i < client.expiring; i++) {
    items.push(
      login(["Domain registrar", "TLS certificate"][i], `it@${client.domain}`, strong(10 + i), "https://registrar.example", {
        fields: [expires(9 + i * 11)],
      }),
    );
  }
  return JSON.stringify({ encrypted: false, folders: [], items });
}

/** A person's work email at their client: "Maria Lopez" at acmedental.example. */
export const emailOf = (person: string, client: Client) =>
  `${person.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".")}@${client.domain}`;

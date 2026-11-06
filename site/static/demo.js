// The home page's demo: a vault and an MSP console with made-up people and
// data. It all happens in this page: nothing is stored, and nothing is sent
// anywhere. Until it starts, or without scripts, the page shows a screenshot
// of the web vault instead. No innerHTML: every element is made with
// createElement, and every text is set with textContent.
(() => {
  "use strict";

  const root = document.querySelector("[data-demo]");
  if (!root) return;

  const SVG = "http://www.w3.org/2000/svg";
  // The apps' glyphs (site/icons.mjs).
  const KINDS = {
    login: { tone: "sapphire", glyph: "M8 14a4 4 0 1 1 3.87-5H21v3h-2v3h-3v-3h-4.13A4 4 0 0 1 8 14Z M7 10h.01" },
    card: { tone: "amethyst", glyph: "M3 6h18v12H3Z M3 10h18 M7 15h4" },
    note: {
      tone: "ruby",
      glyph: "M4 5h16v14H4Z M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M5.5 16c.6-1.8 2-2.8 3.5-2.8s2.9 1 3.5 2.8 M14 9h4 M14 13h4",
    },
    wifi: {
      tone: "turquoise",
      glyph: "M2.5 9a14 14 0 0 1 19 0 M5.5 12.5a9.5 9.5 0 0 1 13 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01",
    },
  };

  const ITEMS = [
    { id: "clinic", type: "login", name: "Dr. Okafor's patient portal", user: "sam.rivera", pw: "Spring2019!", site: "clinic.example", exposed: true },
    { id: "bank", type: "login", name: "Hometown Credit Union", user: "sam.rivera", pw: "Tq7#vP2m!Lr9xWc4", site: "bank.example", folder: "Bills", totp: true },
    { id: "power", type: "login", name: "City Power & Light", user: "sam@example.com", pw: "Hk4$wN8q@Zp2", site: "power.example", folder: "Bills" },
    { id: "water", type: "login", name: "Water and sewer", user: "sam@example.com", pw: "Hk4$wN8q@Zp2", site: "water.example", folder: "Bills" },
    { id: "mail", type: "login", name: "Family email", user: "sam@example.com", pw: "orbit-canyon-velvet-73", site: "mail.example.com", folder: "Family" },
    { id: "school", type: "login", name: "Lincoln Elementary parents", user: "rivera.family", pw: "maple-harbor-quilt-18", site: "school.example", folder: "Family" },
    { id: "stream", type: "login", name: "Streaming at home", user: "sam@example.com", pw: "Wd3^yH7n$Cv6", site: "watch.example", folder: "Family" },
    { id: "visa", type: "card", name: "Everyday Visa", holder: "Sam Rivera", number: "4111 1111 1111 1111", exp: "08/29", cvv: "737" },
    { id: "passport", type: "note", name: "Passport", number: "X48210537", expires: "in 12 days", folder: "Family", expiring: true },
    { id: "wifi", type: "wifi", name: "Home Wi-Fi", network: "Rivera-Home", pw: "quiet-lantern-orchard-52", folder: "Family" },
  ];

  const CLIENTS = [
    { id: "acme", name: "Acme Dental", people: 12, twofa: "11 of 12", tone: "sapphire", issues: [["warn", "Domain registrar login expires in 12 days"], ["warn", "Grace Kim has no two-step login"]] },
    { id: "baker", name: "Baker & Hale Law", people: 6, twofa: "4 of 6", tone: "amethyst", issues: [["bad", "The payroll password is used for 3 logins"], ["warn", "James Wu and Nina Petrova have no two-step login"]] },
    { id: "cedar", name: "Cedar Pediatrics", people: 18, twofa: "18 of 18", tone: "turquoise", issues: [["warn", "TLS certificate login expires in 30 days"]] },
    { id: "linden", name: "Linden Realty", people: 4, twofa: "2 of 4", tone: "topaz", issues: [["bad", "The firewall password was found in a data breach"], ["warn", "Erin Walsh and Dana Fox have no two-step login"], ["warn", "The copier password is weak"]] },
    { id: "maple", name: "Maple Street Bakery", people: 3, twofa: "3 of 3", tone: "ruby", issues: [] },
  ];

  const state = {
    mode: "vault",
    filter: "all",
    query: "",
    sel: "clinic",
    reveal: "",
    copied: "",
    pw: {},
    fixed: "",
    client: "linden",
    opened: "",
  };

  /** An element: h("button", { class: "x", text: "Hi", onclick: fn }, child, ...). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }

  /** Replaces an element's children, skipping the empty ones (false, null). */
  function put(el, ...kids) {
    el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  }

  function glyphTile(tone, glyph) {
    const span = h("span", { class: `tile ${tone}`, "aria-hidden": "true" });
    const svg = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.9", "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(k, v);
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", glyph);
    svg.append(path);
    span.append(svg);
    return span;
  }

  const kindTile = (type) => glyphTile(KINDS[type].tone, KINDS[type].glyph);

  function newPassword() {
    const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
    const buf = new Uint32Array(18);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join("");
  }

  const pwOf = (it) => state.pw[it.id] || it.pw;

  function issueOf(it) {
    if (it.type === "login" && it.exposed && !state.pw[it.id]) {
      return { level: "bad", short: "Breach", text: "This password was found in a data breach.", fix: true };
    }
    if (it.type === "login") {
      const twin = ITEMS.find((o) => o.id !== it.id && o.type === "login" && pwOf(o) === pwOf(it));
      if (twin) return { level: "warn", short: "Reused", text: `This password is also used for ${twin.name}.`, fix: true };
    }
    if (it.expiring) return { level: "info", short: "Expires", text: `This passport expires ${it.expires}.`, fix: false };
    return null;
  }

  function subOf(it) {
    if (it.type === "login") return it.user;
    if (it.type === "card") return "Visa, ending 1111";
    if (it.type === "note") return "Passport number and renewal";
    return it.network;
  }

  function matches(it) {
    const f = state.filter;
    if (["login", "card", "note", "wifi"].includes(f) && it.type !== f) return false;
    if ((f === "Bills" || f === "Family") && it.folder !== f) return false;
    if (f === "issues" && !issueOf(it)) return false;
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return `${it.name} ${it.user || ""} ${it.site || ""}`.toLowerCase().includes(q);
  }

  // A screen reader hears what a button did ("Copied").
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  function say(text) {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 50);
  }

  let copyTimer = 0;
  function copy(key, label, value) {
    try {
      navigator.clipboard?.writeText(value).catch(() => {});
    } catch {
      // A sample value that didn't reach the clipboard is fine.
    }
    state.copied = key;
    say(`Copied the ${label.toLowerCase()}`);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      state.copied = "";
      render();
    }, 1400);
    render();
  }

  // The parts that stay put; render() fills the rest in.
  const seg = (label, mode) =>
    h("button", { type: "button", "data-key": `mode:${mode}`, onclick: () => set({ mode }) }, label);
  const vaultTab = seg("My vault", "vault");
  const mspTab = seg("MSP console", "msp");
  const search = h("input", {
    class: "demo-search",
    type: "search",
    placeholder: "Search the vault",
    "aria-label": "Search the vault",
    autocomplete: "off",
    oninput: (e) => set({ query: e.target.value }),
  });
  const status = h("span", { class: "demo-status", text: "5 clients, 43 seats in use from one pool" });
  const nav = h("nav", { class: "demo-nav", "aria-label": "Vault" });
  const list = h("div", { class: "demo-list", role: "region", "aria-label": "Items" });
  const detail = h("div", { class: "demo-detail", role: "region", "aria-label": "Item" });
  const vaultView = h("div", { class: "demo-body" }, nav, list, detail);
  const clients = h("div", { class: "demo-clients", role: "region", "aria-label": "Clients" });
  const client = h("div", { class: "demo-client", role: "region", "aria-label": "Client" });
  const mspView = h("div", { class: "demo-msp" }, clients, client);

  function set(change) {
    Object.assign(state, change);
    render();
  }

  function renderNav() {
    const count = (fn) => ITEMS.filter(fn).length;
    const entries = [
      ["all", "All items", ITEMS.length],
      ["login", "Logins", count((i) => i.type === "login")],
      ["card", "Cards", count((i) => i.type === "card")],
      ["note", "Notes", count((i) => i.type === "note")],
      ["wifi", "Wi-Fi", count((i) => i.type === "wifi")],
      "Shared folders",
      ["Bills", "Bills", count((i) => i.folder === "Bills")],
      ["Family", "Family", count((i) => i.folder === "Family")],
      "Health",
      ["issues", "Needs attention", count((i) => !!issueOf(i)), true],
    ];
    nav.replaceChildren(
      ...entries.map((e) => {
        if (typeof e === "string") return h("p", { text: e });
        const [id, label, n, alert] = e;
        return h(
          "button",
          {
            type: "button",
            "data-key": `nav:${id}`,
            "aria-pressed": state.filter === id,
            onclick: () => set({ filter: id }),
          },
          h("span", { text: label }),
          h("span", { class: `demo-count${alert && n > 0 ? " alert" : ""}`, text: String(n) }),
        );
      }),
    );
  }

  function renderList() {
    const shown = ITEMS.filter(matches);
    if (shown.length === 0) {
      const q = state.query.trim();
      list.replaceChildren(h("p", { class: "demo-empty", text: q ? `Nothing matches "${q}".` : "All clear. Nothing needs attention." }));
      return;
    }
    list.replaceChildren(
      ...shown.map((it) => {
        const issue = issueOf(it);
        return h(
          "button",
          {
            type: "button",
            class: "demo-item",
            "data-key": `item:${it.id}`,
            "aria-pressed": state.sel === it.id,
            onclick: () => {
              set({ sel: it.id, reveal: "", fixed: "" });
              // On a phone the item opens below the list: bring it into view.
              if (matchMedia("(max-width: 640px)").matches) {
                const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
                detail.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
              }
            },
          },
          kindTile(it.type),
          h("span", { class: "demo-item-text" }, h("b", { text: it.name }), h("span", { text: subOf(it) })),
          issue && h("span", { class: `badge ${issue.level}`, text: issue.short }),
        );
      }),
    );
  }

  function code() {
    // A stand-in for a two-step code: a new six digits every 30 seconds.
    const step = Math.floor(Date.now() / 30000);
    const n = String((Math.imul(step ^ 0x5bd1e995, 2654435761) >>> 0) % 1000000).padStart(6, "0");
    return { value: `${n.slice(0, 3)} ${n.slice(3)}`, left: 30 - (Math.floor(Date.now() / 1000) % 30) };
  }

  let codeValue = null;
  let codeNote = null;

  function field(it, key, label, value, opts = {}) {
    const id = `${it.id}:${key}`;
    const shown = !opts.secret || state.reveal === id;
    const copied = state.copied === id;
    const lower = label.toLowerCase();
    const valueEl = h("span", {
      class: `demo-value${opts.secret || opts.mono ? " mono" : ""}${opts.code ? " code" : ""}`,
      text: shown ? value : opts.masked || "••••••••••••",
    });
    const noteEl = opts.note ? h("span", { class: "demo-note", text: opts.note }) : null;
    if (opts.code) {
      codeValue = valueEl;
      codeNote = noteEl;
    }
    return h(
      "div",
      { class: "demo-field" },
      h("div", { class: "demo-field-text" }, h("span", { class: "demo-label", text: label }), valueEl, noteEl),
      opts.secret &&
        h("button", {
          type: "button",
          class: "demo-btn",
          "data-key": `reveal:${id}`,
          "aria-label": `${shown ? "Hide" : "Show"} the ${lower}`,
          text: shown ? "Hide" : "Show",
          onclick: () => set({ reveal: shown ? "" : id }),
        }),
      opts.generate &&
        h("button", {
          type: "button",
          class: "demo-btn",
          "data-key": `new:${id}`,
          "aria-label": "Make a new password",
          text: "New",
          onclick: () => {
            set({ pw: { ...state.pw, [it.id]: newPassword() }, reveal: `${it.id}:pw` });
            say("Made a new password");
          },
        }),
      opts.copy !== false &&
        h("button", {
          type: "button",
          class: `demo-btn copy${copied ? " done" : ""}`,
          "data-key": `copy:${id}`,
          "aria-label": `Copy the ${lower}`,
          text: copied ? "Copied" : "Copy",
          onclick: () => copy(id, label, opts.code ? code().value.replace(" ", "") : value),
        }),
    );
  }

  function renderDetail() {
    codeValue = null;
    codeNote = null;
    const it = ITEMS.find((i) => i.id === state.sel);
    if (!it) {
      detail.replaceChildren();
      return;
    }
    const issue = issueOf(it);
    let where = { login: it.site, card: "Payment card", note: "Secure note", wifi: "Wi-Fi network" }[it.type];
    if (it.folder) where += `, in ${it.folder}`;

    const fields = [];
    if (it.type === "login") {
      fields.push(field(it, "user", "Username", it.user));
      fields.push(field(it, "pw", "Password", pwOf(it), { secret: true, generate: true }));
      if (it.totp) {
        const c = code();
        fields.push(field(it, "totp", "Two-step code", c.value, { mono: true, code: true, note: `New code in ${c.left}s` }));
      }
      fields.push(field(it, "site", "Website", `https://${it.site}`));
    } else if (it.type === "card") {
      fields.push(field(it, "holder", "Cardholder name", it.holder));
      fields.push(field(it, "number", "Number", it.number, { secret: true, masked: "•••• •••• •••• 1111" }));
      fields.push(field(it, "exp", "Expires", it.exp, { copy: false }));
      fields.push(field(it, "cvv", "Security code", it.cvv, { secret: true, masked: "•••" }));
    } else if (it.type === "note") {
      fields.push(field(it, "number", "Passport number", it.number, { secret: true, masked: "•••••••••" }));
      fields.push(field(it, "expires", "Expires", "November 18, 2026", { copy: false }));
    } else {
      fields.push(field(it, "network", "Network name", it.network));
      fields.push(field(it, "pw", "Password", it.pw, { secret: true }));
      fields.push(field(it, "security", "Security", "WPA3", { copy: false }));
    }

    put(
      detail,
      h("div", { class: "demo-head" }, kindTile(it.type), h("div", {}, h("h3", { text: it.name }), h("span", { class: "demo-where", text: where }))),
      issue &&
        h(
          "div",
          { class: `demo-alert ${issue.level}` },
          h("p", { text: issue.text }),
          issue.fix &&
            h("button", {
              type: "button",
              class: "demo-btn primary",
              "data-key": `fix:${it.id}`,
              text: "Make a new one",
              onclick: () => {
                set({ pw: { ...state.pw, [it.id]: newPassword() }, reveal: `${it.id}:pw`, fixed: it.id });
                say("Saved a strong new password");
              },
            }),
        ),
      !issue && state.fixed === it.id && h("p", { class: "demo-ok", text: "Saved a strong new password. Use it on the site to finish the change." }),
      h("div", { class: "demo-fields" }, fields),
      it.folder &&
        h(
          "div",
          { class: "demo-shared" },
          h(
            "span",
            { class: "demo-avatars", "aria-hidden": "true" },
            h("span", { class: "avatar a1", text: "SR" }),
            h("span", { class: "avatar a2", text: "AR" }),
            h("span", { class: "avatar a3", text: "JR" }),
          ),
          h("span", { text: `Shared with Alex and Jordan in ${it.folder}` }),
        ),
    );
  }

  function renderMsp() {
    const cur = CLIENTS.find((c) => c.id === state.client) || CLIENTS[0];
    clients.replaceChildren(
      h(
        "div",
        { class: "demo-table" },
        h(
          "div",
          { class: "demo-row head", "aria-hidden": "true" },
          h("span", { text: "Client" }),
          h("span", { text: "People" }),
          h("span", { text: "Two-step login" }),
          h("span", { text: "Needs attention" }),
        ),
        CLIENTS.map((c) => {
          const bad = c.issues.some(([level]) => level === "bad");
          const n = c.issues.length;
          const needs = n === 0 ? "None" : `${n} ${n === 1 ? "item" : "items"}`;
          return h(
            "button",
            {
              type: "button",
              class: "demo-row",
              "data-key": `client:${c.id}`,
              "aria-pressed": c.id === cur.id,
              "aria-label": `${c.name}: ${c.people} people, two-step login ${c.twofa}, needs attention: ${needs}`,
              onclick: () => set({ client: c.id, opened: "" }),
            },
            h(
              "span",
              { class: "demo-client-name" },
              h("span", { class: `tile small ${c.tone}`, "aria-hidden": "true", text: c.name.charAt(0) }),
              h("span", { text: c.name }),
            ),
            h("span", { text: String(c.people) }),
            h("span", { text: c.twofa }),
            h("span", {}, h("span", { class: `badge${bad ? " bad" : n ? " warn" : ""}`, text: needs })),
          );
        }),
      ),
    );
    put(
      client,
      h("h3", { text: cur.name }),
      h("span", { class: "demo-where", text: `${cur.people} people, with your MSP's default policies` }),
      cur.issues.length
        ? h(
            "ul",
            { class: "demo-issues" },
            cur.issues.map(([level, text]) => h("li", {}, h("span", { class: `demo-dot ${level}`, "aria-hidden": "true" }), h("span", { text }))),
          )
        : h("p", { class: "demo-where", text: "Nothing needs attention." }),
      h(
        "div",
        { class: "actions" },
        h("button", {
          type: "button",
          class: "demo-btn primary",
          "data-key": `open:${cur.id}`,
          text: "Open their vault",
          onclick: () => set({ opened: cur.id }),
        }),
      ),
      state.opened === cur.id && h("p", { class: "demo-where", text: `In the real console, this opens ${cur.name}'s vault.` }),
    );
  }

  function render() {
    // Keep the keyboard where it was when the part it was on is redrawn.
    const focused = root.contains(document.activeElement) ? document.activeElement.getAttribute("data-key") : null;
    vaultTab.setAttribute("aria-pressed", String(state.mode === "vault"));
    mspTab.setAttribute("aria-pressed", String(state.mode === "msp"));
    const vault = state.mode === "vault";
    search.hidden = !vault;
    status.hidden = vault;
    vaultView.hidden = !vault;
    mspView.hidden = vault;
    if (vault) {
      renderNav();
      renderList();
      renderDetail();
    } else {
      renderMsp();
    }
    if (focused) root.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  root.replaceChildren(
    h(
      "div",
      { class: "demo-top" },
      h("div", { class: "demo-seg", role: "group", "aria-label": "Show" }, vaultTab, mspTab),
      search,
      status,
      h("span", { class: "chip", text: "Sample data" }),
    ),
    vaultView,
    mspView,
    live,
  );
  render();

  // The two-step code counts down without redrawing anything else.
  setInterval(() => {
    if (!codeValue || state.mode !== "vault") return;
    const c = code();
    codeValue.textContent = c.value;
    if (codeNote) codeNote.textContent = `New code in ${c.left}s`;
  }, 1000);
})();

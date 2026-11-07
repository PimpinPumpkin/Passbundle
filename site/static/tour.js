// The homepage's demo (parts/tour.html): six small apps with made-up data,
// the extension, the web vault, the desktop app, the phone app, a family,
// and the MSP console, with tips on top that point at what to try next.
//
// The apps: each part's screen works like the real thing, with or without
// the tips. The extension, desktop, phone, and family screens are drawn in
// the HTML; their app here keeps their state and turns it into words (an
// element shows when its data-show has one of them, hides when its
// data-hide has one, and data-pressed sets aria-pressed), and data-act names
// what a click on an element does. The web vault and the MSP console are
// drawn here from their data. Nothing is stored or sent: Copy puts a
// made-up value on the clipboard, and that's all.
//
// The tips: each part's steps are the <ol class="tour-steps"> under it, so
// without scripts the page shows the first part's screen and steps as a
// list (and a part a link names, by :target). Each step says:
//   data-target   the [data-x] it points at, ringed (the tip docks under
//                 the screen while that isn't on screen)
//   data-state    its scene: words the part's app reads to put its screen
//                 where the step is about, when the visitor goes to it with
//                 Back or Next
//   data-advance  "click": doing it (clicking the target) moves on
//   data-pick     the click is PassBundle's (a login, a code, a passkey):
//                 the self-playing part lands it with a flourish
//   data-place    where the tip sits: top, bottom, left, or right
//   data-anchor   optional: the [data-x] the tip sits beside, when that
//                 isn't the target (so it doesn't cover what it explains)
// Clicking something a step points at goes on from that step, wherever the
// tips were; clicking anything else means the visitor is playing on their
// own, so the tip steps aside (Back, Next, and "Show tip" under the screen)
// until they do what it says or ask for it. A part with data-autoplay plays
// itself once when it comes into view, a pointer clicking through its steps
// up to the one marked data-autoplay-end, unless the device asks for less
// motion; it stops for good the moment the visitor clicks or types in it,
// and the Play button beside the tabs controls it. The Tips switch hides the
// tips and rings and leaves Back and Next; the browser remembers "off" on
// the device (the privacy policy says so). No innerHTML: everything is made
// with createElement, and every text set with textContent.
(() => {
  "use strict";

  const parts = [...document.querySelectorAll(".tour-part")];
  if (parts.length === 0) return;
  // Without this, CSS shows a part a link names (:target), for no scripts.
  document.documentElement.dataset.tour = "on";
  const tabs = [...document.querySelectorAll("[data-tour-tab]")];
  // Narrower than this, tips sit under the screen rather than on it.
  const NARROW = 960;
  // How far the ring reaches past its element: outline-offset, width, and
  // the pulse.
  const RING = 9;
  const main = parts[0].parentElement;
  const lessMotion = matchMedia("(prefers-reduced-motion: reduce)");

  let tips = true;
  try {
    tips = localStorage.getItem("tourTips") !== "off";
  } catch {
    // Storage blocked: tips stay on.
  }

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)));
  const wordsOf = (s) => (s || "").split(/\s+/).filter(Boolean);
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const shows = (el) => !!el && el.getClientRects().length > 0;

  // ===== Building blocks =================================================

  /** An element: h("button", { class: "x", text: "Hi", onclick: fn }, child, ...). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }

  /** Replaces an element's children, skipping the empty ones (false, null). */
  const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

  const SVG = "http://www.w3.org/2000/svg";
  function svg(viewBox, d, attrs) {
    const el = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ viewBox, "aria-hidden": "true", focusable: "false", ...attrs })) el.setAttribute(k, v);
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    if (attrs && attrs["fill-rule"]) path.setAttribute("fill-rule", attrs["fill-rule"]);
    el.append(path);
    return el;
  }

  // The apps' glyphs (site/icons.mjs), and the logo's lock.
  const GLYPH = {
    key: "M8 14a4 4 0 1 1 3.87-5H21v3h-2v3h-3v-3h-4.13A4 4 0 0 1 8 14Z M7 10h.01",
    card: "M3 6h18v12H3Z M3 10h18 M7 15h4",
    note: "M4 5h16v14H4Z M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M5.5 16c.6-1.8 2-2.8 3.5-2.8s2.9 1 3.5 2.8 M14 9h4 M14 13h4",
    wifi: "M2.5 9a14 14 0 0 1 19 0 M5.5 12.5a9.5 9.5 0 0 1 13 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01",
    send: "M21 3 3 10.5l7 3 3 7.5Z M10 13.5 21 3",
  };
  const KIND = { login: ["sapphire", GLYPH.key], card: ["amethyst", GLYPH.card], note: ["ruby", GLYPH.note], wifi: ["turquoise", GLYPH.wifi] };
  const MARK =
    "M4.5 13V8.5a8.5 8.5 0 0 1 17 0V13h-4V8.5a4.5 4.5 0 0 0-9 0V13ZM4.5 13h17a4.5 4.5 0 0 1 4.5 4.5V18H0v-.5A4.5 4.5 0 0 1 4.5 13ZM0 20h26v5H0ZM0 27h26v.5a4.5 4.5 0 0 1-4.5 4.5h-17A4.5 4.5 0 0 1 0 27.5Z";

  function tile(tone, glyph, size) {
    const icon = svg("0 0 24 24", glyph, { fill: "none", stroke: "currentColor", "stroke-width": "1.9", "stroke-linecap": "round", "stroke-linejoin": "round" });
    return h("span", { class: `tile ${tone}${size ? ` ${size}` : ""}`, "aria-hidden": "true" }, icon);
  }
  const kindTile = (type, size) => tile(KIND[type][0], KIND[type][1], size);
  const mark = () => h("span", { class: "brand-tile mini", "aria-hidden": "true" }, svg("0 0 26 32", MARK, { "fill-rule": "evenodd" }));

  // A screen reader hears what a click did ("Copied the password").
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  main.append(live);
  let sayTimer = 0;
  function say(text) {
    live.textContent = "";
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => (live.textContent = text), 60);
  }

  // Copy: the visitor's own clicks put the made-up value on the clipboard.
  function toClipboard(text, e) {
    if (!e || !e.isTrusted) return;
    try {
      navigator.clipboard?.writeText(text).catch(() => {});
    } catch {
      // A sample value that didn't reach the clipboard is fine.
    }
  }

  // A button says what it did for a moment ("Copied"), or until it's
  // drawn again (ms 0).
  const flashes = new WeakMap();
  function flash(btn, text = "Copied", ms = 1400) {
    if (!btn) return;
    if (!flashes.has(btn)) flashes.set(btn, { was: btn.textContent, timer: 0 });
    const f = flashes.get(btn);
    clearTimeout(f.timer);
    btn.textContent = text;
    btn.classList.add("done");
    if (ms) {
      f.timer = setTimeout(() => {
        btn.textContent = f.was;
        btn.classList.remove("done");
        flashes.delete(btn);
      }, ms);
    }
  }

  // A stand-in for a two-step code: six new digits every 30 seconds. Every
  // [data-code] shows it, and every [data-code-left] counts down.
  function code() {
    const step = Math.floor(Date.now() / 30000);
    const n = String((Math.imul(step ^ 0x5bd1e995, 2654435761) >>> 0) % 1000000).padStart(6, "0");
    return { value: `${n.slice(0, 3)} ${n.slice(3)}`, left: 30 - (Math.floor(Date.now() / 1000) % 30) };
  }
  function tick() {
    const c = code();
    for (const el of document.querySelectorAll("[data-code]")) el.textContent = c.value;
    for (const el of document.querySelectorAll("[data-code-left]")) el.textContent = `New code in ${c.left}s`;
  }
  tick();
  setInterval(() => document.hidden || tick(), 1000);

  // The generator's default: 20 characters of every kind, leaving out
  // look-alikes (0 O, 1 l I), or six words.
  const CHARS = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*";
  const WORDS = wordsOf(
    "orbit canyon velvet maple harbor quilt lantern meadow ripple copper river ember alpine tiger ladder willow sparrow granite cobalt basil pepper thistle marble prairie glacier cedar falcon otter saffron harvest beacon juniper",
  );
  function randoms(n) {
    const a = new Uint32Array(n);
    crypto.getRandomValues(a);
    return [...a];
  }
  function newPassword(length = 20) {
    for (;;) {
      const pw = randoms(length).map((n) => CHARS[n % CHARS.length]).join("");
      if (length < 8 || [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].every((re) => re.test(pw))) return pw;
    }
  }
  const newPassphrase = (words = 6) => randoms(words).map((n) => WORDS[n % WORDS.length]).join("-");
  const token = (n) => randoms(n).map((v) => "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[v % 57]).join("");

  /** Shows and hides a screen's pieces by its words (see parts/tour.html). */
  function painter(stage) {
    return (words) => {
      const any = (attr) => wordsOf(attr).some((w) => words.has(w));
      for (const el of stage.querySelectorAll("[data-show], [data-hide]")) {
        el.hidden = ("show" in el.dataset && !any(el.dataset.show)) || any(el.dataset.hide);
      }
      for (const el of stage.querySelectorAll("[data-pressed]")) el.setAttribute("aria-pressed", String(any(el.dataset.pressed)));
    };
  }

  /**
   * Runs the [data-act] a click lands on, acts[name](element, event), after
   * before(event) and then draws the screen.
   */
  function actions(stage, acts, draw, before) {
    stage.addEventListener("click", (e) => {
      before?.(e);
      const el = e.target.closest("[data-act]");
      if (el && stage.contains(el)) acts[el.dataset.act]?.(el, e);
      draw();
    });
  }

  /** Keeps the keyboard where it was when part of a screen is drawn again. */
  function keepFocus(root, draw) {
    const key = root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    draw();
    if (key) root.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }

  /**
   * One field of an item: its label and value, Show for a secret, and Copy.
   * mem.shown remembers what's showing when the item is drawn again.
   */
  function field(mem, key, label, value, opt = {}) {
    const lower = label.toLowerCase();
    const masked = opt.masked || "••••••••••";
    const isShown = () => !opt.secret || mem.shown.has(key);
    const out = h("span", {
      class: `demo-value${opt.secret || opt.mono ? " mono" : ""}${opt.code ? " code" : ""}`,
      text: isShown() ? value : masked,
      "data-code": opt.code ? "" : null,
    });
    const note = opt.code && h("span", { class: "demo-note", "data-code-left": "", text: `New code in ${code().left}s` });
    const show =
      opt.secret &&
      h("button", {
        type: "button",
        class: "demo-btn",
        "data-key": `show:${key}`,
        "aria-label": `${isShown() ? "Hide" : "Show"} the ${lower}`,
        text: isShown() ? "Hide" : "Show",
        onclick: () => {
          if (isShown()) mem.shown.delete(key);
          else mem.shown.add(key);
          out.textContent = isShown() ? value : masked;
          show.textContent = isShown() ? "Hide" : "Show";
          show.setAttribute("aria-label", `${show.textContent} the ${lower}`);
        },
      });
    const copy =
      opt.copy !== false &&
      h("button", {
        type: "button",
        class: "demo-btn copy",
        "data-key": `copy:${key}`,
        "data-x": opt.x,
        "aria-label": `Copy the ${lower}`,
        text: "Copy",
        onclick: (e) => {
          toClipboard(opt.code ? code().value.replace(" ", "") : value, e);
          flash(copy);
          say(`Copied the ${lower}`);
        },
      });
    return h(
      "div",
      { class: "demo-field" },
      h("div", { class: "demo-field-text" }, h("span", { class: "demo-label", text: label }), out, note),
      show,
      copy,
    );
  }

  // ===== The apps ========================================================
  // Each takes { stage, refresh } (refresh: the tip finds its target again
  // after the screen changes) and returns { scene(words) }.

  // ----- The browser extension: a bank with a two-step code, a bakery with
  // a passkey, and PassBundle's toolbar popup.
  function extension({ stage, refresh }) {
    const paint = painter(stage);
    const fresh = () => ({ tab: "bank", bank: "signin", filled: false, coded: false, menu: "", bakery: "signin", pk: false, popup: false, pop: "vault", err: "" });
    let st = fresh();
    let inlineMenu = true;
    const gen = { kind: "password", length: 20, words: 6 };
    const out = stage.querySelector("[data-gen-out]");
    const note = stage.querySelector("[data-gen-note]");
    const range = stage.querySelector("[data-gen-len]");
    const rangeLabel = stage.querySelector("[data-gen-len-label]");
    const search = stage.querySelector(".pop-search");
    const sends = stage.querySelector("[data-send-list]");
    const SENDS = ["Gate code for Jordan", "Note for Alex", "Door code for the sitter"];

    const page = () => (st.tab === "bank" ? st.bank : st.bakery);
    function render() {
      const w = new Set([st.tab, `at-${st.tab}-${page()}`, `pop-${st.pop}`, `gen-${gen.kind}`]);
      if (st.filled) w.add("filled");
      if (st.coded) w.add("coded");
      if (st.menu) w.add(st.menu === "code" ? "codemenu" : "menu");
      if (st.pk) w.add("pkprompt");
      if (st.popup) w.add("popup");
      if (st.err) w.add(`err-${st.err}`);
      if (page() !== "home") w.add("fillable");
      paint(w);
      refresh();
    }

    function makeGen() {
      const words = gen.kind === "passphrase";
      const n = words ? gen.words : gen.length;
      range.min = words ? "3" : "8";
      range.max = words ? "10" : "64";
      range.value = String(n);
      const label = words ? `${n} words` : `${n} characters`;
      rangeLabel.textContent = label;
      range.setAttribute("aria-valuetext", label);
      range.setAttribute("aria-label", words ? "Words" : "Length");
      out.textContent = words ? newPassphrase(n) : newPassword(n);
      const strong = words ? (n >= 5 ? "very strong" : n === 4 ? "strong" : "weak") : n >= 14 ? "very strong" : n >= 10 ? "strong" : "weak";
      note.textContent = `${label}, ${strong}`;
    }
    range.addEventListener("input", () => {
      gen[gen.kind === "passphrase" ? "words" : "length"] = Number(range.value);
      makeGen();
    });
    makeGen();

    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let n = 0;
      for (const item of stage.querySelectorAll(".pop-item[data-name]")) {
        item.hidden = !!q && !item.dataset.name.includes(q);
        if (!item.hidden) n++;
      }
      stage.querySelector("[data-pop-empty]").hidden = n > 0;
    });

    // What the page asks for: the login on the sign-in form, the code on
    // the next.
    function fill() {
      if (st.tab === "bank" && st.bank === "signin") {
        st.filled = true;
        say("Filled your username and password");
      } else if (st.tab === "bank" && st.bank === "code") {
        stage.querySelector("[data-code-fill]").textContent = code().value;
        st.coded = true;
        say("Filled the two-step code");
      }
      st.menu = "";
      st.err = "";
    }
    function bakeryIn() {
      st.pk = false;
      st.popup = false;
      st.bakery = "home";
      say("Signed in to Juniper Bakery with your passkey");
    }

    const acts = {
      tab: (el) => Object.assign(st, { tab: el.dataset.tab, menu: "", pk: false, popup: false, err: "" }),
      popup: () => Object.assign(st, { popup: !st.popup, menu: "", pk: false }),
      field: () => {
        if (!inlineMenu || page() === "home" || st.tab !== "bank") return;
        const want = st.bank === "code" ? "code" : "login";
        st.menu = st.menu === want ? "" : want;
      },
      fill,
      signin: (el, e) => {
        if (!st.filled) {
          st.err = "signin";
          e.preventDefault();
          return;
        }
        Object.assign(st, { bank: "code", err: "", menu: inlineMenu ? "code" : "" });
      },
      verify: (el, e) => {
        if (!st.coded) {
          st.err = "code";
          e.preventDefault();
          return;
        }
        Object.assign(st, { bank: "home", err: "", menu: "" });
        say("Signed in to Hometown Credit Union");
      },
      "bank-out": () => Object.assign(st, { bank: "signin", filled: false, coded: false }),
      pk: () => Object.assign(st, { pk: true, popup: false }),
      "pk-use": bakeryIn,
      "pk-cancel": () => (st.pk = false),
      "bakery-out": () => (st.bakery = "signin"),
      "pop-tab": (el) => (st.pop = el.dataset.pop),
      "pop-fill": () => {
        fill();
        st.popup = false;
      },
      "pop-passkey": bakeryIn,
      copy: (el, e) => {
        toClipboard(el.dataset.value, e);
        flash(el);
        say(`Copied the ${el.dataset.label}`);
      },
      regen: () => {
        makeGen();
        say(gen.kind === "passphrase" ? "Made a new passphrase" : "Made a new password");
      },
      "gen-kind": (el) => {
        gen.kind = el.dataset.kind;
        makeGen();
      },
      "copy-gen": (el, e) => {
        toClipboard(out.textContent, e);
        flash(el);
        say(`Copied the ${gen.kind}`);
      },
      "new-send": () => {
        const name = SENDS[(sends.children.length - 1) % SENDS.length];
        const link = `https://vault.passbundle.com/#/send/${token(10)}/${token(22)}`;
        sends.append(
          h(
            "span",
            { class: "pop-item" },
            tile("sapphire", GLYPH.send, "small"),
            h("span", { class: "ui-who" }, h("b", { text: name }), h("span", { text: "Deletes in 7 days" })),
            h("button", { type: "button", class: "demo-btn", "data-act": "copy", "data-value": link, "data-label": "link", "aria-label": `Copy the link to ${name}`, text: "Copy link" }),
          ),
        );
        say(`Made a Send: ${name}. Copy its link to share it.`);
      },
      switch: (el) => {
        const on = el.getAttribute("aria-checked") !== "true";
        el.setAttribute("aria-checked", String(on));
        if (el.dataset.setting === "menu") inlineMenu = on;
      },
    };

    // A click away from PassBundle's popup or menu closes it, as in a
    // browser.
    actions(stage, acts, render, (e) => {
      const t = e.target;
      if (st.popup && !t.closest('[data-x="popup"], [data-x="ext-icon"]')) st.popup = false;
      if (st.menu && !t.closest(".ui-menu, .ui-field")) st.menu = "";
      if (st.pk && !t.closest('[data-x="pk-popup"], [data-x="pk-btn"]')) st.pk = false;
    });

    return {
      scene(w) {
        st = fresh();
        if (w.has("bakery") || w.has("cake")) Object.assign(st, { tab: "bakery", bank: "home", filled: true, coded: true });
        if (w.has("cake")) st.bakery = "home";
        if (w.has("bankhome")) Object.assign(st, { bank: "home", filled: true, coded: true });
        if (w.has("code")) Object.assign(st, { bank: "code", filled: true });
        if (w.has("filled")) st.filled = true;
        if (w.has("coded")) {
          stage.querySelector("[data-code-fill]").textContent = code().value;
          st.coded = true;
        }
        if (w.has("menu")) st.menu = "login";
        if (w.has("codemenu")) st.menu = "code";
        if (w.has("pkprompt")) st.pk = true;
        if (w.has("popup")) st.popup = true;
        if (w.has("gen")) st.pop = "gen";
        render();
      },
    };
  }

  // ----- The web vault: search, the menu's filters, an item with Show,
  // Copy, a live two-step code, and its history, and Health's fixes.
  function web({ stage, refresh }) {
    const mock = stage.querySelector(".mock");
    const DATA = [
      { id: "power", type: "login", name: "City Power & Light", user: "sam@example.com", pw: "Hk4$wN8q@Zp2", site: "power.example", folder: "Bills", by: "Alex Rivera, 3 days ago", was: [["PowerBill#24", "you, January 9"]] },
      { id: "pharmacy", type: "login", name: "Corner pharmacy", user: "sam@example.com", pw: "Jm6&pL2s!Xr8", site: "pharmacy.example", by: "you, in May" },
      { id: "clinic", type: "login", name: "Dr. Okafor's patient portal", user: "sam.rivera", pw: "Spring2019!", exposed: "Spring2019!", site: "clinic.example", by: "you, in 2019" },
      { id: "visa", type: "card", name: "Everyday Visa", holder: "Sam Rivera", number: "4111 1111 1111 1111", exp: "09/29", cvv: "123" },
      { id: "mail", type: "login", name: "Family email", user: "sam@example.com", pw: "orbit-canyon-velvet-73", site: "mail.example.com", fav: true, by: "you, last year" },
      { id: "wifi", type: "wifi", name: "Home Wi-Fi", network: "Rivera Home", pw: "lantern-meadow-ripple-42", folder: "Family" },
      { id: "bank", type: "login", name: "Hometown Credit Union", user: "sam.rivera", pw: "Tq7#vP2m!Lr9xWc4", site: "bank.example", folder: "Bills", fav: true, totp: true, by: "you, March 2", was: [["Hometown#2023", "you, last year"]] },
      { id: "school", type: "login", name: "Lincoln Elementary parents", user: "rivera.family", pw: "maple-harbor-quilt-18", site: "school.example", folder: "Family", by: "Alex Rivera, in September", was: [["maple-harbor-17", "Alex Rivera, last year"]] },
      { id: "mobile", type: "login", name: "Mobile carrier", user: "sam@example.com", pw: "Ru2*eM6x#Vq4", site: "mobile.example", by: "you, last year" },
      { id: "passport", type: "note", name: "Passport", number: "X48210537", expiring: true },
      { id: "stream", type: "login", name: "Streaming at home", user: "sam@example.com", pw: "Wd3^yH7n$Cv6", site: "watch.example", folder: "Family", by: "Alex Rivera, last month" },
      { id: "water", type: "login", name: "Water and sewer", user: "sam@example.com", pw: "Hk4$wN8q@Zp2", site: "water.example", folder: "Bills", by: "you, January 9", was: [["Water&Sewer22", "you, in 2022"]] },
    ];
    const copyOf = (d) => ({ ...d, versions: (d.was || []).map(([pw, by]) => ({ pw, by })) });
    const items = DATA.map(copyOf);
    const byId = (id) => items.find((i) => i.id === id);
    const state = { filter: "all", query: "", sel: "", history: false, fixed: "" };
    const mem = { shown: new Set() };
    const passportDate = new Date(Date.now() + 12 * 864e5).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

    function issueOf(it) {
      if (it.type === "login" && it.exposed && it.pw === it.exposed) {
        return { level: "bad", short: "Breach", text: "This password was found in a data breach.", fix: true };
      }
      if (it.type === "login") {
        const twin = items.find((o) => o !== it && o.type === "login" && o.pw === it.pw);
        if (twin) return { level: "warn", short: "Reused", text: `This password is also used for ${twin.name}.`, fix: true };
      }
      if (it.expiring) return { level: "info", short: "Expires", text: `This passport expires in 12 days.` };
      return null;
    }
    const toFix = (it) => !!issueOf(it)?.fix;
    const subOf = (it) => ({ login: it.user, card: "Visa, ending 1111", note: "Passport number and renewal", wifi: it.network })[it.type];

    function matches(it) {
      const f = state.filter;
      if (f === "fav" && !it.fav) return false;
      if (f === "issues" && !toFix(it)) return false;
      if (KIND[f] && it.type !== f) return false;
      if ((f === "Bills" || f === "Family") && it.folder !== f) return false;
      const q = state.query.trim().toLowerCase();
      return !q || `${it.name} ${it.user || ""} ${it.site || ""} ${it.network || ""}`.toLowerCase().includes(q);
    }

    function set(change) {
      Object.assign(state, change);
      render();
    }

    function fix(it) {
      it.versions.unshift({ pw: it.pw, by: it.by });
      it.pw = newPassword(20);
      it.by = "you, just now";
      mem.shown.add(`${it.id}:pw`);
      state.fixed = it.id;
    }

    const search = h("input", {
      class: "demo-search",
      type: "search",
      placeholder: "Search the vault",
      "aria-label": "Search the vault",
      autocomplete: "off",
      "data-x": "search",
      oninput: () => {
        state.query = search.value;
        keepFocus(mock, renderList);
        refresh();
      },
    });
    const nav = h("nav", { class: "demo-nav", "aria-label": "Sample vault menu" });
    const list = h("div", { class: "demo-list", role: "region", "aria-label": "Items" });
    const detail = h("div", { class: "demo-detail", role: "region", "aria-label": "Item" });
    mock.replaceChildren(h("div", { class: "mock-top" }, mark(), search), h("div", { class: "demo-body mock-body" }, nav, list, detail));

    function renderNav() {
      const count = (fn) => items.filter(fn).length;
      const entries = [
        ["all", "All items", items.length],
        ["fav", "Favorites", count((i) => i.fav)],
        ["issues", "Health", count(toFix), true],
        "Categories",
        ["login", "Logins", count((i) => i.type === "login")],
        ["card", "Cards", count((i) => i.type === "card")],
        ["note", "Identities", count((i) => i.type === "note")],
        ["wifi", "Wi-Fi", count((i) => i.type === "wifi")],
        "Folders",
        ["Bills", "Bills", count((i) => i.folder === "Bills")],
        ["Family", "Family", count((i) => i.folder === "Family")],
      ];
      put(nav, 
        ...entries.map((e) => {
          if (typeof e === "string") return h("p", { text: e });
          const [id, label, n, alert] = e;
          return h(
            "button",
            {
              type: "button",
              "data-key": `nav:${id}`,
              "data-x": id === "issues" ? "health" : null,
              "aria-pressed": String(state.filter === id),
              onclick: () => {
                // Health opens on the first thing to fix.
                const first = id === "issues" ? items.find(toFix) : null;
                set({ filter: id, sel: first ? first.id : state.sel, history: false, fixed: "" });
              },
            },
            h("span", { text: label }),
            h("span", { class: `demo-count${alert && n > 0 ? " alert" : ""}`, text: String(n) }),
          );
        }),
      );
    }

    function renderList() {
      const shown = items.filter(matches);
      if (shown.length === 0) {
        const q = state.query.trim();
        put(list, h("p", { class: "demo-empty", text: q ? `Nothing matches "${q}".` : state.filter === "issues" ? "All clear. Nothing to fix." : "Nothing here yet." }));
        return;
      }
      put(list, 
        ...shown.map((it) => {
          const issue = issueOf(it);
          return h(
            "button",
            {
              type: "button",
              class: "demo-item",
              "data-key": `item:${it.id}`,
              "data-x": it.id === "power" ? "item-power" : null,
              "aria-pressed": String(state.sel === it.id),
              onclick: (e) => {
                set({ sel: it.id, history: false, fixed: "" });
                // On a phone the item opens under the list: bring it in.
                if (e.isTrusted && detail.offsetTop > list.offsetTop + 40) {
                  detail.scrollIntoView({ block: "nearest", behavior: lessMotion.matches ? "auto" : "smooth" });
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

    function history(it) {
      return h(
        "div",
        { class: "demo-history" },
        h(
          "div",
          { class: "demo-history-head" },
          h("span", { text: `Saved by ${it.by}` }),
          h("button", {
            type: "button",
            class: "demo-btn",
            "data-x": "history",
            "data-key": "history",
            "aria-expanded": String(state.history),
            text: state.history ? "Hide history" : "Version history",
            onclick: () => set({ history: !state.history }),
          }),
        ),
        state.history &&
          (it.versions.length
            ? h(
                "ul",
                { class: "demo-versions", "data-x": "versions" },
                it.versions.map((v, i) =>
                  h(
                    "li",
                    {},
                    h("span", { class: "demo-versions-who", text: `Saved by ${v.by}` }),
                    h("button", {
                      type: "button",
                      class: "demo-btn",
                      "data-key": `restore:${i}`,
                      "aria-label": `Restore the version saved by ${v.by}`,
                      text: "Restore",
                      onclick: () => {
                        const [old] = it.versions.splice(i, 1);
                        it.versions.unshift({ pw: it.pw, by: it.by });
                        it.pw = old.pw;
                        it.by = "you, just now";
                        say("Restored that version. The one it replaced is in the history too.");
                        set({ fixed: "" });
                      },
                    }),
                  ),
                ),
              )
            : h("p", { class: "demo-note", text: "No earlier versions yet." })),
      );
    }

    function renderDetail() {
      const it = byId(state.sel);
      if (!it) {
        put(detail, h("p", { class: "mock-empty", text: "Pick an item to see it." }));
        return;
      }
      const issue = issueOf(it);
      let where = { login: it.site, card: "Payment card", note: "Identity", wifi: "Wi-Fi network" }[it.type];
      if (it.folder) where += `, in ${it.folder}`;
      const k = (f) => `${it.id}:${f}`;
      const fields = {
        login: () => [
          field(mem, k("user"), "Username", it.user),
          field(mem, k("pw"), "Password", it.pw, { secret: true, x: "copy" }),
          it.totp && field(mem, k("totp"), "Two-step code", code().value, { mono: true, code: true }),
          field(mem, k("site"), "Website", `https://${it.site}`),
        ],
        card: () => [
          field(mem, k("holder"), "Cardholder name", it.holder),
          field(mem, k("number"), "Number", it.number, { secret: true, masked: "•••• •••• •••• 1111" }),
          field(mem, k("exp"), "Expires", it.exp, { copy: false }),
          field(mem, k("cvv"), "Security code", it.cvv, { secret: true, masked: "•••" }),
        ],
        note: () => [field(mem, k("number"), "Passport number", it.number, { secret: true, masked: "•••••••••" }), field(mem, k("exp"), "Expires", passportDate, { copy: false })],
        wifi: () => [field(mem, k("net"), "Network name", it.network), field(mem, k("pw"), "Password", it.pw, { secret: true }), field(mem, k("sec"), "Security", "WPA3", { copy: false })],
      }[it.type]();
      const avatars = it.folder === "Family" ? ["SR", "AR", "JR"] : ["SR", "AR"];
      put(detail, 
        h("div", { class: "demo-head" }, kindTile(it.type, "large"), h("div", {}, h("h3", { text: it.name }), h("span", { class: "demo-where", text: where }))),
        issue &&
          h(
            "div",
            { class: `demo-alert ${issue.level}` },
            h("p", { text: issue.text }),
            issue.fix &&
              h("button", {
                type: "button",
                class: "demo-btn primary",
                "data-x": "fix",
                "data-key": "fix",
                text: "Make a new one",
                onclick: () => {
                  fix(it);
                  say("Saved a strong new password");
                  render();
                },
              }),
          ),
        !issue && state.fixed === it.id && h("p", { class: "demo-ok", "data-x": "fixed", text: "Saved a strong new password. The old one is in the history. Use the new one on the site to finish." }),
        h("div", { class: "demo-fields" }, fields),
        it.type === "login" && history(it),
        it.folder &&
          h(
            "div",
            { class: "demo-shared" },
            h("span", { class: "demo-avatars", "aria-hidden": "true" }, avatars.map((a, i) => h("span", { class: `avatar a${i + 1}`, text: a }))),
            h("span", { text: it.folder === "Family" ? "Shared with Alex and Jordan, in Family" : "Shared with Alex, in Bills" }),
          ),
      );
    }

    function render() {
      keepFocus(mock, () => {
        renderNav();
        renderList();
        renderDetail();
      });
      refresh();
    }

    return {
      scene(w) {
        search.value = "";
        mem.shown.clear();
        Object.assign(state, {
          query: "",
          filter: w.has("health") ? "issues" : "all",
          sel: w.has("health") ? "clinic" : w.has("item") ? "power" : "",
          history: w.has("history"),
          fixed: "",
        });
        // The steps about Health start with the breached password there.
        const clinic = byId("clinic");
        if (w.has("health") && clinic.pw !== clinic.exposed) items[items.indexOf(clinic)] = copyOf(DATA.find((d) => d.id === "clinic"));
        if (w.has("fixed")) fix(byId("clinic"));
        render();
      },
    };
  }

  // ----- The desktop app: unlock, items, and a sign-in to approve.
  function desktop({ stage, refresh }) {
    const paint = painter(stage);
    const ITEMS = {
      bank: { name: "Hometown Credit Union", where: "bank.example", user: "sam.rivera", pw: "Tq7#vP2m!Lr9xWc4", totp: true },
      mail: { name: "Family email", where: "mail.example.com", user: "sam@example.com", pw: "orbit-canyon-velvet-73" },
      power: { name: "City Power & Light", where: "power.example", user: "sam@example.com", pw: "Hk4$wN8q@Zp2" },
      wifi: { name: "Home Wi-Fi", where: "Wi-Fi network", network: "Rivera Home", pw: "lantern-meadow-ripple-42" },
    };
    const detail = stage.querySelector("[data-desk-detail]");
    const mem = { shown: new Set() };
    const fresh = () => ({ unlocked: false, typed: false, sel: "", req: "none" });
    let st = fresh();
    let drawn = null;
    let timer = 0;

    function render() {
      const w = new Set([st.unlocked ? "unlocked" : "locked", `req-${st.req}`, `sel-${st.sel}`]);
      if (st.typed) w.add("typed");
      if (["wait", "check", "approved", "denied"].includes(st.req)) w.add("req");
      paint(w);
      if (drawn !== st.sel) {
        drawn = st.sel;
        const it = ITEMS[st.sel];
        const k = (f) => `${st.sel}:${f}`;
        put(detail, 
          ...(it
            ? [
                h("div", { class: "demo-head" }, it.network ? kindTile("wifi") : kindTile("login"), h("div", {}, h("h3", { text: it.name }), h("span", { class: "demo-where", text: it.where }))),
                h(
                  "div",
                  { class: "demo-fields" },
                  it.network
                    ? [field(mem, k("net"), "Network name", it.network), field(mem, k("pw"), "Password", it.pw, { secret: true })]
                    : [
                        field(mem, k("user"), "Username", it.user),
                        field(mem, k("pw"), "Password", it.pw, { secret: true }),
                        it.totp && field(mem, k("totp"), "Two-step code", code().value, { mono: true, code: true }),
                      ],
                ),
              ]
            : [h("p", { class: "mock-empty", text: "Pick an item to see it." })]),
        );
      }
      refresh();
    }

    function unlock() {
      Object.assign(st, { unlocked: true, typed: false });
      say("Unlocked");
      // A sign-in from another computer comes in a few seconds later.
      clearTimeout(timer);
      if (st.req === "none") {
        timer = setTimeout(() => {
          if (!st.unlocked || st.req !== "none") return;
          st.req = "wait";
          say("A sign-in request from the web vault in Chrome on Windows");
          render();
        }, 5000);
      }
    }

    actions(
      stage,
      {
        hello: unlock,
        type: () => (st.typed = true),
        unlock,
        open: (el) => (st.sel = el.dataset.item),
        approve: () => {
          st.req = "check";
          setTimeout(() => {
            if (st.req !== "check") return;
            st.req = "approved";
            say("Approved. Chrome on Windows is signed in.");
            render();
          }, 900);
        },
        deny: () => {
          st.req = "denied";
          say("Denied. Nothing was sent.");
        },
        later: () => (st.req = "later"),
        reopen: () => (st.req = "wait"),
        "req-done": () => (st.req = "done"),
        lock: () => {
          clearTimeout(timer);
          const answered = ["approved", "denied", "done"].includes(st.req);
          st = { ...fresh(), req: answered ? "done" : "none" };
          mem.shown.clear();
          say("Locked");
        },
      },
      render,
    );

    return {
      scene(w) {
        clearTimeout(timer);
        st = fresh();
        mem.shown.clear();
        drawn = null;
        if (w.has("unlocked")) st.unlocked = true;
        if (w.has("item")) st.sel = "bank";
        if (w.has("request")) st.req = "wait";
        if (w.has("approved")) st.req = "approved";
        render();
      },
    };
  }

  // ----- The phone: PassBundle's autofill card and Android's settings, the
  // home screen, a bank app it fills, and a bakery app with a passkey.
  function phone({ stage, refresh }) {
    const paint = painter(stage);
    const ITEMS = {
      bank: { name: "Hometown Credit Union", user: "sam.rivera", pw: "Tq7#vP2m!Lr9xWc4", totp: true },
      mail: { name: "Family email", user: "sam@example.com", pw: "orbit-canyon-velvet-73" },
      wifi: { name: "Home Wi-Fi", network: "Rivera Home", pw: "lantern-meadow-ripple-42" },
    };
    const view = stage.querySelector("[data-phone-item]");
    const title = stage.querySelector("[data-phone-title]");
    const mem = { shown: new Set() };
    const FLAGS = ["card", "on", "chosen", "confirm", "suggest", "bio", "filled", "bankhome", "pk", "cake", "err"];
    const fresh = () => ({ screen: "vault", from: "vault", card: true, on: false, chosen: false, confirm: false, suggest: false, bio: false, filled: false, bankhome: false, pk: false, cake: false, err: false });
    let st = fresh();

    function render() {
      const w = new Set([st.screen, ...FLAGS.filter((f) => st[f])]);
      paint(w);
      refresh();
    }

    function settings(from) {
      Object.assign(st, { screen: "settings", from, chosen: st.on, confirm: false });
    }

    actions(
      stage,
      {
        "turn-on": () => settings("vault"),
        later: () => (st.card = false),
        item: (el) => {
          const it = ITEMS[el.dataset.item];
          const k = (f) => `${el.dataset.item}:${f}`;
          title.textContent = it.name;
          put(view, 
            h(
              "div",
              { class: "demo-fields" },
              it.network
                ? [field(mem, k("net"), "Network name", it.network), field(mem, k("pw"), "Password", it.pw, { secret: true })]
                : [field(mem, k("user"), "Username", it.user), field(mem, k("pw"), "Password", it.pw, { secret: true }), it.totp && field(mem, k("totp"), "Two-step code", code().value, { mono: true, code: true })],
            ),
          );
          st.screen = "item";
        },
        back: () => (st.screen = st.screen === "settings" && st.from === "home" ? "home" : "vault"),
        none: () => {
          if (st.on) say("Autofill is off");
          Object.assign(st, { on: false, chosen: false });
        },
        choose: () => {
          if (!st.on) Object.assign(st, { chosen: true, confirm: true });
        },
        cancel: () => Object.assign(st, { chosen: false, confirm: false }),
        ok: () => {
          Object.assign(st, { on: true, chosen: true, confirm: false, card: true });
          say("PassBundle fills your sign-ins now");
          if (st.from === "vault") st.screen = "vault";
        },
        home: () => Object.assign(st, { screen: "home", bio: false, pk: false, confirm: false }),
        app: (el) => {
          const app = el.dataset.app;
          if (app === "settings") settings("home");
          else st.screen = app;
          // The bank's app starts in its username field.
          if (app === "bank") st.suggest = st.on && !st.filled;
        },
        field: () => {
          if (st.on && !st.filled) st.suggest = true;
        },
        suggest: () => (st.bio = true),
        finger: () => {
          Object.assign(st, { bio: false, filled: true, suggest: false, err: false });
          say("Unlocked, and filled your username and password");
        },
        "sheet-cancel": () => Object.assign(st, { bio: false, pk: false }),
        signin: (el, e) => {
          if (!st.filled) {
            st.err = true;
            e.preventDefault();
            return;
          }
          Object.assign(st, { bankhome: true, err: false });
          say("Signed in to Hometown Credit Union");
        },
        "bank-out": () => Object.assign(st, { bankhome: false, filled: false, suggest: false }),
        pk: () => (st.pk = true),
        "pk-use": () => {
          Object.assign(st, { pk: false, cake: true });
          say("Signed in to Juniper Bakery with your passkey");
        },
        "bakery-out": () => (st.cake = false),
      },
      render,
    );

    return {
      scene(w) {
        st = fresh();
        if (w.has("on")) Object.assign(st, { on: true, chosen: true });
        if (w.has("settings")) st.screen = "settings";
        if (w.has("chosen")) st.chosen = true;
        if (w.has("confirm")) st.confirm = true;
        if (w.has("home")) st.screen = "home";
        if (w.has("bank")) Object.assign(st, { screen: "bank", suggest: true });
        if (w.has("bio")) st.bio = true;
        if (w.has("filled") || w.has("bankhome")) Object.assign(st, { filled: true, suggest: false });
        if (w.has("bankhome")) st.bankhome = true;
        render();
      },
    };
  }

  // ----- A family: invite someone with access to chosen folders, and change
  // who reaches a folder.
  function family({ stage, refresh }) {
    const paint = painter(stage);
    const people = stage.querySelector("[data-people]");
    const limit = Number(people.dataset.limit) || 6;
    const email = stage.querySelector("[data-invite-email]");
    const picks = Object.fromEntries([...stage.querySelectorAll("[data-invite]")].map((s) => [s.dataset.invite, s]));
    const error = stage.querySelector("[data-invite-error]");
    const accessList = stage.querySelector("[data-access-list]");
    const accessTitle = stage.querySelector("[data-access-title]");
    const FOLDERS = { bills: ["Bills", 3], family: ["Family", 3] };
    const LEVELS = { none: "No access", view: "Can view", edit: "Can edit", manage: "Can manage" };
    const fresh = () => ({ dialog: false, access: "", invited: [], grants: { bills: { alex: "edit" }, family: { alex: "edit" } } });
    let st = fresh();
    let count = 0;
    let opener = null;
    // A dialog closed: the keyboard goes back to what opened it.
    function closed(e) {
      Object.assign(st, { dialog: false, access: "" });
      if (e.isTrusted && opener) setTimeout(() => opener.focus(), 0);
    }
    const nameOf = (id) => (id === "alex" ? "Alex" : st.invited.find((p) => p.id === id)?.name || "");

    function render() {
      const w = new Set();
      if (st.dialog) w.add("dialog");
      if (st.access) w.add("access");
      paint(w);
      for (const row of people.querySelectorAll("[data-invited]")) row.remove();
      for (const p of st.invited) {
        people.append(
          h(
            "span",
            { class: "ui-list-row", "data-invited": "", "data-x": p.id === "jordan" ? "jordan" : null },
            h("span", { class: "avatar a3", "aria-hidden": "true", text: p.name.charAt(0) }),
            h("span", { class: "ui-name" }, h("b", { text: p.name }), h("small", { text: p.email })),
            h("span", { class: "badge info", text: "Invited" }),
          ),
        );
      }
      for (const [id, [, items]] of Object.entries(FOLDERS)) {
        const who = Object.entries(st.grants[id])
          .filter(([, level]) => level !== "none")
          .map(([p, level]) => `${nameOf(p)} ${LEVELS[level].toLowerCase()}`);
        stage.querySelector(`[data-folder-note="${id}"]`).textContent = `${items} items. ${who.length ? `${who.join(", ")}.` : "Only you."}`;
      }
      refresh();
    }

    function openInvite(focus) {
      const jordan = st.invited.some((p) => p.email === "jordan@example.com");
      email.value = jordan ? "" : "jordan@example.com";
      picks.bills.value = "none";
      picks.family.value = "view";
      error.hidden = true;
      st.dialog = true;
      if (focus) setTimeout(() => email.focus(), 0);
    }

    function openAccess(id, focus) {
      st.access = id;
      accessTitle.textContent = `${FOLDERS[id][0]}: who reaches it`;
      const row = (name, sub, control) => h("div", { class: "access-row" }, h("span", { class: "ui-name" }, h("b", { text: name }), sub && h("small", { text: sub })), control);
      const pick = (pid, name) =>
        h(
          "select",
          {
            "aria-label": `What ${name} can do in ${FOLDERS[id][0]}`,
            onchange: (e) => {
              st.grants[id][pid] = e.target.value;
              say(`${name}: ${LEVELS[e.target.value].toLowerCase()}`);
              render();
            },
          },
          Object.entries(LEVELS).map(([v, label]) => h("option", { value: v, selected: (st.grants[id][pid] || "none") === v, text: label })),
        );
      put(accessList, 
        row("Sam Rivera", "Owner", h("span", { class: "mock-note", text: "Can manage" })),
        row("Alex Rivera", "Member", pick("alex", "Alex")),
        st.invited.map((p) => row(p.name, "Invited", pick(p.id, p.name))),
      );
      if (focus) setTimeout(() => accessList.querySelector("select")?.focus(), 0);
    }

    function refuse(text, e) {
      error.textContent = text;
      error.hidden = false;
      e.preventDefault();
    }

    actions(
      stage,
      {
        invite: (el, e) => {
          opener = el;
          openInvite(e.isTrusted);
        },
        close: (el, e) => closed(e),
        send: (el, e) => {
          const addr = email.value.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return refuse("Enter an email address.", e);
          if (["sam@example.com", "alex@example.com"].includes(addr) || st.invited.some((p) => p.email === addr)) return refuse("They're in the family already.", e);
          if (2 + st.invited.length >= limit) return refuse(`Families has room for ${limit} people.`, e);
          const id = addr === "jordan@example.com" ? "jordan" : `p${++count}`;
          const local = addr.split("@")[0].split(/[._-]/)[0];
          st.invited.push({ id, email: addr, name: local.charAt(0).toUpperCase() + local.slice(1) });
          for (const [folder, select] of Object.entries(picks)) if (select.value !== "none") st.grants[folder][id] = select.value;
          closed(e);
          say(`Invited ${addr}`);
        },
        folder: (el, e) => {
          opener = el;
          openAccess(el.dataset.folder, e.isTrusted);
        },
      },
      render,
    );
    stage.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (st.dialog || st.access)) {
        closed(e);
        render();
      }
      if (e.key === "Enter" && e.target === email) {
        stage.querySelector('[data-act="send"]').click();
        if (!st.dialog) opener?.focus();
      }
    });

    return {
      scene(w) {
        st = fresh();
        if (w.has("invited")) {
          st.invited.push({ id: "jordan", email: "jordan@example.com", name: "Jordan" });
          st.grants.family.jordan = "view";
        }
        if (w.has("dialog")) openInvite(false);
        if (w.has("access")) openAccess("family", false);
        render();
      },
    };
  }

  // ----- The MSP console: clients side by side, one client's passwords to
  // fix, its people, and its install command, and adding a client.
  function msp({ stage, refresh }) {
    const mock = stage.querySelector(".mock");
    const CLIENTS = [
      {
        id: "acme",
        name: "Acme Dental",
        tone: "sapphire",
        people: ["Maria Lopez", "Dev Patel", "Grace Kim", "Tom Becker", "Aisha Bello", "Luis Ortega", "Emma Novak", "Ben Carter", "Priya Shah"],
        weak: ["Front desk PC", "Copier"],
        reused: ["Supplier portal", "Shipping account", "Payroll"],
        expiring: [["Domain registrar", 9]],
      },
      { id: "baker", name: "Baker & Hale Law", tone: "amethyst", people: ["Helen Baker", "Marcus Hale", "Sofia Rossi", "James Wu", "Nina Petrova", "Owen Clark"], expiring: [["Domain registrar", 9], ["TLS certificate", 20]] },
      {
        id: "cedar",
        name: "Cedar Pediatrics",
        tone: "turquoise",
        people: ["Rachel Green", "Ahmed Hassan", "Lily Chen", "Carlos Diaz", "Hannah Weber", "Kofi Mensah", "Zoe Martin", "Ravi Iyer", "Chloe Dubois", "Sam Taylor", "Ines Silva", "Noah Brooks", "Mei Tanaka", "Lucas Moreau"],
        weak: ["Front desk PC"],
      },
      { id: "linden", name: "Linden Realty", tone: "topaz", people: ["Paul Linden", "Erin Walsh", "Victor Huang", "Dana Fox"], weak: ["Front desk PC", "Copier", "Door system", "Voicemail"], reused: ["Supplier portal", "Shipping account"] },
      { id: "maple", name: "Maple Street Bakery", tone: "ruby", people: ["Rosa Alvarez", "Finn O'Brien", "Kate Morgan"], expiring: [["Domain registrar", 9]] },
    ].map((c) => ({ weak: [], reused: [], expiring: [], ...c }));
    let clients = [...CLIENTS];
    const state = { sel: "", adding: false, name: "", err: "", admin: "" };
    let added = 0;
    const slug = (c) => c.id.replace(/^new\d+$/, () => c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));

    const status = h("span", { class: "demo-status" });
    const addButton = h("button", { type: "button", class: "demo-btn primary mock-push", "data-x": "add", "data-key": "add", text: "Add client", onclick: (e) => openAdd(e.isTrusted) });
    const table = h("div", { class: "demo-clients", role: "region", "aria-label": "Clients", "data-x": "clients" });
    const panel = h("div", { class: "demo-client", role: "region", "aria-label": "Client" });
    const dialog = h("div", { class: "mock-dialog" });
    const body = h("div", { class: "demo-msp mock-msp" }, table, panel, dialog);
    mock.replaceChildren(h("div", { class: "mock-top wrap" }, mark(), h("b", { text: "MSP console" }), h("span", { class: "chip", text: "Harbor IT" }), status, addButton), body);

    function openAdd(focus) {
      Object.assign(state, { adding: true, err: "", name: clients.some((c) => c.name === "Oak Street Dental") ? "" : "Oak Street Dental" });
      render();
      if (focus) setTimeout(() => dialog.querySelector("input")?.focus(), 0);
    }

    function create(e) {
      const name = state.name.trim();
      if (!name) {
        state.err = "Name the client.";
        e?.preventDefault();
        render();
        return;
      }
      const c = { id: `new${++added}`, name, tone: "emerald", people: [], weak: [], reused: [], expiring: [], isNew: true };
      clients.push(c);
      Object.assign(state, { adding: false, sel: c.id, err: "" });
      say(`Added ${name}, with your default policies`);
      render();
      if (!e || e.isTrusted) table.querySelector(`[data-key="client:${c.id}"]`)?.focus();
    }

    const num = (n, level) => h("span", {}, n ? h("span", { class: `badge ${level}`, text: String(n) }) : h("span", { class: "demo-zero", text: "0" }));

    function renderTable() {
      const newest = clients.filter((c) => c.isNew).at(-1);
      put(table, 
        h(
          "div",
          { class: "demo-table" },
          h("div", { class: "demo-row head", "aria-hidden": "true" }, ["Client", "Members", "Expiring", "Weak", "Reused"].map((t) => h("span", { text: t }))),
          clients.map((c) =>
            h(
              "button",
              {
                type: "button",
                class: "demo-row",
                "data-key": `client:${c.id}`,
                "data-x": c === newest ? "new-client" : c.id,
                "aria-pressed": String(state.sel === c.id),
                "aria-label": `${c.name}: ${c.people.length} members, ${c.expiring.length} expiring, ${c.weak.length} weak, ${c.reused.length} reused`,
                onclick: () => {
                  Object.assign(state, { sel: c.id, admin: "" });
                  render();
                },
              },
              h("span", { class: "demo-client-name" }, h("span", { class: `tile small ${c.tone}`, "aria-hidden": "true", text: c.name.charAt(0) }), h("span", { text: c.name })),
              h("span", { text: String(c.people.length) }),
              num(c.expiring.length, "warn"),
              num(c.weak.length, "bad"),
              num(c.reused.length, "warn"),
            ),
          ),
        ),
      );
      const total = clients.reduce((n, c) => n + c.people.length, 0);
      status.textContent = `${total} people in ${clients.length} clients, from one pool of seats`;
    }

    function renderPanel() {
      const c = clients.find((x) => x.id === state.sel);
      if (!c) {
        put(panel, h("p", { class: "mock-empty", text: "Pick a client to see what needs attention." }));
        return;
      }
      const fix = [
        c.weak.length > 0 && [c.weak.length === 1 ? "Weak, and found in a data breach" : `${c.weak.length} weak, and found in data breaches`, c.weak],
        c.reused.length > 0 && [`${c.reused.length} with the same password, found in a data breach`, c.reused],
      ].filter(Boolean);
      const names = c.people.length > 5 ? `${c.people.slice(0, 4).join(", ")}, and ${c.people.length - 4} more` : c.people.join(", ");
      const command = `iwr https://vault.example/install/${slug(c)} | iex`;
      const copy = h("button", {
        type: "button",
        class: "demo-btn",
        "data-x": "install",
        "data-key": "install",
        text: "Copy command",
        onclick: (e) => {
          toClipboard(command, e);
          flash(copy);
          say("Copied the install command");
        },
      });
      put(panel, 
        h(
          "div",
          { class: "demo-client-head" },
          h("div", {}, h("h3", { text: c.name }), h("span", { class: "demo-where", text: c.people.length ? `${c.people.length} people, with your default policies` : "No one yet, with your default policies" })),
          h("button", {
            type: "button",
            class: "demo-btn",
            "data-key": "admin",
            "aria-expanded": String(state.admin === c.id),
            text: "Admin console",
            onclick: () => {
              state.admin = state.admin === c.id ? "" : c.id;
              render();
            },
          }),
        ),
        state.admin === c.id && h("p", { class: "demo-ok plain", text: `In the real console, this opens ${c.name}'s admin console: its members, groups, folders, and policies.` }),
        h("h4", { text: "To fix" }),
        fix.length
          ? h(
              "ul",
              { class: "demo-issues", "data-x": "fix-list" },
              fix.map(([why, names]) => h("li", {}, h("span", { class: "demo-dot bad", "aria-hidden": "true" }), h("span", { class: "ui-who" }, h("b", { text: why }), h("span", { text: names.join(", ") })))),
            )
          : h("p", { class: "demo-note", "data-x": "fix-list", text: c.isNew ? "Nothing yet." : "Nothing to fix." }),
        c.expiring.length > 0 && h("h4", { text: "Expiring soon" }),
        c.expiring.length > 0 &&
          h(
            "ul",
            { class: "demo-issues" },
            c.expiring.map(([name, days]) => h("li", {}, h("span", { class: "demo-dot", "aria-hidden": "true" }), h("span", { class: "ui-who" }, h("b", { text: name }), h("span", { text: `Expires in ${days} days` })))),
          ),
        h("h4", { text: "People" }),
        h("p", { class: "demo-note", text: names || "No one yet. Run the install command on their computers, and people land here as they sign in." }),
        h("h4", { text: "Install command" }),
        h("p", { class: "demo-note", text: `Run it from your RMM on their Windows computers: it adds PassBundle to Chrome and Edge, and whoever signs in joins ${c.name}.` }),
        h("span", { class: "mock-code", text: command }),
        h("span", { class: "mock-actions start" }, copy, h("span", { class: "demo-note", text: `${c.people.length} ${c.people.length === 1 ? "person has" : "people have"} joined with it.` })),
      );
    }

    function renderDialog() {
      dialog.hidden = !state.adding;
      if (!state.adding) return;
      const input = h("input", {
        class: "mock-input",
        id: "msp-client-name",
        type: "text",
        value: state.name,
        autocomplete: "off",
        spellcheck: "false",
        oninput: (e) => (state.name = e.target.value),
        onkeydown: (e) => {
          if (e.key === "Enter") create();
        },
      });
      const err = state.err && h("span", { class: "mock-error", text: state.err });
      put(dialog, 
        h(
          "div",
          { class: "mock-dialog-card", role: "dialog", "aria-labelledby": "msp-add-title" },
          h("b", { class: "mock-dialog-title", id: "msp-add-title", text: "Add a client" }),
          h("label", { class: "ui-label", for: "msp-client-name", text: "Name" }),
          input,
          h("span", { class: "ui-label", text: "Policies" }),
          h("p", { class: "mock-note", text: "Your defaults: account recovery, strong master passwords, and one work account per person." }),
          err,
          h(
            "span",
            { class: "mock-actions" },
            h("button", {
              type: "button",
              class: "demo-btn",
              text: "Cancel",
              onclick: () => {
                state.adding = false;
                render();
                addButton.focus();
              },
            }),
            h("button", { type: "button", class: "demo-btn primary", "data-x": "create", text: "Add client", onclick: create }),
          ),
        ),
      );
    }
    stage.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !state.adding) return;
      state.adding = false;
      render();
      addButton.focus();
    });

    function render() {
      keepFocus(mock, () => {
        renderTable();
        renderPanel();
        renderDialog();
      });
      refresh();
    }

    return {
      scene(w) {
        clients = [...CLIENTS];
        Object.assign(state, { sel: w.has("client") ? "linden" : "", adding: false, name: "Oak Street Dental", err: "", admin: "" });
        if (w.has("add")) state.adding = true;
        if (w.has("added")) {
          const c = { id: `new${++added}`, name: "Oak Street Dental", tone: "emerald", people: [], weak: [], reused: [], expiring: [], isNew: true };
          clients.push(c);
          state.sel = c.id;
        }
        render();
      },
    };
  }

  const APPS = { extension, web, desktop, phone, family, msp };

  // ===== The tips ========================================================

  const tours = parts.map((part, index) => {
    const frame = part.querySelector(".tour-frame");
    const stage = part.querySelector(".tour-stage");
    const list = part.querySelector(".tour-steps");
    const steps = [...list.children];
    list.hidden = true;
    stage.dataset.tour = "on";

    const count = h("p", { class: "tour-count" });
    const text = h("p", { class: "tour-text" });
    const again = h("button", { type: "button", class: "again", text: "Show tip", hidden: "" });
    const back = h("button", { type: "button", text: "Back" });
    const next = h("button", { type: "button", class: "go" });
    const bubble = h(
      "div",
      { class: "tour-bubble", role: "group", "aria-label": `Tip for the ${part.dataset.label}` },
      count,
      h("div", { "aria-live": "polite" }, text),
      h("div", { class: "tour-buttons" }, again, back, next),
    );
    frame.append(bubble);

    let at = 0;
    let target = null;
    // The visitor is playing on their own: the tip steps aside.
    let quiet = false;
    const following = parts[index + 1];
    const find = (x) => (x ? [...stage.querySelectorAll(`[data-x="${x}"]`)].find(shows) || null : null);

    // The app draws the screen and says when it changed; the tip finds its
    // target again.
    let app = { scene() {} };
    function refresh() {
      const found = find(steps[at].dataset.target);
      if (found !== target) {
        target?.classList.remove("tour-focus", "inset");
        target = found;
      }
      place();
    }

    function wander(on) {
      if (quiet === on) return;
      quiet = on;
      frame.classList.toggle("quiet", on);
      place();
    }

    // On a narrow screen, a target can sit partly outside a strip that
    // scrolls sideways (a sidebar, a table): scroll the strip, not the page.
    function reveal(el) {
      for (let a = el.parentElement; a && a !== frame; a = a.parentElement) {
        const s = getComputedStyle(a);
        const across = /auto|scroll/.test(s.overflowX) && a.scrollWidth > a.clientWidth;
        const down = /auto|scroll/.test(s.overflowY) && a.scrollHeight > a.clientHeight;
        if (!across && !down) continue;
        const r = el.getBoundingClientRect();
        const c = a.getBoundingClientRect();
        if (across && r.left - RING < c.left) a.scrollLeft -= c.left - r.left + RING;
        else if (across && r.right + RING > c.right) a.scrollLeft += r.right - c.right + RING;
        if (down && r.top - RING < c.top) a.scrollTop -= c.top - r.top + RING;
        else if (down && r.bottom + RING > c.bottom) a.scrollTop += r.bottom - c.bottom + RING;
      }
    }

    // Whether something between the target and the frame cuts off the
    // ring (a screen's rounded, clipped edge): then it's drawn inside.
    function clipped(el) {
      const r = el.getBoundingClientRect();
      for (let a = el.parentElement; a && a !== frame; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === "visible" && s.overflowY === "visible") continue;
        const c = a.getBoundingClientRect();
        if (r.left - RING < c.left || r.right + RING > c.right || r.top - RING < c.top || r.bottom + RING > c.bottom) {
          return true;
        }
      }
      return false;
    }

    // how.scene false: the visitor's own click got here, so the screen is
    // already where this step is about.
    function go(i, how = {}) {
      at = clamp(i, 0, steps.length - 1);
      const step = steps[at];
      if (how.scene !== false) app.scene(new Set(wordsOf(step.dataset.state)));
      count.textContent = `${at + 1} of ${steps.length}`;
      text.replaceChildren(...[...step.childNodes].map((n) => n.cloneNode(true)));
      back.hidden = at === 0;
      const last = at === steps.length - 1;
      next.textContent = !last ? "Next" : following ? `Next: ${following.dataset.label}` : "Start over";
      refresh();
      auto?.onChange();
      // On a phone the tip sits under the screen: when the visitor did what
      // it said, show them the next one.
      if (how.followed && frame.clientWidth < NARROW && tips && !auto?.playing) bubble.scrollIntoView({ block: "nearest" });
    }

    function place() {
      if (part.hidden) return;
      const step = steps[at];
      const showing = tips && !quiet;
      again.hidden = !(tips && quiet);
      if (target) {
        if (showing) reveal(target);
        target.classList.toggle("tour-focus", showing);
        target.classList.toggle("inset", showing && clipped(target));
      }
      if (!target || !showing || frame.clientWidth < NARROW) {
        bubble.classList.add("docked");
        bubble.style.left = "";
        bubble.style.top = "";
        return;
      }
      bubble.classList.remove("docked");
      const f = frame.getBoundingClientRect();
      const anchor = find(step.dataset.anchor) || target;
      const t = anchor.getBoundingClientRect();
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      const gap = 16;
      // A phone's tips sit beside the phone, not on it.
      const phone = stage.querySelector(".mock-phone")?.getBoundingClientRect();
      // Where it can go: above or below (centered on the anchor, or lined
      // up with either end of a wide one), or beside it.
      const across = [t.left + t.width / 2 - bw / 2, t.right - bw, t.left].map((x) => x - f.left);
      const middle = t.top - f.top + t.height / 2 - bh / 2;
      const spots = [
        ...across.map((x) => ["bottom", x, t.bottom - f.top + gap]),
        ...across.map((x) => ["top", x, t.top - f.top - bh - gap]),
        ["right", Math.max(t.right, phone?.right ?? 0) - f.left + gap, middle],
        ["left", Math.min(t.left, phone?.left ?? Infinity) - f.left - bw - gap, middle],
      ];
      // Above or below needs the room up or down; beside needs the room
      // across. The other way, the tip slides to stay in the frame. It never
      // covers what it points at, or what the next step points at when
      // that's on screen: with no room for it, it docks under the screen.
      const clear = [anchor, target, find(steps[at + 1]?.dataset.target)].filter(Boolean).map((el) => el.getBoundingClientRect());
      if (phone) clear.push(phone);
      const fits = ([p, x, y]) => {
        const room = p === "top" || p === "bottom" ? y >= 0 && y + bh <= f.height : x >= 0 && x + bw <= f.width;
        const [cx, cy] = [clamp(x, 8, f.width - bw - 8), clamp(y, 8, f.height - bh - 8)];
        const covers = (r) => cx < r.right - f.left && cx + bw > r.left - f.left && cy < r.bottom - f.top && cy + bh > r.top - f.top;
        return room && !clear.some(covers);
      };
      const wanted = step.dataset.place || "bottom";
      const flip = { top: "bottom", bottom: "top", left: "right", right: "left" }[wanted];
      const order = [wanted, flip, "bottom", "top", "right", "left"];
      const spot = order.flatMap((p) => spots.filter((s) => s[0] === p)).find(fits);
      if (!spot) {
        bubble.classList.add("docked");
        bubble.style.left = "";
        bubble.style.top = "";
        return;
      }
      const [where, sx, sy] = spot;
      const x = clamp(sx, 8, f.width - bw - 8);
      const y = clamp(sy, 8, f.height - bh - 8);
      bubble.style.left = `${x}px`;
      bubble.style.top = `${y}px`;
      bubble.dataset.place = where;
      const arrow =
        where === "top" || where === "bottom"
          ? clamp(t.left - f.left + t.width / 2 - x, 18, bw - 18)
          : clamp(t.top - f.top + t.height / 2 - y, 18, bh - 18);
      bubble.style.setProperty("--arrow", `${arrow}px`);
    }

    // Plays the part by itself: a pointer moves to each step's target and
    // clicks it, with time to read each tip, up to data-autoplay-end.
    // PassBundle's own clicks (data-pick) land with a flourish.
    function player() {
      const marked = steps.findIndex((s) => s.hasAttribute("data-autoplay-end"));
      const end = marked < 0 ? steps.length - 1 : marked;
      const pointer = h("span", { class: "tour-pointer", "aria-hidden": "true" }, h("i"));
      frame.append(pointer);
      let run = 0;
      let playing = false;
      let wanted = true;
      let seen = false;
      const reading = (step) => Math.min(3400, 1000 + step.textContent.length * 15);

      function aim(el) {
        const f = frame.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const x = r.left - f.left + Math.min(r.width / 2, 48);
        const y = r.top - f.top + r.height * 0.6;
        pointer.style.transform = `translate(${x}px, ${y}px)`;
      }

      async function play() {
        const mine = ++run;
        const alive = () => mine === run;
        playing = true;
        auto.onChange();
        if (!pointer.style.transform) {
          pointer.style.transform = `translate(${frame.clientWidth * 0.7}px, ${frame.clientHeight * 0.75}px)`;
        }
        pointer.classList.add("on");
        while (at < end) {
          await sleep(reading(steps[at]));
          if (!alive()) return;
          const step = steps[at];
          refresh();
          if (step.dataset.advance === "click" && target) {
            const t = target;
            const pick = step.hasAttribute("data-pick");
            aim(t);
            await sleep(700);
            if (!alive()) return;
            pointer.classList.add("press");
            if (pick) {
              pointer.classList.add("pick");
              t.classList.add("picked");
            }
            await sleep(180);
            pointer.classList.remove("press");
            if (!alive()) return;
            const was = at;
            t.click();
            await sleep(80);
            if (pick) {
              setTimeout(() => {
                pointer.classList.remove("pick");
                t.classList.remove("picked");
              }, 700);
            }
            if (!alive()) return;
            if (at === was) go(at + 1);
          } else {
            go(at + 1);
          }
        }
        await sleep(1200);
        if (!alive()) return;
        playing = false;
        wanted = false;
        pointer.classList.remove("on");
        auto.onChange();
      }

      function stop(forGood) {
        run++;
        if (forGood) wanted = false;
        playing = false;
        pointer.classList.remove("on", "press", "pick");
        auto.onChange();
      }

      // Starts by itself only while it's on screen, showing, and wanted.
      function maybe() {
        if (wanted && !playing && seen && !part.hidden && !lessMotion.matches && !document.hidden) play();
      }

      const auto = {
        onChange: () => {},
        get playing() {
          return playing;
        },
        get finished() {
          return at >= end;
        },
        stop,
        maybe,
        // The Play button, or "Watch it work": from the step it's on, with
        // the screen put back where that step is about, or from the start
        // once it's done.
        start() {
          wander(false);
          go(at >= end ? 0 : at);
          wanted = true;
          play();
        },
      };

      new IntersectionObserver(
        ([entry]) => {
          seen = entry.isIntersecting;
          if (seen) setTimeout(maybe, 700);
          else if (playing) stop(false);
        },
        { threshold: 0.5 },
      ).observe(frame);
      document.addEventListener("visibilitychange", () => (document.hidden ? playing && stop(false) : maybe()));

      // The visitor takes over: their own clicks and keys end it.
      const takeOver = (e) => {
        if (e.isTrusted && (playing || wanted)) stop(true);
      };
      frame.addEventListener("pointerdown", takeOver, true);
      frame.addEventListener("keydown", takeOver, true);

      return auto;
    }

    // After the app has handled a click on its screen: doing what the tip
    // says moves on, so does doing what a later (or earlier) step says, and
    // anything else is the visitor playing on their own. An app refuses a
    // click (Sign in with nothing filled in) with preventDefault. What was
    // clicked is noted on the way down, before the app draws it again, and
    // weighed on the way back up, after the app's own handlers.
    let clicked = null;
    stage.addEventListener("click", (e) => (clicked = { hit: e.target.closest("[data-x]")?.dataset.x }), true);
    frame.addEventListener("click", (e) => {
      if (!clicked) return;
      const { hit } = clicked;
      clicked = null;
      const step = steps[at];
      const done = !e.defaultPrevented;
      if (hit && hit === step.dataset.target) {
        if (step.dataset.advance === "click" && done) {
          wander(false);
          go(at + 1, { scene: false, followed: true });
        }
        return;
      }
      const i = hit && done ? steps.findIndex((s) => s.dataset.advance === "click" && s.dataset.target === hit) : -1;
      if (i >= 0) {
        wander(false);
        go(i + 1, { scene: false, followed: true });
        return;
      }
      wander(true);
      refresh();
    });
    // Clicking the tip itself (not its buttons) moves it out of the way.
    bubble.addEventListener("click", (e) => {
      if (!e.target.closest("button")) wander(true);
    });
    again.addEventListener("click", () => {
      wander(false);
      // The tip's target went away while the visitor played: put the
      // screen back where the tip is about.
      if (!target) go(at);
      next.focus({ preventScroll: true });
    });
    back.addEventListener("click", () => {
      wander(false);
      go(at - 1);
    });
    next.addEventListener("click", () => {
      wander(false);
      if (at < steps.length - 1) go(at + 1);
      else if (following) show(following.id, { scroll: true, user: true });
      else go(0);
    });

    const auto = part.hasAttribute("data-autoplay") ? player() : null;
    app = APPS[part.id]?.({ stage, refresh }) || app;
    return { id: part.id, part, go, place, auto, started: false };
  });

  // Beside the parts' tabs: Pause / Play for a part that plays itself, and
  // the Tips switch.
  const tabsNav = document.querySelector(".tour-tabs");
  const switcher = h(
    "button",
    { type: "button", class: "tour-tips", "aria-pressed": String(tips) },
    "Tips",
    h("span", { class: "tour-tips-switch", "aria-hidden": "true" }),
  );
  const playButton = h("button", { type: "button", class: "tour-play", hidden: "" });
  tabsNav?.after(h("div", { class: "tour-controls" }, playButton, switcher));

  const shown = () => tours.find((t) => !t.part.hidden);
  function showPlayer() {
    const auto = shown()?.auto;
    playButton.hidden = !auto;
    if (!auto) return;
    const label = auto.playing ? "Pause" : auto.finished ? "Replay" : "Play";
    playButton.dataset.state = label.toLowerCase();
    playButton.textContent = label;
    playButton.setAttribute("aria-label", `${label} the demo`);
  }
  for (const t of tours) if (t.auto) t.auto.onChange = showPlayer;
  playButton.addEventListener("click", () => {
    const auto = shown()?.auto;
    if (!auto) return;
    if (auto.playing) auto.stop(true);
    else auto.start();
  });

  function setTips(on) {
    tips = on;
    switcher.setAttribute("aria-pressed", String(on));
    main.dataset.tips = on ? "on" : "off";
    try {
      if (on) localStorage.removeItem("tourTips");
      else localStorage.setItem("tourTips", "off");
    } catch {
      // Storage blocked: the choice lasts until the page closes.
    }
    tours.forEach((t) => t.place());
  }
  switcher.addEventListener("click", () => setTips(!tips));
  main.dataset.tips = tips ? "on" : "off";

  // how.user: the visitor chose it (the address names it, and a part that
  // plays itself stops). how.scroll: bring the tabs into view.
  function show(id, how = {}) {
    for (const part of parts) part.hidden = part.id !== id;
    for (const tab of tabs) tab.setAttribute("aria-current", String(tab.dataset.tourTab === id));
    // On a phone the tabs are a strip that scrolls sideways: bring this one in.
    const active = tabs.find((t) => t.dataset.tourTab === id);
    if (active && tabsNav && tabsNav.scrollWidth > tabsNav.clientWidth) {
      const a = active.getBoundingClientRect();
      const n = tabsNav.getBoundingClientRect();
      if (a.left < n.left) tabsNav.scrollLeft -= n.left - a.left + 16;
      else if (a.right > n.right) tabsNav.scrollLeft += a.right - n.right + 16;
    }
    if (how.user) for (const t of tours) if (t.id !== id) t.auto?.stop(true);
    for (const t of tours) if (t.id !== id && t.auto?.playing) t.auto.stop(false);
    const tour = tours.find((t) => t.id === id);
    if (!tour.started) {
      tour.started = true;
      tour.go(0);
    } else {
      tour.place();
    }
    showPlayer();
    if (how.user && location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    if (how.scroll) (document.getElementById("demo") || tour.part).scrollIntoView({ block: "start" });
    tour.auto?.maybe();
  }

  for (const tab of tabs) {
    tab.addEventListener("click", (e) => {
      e.preventDefault();
      show(tab.dataset.tourTab, { user: true });
    });
  }

  // "Watch it work": the part that plays itself, from the start.
  for (const link of document.querySelectorAll("[data-watch]")) {
    link.addEventListener("click", () => {
      const tour = tours.find((t) => t.auto);
      if (!tour) return;
      show(tour.id);
      tour.go(0);
      tour.auto.start();
    });
  }

  // A link to /#family, from another page or this one, opens that part.
  const named = () => parts.find((p) => `#${p.id}` === location.hash);
  addEventListener("hashchange", () => {
    const part = named();
    if (part) show(part.id, { scroll: true, user: true });
  });

  let frameRequest = 0;
  const replace = () => {
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(() => tours.forEach((t) => t.place()));
  };
  addEventListener("resize", replace);
  document.fonts?.ready.then(replace);

  const first = named();
  if (first) show(first.id, { scroll: true, user: true });
  else show(parts[0].id);
})();

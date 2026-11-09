// Builds passbundle.com into site/dist: each page in site/pages is wrapped in
// the shared layout, and everything in site/static is copied as is. No
// framework, nothing loaded from anyone else, which the privacy policy
// promises, and no scripts but our own: the light or dark switch, inline in
// every page (theme.mjs), and a page whose header has "script: tour" loads
// /tour.js. Run: node site/build.mjs
//
// Pages can use:
//   {{prices.premium}}, {{links.vault}}: values from site.json. An empty link
//     isn't live yet and becomes /download/ (check.mjs --launch refuses it).
//     {{links.extensionZip|links.extension}} is the first of them that isn't
//     empty.
//   <x-if link="vault">...</x-if>: what's inside, only once that link is
//     filled in. <x-if not link="vault">...</x-if>: only until then.
//   <x-shot name="msp-console" alt="..." frame="desktop"></x-shot>: a
//     screenshot from static/shots, with its dark version in dark mode. Add
//     `eager` for one that's on screen when the page opens, and `class` to
//     style it. Until e2e/site-shots has made it, it's a placeholder the size
//     of its `frame` (desktop, popup, or panel), which check.mjs --launch
//     refuses.
//   <x-tile icon="console" tone="sapphire"></x-tile>: a tile tinted with its
//     tone, with a glyph from icons.mjs in that tone. Decorative: say what it
//     means beside it. `class` sizes it (small, large).
//   <x-art name="LockIcon"></x-art>: one of the apps' drawings from art/,
//     inline so it takes the page's colors.
//   <x-mark class="mini"></x-mark>: the logo's glossy tile with the lock, as
//     the apps draw PassBundle's mark in their screens. Decorative. `class`
//     sizes it (mini, big, app).
//   <x-part name="tour"></x-part>: parts/tour.html, a piece of a page kept
//     in its own file (its leading comment says how to use it). `first-only` hides
//     every .tour-part but the first until static/tour.js runs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ICONS } from "./icons.mjs";
import { THEME_BUTTON, THEME_MENU_BUTTON, THEME_SCRIPT, themeable } from "./theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesDir = path.join(here, "pages");
const partsDir = path.join(here, "parts");
const staticDir = path.join(here, "static");
const artDir = path.join(here, "art");
const dist = path.join(here, "dist");
const site = JSON.parse(fs.readFileSync(path.join(here, "site.json"), "utf8"));

const MARK =
  "M4.5 13V8.5a8.5 8.5 0 0 1 17 0V13h-4V8.5a4.5 4.5 0 0 0-9 0V13ZM4.5 13h17a4.5 4.5 0 0 1 4.5 4.5V18H0v-.5A4.5 4.5 0 0 1 4.5 13ZM0 20h26v5H0ZM0 27h26v.5a4.5 4.5 0 0 1-4.5 4.5h-17A4.5 4.5 0 0 1 0 27.5Z";
// The logo: the solid emerald tile with the lock in white, then the name in
// lower case, two-tone, "pass" bold and "bundle" lighter (styles.css, .brand).
// Its accessible name is the link's, "PassBundle home".
const brandMark = `
      <span class="brand-tile" aria-hidden="true"><svg viewBox="0 0 26 32"><path fill-rule="evenodd" d="${MARK}"/></svg></span>
      <span class="brand-word" aria-hidden="true"><b>pass</b>bundle</span>`;
const GITHUB = "https://github.com/PimpinPumpkin/Passbundle";
const YEAR = 2026;

const escape = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A page file starts with a comment block of "key: value" lines. */
function parse(file) {
  const raw = fs.readFileSync(file, "utf8");
  const match = raw.match(/^<!--\n([\s\S]*?)\n-->\n/);
  if (!match) throw new Error(`${file}: missing the header comment`);
  const meta = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  for (const key of ["title", "description"]) {
    if (!meta[key]) throw new Error(`${file}: missing ${key}`);
  }
  return { meta, body: raw.slice(match[0].length), file };
}

/** Width and height of a WebP image, from its header. */
function webpSize(file) {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error(`${file}: not a WebP image`);
  }
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (chunk === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
  }
  throw new Error(`${file}: unknown WebP chunk ${chunk}`);
}

const attrs = (tag) =>
  Object.fromEntries([...tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k, v ?? ""]));

/** <x-shot>: a <picture> with the light and dark screenshots. Shots are 2x, so the size given is half. */
const placeholders = [];
const FRAMES = ["desktop", "popup", "panel"];
function shot(tag, file) {
  const a = attrs(tag);
  const shots = path.join(staticDir, "shots");
  if (!a.alt) throw new Error(`${file}: screenshot ${a.name} needs alt text`);
  const light = ["-light", ""].map((s) => `${a.name}${s}.webp`).find((f) => fs.existsSync(path.join(shots, f)));
  const cls = a.class ? ` ${a.class}` : "";
  if (!light) {
    // Not made yet: a box the shot's size, saying what goes there.
    const frame = a.frame ?? "desktop";
    if (!FRAMES.includes(frame)) throw new Error(`${file}: screenshot ${a.name} has an unknown frame ${frame}`);
    placeholders.push(`${path.basename(file)}: ${a.name}`);
    return `<span class="shot placeholder ${frame}${cls}" role="img" aria-label="${escape(a.alt)}"><mark class="todo">Screenshot to come: ${escape(a.name)}</mark></span>`;
  }
  const dark = `${a.name}-dark.webp`;
  const [w, h] = webpSize(path.join(shots, light));
  const source = fs.existsSync(path.join(shots, dark))
    ? `<source srcset="/shots/${dark}" media="(prefers-color-scheme: dark)">`
    : "";
  const loading = "eager" in a ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
  return `<picture class="shot${cls}">${source}<img src="/shots/${light}" width="${w / 2}" height="${h / 2}" alt="${escape(a.alt)}" ${loading}></picture>`;
}

/** <x-tile>: a tinted tile with its glyph in the tone's color, decorative. */
const TONES = [
  "brand", "sapphire", "topaz", "amethyst", "turquoise", "onyx", "aquamarine", "garnet", "emerald", "ruby", "gold",
];
function tile(tag, file) {
  const { icon, tone, class: cls } = attrs(tag);
  if (!ICONS[icon]) throw new Error(`${file}: no icon ${icon} in icons.mjs`);
  if (!TONES.includes(tone)) throw new Error(`${file}: tile ${icon} has an unknown tone ${tone}`);
  return `<span class="tile ${tone}${cls ? ` ${cls}` : ""}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="${ICONS[icon]}"/></svg></span>`;
}

/** <x-mark>: PassBundle's tile, decorative. */
function mark(tag) {
  const { class: cls } = attrs(tag);
  return `<span class="brand-tile${cls ? ` ${cls}` : ""}" aria-hidden="true"><svg viewBox="0 0 26 32" focusable="false"><path fill-rule="evenodd" d="${MARK}"/></svg></span>`;
}

/** <x-art>: an inline drawing, decorative. */
function art(tag, file) {
  const { name, class: cls } = attrs(tag);
  const svgFile = path.join(artDir, `${name}.svg`);
  if (!fs.existsSync(svgFile)) throw new Error(`${file}: no drawing ${name}`);
  return fs
    .readFileSync(svgFile, "utf8")
    .trim()
    .replace(/^<svg /, `<svg class="art${cls ? ` ${cls}` : ""}" aria-hidden="true" focusable="false" `);
}

function value(keys, file) {
  for (const key of keys.split("|")) {
    const v = key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), site);
    if (v === undefined) throw new Error(`${file}: no {{${key}}} in site.json`);
    if (!key.startsWith("links.") || v !== "") return v;
  }
  return "/download/";
}

/** <x-if link="vault">: its contents once that link is filled in; with `not`, until then. */
function when(tag, inner, file) {
  const a = attrs(tag);
  if (typeof site.links[a.link] !== "string") throw new Error(`${file}: <x-if> needs a link from site.json, like link="vault"`);
  return (site.links[a.link] !== "") === !("not" in a) ? inner : "";
}

/** <x-part>: a shared piece of a page, from parts/. */
function part(tag, file) {
  const a = attrs(tag);
  if (!/^[a-z-]+$/.test(a.name ?? "")) throw new Error(`${file}: <x-part> needs a name like tour`);
  const from = path.join(partsDir, `${a.name}.html`);
  if (!fs.existsSync(from)) throw new Error(`${file}: no parts/${a.name}.html`);
  let html = fs.readFileSync(from, "utf8").replace(/^<!--[\s\S]*?-->\s*/, "");
  if ("first-only" in a) {
    let seen = 0;
    html = html.replace(/<section class="tour-part"/g, (m) => (seen++ ? `${m} hidden` : m));
  }
  return html;
}

function expand(html, file) {
  return html
    .replace(/<x-part\b([^>]*)><\/x-part>/g, (_, t) => part(t, file))
    .replace(/<x-if\b([^>]*)>([\s\S]*?)<\/x-if>/g, (_, t, inner) => when(t, inner, file))
    .replace(/<x-shot\b([^>]*)><\/x-shot>/g, (_, t) => shot(t, file))
    .replace(/<x-art\b([^>]*)><\/x-art>/g, (_, t) => art(t, file))
    .replace(/<x-tile\b([^>]*)><\/x-tile>/g, (_, t) => tile(t, file))
    .replace(/<x-mark\b([^>]*)><\/x-mark>/g, (_, t) => mark(t))
    .replace(/\{\{\s*([\w.|]+)\s*\}\}/g, (_, k) => value(k, file));
}

// Six links: see it, what it does, who it's for, and what it costs. Demo is
// the homepage's demo, from any page. Download is the button beside them;
// Security, Help, and the rest are in the footer.
const NAV = [
  ["/#demo", "Demo"],
  ["/features/", "Features"],
  ["/personal/", "Personal"],
  ["/business/", "Business"],
  ["/msp/", "MSPs"],
  ["/pricing/", "Pricing"],
];

function layout({ meta, body, file }, route) {
  const title = route === "/" ? meta.title : `${meta.title} · PassBundle`;
  const kind = meta.layout === "wide" ? "wide" : "doc";
  const current = (href) => (route.startsWith(href) ? ' aria-current="page"' : "");
  const links = NAV.map(([href, label]) => `<a href="${href}"${current(href)}>${label}</a>`).join("\n        ");
  // "Sign in" goes to the hosted web vault (links.vault). Until that's
  // filled in, it goes to Download's Web card, which says when sign-in opens.
  const signIn = site.links.vault || "/download/#web";
  // Our own scripts only, by name, from static/: "script: tour" is /tour.js.
  if (meta.script && !/^[a-z-]+$/.test(meta.script)) throw new Error(`${file}: script must be a name like demo`);
  if (meta.script && !fs.existsSync(path.join(staticDir, `${meta.script}.js`))) throw new Error(`${file}: no static/${meta.script}.js`);
  const script = meta.script ? `\n<script src="/${meta.script}.js" defer></script>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>${THEME_SCRIPT}</script>
<title>${escape(title)}</title>
<meta name="description" content="${escape(meta.description)}">
<meta name="theme-color" content="#FAFAF8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0B0D0E" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/google-sans-flex-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css">
<link rel="canonical" href="https://passbundle.com${route}">${script}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="bar">
    <a class="brand" href="/" aria-label="PassBundle home">${brandMark}
    </a>
    <nav class="nav" aria-label="Main">
        ${links}
    </nav>
    ${THEME_BUTTON}
    <div class="header-actions">
      <a class="login" href="${signIn}">Sign in</a>
      <a class="button primary small" href="/download/">Download</a>
    </div>
    <details class="menu">
      <summary><span class="menu-word">Menu</span><svg class="menu-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M3 5h14M3 10h14M3 15h14"/></svg></summary>
      <nav aria-label="Menu">
        ${links}
        <a href="${signIn}">Sign in</a>
        ${THEME_MENU_BUTTON}
        <a class="button primary" href="/download/">Download</a>
      </nav>
    </details>
  </div>
</header>
<main id="main" class="${kind}">
${kind === "doc" ? `<div class="paper">\n${expand(body.trim(), file)}\n</div>` : expand(body.trim(), file)}
</main>
<footer class="site-footer">
  <div class="bar footer-grid">
    <div class="footer-brand">
      <a class="brand" href="/" aria-label="PassBundle home">${brandMark}
      </a>
      <p>The password manager for MSPs and every client they look after, for businesses with their own IT, and for everyone at home.</p>
      <p>PassBundle is free and open-source software. The apps, browser extension, and web vault are licensed under the GNU GPLv3, and the server under the GNU AGPLv3.</p>
      <p class="quiet">This site has no cookies and no trackers, and loads nothing from anyone else.</p>
    </div>
    <nav aria-label="Product">
      <h2>Product</h2>
      <a href="/personal/">Personal and families</a>
      <a href="/business/">Business</a>
      <a href="/msp/">For MSPs</a>
      <a href="/#demo">Demo</a>
      <a href="/features/">Features</a>
      <a href="/pricing/">Pricing</a>
      <a href="/download/">Download</a>
    </nav>
    <nav aria-label="Resources">
      <h2>Resources</h2>
      <a href="/switch/">Switch to PassBundle</a>
      <a href="/help/">Help</a>
      <a href="/security/">Security</a>
      <a href="${GITHUB}">Source code</a>
    </nav>
    <nav aria-label="Company">
      <h2>Company</h2>
      <a href="/contact/">Contact</a>
      <a href="/privacy/">Privacy</a>
      <a href="/terms/">Terms</a>
    </nav>
  </div>
  <div class="bar legal">
    <p>© ${YEAR} PassBundle. Built on the open-source Bitwarden clients and Vaultwarden. PassBundle isn't affiliated with Bitwarden, Inc. Bitwarden is a trademark of Bitwarden, Inc.</p>
  </div>
</footer>
</body>
</html>
`;
}

/** pages/index.html is "/", pages/help.html is "/help/", pages/404.html stays 404.html. */
function routeOf(rel) {
  const name = rel.replace(/\.html$/, "");
  if (name === "index") return "/";
  if (name === "404") return null;
  return `/${name}/`;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
copyDir(staticDir, dist);

// The light or dark button: every dark-mode rule also answers to the
// visitor's pick (theme.mjs), and the CSP allows the inline theme script by
// its hash and nothing else inline.
const cssFile = path.join(dist, "styles.css");
fs.writeFileSync(cssFile, themeable(fs.readFileSync(cssFile, "utf8")));
const themeHash = crypto.createHash("sha256").update(THEME_SCRIPT).digest("base64");
const headersFile = path.join(dist, "_headers");
const headers = fs.readFileSync(headersFile, "utf8");
if (headers.split("script-src 'self';").length !== 2) throw new Error("_headers: expected one script-src 'self'; in the CSP");
fs.writeFileSync(headersFile, headers.replace("script-src 'self';", `script-src 'self' 'sha256-${themeHash}';`));
let pages = 0;
for (const rel of fs.readdirSync(pagesDir).filter((f) => f.endsWith(".html"))) {
  const route = routeOf(rel);
  const html = layout(parse(path.join(pagesDir, rel)), route ?? "/404");
  const out = route == null ? path.join(dist, "404.html") : path.join(dist, route, "index.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  pages++;
}
console.log(`built ${pages} pages into ${path.relative(process.cwd(), dist) || dist}`);
if (placeholders.length > 0) {
  console.log(`screenshots not made yet, shown as placeholders (${placeholders.length}):\n  ${placeholders.join("\n  ")}`);
}

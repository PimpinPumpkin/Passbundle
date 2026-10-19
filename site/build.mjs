// Builds passbundle.com into site/dist: each page in site/pages is wrapped in
// the shared layout, and everything in site/static is copied as is. No
// framework, no scripts, and nothing loaded from anyone else, which the
// privacy policy promises. Run: node site/build.mjs
//
// Pages can use:
//   {{prices.premium}}, {{links.vault}}: values from site.json. An empty link
//     isn't live yet and becomes /download/ (check.mjs --launch refuses it).
//   <x-shot name="msp-console" alt="..."></x-shot>: a screenshot from
//     static/shots, with its dark version in dark mode. Add `eager` for one
//     that's on screen when the page opens, and `class` to style it.
//   <x-art name="LockIcon"></x-art>: one of the apps' drawings from art/,
//     inline so it takes the page's colors.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesDir = path.join(here, "pages");
const staticDir = path.join(here, "static");
const artDir = path.join(here, "art");
const dist = path.join(here, "dist");
const site = JSON.parse(fs.readFileSync(path.join(here, "site.json"), "utf8"));

const MARK =
  "M4.5 13V8.5a8.5 8.5 0 0 1 17 0V13h-4V8.5a4.5 4.5 0 0 0-9 0V13ZM4.5 13h17a4.5 4.5 0 0 1 4.5 4.5V18H0v-.5A4.5 4.5 0 0 1 4.5 13ZM0 20h26v5H0ZM0 27h26v.5a4.5 4.5 0 0 1-4.5 4.5h-17A4.5 4.5 0 0 1 0 27.5Z";
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
function shot(tag, file) {
  const a = attrs(tag);
  const shots = path.join(staticDir, "shots");
  const light = ["-light", ""].map((s) => `${a.name}${s}.webp`).find((f) => fs.existsSync(path.join(shots, f)));
  if (!light) throw new Error(`${file}: no screenshot ${a.name}`);
  if (!a.alt) throw new Error(`${file}: screenshot ${a.name} needs alt text`);
  const dark = `${a.name}-dark.webp`;
  const [w, h] = webpSize(path.join(shots, light));
  const source = fs.existsSync(path.join(shots, dark))
    ? `<source srcset="/shots/${dark}" media="(prefers-color-scheme: dark)">`
    : "";
  const loading = "eager" in a ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
  return `<picture class="shot${a.class ? ` ${a.class}` : ""}">${source}<img src="/shots/${light}" width="${w / 2}" height="${h / 2}" alt="${escape(a.alt)}" ${loading}></picture>`;
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

function value(key, file) {
  const v = key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), site);
  if (v === undefined) throw new Error(`${file}: no {{${key}}} in site.json`);
  if (key.startsWith("links.") && v === "") return "/download/";
  return v;
}

function expand(html, file) {
  return html
    .replace(/<x-shot\b([^>]*)><\/x-shot>/g, (_, t) => shot(t, file))
    .replace(/<x-art\b([^>]*)><\/x-art>/g, (_, t) => art(t, file))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => value(k, file));
}

const NAV = [
  ["/business/", "Business"],
  ["/msp/", "For MSPs"],
  ["/pricing/", "Pricing"],
  ["/security/", "Security"],
  ["/help/", "Help"],
];

function layout({ meta, body, file }, route) {
  const title = route === "/" ? meta.title : `${meta.title} · PassBundle`;
  const kind = meta.layout === "wide" ? "wide" : "doc";
  const current = (href) => (route.startsWith(href) ? ' aria-current="page"' : "");
  const links = NAV.map(([href, label]) => `<a href="${href}"${current(href)}>${label}</a>`).join("\n        ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(meta.description)}">
<meta name="theme-color" content="#1F6F5C">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/figtree-latin-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css">
<link rel="canonical" href="https://passbundle.com${route}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="bar">
    <a class="brand" href="/" aria-label="PassBundle home">
      <svg viewBox="0 0 26 32" width="22" height="27" aria-hidden="true"><path fill-rule="evenodd" d="${MARK}"/></svg>
      <span>PassBundle</span>
    </a>
    <nav class="nav" aria-label="Main">
        ${links}
    </nav>
    <div class="header-actions">
      <a class="login" href="${value("links.vault", file)}">Log in</a>
      <a class="button primary small" href="/download/">Get PassBundle</a>
    </div>
    <details class="menu">
      <summary>Menu</summary>
      <nav aria-label="Main">
        ${links}
        <a href="${value("links.vault", file)}">Log in</a>
      </nav>
    </details>
  </div>
</header>
<main id="main" class="${kind}">
${kind === "doc" ? `<div class="paper">\n${expand(body.trim(), file)}\n</div>` : expand(body.trim(), file)}
</main>
<footer class="site-footer">
  <div class="bar">
    <div class="footer-brand">
      <a class="brand" href="/" aria-label="PassBundle home">
        <svg viewBox="0 0 26 32" width="18" height="22" aria-hidden="true"><path fill-rule="evenodd" d="${MARK}"/></svg>
        <span>PassBundle</span>
      </a>
      <p>The password manager for you, your family, your business, and every client you look after.</p>
    </div>
    <nav aria-label="Product">
      <h2>Product</h2>
      <a href="/">Personal</a>
      <a href="/business/">Business</a>
      <a href="/msp/">For MSPs</a>
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

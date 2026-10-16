// Builds passbundle.com into site/dist: each page in site/pages is wrapped in
// the shared layout, and everything in site/static is copied as is. No
// framework, no scripts, and nothing loaded from anyone else, which the
// privacy policy promises. Run: node site/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagesDir = path.join(here, "pages");
const staticDir = path.join(here, "static");
const dist = path.join(here, "dist");

const MARK =
  "M3 0h20a3 3 0 0 1 3 3v26a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3Zm10 7a5 5 0 0 0-2.5 9.33L9 26h8l-1.5-9.67A5 5 0 0 0 13 7Z";
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
  return { meta, body: raw.slice(match[0].length) };
}

function layout({ meta, body }, route) {
  const title = route === "/" ? meta.title : `${meta.title} · PassBundle`;
  const wide = meta.layout === "wide";
  const current = (href) => (route.startsWith(href) ? ' aria-current="page"' : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(meta.description)}">
<meta name="theme-color" content="#1F6F5C">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
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
    <nav aria-label="Main">
      <a href="/help/"${current("/help/")}>Help</a>
      <a href="/security/"${current("/security/")}>Security</a>
      <a href="${GITHUB}">GitHub</a>
    </nav>
  </div>
</header>
<main id="main" class="${wide ? "wide" : "doc"}">
${body.trim()}
</main>
<footer class="site-footer">
  <div class="bar">
    <nav aria-label="Footer">
      <a href="/privacy/">Privacy</a>
      <a href="/terms/">Terms</a>
      <a href="/security/">Security</a>
      <a href="/contact/">Contact</a>
      <a href="${GITHUB}">GitHub</a>
    </nav>
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

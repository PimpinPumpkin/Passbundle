// Checks the built site: every internal link resolves to a page or file, and
// every path the PassBundle apps link to exists. Run after build.mjs:
// node site/check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

// The apps' links to the website (brand.json's "website" plus upstream's
// paths, rewritten by the clients' brand/apply.mjs) and the security.txt path.
const REQUIRED = [
  "/",
  "/help/",
  "/privacy/",
  "/terms/",
  "/download/",
  "/contact/",
  "/browser-start/",
  "/security/",
  "/.well-known/security.txt",
];

function resolves(route) {
  const clean = route.split(/[?#]/)[0];
  const file = path.join(dist, clean);
  if (clean.endsWith("/")) return fs.existsSync(path.join(file, "index.html"));
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

const problems = [];
for (const route of REQUIRED) {
  if (!resolves(route)) problems.push(`missing ${route}`);
}

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? htmlFiles(p) : e.name.endsWith(".html") ? [p] : [];
  });
}

let links = 0;
for (const file of htmlFiles(dist)) {
  const html = fs.readFileSync(file, "utf8");
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (url.startsWith("#") || /^(https?:|mailto:)/.test(url)) continue;
    links++;
    if (!url.startsWith("/")) problems.push(`${path.relative(dist, file)}: relative link ${url}`);
    else if (!resolves(url)) problems.push(`${path.relative(dist, file)}: broken link ${url}`);
  }
  if (/<script/i.test(html)) problems.push(`${path.relative(dist, file)}: has a script`);
  if (/—/.test(html)) problems.push(`${path.relative(dist, file)}: has an em dash`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`site ok: ${REQUIRED.length} required paths, ${links} internal links`);

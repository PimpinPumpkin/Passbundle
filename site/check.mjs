// Checks the built site: every internal link and image resolves to a file,
// every path the PassBundle apps link to exists, and nothing breaks the
// site's promises (no scripts but our own files, no em dashes). Run after
// build.mjs:
//   node site/check.mjs            the preview
//   node site/check.mjs --launch   also refuses what isn't ready for
//                                  passbundle.com: highlighted placeholders
//                                  and links in site.json still empty
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { THEME_SCRIPT } from "./theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const launch = process.argv.includes("--launch");

// The apps' links to the website (brand.json's "website" plus upstream's
// paths, rewritten by the clients' brand/apply.mjs), the security.txt path,
// and the pages the site is built around.
const REQUIRED = [
  "/",
  "/business/",
  "/msp/",
  "/pricing/",
  "/switch/",
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
const todos = [];
for (const file of htmlFiles(dist)) {
  const html = fs.readFileSync(file, "utf8");
  const rel = path.relative(dist, file);
  const urls = [...html.matchAll(/(?:href|src|srcset)="([^"]+)"/g)].map((m) => m[1]);
  for (const url of urls) {
    if (url.startsWith("#") || /^(https?:|mailto:)/.test(url)) continue;
    links++;
    if (!url.startsWith("/")) problems.push(`${rel}: relative link ${url}`);
    else if (!resolves(url)) problems.push(`${rel}: broken link ${url}`);
  }
  // Only our own scripts: files loaded with defer, and the theme script inline
  // (allowed by its hash in _headers). Nothing else inline, nothing from
  // anyone else.
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  if (scripts.length !== (html.match(/<script\b/gi) ?? []).length) problems.push(`${rel}: has a script tag that isn't closed`);
  for (const tag of scripts) {
    if (tag === `<script>${THEME_SCRIPT}</script>`) continue;
    if (!/^<script src="\/[a-z-]+\.js" defer><\/script>$/.test(tag)) problems.push(`${rel}: has a script that isn't one of our own files: ${tag.slice(0, 60)}`);
  }
  if (/\son[a-z]+=/i.test(html)) problems.push(`${rel}: has an inline event handler, which the site's CSP blocks`);
  if (/\sstyle="/i.test(html)) problems.push(`${rel}: has an inline style, which the site's CSP blocks`);
  if (/—/.test(html)) problems.push(`${rel}: has an em dash`);
  if (/\{\{|<x-/.test(html)) problems.push(`${rel}: has a placeholder build.mjs didn't fill in`);
  for (const [, text] of html.matchAll(/<mark class="todo">([\s\S]*?)<\/mark>/g)) todos.push(`${rel}: ${text}`);
}

// The CSP allows the inline theme script by its hash, and nothing else inline.
const hash = crypto.createHash("sha256").update(THEME_SCRIPT).digest("base64");
if (!fs.readFileSync(path.join(dist, "_headers"), "utf8").includes(`script-src 'self' 'sha256-${hash}';`)) {
  problems.push("_headers: the CSP doesn't allow the theme script by its hash");
}

const site = JSON.parse(fs.readFileSync(path.join(here, "site.json"), "utf8"));
const unset = Object.entries(site.links)
  .filter(([, v]) => v === "")
  .map(([k]) => `site.json: links.${k} is empty`);

if (launch) problems.push(...todos, ...unset);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`site ok: ${REQUIRED.length} required paths, ${links} internal links`);
if (!launch && todos.length + unset.length > 0) {
  console.log(`not ready for launch (${todos.length + unset.length}):\n  ${[...todos, ...unset].join("\n  ")}`);
}

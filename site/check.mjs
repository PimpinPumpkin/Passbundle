// Checks the built site: every internal link and image resolves to a file,
// every path the PassBundle apps link to exists, and nothing breaks the
// site's promises (no scripts but our own files, no em dashes). Run after
// build.mjs:
//   node site/check.mjs            the preview. Lists what's not filled in
//                                  yet: what blocks passbundle.com, and
//                                  what doesn't
//   node site/check.mjs --launch   also refuses what passbundle.com can't go
//                                  live without: highlighted placeholders,
//                                  and an empty links.vault or
//                                  links.extensionZip in site.json
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { THEME_SCRIPT } from "./theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const launch = process.argv.includes("--launch");
const ORIGIN = "https://passbundle.com";

// The apps' links to the website (brand.json's "website" plus upstream's
// paths, rewritten by the clients' brand/apply.mjs), the security.txt path,
// and the pages the site is built around.
const REQUIRED = [
  "/",
  "/personal/",
  "/business/",
  "/msp/",
  "/features/",
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

// Search engines: "indexed" in site.json decides, and what the build wrote
// for them has to agree with it. Not indexed is an X-Robots-Tag: noindex
// header on every path and no sitemap. Indexed is no such header, and a
// sitemap.xml that robots.txt points at, listing every page but the 404 and
// those that keep themselves out ("index: no" at the top of the page).
// robots.txt never turns crawlers away: one that's turned away never sees
// the noindex header, and the address can still be listed.
const noindex = /^\/\*\n(?:[ \t]+.*\n)*?[ \t]+X-Robots-Tag: noindex$/m.test(fs.readFileSync(path.join(dist, "_headers"), "utf8"));
const robots = fs.existsSync(path.join(dist, "robots.txt")) ? fs.readFileSync(path.join(dist, "robots.txt"), "utf8") : "";
const shut = /^Disallow: \/$/m.test(robots);
const sitemapFile = path.join(dist, "sitemap.xml");
const sitemap = fs.existsSync(sitemapFile) ? fs.readFileSync(sitemapFile, "utf8") : null;
let search;
if (site.indexed === false) {
  if (!noindex) problems.push("_headers: the site isn't indexed, and the block for every path has no X-Robots-Tag: noindex");
  if (shut) problems.push("robots.txt: the site isn't indexed, and this turns crawlers away, so they'd never see the noindex header");
  if (sitemap != null) problems.push("sitemap.xml: the site isn't indexed, so there shouldn't be one");
  search = `search engines: told not to index the site (site.json, "indexed": false)`;
} else if (site.indexed === true) {
  if (noindex) problems.push("_headers: the site is indexed, and this has X-Robots-Tag: noindex");
  if (shut || !/^Allow: \/$/m.test(robots)) problems.push("robots.txt: the site is indexed, and this doesn't allow everything");
  if (!robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) problems.push("robots.txt: doesn't point at the sitemap");
  const listed = [...(sitemap ?? "").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const built = htmlFiles(dist)
    .filter((file) => !fs.readFileSync(file, "utf8").includes('<meta name="robots" content="noindex">'))
    .map((file) => path.relative(dist, file).split(path.sep).join("/"))
    .filter((rel) => rel !== "404.html")
    .map((rel) => `${ORIGIN}/${rel.replace(/index\.html$/, "")}`);
  if (sitemap == null) problems.push("sitemap.xml: the site is indexed, and there isn't one");
  else {
    for (const url of built) if (!listed.includes(url)) problems.push(`sitemap.xml: doesn't list ${url}`);
    for (const url of listed) if (!built.includes(url)) problems.push(`sitemap.xml: lists ${url}, which isn't a page`);
  }
  search = `search engines: may index the site, and robots.txt points them at sitemap.xml, ${listed.length} pages (site.json, "indexed": true)`;
} else {
  problems.push('site.json: "indexed" has to be true or false');
}

// Links passbundle.com can go live without, because the pages read true
// while they're empty: with links.vault filled in and links.signup empty,
// they say new accounts aren't open yet and how to ask for one, and the store
// listings arrive whenever each store approves the extension. Any other
// empty link blocks.
const CAN_WAIT = {
  signup: "new accounts: until then, with links.vault filled in, the pages say they aren't open yet and how to ask for one",
  chrome: "the Chrome Web Store listing",
  edge: "the Edge Add-ons listing",
  firefox: "the Firefox Add-ons listing",
};
const empty = Object.entries(site.links)
  .filter(([, v]) => v === "")
  .map(([k]) => k);
const blocking = [
  ...todos,
  ...empty.filter((k) => !(k in CAN_WAIT)).map((k) => `site.json: links.${k} is empty`),
];
const waiting = empty.filter((k) => k in CAN_WAIT).map((k) => `site.json: links.${k} is empty (${CAN_WAIT[k]})`);

if (launch) problems.push(...blocking);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`site ok: ${REQUIRED.length} required paths, ${links} internal links`);
console.log(search);
if (blocking.length > 0) {
  console.log(`blocks going live on passbundle.com (${blocking.length}):\n  ${blocking.join("\n  ")}`);
}
if (waiting.length > 0) {
  console.log(`not filled in, and doesn't block (${waiting.length}):\n  ${waiting.join("\n  ")}`);
}

#!/usr/bin/env node
// Checks that every relative link in this repository's Markdown files
// points at a file or folder that exists here: `[text](path)` and
// `[text](path#anchor)`, resolved from the file the link is in. Links to
// websites, email addresses, anchors on the same page, and paths that leave
// the repository (another repository's checkout beside this one) aren't
// checked. Run from anywhere: `node tools/check-doc-links.mjs`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

// [text](target) and [text](target "title"), not images' sources inside
// code. Code spans and fenced blocks are blanked first, so an example of a
// link in code isn't read as one.
const LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

function withoutCode(text) {
  return text
    .replace(/^(\s*)(```|~~~)[\s\S]*?^\1\2[^\n]*$/gm, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

const broken = [];
for (const file of files) {
  const text = withoutCode(readFileSync(path.join(root, file), "utf8"));
  for (const match of text.matchAll(LINK)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//")) continue;
    let pathPart = target.split("#")[0].split("?")[0];
    try {
      pathPart = decodeURIComponent(pathPart);
    } catch {
      // Left as written.
    }
    if (!pathPart) continue;
    const resolved = pathPart.startsWith("/")
      ? path.join(root, pathPart)
      : path.resolve(root, path.dirname(file), pathPart);
    if (path.relative(root, resolved).startsWith("..")) continue;
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split("\n").length;
      broken.push(`${file}:${line}: ${target}`);
    }
  }
}

if (broken.length) {
  console.error(`${broken.length} link(s) to files that don't exist:`);
  for (const b of broken) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`Checked the relative links in ${files.length} Markdown files.`);

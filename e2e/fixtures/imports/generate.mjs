// Writes the fake exports (files/<format>/) and what PassBundle should hold
// after importing each one (expected/<format>.json). The same every run.
//
//   node fixtures/imports/generate.mjs           write them
//   node fixtures/imports/generate.mjs --check   fail if what's committed is out of date
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dataset } from "./dataset.mjs";
import { formats } from "./formats.mjs";
import { unzip } from "./zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** JSON with one item per line, so a change to an item is a one-line diff. */
function pretty(expected) {
  const lines = Object.entries(expected).map(([key, value]) =>
    Array.isArray(value) && key === "items"
      ? `  "items": [\n${value.map((v) => "    " + JSON.stringify(v)).join(",\n")}\n  ]`
      : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{\n${lines.join(",\n")}\n}\n`;
}

/** The same file: the same bytes, or for a zip, the same entries with the same contents. */
export function sameFile(relative, a, b) {
  if (a.equals(b)) return true;
  if (!/\.(zip|1pux)$/.test(relative)) return false;
  const [x, y] = [unzip(a), unzip(b)];
  return x.size === y.size && [...x].every(([name, data], i) => [...y.keys()][i] === name && data.equals(y.get(name)));
}

/** Every file this generator makes, by path under fixtures/imports/. */
export function generate() {
  const data = dataset();
  const out = new Map();
  for (const format of formats) {
    const files = format.files(data);
    for (const file of files) {
      out.set(
        path.join("files", format.id, file.name),
        Buffer.isBuffer(file.contents) ? file.contents : Buffer.from(file.contents, "utf8"),
      );
    }
    const expected = {
      format: format.id,
      title: format.title,
      files: files.map((f) => f.name),
      ...format.expect(data),
    };
    out.set(path.join("expected", `${format.id}.json`), Buffer.from(pretty(expected), "utf8"));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const files = generate();
  let stale = 0;
  for (const [relative, contents] of files) {
    const target = path.join(here, relative);
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (current != null && sameFile(relative, current, contents)) continue;
    if (check) {
      console.error(`Out of date: ${relative}`);
      stale++;
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
      console.log(`Wrote ${relative}`);
    }
  }
  if (stale > 0) {
    console.error("Run node fixtures/imports/generate.mjs and commit the result.");
    process.exit(1);
  }
}

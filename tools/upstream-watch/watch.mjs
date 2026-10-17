// The weekly upstream watch (.github/workflows/upstream-watch.yml). Compares
// our bases with upstream and reads the dependency audits, and writes a
// report of what needs doing:
//
// - A Vaultwarden release newer than the server's base (passbundle-server's
//   .keykeeper-base), flagged when it has security fixes.
// - Vaultwarden shipping a newer web vault than the clients' base
//   (passbundle-clients' .keykeeper-base). We follow the web vault Vaultwarden
//   supports, not Bitwarden's newest: the server must understand the clients.
// - Known vulnerabilities in what we ship (cargo audit for the server and the
//   desktop agent, npm audit of the clients' production dependencies).
//
// See DESIGN.md, "Keeping up with upstream".
import fs from "node:fs";

/** "web-v2026.8.0", "v2026.8.0", or "1.37.4" as numbers, or null. */
export function parseVersion(tag) {
  const match = /^(?:[a-z]+-)?v?(\d+(?:\.\d+)*)$/.exec(String(tag).trim());
  return match ? match[1].split(".").map(Number) : null;
}

/** Negative, zero, or positive, like a sort comparator. */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`can't compare ${a} and ${b}`);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The web vault a Vaultwarden release ships, from its docker/DockerSettings.yaml. */
export function supportedWebVault(dockerSettings) {
  const match = /^vault_version:\s*"?([^"\s]+)"?/m.exec(dockerSettings);
  return match ? match[1] : null;
}

export function hasSecurityFixes(releaseBody) {
  return /^#+\s*security fixes/im.test(releaseBody ?? "");
}

/** The findings that matter from `cargo audit --json`. */
export function cargoFindings(report) {
  return (report?.vulnerabilities?.list ?? []).map((v) => ({
    id: v.advisory.id,
    package: `${v.package.name} ${v.package.version}`,
    title: v.advisory.title,
    fix: (v.versions?.patched ?? []).join(", ") || "no fixed version yet",
  }));
}

/**
 * High and critical advisories from `npm audit --omit=dev --json`, one per
 * advisory, on the package that has it (npm also lists every package that
 * merely depends on it).
 */
export function npmFindings(report) {
  const findings = [];
  for (const v of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || (via.severity !== "high" && via.severity !== "critical")) continue;
      findings.push({
        id: via.url?.split("/").pop() ?? via.severity,
        package: v.name,
        title: via.title ?? "vulnerable dependency",
        fix: v.fixAvailable ? "a fix is available" : "no fix yet",
      });
    }
  }
  return findings;
}

/**
 * What to do, from what was gathered.
 * @param {{
 *   serverBase: string, clientsBase: string,
 *   vaultwardenReleases: { tag: string, body: string }[],
 *   webVaultForLatest: string | null,
 *   webVaultOnMain?: string | null,
 *   bitwardenLatest: { web?: string, browser?: string },
 *   audits: { name: string, npm?: boolean, findings: { id: string, package: string, title: string, fix: string }[] }[],
 *   accepted?: { npm?: Record<string, string>, cargo?: Record<string, string> },
 * }} input
 */
export function plan(input) {
  const actions = [];
  const notes = [];
  const newer = input.vaultwardenReleases
    .filter((r) => parseVersion(r.tag) && compareVersions(r.tag, input.serverBase) > 0)
    .sort((a, b) => compareVersions(a.tag, b.tag));
  if (newer.length) {
    const security = newer.filter((r) => hasSecurityFixes(r.body)).map((r) => r.tag);
    const latest = newer[newer.length - 1].tag;
    actions.push(
      `Move the server from Vaultwarden ${input.serverBase} to ${latest}` +
        (security.length ? `. **Security fixes in ${security.join(", ")}.**` : "."),
    );
  }
  if (input.webVaultForLatest && compareVersions(input.webVaultForLatest, input.clientsBase) > 0) {
    actions.push(
      `Vaultwarden now ships web vault ${input.webVaultForLatest}: move the clients from ${input.clientsBase} with the server.`,
    );
  }
  const accepted = input.accepted ?? { npm: {}, cargo: {} };
  const skipped = new Map();
  for (const audit of input.audits) {
    for (const f of audit.findings) {
      // npm: by package (packages outside what we ship). cargo: by advisory and package version.
      const key = audit.npm ? f.package : `${f.id} ${f.package}`;
      if ((audit.npm ? accepted.npm : accepted.cargo)?.[key]) {
        skipped.set(key, (skipped.get(key) ?? 0) + 1);
        continue;
      }
      actions.push(`${audit.name}: ${f.package}, ${f.title} (${f.id}; ${f.fix}).`);
    }
  }
  if (skipped.size) {
    const count = [...skipped.values()].reduce((a, b) => a + b, 0);
    notes.push(
      `Accepted, with reasons in tools/upstream-watch/accepted.json: ${count} findings (${[...skipped.keys()].sort().join("; ")}).`,
    );
  }
  const { web, browser } = input.bitwardenLatest;
  const latestServer = input.vaultwardenReleases[0]?.tag;
  notes.push(
    `Our clients are on ${input.clientsBase}. Vaultwarden ${latestServer ?? "(no release)"} ships web vault ${input.webVaultForLatest ?? "(unknown)"}` +
      (input.webVaultOnMain ? `, and its main branch, the next release, ${input.webVaultOnMain}.` : "."),
  );
  if (web || browser) {
    notes.push(
      `Bitwarden's newest clients are ${[web, browser].filter(Boolean).join(" and ")}. They wait until Vaultwarden supports them.`,
    );
  }
  return { actions, notes };
}

export function report({ actions, notes }, date) {
  const lines = [`Upstream and dependency watch, ${date}.`, ""];
  if (actions.length) {
    lines.push("**To do:**", "", ...actions.map((a) => `- ${a}`));
  } else {
    lines.push("Nothing to do: the server and clients are on the newest bases Vaultwarden supports, and the audits found nothing.");
  }
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n") + "\n";
}

async function github(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
  return response.json();
}

/** A file from a branch, or from the main branch if that branch hasn't one. */
async function raw(repo, ref, file) {
  for (const branch of [...new Set([ref, "keykeeper"])]) {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${file}`);
    if (response.ok) return (await response.text()).trim();
  }
  throw new Error(`${repo}/${file}: not found on ${ref} or keykeeper`);
}

const readJson = (path) => (path && fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : null);

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)),
  );
  // The forks' main branches, or the branches a pull request links.
  const [serverBase, clientsBase] = await Promise.all([
    raw("PimpinPumpkin/passbundle-server", args["server-ref"] || "keykeeper", ".keykeeper-base"),
    raw("PimpinPumpkin/passbundle-clients", args["clients-ref"] || "keykeeper", ".keykeeper-base"),
  ]);
  const releases = await github("repos/dani-garcia/vaultwarden/releases?per_page=20");
  const vaultwardenReleases = releases
    .filter((r) => !r.prerelease && !r.draft)
    .map((r) => ({ tag: r.tag_name, body: r.body ?? "" }));
  const latest = vaultwardenReleases[0]?.tag;
  let webVaultForLatest = null;
  const webVaultAt = async (ref) => {
    const file = await github(`repos/dani-garcia/vaultwarden/contents/docker/DockerSettings.yaml?ref=${ref}`);
    return supportedWebVault(Buffer.from(file.content, "base64").toString("utf8"));
  };
  if (latest) {
    webVaultForLatest = await webVaultAt(latest);
  }
  const webVaultOnMain = await webVaultAt("main");
  const clientReleases = await github("repos/bitwarden/clients/releases?per_page=40");
  const newest = (prefix) =>
    clientReleases.find((r) => !r.prerelease && r.tag_name.startsWith(prefix))?.tag_name;
  const audits = [
    { name: "Server (cargo audit)", findings: cargoFindings(readJson(args["cargo-server"])) },
    { name: "Desktop agent (cargo audit)", findings: cargoFindings(readJson(args["cargo-agent"])) },
    { name: "Clients (npm audit, production)", npm: true, findings: npmFindings(readJson(args["npm-clients"])) },
  ];
  const accepted = JSON.parse(fs.readFileSync(new URL("./accepted.json", import.meta.url), "utf8"));
  const result = plan({
    serverBase,
    clientsBase,
    vaultwardenReleases,
    webVaultForLatest,
    webVaultOnMain,
    bitwardenLatest: { web: newest("web-v"), browser: newest("browser-v") },
    audits,
    accepted,
  });
  const text = report(result, new Date().toISOString().slice(0, 10));
  process.stdout.write(text);
  if (args.out) fs.writeFileSync(args.out, text);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `actionable=${result.actions.length > 0}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

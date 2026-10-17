// node --test tools/upstream-watch
import assert from "node:assert/strict";
import test from "node:test";

import {
  cargoFindings,
  compareVersions,
  hasSecurityFixes,
  npmFindings,
  plan,
  report,
  supportedWebVault,
} from "./watch.mjs";

const quiet = {
  serverBase: "1.37.4",
  clientsBase: "web-v2026.8.0",
  vaultwardenReleases: [{ tag: "1.37.4", body: "## Security Fixes\n- old ones" }],
  webVaultForLatest: "v2026.8.0",
  bitwardenLatest: {},
  audits: [],
};

test("versions compare by number, whatever the prefix", () => {
  assert.ok(compareVersions("web-v2026.10.0", "v2026.9.1") > 0);
  assert.ok(compareVersions("1.37.10", "1.37.9") > 0);
  assert.equal(compareVersions("v2026.8.0", "web-v2026.8.0"), 0);
  assert.throws(() => compareVersions("main", "1.0.0"));
});

test("nothing to do when we're on the newest bases Vaultwarden supports", () => {
  const result = plan(quiet);
  assert.deepEqual(result.actions, []);
  assert.match(report(result, "2026-10-19"), /Nothing to do/);
});

test("a newer Vaultwarden release is a to-do, flagged when it has security fixes", () => {
  const result = plan({
    ...quiet,
    vaultwardenReleases: [
      { tag: "1.37.6", body: "Fixes" },
      { tag: "1.37.5", body: "## Security Fixes\n- something" },
      ...quiet.vaultwardenReleases,
    ],
  });
  assert.deepEqual(result.actions, [
    "Move the server from Vaultwarden 1.37.4 to 1.37.6. **Security fixes in 1.37.5.**",
  ]);
});

test("a newer supported web vault moves the clients; Bitwarden's newest alone doesn't", () => {
  assert.deepEqual(plan({ ...quiet, bitwardenLatest: { web: "web-v2026.10.0" } }).actions, []);
  const result = plan({ ...quiet, webVaultForLatest: "v2026.9.1" });
  assert.deepEqual(result.actions, [
    "Vaultwarden now ships web vault v2026.9.1: move the clients from web-v2026.8.0 with the server.",
  ]);
});

test("the web vault version comes from Vaultwarden's docker settings", () => {
  assert.equal(supportedWebVault('---\nvault_version: "v2026.8.0"\nvault_image_digest: "sha256:x"\n'), "v2026.8.0");
  assert.equal(supportedWebVault("nothing here"), null);
});

test("security fixes are a heading in the release notes", () => {
  assert.ok(hasSecurityFixes("Intro\n\n## Security Fixes\nThis release..."));
  assert.ok(!hasSecurityFixes("Updated a security header"));
});

test("audit findings become to-dos: every cargo advisory, npm's high and critical", () => {
  const cargo = cargoFindings({
    vulnerabilities: {
      list: [
        {
          advisory: { id: "RUSTSEC-2026-0001", title: "Bad parse" },
          package: { name: "foo", version: "1.2.3" },
          versions: { patched: [">=1.2.4"] },
        },
      ],
    },
  });
  const npm = npmFindings({
    vulnerabilities: {
      lodash: {
        name: "lodash",
        severity: "high",
        via: [{ title: "Prototype pollution", severity: "high", url: "https://github.com/advisories/GHSA-aaaa" }],
        fixAvailable: true,
      },
      // Only depends on lodash: the advisory is reported once, on lodash.
      "lodash-wrapper": { name: "lodash-wrapper", severity: "high", via: ["lodash"], fixAvailable: true },
      chalk: { name: "chalk", severity: "low", via: [{ title: "x", severity: "low" }], fixAvailable: false },
    },
  });
  const result = plan({
    ...quiet,
    audits: [
      { name: "Server (cargo audit)", findings: cargo },
      { name: "Clients (npm audit, production)", npm: true, findings: npm },
    ],
  });
  assert.deepEqual(result.actions, [
    "Server (cargo audit): foo 1.2.3, Bad parse (RUSTSEC-2026-0001; >=1.2.4).",
    "Clients (npm audit, production): lodash, Prototype pollution (GHSA-aaaa; a fix is available).",
  ]);
  assert.deepEqual(cargoFindings(null), []);
});

test("accepted npm packages are noted, not raised; cargo findings never are", () => {
  const finding = { id: "GHSA-bbbb", package: "vite", title: "Dev server bypass", fix: "a fix is available" };
  const result = plan({
    ...quiet,
    audits: [
      { name: "Clients (npm audit, production)", npm: true, findings: [finding, { ...finding, id: "GHSA-cccc" }] },
      { name: "Desktop agent (cargo audit)", findings: [{ ...finding, package: "vite 1.0.0" }] },
    ],
    accepted: { vite: "Build tooling only." },
  });
  assert.deepEqual(result.actions, ["Desktop agent (cargo audit): vite 1.0.0, Dev server bypass (GHSA-bbbb; a fix is available)."]);
  assert.ok(result.notes.some((n) => n.includes("2 npm advisories in vite")));
});

test("the accepted list gives a reason for every package", async () => {
  const fs = await import("node:fs");
  const { npm } = JSON.parse(fs.readFileSync(new URL("./accepted.json", import.meta.url), "utf8"));
  for (const [name, reason] of Object.entries(npm)) {
    assert.ok(reason.length > 20, `${name} needs a real reason`);
  }
});

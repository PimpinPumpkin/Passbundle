// Seeds a PassBundle server with test tenants for hands-on testing, and
// takes them down again. See README.md.
//
//   node tools/test-tenants/test-tenants.ts <seed|status|teardown|reset|code|domains> [--server <url>] [--test-server] [--out <folder>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Api, stepOf, totp } from "./api.ts";
import { check, credentialsFile, newState, Seeder, type State, teardown } from "./seed.ts";
import { DOMAINS, PEOPLE } from "./tenants.ts";

const TEST_SERVER = "test.passbundle.com";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

const USAGE = `Usage: node tools/test-tenants/test-tenants.ts <command> [options]

Commands:
  seed       Make the test tenants (does nothing if they're there already)
  status     Say whether the server has them
  teardown   Delete what seed made
  reset      teardown, then seed
  code NAME  Print NAME's current two-step login code (maya, grace, ...)
  domains    Print the email domains, for SIGNUPS_DOMAINS_WHITELIST

Options:
  --server URL    https://localhost, https://127.0.0.1, or https://[::1] with any port,
                  or https://${TEST_SERVER} with --test-server
  --test-server   Allow https://${TEST_SERVER}
  --out FOLDER    Where the credentials and state files go
                  (default ~/Documents/PassBundle-test-tenants/<server>)
`;

class UsageError extends Error {}

/** The server, if it's one this tool may seed: this computer's, or the test server when asked for by name. */
function serverOf(raw: string | undefined, testServer: boolean) {
  if (!raw) {
    throw new UsageError("Name the server with --server.");
  }
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new UsageError(`${raw} isn't an address.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new UsageError("The server's address is https:// and a host name, with an optional port, and nothing else.");
  }
  const host = url.hostname.toLowerCase();
  if (LOCAL.has(host)) {
    const name = host === "[::1]" ? "ipv6-localhost" : host;
    return { origin: url.origin, local: true, folder: `${name}${url.port ? `-${url.port}` : ""}` };
  }
  if (host === TEST_SERVER && !url.port) {
    if (!testServer) {
      throw new UsageError(`Seeding ${TEST_SERVER} needs --test-server too, and its settings in README.md ("Which servers").`);
    }
    return { origin: url.origin, local: false, folder: TEST_SERVER };
  }
  throw new UsageError(`The tool seeds only this computer's servers and https://${TEST_SERVER}, not ${url.origin}.`);
}

/** A folder isn't in a git checkout: none of it or its parents holds .git. */
function insideGit(folder: string): string | null {
  let at = path.resolve(folder);
  for (;;) {
    if (fs.existsSync(path.join(at, ".git"))) {
      return at;
    }
    const up = path.dirname(at);
    if (up === at) {
      return null;
    }
    at = up;
  }
}

/** The folder for a server's files, readable only by this user. */
function outFolder(chosen: string | undefined, server: string): string {
  const base = path.join(os.homedir(), "Documents", "PassBundle-test-tenants");
  const folder = chosen ? path.resolve(chosen) : path.join(base, server);
  const repo = insideGit(folder);
  if (repo) {
    throw new UsageError(`${folder} is inside the git checkout ${repo}. The credentials go outside any repository.`);
  }
  if (!chosen) {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    fs.chmodSync(base, 0o700);
  }
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  return folder;
}

/** Writes a file only this user can read, all at once. */
function writePrivate(file: string, text: string) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "test-server": { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "domains") {
    console.log(DOMAINS.join(","));
    return;
  }
  if (!["seed", "status", "teardown", "reset", "code"].includes(command)) {
    throw new UsageError(`No command ${command}.\n\n${USAGE}`);
  }
  const server = serverOf(values.server, values["test-server"]!);
  const folder = outFolder(values.out, server.folder);
  const stateFile = path.join(folder, "state.json");
  const credentials = path.join(folder, "credentials.md");
  const self = `node tools/test-tenants/test-tenants.ts --server ${server.origin}${server.local ? "" : " --test-server"}`;
  let state: State = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : newState(server.origin);
  if (state.server !== server.origin) {
    throw new UsageError(`${stateFile} is for ${state.server}, not ${server.origin}.`);
  }
  const save = () => {
    const empty = Object.keys(state.people).length === 0 && Object.keys(state.orgs).length === 0 && !state.mspId;
    if (empty) {
      fs.rmSync(stateFile, { force: true });
      fs.rmSync(credentials, { force: true });
      return;
    }
    writePrivate(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    writePrivate(credentials, credentialsFile(state, self));
  };
  const log = (line: string) => console.log(line);

  if (command === "code") {
    const key = (rest[0] ?? "").toLowerCase();
    const st = state.people[key];
    if (!PEOPLE.some((p) => p.key === key)) {
      throw new UsageError(`No one called ${rest[0] ?? "(nobody named)"}. Names: ${PEOPLE.filter((p) => p.authenticator).map((p) => p.key).join(", ")}.`);
    }
    if (!st?.totpKey) {
      throw new UsageError(`${st?.name ?? key} has no authenticator app on ${server.origin}.`);
    }
    // Not one the tool has used, so the server takes it.
    const now = Date.now();
    const code = (st.totpStep ?? -1) >= stepOf(now) ? totp(st.totpKey, (stepOf(now) + 1) * 30_000) : totp(st.totpKey, now);
    console.log(`${code}  (${30 - Math.floor((now / 1000) % 30)} seconds left)`);
    return;
  }

  const api = await Api.open(server.origin, server.local);
  try {
    if (!(await api.alive())) {
      throw new Error(`${server.origin} doesn't answer.`);
    }
    if (command === "status") {
      const result = await check(api, state, save);
      console.log(result.ok ? `Seeded: ${result.detail}. Credentials: ${credentials}` : `Not seeded (${result.detail}).`);
      return;
    }
    if (command === "teardown" || command === "reset" || (command === "seed" && !state.complete && Object.keys(state.people).length)) {
      if (command === "seed") {
        log("A seed that didn't finish is here: taking it down first.");
      }
      const left = await teardown(api, state, save, log);
      if (left.length) {
        console.error(`Some of it stays:\n- ${left.join("\n- ")}`);
        process.exitCode = 1;
        return;
      }
      log("Nothing the tool made is left, except Harbor IT's empty MSP record and invitations nobody accepted.");
      if (command === "teardown") {
        return;
      }
      state = newState(server.origin);
    }
    if (state.complete) {
      const result = await check(api, state, save);
      if (result.ok) {
        console.log(`Already seeded: ${result.detail}. Nothing changed. Credentials: ${credentials}`);
        return;
      }
      throw new Error(
        `The state file says this server was seeded, but ${result.detail}. If the server was wiped, remove ${stateFile}; otherwise run reset.`,
      );
    }
    await new Seeder(api, state, save, log).run();
    console.log(`Seeded ${server.origin}. Credentials: ${credentials}`);
  } finally {
    await api.close();
  }
}

main().catch((e) => {
  console.error(e instanceof UsageError ? e.message : `Stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = e instanceof UsageError ? 2 : 1;
});

// The core's interop tool (passbundle-apps core/examples/interop.rs), which
// tier 1 builds from the linked passbundle-apps branch (KK_CORE_INTEROP): it
// signs in to the test server as an account, prints what it opens, and saves
// an item or does a passkey action through the app's own calls.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

import { port } from "../../paths.mjs";

export const coreTool = process.env.KK_CORE_INTEROP;

export type CoreRead = {
  items: {
    name: string;
    username: string | null;
    password: string | null;
    notes: string | null;
    uris: string[];
    organizationId: string | null;
    fields: { name: string; value: string; hidden: boolean }[];
    passkey: {
      rpId: string;
      userName: string | null;
      credentialId: string | null;
      counter: number;
      discoverable: boolean;
      usable: boolean;
    } | null;
  }[];
  saved?: boolean;
  passkey?: Record<string, string>;
  /** Sign-in requests (docs/core.md, "Approving a sign-in"), and one answered or refused. */
  signIn?: {
    requests: {
      id: string;
      device: string;
      ip: string;
      fingerprint: string;
      ageSeconds: number;
      secondsLeft: number;
    }[];
    answered?: string;
    refused?: string;
  };
};

/** The test server's certificate, for the core to trust (its usual trust is the OS's). */
export async function serverCertificate(dir: string): Promise<string> {
  const der = await new Promise<Buffer>((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: Number(port), rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate(true).raw);
      socket.end();
    });
    socket.on("error", reject);
  });
  const file = path.join(dir, "server.pem");
  fs.writeFileSync(
    file,
    `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`,
  );
  return file;
}

/** Runs the core: signs in, reads every item, and saves the draft or does the action, if any. */
export function core(dir: string, cert: string, user: { email: string; password: string }, draft?: object): CoreRead {
  const args = [`https://127.0.0.1:${port}`, cert, user.email, user.password];
  if (draft) {
    const file = path.join(dir, `draft-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(draft));
    args.push(file);
  }
  return JSON.parse(execFileSync(coreTool!, args, { encoding: "utf8", timeout: 60_000 }));
}

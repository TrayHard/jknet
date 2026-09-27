/**
 * Starts the JKNet Online the e2e run talks to, and stops it afterwards.
 *
 * The binary comes from `JKNET_ONLINE_BIN` (a `cargo build` of jknet-online).
 * It runs in a fresh temporary folder, so no `.env` with secrets is read and
 * the database starts empty, on 127.0.0.1:8788 with the dev provider, which
 * also opens the service to the preview's origin, 127.0.0.1:5175. A
 * developer's service on 8787 is left alone.
 *
 * The workers find the folder and the environment in `JKNET_E2E_SERVICE`,
 * for the administrator's command the developer-account test runs.
 */

import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SERVICE = "http://127.0.0.1:8788";

async function waitForHealth(deadline: number): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${SERVICE}/healthz`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`JKNet Online did not answer ${SERVICE}/healthz`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const bin = process.env.JKNET_ONLINE_BIN;
  if (bin === undefined || bin === "") {
    throw new Error(
      "JKNET_ONLINE_BIN is not set: build jknet-online (`cargo build` in jknet-online) and point " +
        "JKNET_ONLINE_BIN at target/debug/jknet-online(.exe) before `npm run web:e2e`.",
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "jknet-web-e2e-"));
  const vapid = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }).d ?? "";
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("JKNET_ONLINE_")));
  const env: Record<string, string> = {
    ...(clean as Record<string, string>),
    RUST_LOG: "info,tower_http=warn,sqlx=warn",
    JKNET_ONLINE_BIND: "127.0.0.1:8788",
    JKNET_ONLINE_PUBLIC_URL: SERVICE,
    JKNET_ONLINE_DATABASE_URL: `sqlite://${join(dir, "online.db").replace(/\\/g, "/")}?mode=rwc`,
    JKNET_ONLINE_BLOB_DIR: join(dir, "blobs"),
    JKNET_ONLINE_CHAT_FILE_DIR: join(dir, "chat-files"),
    JKNET_ONLINE_DEV_PROVIDER: "1",
    JKNET_ONLINE_VAPID_PRIVATE_KEY: vapid,
  };

  const log = openSync(join(dir, "service.log"), "a");
  const child = spawn(bin, [], { cwd: dir, env, stdio: ["ignore", log, log], windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.once("exit", (code) => {
    if (code !== null && code !== 0) console.error(`JKNet Online exited with ${code}; see ${join(dir, "service.log")}`);
  });

  await waitForHealth(Date.now() + 30_000);
  process.env.JKNET_E2E_SERVICE = JSON.stringify({ bin, dir, env });

  return async () => {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    closeSync(log);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
}

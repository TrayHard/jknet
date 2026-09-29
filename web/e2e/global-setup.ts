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
 *
 * The catalogs are on (spec 1.12, 1.13), fed by the fakes of
 * `catalog-fakes.ts` on 127.0.0.1: the server list asks fake master and game
 * servers, and the JKHub catalog serves a seeded index and links to a fake
 * site. The workers find the fakes in `JKNET_E2E_CATALOG`.
 */

import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedJkhubCatalog, startJkhubFake, startServerFakes, type CatalogFakesInfo } from "./catalog-fakes.ts";

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
  const serverFakes = await startServerFakes();
  const jkhubFake = await startJkhubFake();
  const jkhubDir = join(dir, "jkhub");
  seedJkhubCatalog(jkhubDir);
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
    // A hidden tab, and the socket of a page that navigated away, count
    // for seconds instead of minutes, and the service looks for expired
    // presence every two seconds, so the presence spec sees a player go
    // offline. A page's reload in another spec may flicker its player for
    // a moment; nothing there reads presence across one.
    JKNET_ONLINE_WEB_HIDDEN_GRACE_SECS: "5",
    JKNET_ONLINE_WEB_CLOSE_GRACE_SECS: "5",
    JKNET_ONLINE_PRESENCE_SWEEP_SECS: "2",
    // The server list and the JKHub catalog, on the loopback fakes only:
    // the dev provider lets a loopback master through.
    JKNET_ONLINE_SERVER_LIST_ENABLED: "1",
    JKNET_ONLINE_SERVER_LIST_MASTERS_JA: serverFakes.mastersJa,
    JKNET_ONLINE_SERVER_LIST_MASTERS_JO: serverFakes.mastersJo,
    JKNET_ONLINE_JKHUB_CATALOG_ENABLED: "1",
    JKNET_ONLINE_JKHUB_BASE_URL: jkhubFake.base,
    JKNET_ONLINE_JKHUB_CATALOG_DIR: jkhubDir,
  };

  const log = openSync(join(dir, "service.log"), "a");
  const child = spawn(bin, [], { cwd: dir, env, stdio: ["ignore", log, log], windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.once("exit", (code) => {
    if (code !== null && code !== 0) console.error(`JKNet Online exited with ${code}; see ${join(dir, "service.log")}`);
  });

  await waitForHealth(Date.now() + 30_000);
  process.env.JKNET_E2E_SERVICE = JSON.stringify({ bin, dir, env });
  process.env.JKNET_E2E_CATALOG = JSON.stringify({
    servers: serverFakes.servers,
    jkhubBase: jkhubFake.base,
  } satisfies CatalogFakesInfo);

  return async () => {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await serverFakes.stop();
    await jkhubFake.stop();
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

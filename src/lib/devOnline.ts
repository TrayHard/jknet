/**
 * Talking to `scripts/mock-online.mjs` from a plain browser.
 *
 * --- slice: friends ---
 *
 * `npm run dev` opens the frontend outside Tauri, where every command rejects
 * with `Tauri runtime is not available` — which is the whole review of the
 * Friends screen reduced to one error line, because that screen is nothing but
 * commands. This module stands in for the eight of them by calling the mock
 * service over `fetch`, so the layout can be checked without building the core and
 * without `npm run tauri dev`.
 *
 * It is development scaffolding, not a feature:
 *
 * - `friendsIpc` reaches it only when `isTauri()` is false **and**
 *   `import.meta.env.DEV` is true, and the second is a compile-time constant,
 *   so the branch and this module leave the production bundle.
 * - The presence it reports is invented. The real one comes from the core,
 *   which is where the game is started from; a browser has no game.
 * - `join_friend` fails on purpose: starting a process is exactly what a
 *   browser cannot do, and pretending otherwise would hide the difference.
 *
 * Start the mock first: `node scripts/mock-online.mjs`.
 */

import type {
  BundleDetails,
  BundleDetailsWithLocal,
  BundleList,
  BundleQuery,
  BundleVersion,
  FriendsView,
  Listing,
  Invite,
  Presence,
  RequestSent,
} from "./ipc";

/**
 * Where the stand-in listens.
 *
 * `?online=http://127.0.0.1:8799` points somewhere else, which is what a machine
 * already running the real service on the stock port needs.
 */
const ONLINE =
  new URLSearchParams(window.location.search).get("online") ?? "http://127.0.0.1:8787";

/**
 * The token the mock issued, fetched once.
 *
 * `POST /v1/dev/token` is the mock's own shortcut, outside the contract: it
 * signs in without the browser round trip and hands back the same token a real
 * sign-in would have stored. In the launcher the token comes from
 * `settings.json` and never reaches the frontend at all.
 */
let issued: Promise<string> | null = null;

function token(): Promise<string> {
  issued ??= fetch(`${ONLINE}/v1/dev/token`, { method: "POST" })
    .then((response) => response.json() as Promise<{ token: string }>)
    .then((answer) => {
      if (typeof answer.token !== "string" || answer.token === "") {
        throw new Error("the service has no dev token endpoint");
      }
      return answer.token;
    })
    .catch((e: unknown) => {
      // A failed fetch must not be remembered, or every later call would
      // reject with the same stale error after the mock is started.
      issued = null;
      throw e instanceof Error ? e : new Error(String(e));
    });
  return issued;
}

/**
 * A made-up presence so the Invite button has something to work with.
 *
 * In the launcher this is the player's real state, kept by the presence
 * reporter. Here it is a constant that says "in a game", because a browser
 * review of a button that only appears in a game is otherwise impossible.
 */
const PRESENCE: Presence = {
  status: "in_game",
  serverAddress: "203.0.113.10:29070",
  serverName: "EU FFA Nightly",
  clientName: "Everyday",
  since: new Date().toISOString(),
};

/**
 * A public read goes out without a token when none can be had: the catalogue
 * of a real service answers a guest, and only the mock hands out dev tokens.
 */
async function bearer(auth: "required" | "optional"): Promise<Record<string, string>> {
  try {
    return { authorization: `Bearer ${await token()}` };
  } catch (e) {
    if (auth === "required") throw e;
    return {};
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  auth: "required" | "optional" = "required",
): Promise<T> {
  const response = await fetch(`${ONLINE}${path}`, {
    method,
    headers: {
      ...(await bearer(auth)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    const detail = parsed as { error?: { message?: string } } | null;
    throw new Error(detail?.error?.message ?? `the mock service answered ${response.status}`);
  }
  return parsed as T;
}

/** The signed-out view, for `http://localhost:14xx/?signedOut#/friends`. */
const SIGNED_OUT: FriendsView = {
  signedIn: false,
  live: false,
  friends: [],
  incoming: [],
  outgoing: [],
  invites: [],
  presence: { ...PRESENCE, status: "offline" },
};

/** Both documents the screen needs, in the shape the command answers with. */
async function view(): Promise<FriendsView> {
  if (new URLSearchParams(window.location.search).has("signedOut")) {
    return SIGNED_OUT;
  }
  const [friends, invites] = await Promise.all([
    call<Pick<FriendsView, "friends" | "incoming" | "outgoing">>("GET", "/v1/friends"),
    call<Invite[]>("GET", "/v1/invites"),
  ]);
  return { signedIn: true, live: false, ...friends, invites, presence: PRESENCE };
}

/** Runs one command against the mock service. Unknown commands reject. */
export async function devFriends<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const id = String(args.id ?? "");
  switch (command) {
    case "get_friends_state":
      return (await view()) as T;
    case "send_friend_request": {
      const answer = await call<{ to?: { displayName: string }; friend?: { user: { displayName: string } } }>(
        "POST",
        "/v1/friends/requests",
        { query: args.query },
      );
      const result: RequestSent = answer.friend
        ? {
            outcome: "accepted",
            displayName: answer.friend.user.displayName,
            state: await view(),
          }
        : {
            outcome: "requested",
            displayName: answer.to?.displayName ?? String(args.query),
            state: await view(),
          };
      return result as T;
    }
    case "accept_friend_request":
      await call("POST", `/v1/friends/requests/${id}/accept`);
      return (await view()) as T;
    case "decline_friend_request":
      await call("DELETE", `/v1/friends/requests/${id}`);
      return (await view()) as T;
    case "remove_friend":
      await call("DELETE", `/v1/friends/${String(args.userId)}`);
      return (await view()) as T;
    case "send_invite":
      return (await call<Invite>("POST", "/v1/invites", args)) as T;
    case "dismiss_invite":
      await call("DELETE", `/v1/invites/${id}`);
      return (await view()) as T;
    default:
      // `join_friend` lands here, and so does anything added later without a
      // stand-in. Starting a game is the one thing a browser cannot fake.
      throw new Error(`${command} needs the launcher; a browser cannot run it`);
  }
}

// --- slice: bundles ---

/** The commands of the draft editor: they read and write the data folder of the launcher. */
const DRAFT_COMMANDS = new Set([
  "list_bundle_drafts",
  "create_bundle_draft",
  "create_bundle_draft_from_bundle",
  "get_bundle_draft",
  "update_bundle_draft",
  "delete_bundle_draft",
  "draft_add_component",
  "draft_update_component",
  "draft_remove_component",
  "draft_add_files_from_disk",
  "draft_add_file_from_jkhub",
  "draft_add_files_from_client",
  "draft_remove_file",
  "draft_set_configs",
  "draft_engine_files",
  "draft_replace_engine_file",
  "draft_add_engine_files",
  "draft_exclude_engine_file",
  "draft_restore_engine_file",
  "validate_bundle_draft",
  "install_bundle_draft",
  "publish_bundle_draft",
  "draft_add_image",
  "draft_remove_image",
  "draft_image_path",
  "draft_file_listing",
  "draft_file_text",
  "preview_draft_file",
  // A preview of a catalogue file needs the core too: it fetches the
  // archive into the cache and opens a preview session on it.
  "preview_bundle_file",
]);

/** The shape of a listing file in the store: what the core writes when a pk3 is added. */
interface ListingFile {
  schema: number;
  entries: { path: string; size: number }[];
}

/** One file of the store, as text. The store is public: no token goes with the request. */
async function blobText(sha256: string): Promise<string> {
  const response = await fetch(`${ONLINE}/v1/blobs/${encodeURIComponent(sha256)}`);
  if (!response.ok) throw new Error(`the mock service answered ${response.status} for the file ${sha256}`);
  return response.text();
}

/**
 * Runs one bundles command against the mock service.
 *
 * Three commands read the catalogue and two read a file of the store, and
 * those five have a stand-in: the routes are public, so the tab has cards to
 * draw in a browser and the **Contents** dialog has a listing. Everything
 * else — the drafts, installing, publishing, liking, reviewing, previewing —
 * needs the disk or the token of the launcher, and refuses the way
 * `join_friend` does.
 */
export async function devBundles<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (DRAFT_COMMANDS.has(command)) {
    // A draft is a folder in the data directory of the launcher, and the
    // editor copies files into it: nothing of that exists in a browser.
    throw new Error(
      `${command} needs the launcher: bundle drafts live in its data folder, which a browser cannot read or write`,
    );
  }
  switch (command) {
    case "list_bundles": {
      const query = (args.query ?? {}) as Partial<BundleQuery>;
      const search = new URLSearchParams();
      search.set("game", String(query.game ?? "ja"));
      search.set("sort", String(query.sort ?? "popular"));
      if (query.q) search.set("q", query.q);
      if (query.engineId) search.set("engine", query.engineId);
      if (query.tag) search.set("tag", query.tag);
      search.set("limit", String(query.limit ?? 50));
      search.set("offset", String(query.offset ?? 0));
      return (await call<BundleList>("GET", `/v1/bundles?${search.toString()}`, undefined, "optional")) as T;
    }
    case "get_bundle": {
      const details = await call<BundleDetails>(
        "GET",
        `/v1/bundles/${encodeURIComponent(String(args.bundleId ?? ""))}`,
        undefined,
        "optional",
      );
      // The `local` half is the core's: which clients of this machine came
      // out of the bundle, and whether the engine of each component is in
      // the registry. A browser has no clients, and every engine of the mock
      // is assumed known: a component missing from the map reads as known.
      const answer: BundleDetailsWithLocal = {
        ...details,
        local: { installedClients: [], engineKnown: {} },
      };
      return answer as T;
    }
    case "get_bundle_version":
      return (await call<BundleVersion>(
        "GET",
        `/v1/bundles/${encodeURIComponent(String(args.bundleId ?? ""))}/versions/${encodeURIComponent(String(args.versionId ?? ""))}`,
        undefined,
        "optional",
      )) as T;
    case "bundle_file_listing": {
      // The listing of a pk3 is a small JSON file of the store, and the
      // store is public: the same read the core does, without its cache.
      const parsed = JSON.parse(await blobText(String(args.sha256 ?? ""))) as ListingFile;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const answer: Listing = {
        entries,
        total: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      };
      return answer as T;
    }
    case "bundle_file_text": {
      // The core refuses an archive or an executable by the path the
      // manifest gives it, before it reads a byte; the stand-in does the same.
      const path = String(args.path ?? "");
      if (/\.(?:pk3|dll|exe)$/i.test(path)) throw new Error(`${path} is not a text file`);
      return (await blobText(String(args.sha256 ?? ""))) as T;
    }
    default:
      throw new Error(`${command} needs the launcher; a browser cannot run it`);
  }
}

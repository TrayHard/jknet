/**
 * Stand-ins for the host commands in `npm run dev`.
 *
 * --- slice: play with friends ---
 *
 * `hostIpc` reaches this module only when `isTauri()` is false **and**
 * `import.meta.env.DEV` is true, like `devOnline.ts` for the friends commands.
 * Both conditions are needed and the second is a compile-time constant, so the
 * branch and this module leave the production bundle.
 *
 * It is development scaffolding, not a feature. A browser cannot start a
 * dedicated server, so this module keeps one made-up session in memory and
 * moves it the way the core would: **Start** walks the steps, **Stop** stops,
 * **Retry** brings the relay back. The session reaches the screen through
 * `subscribeDevHost`, which `HostProvider` listens to in place of the
 * `host:session` event a browser never gets.
 *
 * Every state of the screen has a scene, picked with `?host=<scene>` in the
 * address or `window.__devHost.show("<scene>")` in the console:
 * `setup`, `signed-out`, `no-client`, `starting`, `running`,
 * `relay-unavailable`, `running-empty`, `stopped`, `failed`.
 *
 * The data is invented. Addresses come from the documentation ranges, names
 * are neutral, and the log tail is an example, not a real engine's output.
 * The scene builders are exported for the screenshot stand of the workspace,
 * which answers the same commands from its own mocked core.
 */

import type {
  Game,
  HostClientOption,
  HostGametypeOption,
  HostMap,
  HostOptions,
  HostSession,
  HostSettings,
  HostStep,
  Invite,
} from "./ipc";

// ---------------------------------------------------------------------------
// Invented data
// ---------------------------------------------------------------------------

/** The scenes of the screen, one per frame of the Figma section. */
export const DEV_HOST_SCENES = [
  "setup",
  "signed-out",
  "no-client",
  "starting",
  "running",
  "relay-unavailable",
  "running-empty",
  "stopped",
  "failed",
] as const;

export type DevHostScene = (typeof DEV_HOST_SCENES)[number];

/** The friends a scene marks, invites and lets in, by account id. */
export interface DevHostPeople {
  kai: string;
  dana: string;
  juno: string;
  sasha: string;
}

const DEV_PEOPLE: DevHostPeople = {
  kai: "dev-kai",
  dana: "dev-dana",
  juno: "dev-juno",
  sasha: "dev-sasha",
};

const SESSION_ID = "5e0b7c1f9a2d4c38";
const RELAY_ADDRESS = "203.0.113.5:29210";
const LAN_ADDRESS = "192.168.1.23:29070";
const PASSWORD = "k7m2q9xa";

const CLIENTS: HostClientOption[] = [
  { id: "etjk", name: "etjk", engineId: "eternaljk", canHost: true, reason: null },
  { id: "everyday", name: "Everyday", engineId: "openjk", canHost: true, reason: null },
  { id: "tayst", name: "tayst", engineId: "taystjk", canHost: true, reason: null },
  { id: "demos", name: "Demos", engineId: "jamme", canHost: false, reason: "no_dedicated_server" },
];

const GAMETYPES: HostGametypeOption[] = [
  { index: 0, id: "ffa", label: "FFA", scoreCvar: "fraglimit", defaultScore: 20 },
  { index: 1, id: "holocron", label: "Holocron", scoreCvar: "fraglimit", defaultScore: 20 },
  { index: 2, id: "jedimaster", label: "Jedi Master", scoreCvar: "fraglimit", defaultScore: 20 },
  { index: 3, id: "duel", label: "Duel", scoreCvar: "duel_fraglimit", defaultScore: 10 },
  { index: 4, id: "powerduel", label: "Power Duel", scoreCvar: "duel_fraglimit", defaultScore: 10 },
  { index: 6, id: "team", label: "Team FFA", scoreCvar: "fraglimit", defaultScore: 20 },
  { index: 7, id: "siege", label: "Siege", scoreCvar: null, defaultScore: 0 },
  { index: 8, id: "ctf", label: "CTF", scoreCvar: "capturelimit", defaultScore: 8 },
  { index: 9, id: "cty", label: "CTY", scoreCvar: "capturelimit", defaultScore: 8 },
];

function map(name: string, gametypes: string[], source: HostMap["source"] = "game"): HostMap {
  return { name, title: null, gametypes, source, levelshot: null };
}

const FFA = ["ffa", "team", "holocron", "jedimaster"];
const DUEL = ["duel", "powerduel"];
const CTF = ["ctf", "cty"];

const MAPS: HostMap[] = [
  map("mp/ffa1", FFA),
  map("mp/ffa2", FFA),
  map("mp/ffa3", FFA),
  map("mp/ffa4", FFA),
  map("mp/ffa5", FFA),
  map("mp/duel1", DUEL),
  map("mp/duel2", DUEL),
  map("mp/duel3", DUEL),
  map("mp/duel4", DUEL),
  map("mp/duel5", DUEL),
  map("mp/duel6", DUEL),
  map("mp/duel7", DUEL),
  map("mp/duel8", DUEL),
  map("mp/duel9", DUEL),
  map("mp/ctf1", CTF),
  map("mp/ctf2", CTF),
  map("mp/ctf3", CTF),
  map("mp/ctf4", CTF),
  map("mp/ctf5", CTF),
  map("mp/siege_hoth", ["siege"]),
  map("mp/siege_desert", ["siege"]),
  map("mp/siege_korriban", ["siege"]),
  { ...map("atlantica", ["ffa", "team", "duel", "powerduel"], "client"), title: "Atlantica" },
];

/** The last lines of a start that failed: the example of the Figma frame. */
const LOG_TAIL = [
  "----- FS_Startup -----",
  "Current search path:",
  "C:\\Users\\Quinn\\AppData\\Local\\org.jknet.launcher\\clients\\etjk\\home\\japlus",
  "D:\\Games\\Jedi Academy\\GameData\\japlus",
  "C:\\Users\\Quinn\\AppData\\Local\\org.jknet.launcher\\clients\\etjk\\home\\base",
  "D:\\Games\\Jedi Academy\\GameData\\base\\assets3.pk3 (1276 files)",
  "D:\\Games\\Jedi Academy\\GameData\\base\\assets2.pk3 (62 files)",
  "D:\\Games\\Jedi Academy\\GameData\\base\\assets1.pk3 (8424 files)",
  "D:\\Games\\Jedi Academy\\GameData\\base\\assets0.pk3 (15997 files)",
  "----------------------",
  "25759 files in pk3 files",
  "execing server.cfg",
  "--- Common Initialization Complete ---",
  "Opening IP socket: 0.0.0.0:29070",
  "IP: 192.168.1.23",
  "------ Server Initialization ------",
  "Server: mp/ffa3",
  "Hunk_Clear: reset the hunk ok",
  "------- Game Initialization -------",
  "Loading dll file jampgame.",
  "Sys_LoadDll(...\\etjk\\home\\japlus\\jampgamex86.dll) failed:",
  "\"The specified module could not be found.\"",
  "Sys_LoadDll(...\\GameData\\japlus\\jampgamex86.dll) failed:",
  "\"The specified module could not be found.\"",
  "Failed to load dll, looking for qvm.",
  "VM_Create on game failed",
  "********************",
  "ERROR: VM_Create on game failed",
  "********************",
  "----- Server Shutdown (Server crashed: VM_Create on game failed) -----",
];

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** RFC 3339 of `now` plus `seconds`, without milliseconds. */
function at(now: number, seconds: number): string {
  return new Date(now + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function settingsOf(people: DevHostPeople, patch: Partial<HostSettings> = {}): HostSettings {
  return {
    clientId: "etjk",
    map: "mp/ffa3",
    gametype: 0,
    maxPlayers: 8,
    timeLimit: 0,
    scoreLimit: 20,
    bots: 0,
    serverName: "Quinn's game",
    password: PASSWORD,
    network: "internet_lan",
    joinPolicy: "friends",
    joinUserIds: [],
    inviteUserIds: [people.dana, people.juno],
    joinAfterStart: true,
    ...patch,
  };
}

function steps(server: HostStep["state"], mapState: HostStep["state"], relay: HostStep["state"]): HostStep[] {
  return [
    { step: "server", state: server },
    { step: "map", state: mapState },
    { step: "relay", state: relay },
  ];
}

function baseSession(settings: HostSettings, now: number, game: Game): HostSession {
  return {
    id: SESSION_ID,
    status: "running",
    steps: steps("done", "done", settings.network === "lan" ? "skipped" : "done"),
    settings,
    game,
    pid: 21944,
    port: 29070,
    localAddress: "127.0.0.1:29070",
    lanAddresses: settings.network === "internet" ? [] : [LAN_ADDRESS],
    relay:
      settings.network === "lan"
        ? { status: "off", address: null, region: null, expiresAt: null, error: null, errorCode: null }
        : {
            status: "active",
            address: RELAY_ADDRESS,
            region: "Europe",
            expiresAt: at(now, 3 * 3600 + 12 * 60 + 30),
            error: null,
            errorCode: null,
          },
    players: [],
    invited: [],
    joinedCount: 0,
    startedAt: at(now, -24 * 60 - 12),
    readyAt: at(now, -24 * 60),
    emptySince: null,
    autoStopAt: null,
    stoppedAt: null,
    stopReason: null,
    exitCode: null,
    failure: null,
    logTail: [],
  };
}

/** What one scene puts on the screen: the form's options, the maps, the session. */
export interface DevHostWorld {
  options: HostOptions;
  maps: HostMap[];
  session: HostSession | null;
}

/**
 * Builds one scene.
 *
 * `people` names the friends the scene marks and invites: the stand passes the
 * accounts of its own friend list so the rows light up; the browser preview
 * uses ids of its own, which the mock service's friends do not share.
 */
export function buildHostScene(
  scene: DevHostScene,
  people: DevHostPeople = DEV_PEOPLE,
  now: number = Date.now(),
  game: Game = "ja",
): DevHostWorld {
  const signedOut = scene === "signed-out";
  const defaults = signedOut
    ? settingsOf(people, {
        serverName: "JKNet game",
        network: "lan",
        map: "atlantica",
        inviteUserIds: [],
      })
    : settingsOf(people);
  const options: HostOptions = {
    game,
    clients: scene === "no-client" ? CLIENTS.filter((client) => !client.canHost) : CLIENTS,
    gametypes: GAMETYPES,
    defaults,
    relay: signedOut ? { available: false, reason: "signed_out" } : { available: true, reason: null },
    showFirewallNote: !signedOut,
    portFrom: 29070,
    portTo: 29079,
  };

  let session: HostSession | null = null;
  const settings = settingsOf(people);
  switch (scene) {
    case "starting":
      session = {
        ...baseSession(settings, now, game),
        status: "starting",
        steps: steps("done", "active", "pending"),
        port: null,
        localAddress: null,
        relay: { status: "connecting", address: null, region: null, expiresAt: null, error: null, errorCode: null },
        startedAt: at(now, -6),
        readyAt: null,
      };
      break;
    case "running":
      session = {
        ...baseSession(
          settingsOf(people, { joinPolicy: "selected", joinUserIds: [people.kai, people.dana] }),
          now,
          game,
        ),
        players: [
          { name: "^1Q^7uinn", score: 12, ping: 8, bot: false },
          { name: "^5Kai", score: 9, ping: 41, bot: false },
          { name: "^7Tavion", score: 4, ping: 0, bot: true },
        ],
        invited: [{ userId: people.dana, at: at(now, -125), ok: true }],
        joinedCount: 2,
      };
      break;
    case "relay-unavailable":
      session = {
        ...baseSession(settings, now, game),
        relay: {
          status: "unavailable",
          address: null,
          region: null,
          expiresAt: null,
          error: "the relay node did not answer in 10 s",
          errorCode: "node_silent",
        },
        players: [
          { name: "^1Q^7uinn", score: 12, ping: 8, bot: false },
          { name: "^2Juno", score: 7, ping: 3, bot: false },
          { name: "^7Tavion", score: 4, ping: 0, bot: true },
        ],
        invited: [{ userId: people.dana, at: at(now, -70), ok: true }],
        joinedCount: 2,
      };
      break;
    case "running-empty":
      session = {
        ...baseSession(settingsOf(people, { joinPolicy: "invite" }), now, game),
        startedAt: at(now, -75),
        readyAt: at(now, -65),
        emptySince: at(now, -65),
        autoStopAt: at(now, 14 * 60 + 32),
        invited: [
          { userId: people.dana, at: at(now, -62), ok: true },
          { userId: people.juno, at: at(now, -62), ok: true },
        ],
      };
      break;
    case "stopped":
      session = {
        ...baseSession(settings, now, game),
        status: "stopped",
        pid: null,
        startedAt: at(now, -86 * 60),
        readyAt: at(now, -86 * 60 + 12),
        stoppedAt: at(now, -86 * 60 + 12 + 84 * 60),
        stopReason: "user",
        joinedCount: 3,
        relay: { status: "off", address: null, region: null, expiresAt: null, error: null, errorCode: null },
      };
      break;
    case "failed":
      session = {
        ...baseSession(settings, now, game),
        status: "failed",
        steps: steps("done", "failed", "skipped"),
        pid: null,
        port: null,
        localAddress: null,
        lanAddresses: [],
        relay: { status: "off", address: null, region: null, expiresAt: null, error: null, errorCode: null },
        startedAt: at(now, -40),
        readyAt: null,
        stoppedAt: at(now, -38),
        stopReason: "start_failed",
        exitCode: 1,
        failure: { code: "exited", message: "the server ended with exit code 1", portFrom: null, portTo: null },
        logTail: LOG_TAIL,
      };
      break;
    default:
      session = null;
  }

  return { options, maps: MAPS, session };
}

// ---------------------------------------------------------------------------
// The fake core
// ---------------------------------------------------------------------------

interface Listener {
  session: (session: HostSession | null) => void;
  /** Everything else moved too: options, maps. Read them again. */
  reset: () => void;
}

const listeners = new Set<Listener>();

function sceneFromAddress(): DevHostScene {
  const asked = new URLSearchParams(window.location.search).get("host");
  return (DEV_HOST_SCENES as readonly string[]).includes(asked ?? "")
    ? (asked as DevHostScene)
    : "setup";
}

let world: DevHostWorld = buildHostScene(sceneFromAddress());
/** Timers of a start or a retry in progress; a new scene or a stop clears them. */
let timers: number[] = [];

function copy<T>(value: T): T {
  return value === null ? value : structuredClone(value);
}

function publish(): void {
  for (const listener of listeners) listener.session(copy(world.session));
}

function later(ms: number, step: () => void): void {
  timers.push(window.setTimeout(step, ms));
}

function clearTimers(): void {
  for (const timer of timers) window.clearTimeout(timer);
  timers = [];
}

/** Puts one scene on screen. */
function show(scene: DevHostScene): void {
  clearTimers();
  world = buildHostScene(scene);
  for (const listener of listeners) listener.reset();
  publish();
}

/**
 * Hands every change of the made-up session to the screen. Answers the
 * unsubscribe, for the effect that called it.
 */
export function subscribeDevHost(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The console helper of the browser preview. Development only: this whole
// module is left out of a production bundle.
(window as unknown as { __devHost?: unknown }).__devHost = {
  scenes: DEV_HOST_SCENES,
  show,
};

/** A refusal shaped like `AppError`, so the screen translates it. */
function refusal(code: string, message: string): Error & { code: string; details: object } {
  return Object.assign(new Error(message), { code, details: {} });
}

function live(): boolean {
  const status = world.session?.status;
  return status === "starting" || status === "running" || status === "stopping";
}

function now(): string {
  return at(Date.now(), 0);
}

/** Walks a fresh session through the steps the core reports. */
function simulateStart(settings: HostSettings): HostSession {
  const lan = settings.network === "lan";
  const started: HostSession = {
    ...baseSession(settings, Date.now(), world.options.game),
    status: "starting",
    steps: steps("active", "pending", lan ? "skipped" : "pending"),
    pid: 21944,
    port: null,
    localAddress: null,
    lanAddresses: settings.network === "internet" ? [] : [LAN_ADDRESS],
    relay: lan
      ? { status: "off", address: null, region: null, expiresAt: null, error: null, errorCode: null }
      : { status: "connecting", address: null, region: null, expiresAt: null, error: null, errorCode: null },
    startedAt: now(),
    readyAt: null,
    invited: [],
  };
  world.session = started;

  later(800, () => {
    if (world.session?.status !== "starting") return;
    world.session.steps = steps("done", "active", lan ? "skipped" : "pending");
    publish();
  });
  later(1600, () => {
    if (world.session?.status !== "starting") return;
    world.session.steps = steps("done", "done", lan ? "skipped" : "active");
    publish();
  });
  later(2400, () => {
    const current = world.session;
    if (current?.status !== "starting") return;
    const readyAt = now();
    current.status = "running";
    current.steps = steps("done", "done", lan ? "skipped" : "done");
    current.port = 29070;
    current.localAddress = "127.0.0.1:29070";
    current.readyAt = readyAt;
    current.emptySince = readyAt;
    current.autoStopAt = at(Date.now(), 15 * 60);
    if (!lan) {
      current.relay = {
        status: "active",
        address: RELAY_ADDRESS,
        region: "Europe",
        expiresAt: at(Date.now(), 4 * 3600),
        error: null,
        errorCode: null,
      };
    }
    current.invited = current.settings.inviteUserIds.map((userId) => ({ userId, at: readyAt, ok: true }));
    publish();
  });
  if (settings.joinAfterStart) {
    later(3400, () => {
      const current = world.session;
      if (current?.status !== "running") return;
      current.players = [{ name: "^1Q^7uinn", score: 0, ping: 5, bot: false }];
      current.joinedCount = 1;
      current.emptySince = null;
      current.autoStopAt = null;
      publish();
    });
  }
  return copy(started);
}

/** Runs one host command against the made-up session. Unknown commands reject. */
export async function devHost<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  switch (command) {
    case "host_get_options":
      return copy(world.options) as T;
    case "host_list_maps": {
      const index = typeof args.gametype === "number" ? args.gametype : null;
      const token = world.options.gametypes.find((entry) => entry.index === index)?.id ?? null;
      const maps = token === null ? world.maps : world.maps.filter((entry) => entry.gametypes.includes(token));
      return copy(maps) as T;
    }
    case "host_get_session":
      return copy(world.session) as T;
    case "host_start": {
      if (live()) throw refusal("hostBusy", "A server is already running.");
      clearTimers();
      const settings = args.settings as HostSettings;
      const session = simulateStart(settings);
      return session as T;
    }
    case "host_stop": {
      if (!live() || world.session === null) return undefined as T;
      clearTimers();
      world.session.status = "stopping";
      publish();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      if (world.session !== null) {
        world.session.status = "stopped";
        world.session.stopReason = "user";
        world.session.stoppedAt = now();
        world.session.pid = null;
        world.session.players = [];
        world.session.relay = { status: "off", address: null, region: null, expiresAt: null, error: null, errorCode: null };
        publish();
      }
      return undefined as T;
    }
    case "host_change_map": {
      if (world.session?.status !== "running") throw refusal("hostNotRunning", "The server is not running.");
      world.session.settings = {
        ...world.session.settings,
        map: String(args.map),
        gametype: Number(args.gametype),
      };
      publish();
      return copy(world.session) as T;
    }
    case "host_set_join_policy": {
      if (world.session?.status !== "running") throw refusal("hostNotRunning", "The server is not running.");
      world.session.settings = {
        ...world.session.settings,
        joinPolicy: args.joinPolicy as HostSettings["joinPolicy"],
        joinUserIds: (args.joinUserIds as string[]) ?? [],
      };
      publish();
      return copy(world.session) as T;
    }
    case "host_retry_relay": {
      const current = world.session;
      if (current?.status !== "running") throw refusal("hostNotRunning", "The server is not running.");
      current.relay = { status: "connecting", address: null, region: null, expiresAt: null, error: null, errorCode: null };
      publish();
      later(900, () => {
        if (world.session?.status !== "running") return;
        world.session.relay = {
          status: "active",
          address: RELAY_ADDRESS,
          region: "Europe",
          expiresAt: at(Date.now(), 4 * 3600),
          error: null,
          errorCode: null,
        };
        publish();
      });
      return copy(current) as T;
    }
    case "host_invite": {
      const current = world.session;
      if (current?.status !== "running") throw refusal("hostNotRunning", "The server is not running.");
      const toUserId = String(args.toUserId);
      const sent = now();
      current.invited = [...current.invited, { userId: toUserId, at: sent, ok: true }];
      publish();
      const invite: Invite = {
        id: `dev-invite-${toUserId}`,
        from: {
          id: "dev-quinn",
          displayName: "Quinn",
          avatarUrl: null,
          provider: "dev",
          providerName: "quinn",
          createdAt: "2026-09-10T10:00:00Z",
        },
        serverAddress: current.relay.address ?? LAN_ADDRESS,
        serverName: current.settings.serverName,
        message: typeof args.message === "string" ? args.message : null,
        createdAt: sent,
        expiresAt: at(Date.now(), 600),
        hosting: null,
      };
      return invite as T;
    }
    case "host_open_log":
      return undefined as T;
    default:
      // `host_join_own` lands here: starting the game is the one thing a
      // browser cannot fake.
      throw new Error(`${command} needs the launcher; a browser cannot run it`);
  }
}

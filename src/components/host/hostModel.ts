/**
 * The decisions of the **Play with friends** screen, without React.
 *
 * Which card a session calls for, how many people are on the server, what the
 * starting steps look like, which friends sit in which group, what the console
 * command says. Every screen that shows the private server — the page itself,
 * the Home card, the sidebar counter, the Friends panel and the quit dialog —
 * reads it from here, so they cannot disagree about the same session.
 *
 * Types only from `lib/ipc`: `npm run test:unit` loads this file in Node, which
 * strips the types and would choke on the runtime imports of that module.
 */

import type {
  Friend,
  HostInvited,
  HostPlayer,
  HostSession,
  HostSettings,
  HostStepState,
  Presence,
} from "../../lib/ipc";

/**
 * The search parameter **Host and invite** of the Friends screen sends:
 * `#/host?invite=<userId>` opens the screen with that friend marked.
 */
export const HOST_INVITE_PARAM = "invite";

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** A session the core still holds: it starts, runs or stops right now. */
export function isHostLive(
  session: HostSession | null | undefined,
): session is HostSession {
  return (
    session != null &&
    (session.status === "starting" ||
      session.status === "running" ||
      session.status === "stopping")
  );
}

/** The five cards the screen can show. */
export type HostView = "setup" | "starting" | "running" | "stopped" | "failed";

/**
 * The card a session calls for.
 *
 * A server that is stopping keeps the card it had: the Running card while the
 * server was ready, the Starting card while **Cancel** takes a start back. A
 * crash and a failed start both end on the Failed card, whatever status the
 * core recorded them under, because both have a log worth reading.
 */
export function hostView(session: HostSession | null | undefined): HostView {
  if (session == null) return "setup";
  switch (session.status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "stopping":
      return session.readyAt === null ? "starting" : "running";
    case "failed":
      return "failed";
    case "stopped":
      return session.stopReason === "crashed" || session.stopReason === "start_failed"
        ? "failed"
        : "stopped";
    default:
      return "setup";
  }
}

/** People on the server. Bots are players of the engine, not of the host. */
export function humanCount(players: HostPlayer[]): number {
  return players.filter((player) => !player.bot).length;
}

/** The four rows of the Starting card: the three steps of the core, then Ready. */
export type StepRowId = "server" | "map" | "relay" | "ready";

export interface StepRow {
  id: StepRowId;
  state: HostStepState;
}

/**
 * The rows the Starting card draws.
 *
 * The core reports three steps; **Ready** is the screen's own, and it follows
 * the session: done once the server runs, in progress when every step of the
 * core is behind it and the session has not turned yet, failed with the
 * session.
 */
export function stepRows(session: HostSession): StepRow[] {
  const order: Array<"server" | "map" | "relay"> = ["server", "map", "relay"];
  const rows: StepRow[] = order.map((id) => ({
    id,
    state: session.steps.find((step) => step.step === id)?.state ?? "pending",
  }));
  let ready: HostStepState = "pending";
  if (session.status === "running" || (session.status === "stopping" && session.readyAt !== null)) {
    ready = "done";
  } else if (session.status === "failed" || rows.some((row) => row.state === "failed")) {
    ready = "failed";
  } else if (
    session.status === "starting" &&
    rows.every((row) => row.state === "done" || row.state === "skipped")
  ) {
    ready = "active";
  }
  return [...rows, { id: "ready", state: ready }];
}

/** The step the Home card names while the server starts: the first one not behind it. */
export function currentStep(session: HostSession): StepRowId {
  const rows = stepRows(session);
  return (
    rows.find((row) => row.state === "active")?.id ??
    rows.find((row) => row.state === "pending")?.id ??
    "ready"
  );
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** The relay address while the relay carries the server, else `null`. */
export function relayAddress(session: HostSession): string | null {
  return session.relay.status === "active" ? session.relay.address : null;
}

/**
 * The address a player without JKNet types: the relay first, because it
 * works from anywhere, then the first address of the local network.
 */
export function joinAddress(session: HostSession): string | null {
  return relayAddress(session) ?? session.lanAddresses[0] ?? null;
}

/**
 * The line **Copy console command** puts on the clipboard.
 *
 * Both commands on one line, the password first: the engine applies `password`
 * to the userinfo the moment it reads it, and `connect` sends that userinfo. A
 * server without a password gets the `connect` alone.
 */
export function consoleCommand(password: string | null, address: string | null): string | null {
  if (address === null || address === "") return null;
  return password ? `password ${password}; connect ${address}` : `connect ${address}`;
}

/** Whether a friend's presence points at this server, by the relay or a local address. */
export function isInMyGame(presence: Presence, session: HostSession): boolean {
  if (presence.status === "offline") return false;
  const address = (presence.serverAddress ?? "").trim();
  if (address === "") return false;
  if (session.relay.address !== null && session.relay.address === address) return true;
  return session.lanAddresses.includes(address);
}

/** Whether the relay should carry this server and does not. */
export function relayDown(session: HostSession): boolean {
  if (session.settings.network === "lan") return false;
  return session.relay.status === "unavailable" || session.relay.status === "lost";
}

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

/** The two groups of the **Invite friends** panel. */
export interface InviteGroups {
  /** In a game or online, by name: they can take an invite now. */
  active: Friend[];
  /** Offline, by name: the collapsed group at the bottom. */
  offline: Friend[];
}

/** Friends as the panel lists them: those who can play first, each group by name. */
export function inviteGroups(friends: Friend[]): InviteGroups {
  const byName = (a: Friend, b: Friend) =>
    a.user.displayName.localeCompare(b.user.displayName, undefined, { sensitivity: "base" });
  const rank = (friend: Friend) => (friend.presence.status === "in_game" ? 0 : 1);
  const active = friends
    .filter((friend) => friend.presence.status !== "offline")
    .sort((a, b) => rank(a) - rank(b) || byName(a, b));
  const offline = friends
    .filter((friend) => friend.presence.status === "offline")
    .sort(byName);
  return { active, offline };
}

/** The last invite this session sent to one friend. */
export function lastInvite(invited: HostInvited[], userId: string): HostInvited | undefined {
  let last: HostInvited | undefined;
  for (const entry of invited) {
    if (entry.userId !== userId) continue;
    if (last === undefined || Date.parse(entry.at) >= Date.parse(last.at)) last = entry;
  }
  return last;
}

/** A list with one id switched in or out, order kept. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Whole seconds from `from` to `now`, or `null` when there is no stamp. */
export function secondsSince(from: string | null | undefined, now: number): number | null {
  if (!from) return null;
  const at = Date.parse(from);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 1000));
}

/** Whole seconds from `now` to `until`, never below zero, or `null`. */
export function secondsUntil(until: string | null | undefined, now: number): number | null {
  if (!until) return null;
  const at = Date.parse(until);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * A countdown the way a clock shows it: `14:32`, `1:05:00` past an hour.
 *
 * Digits and colons only, so it reads the same in every language and needs
 * no catalog entry.
 */
export function countdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(rest).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** How long the server ran: from ready (or start) to the stop. */
export function ranForSeconds(session: HostSession): number | null {
  const from = session.readyAt ?? session.startedAt;
  const until = session.stoppedAt ? Date.parse(session.stoppedAt) : Number.NaN;
  if (Number.isNaN(until)) return null;
  return secondsSince(from, until);
}

/** When the daily relay time comes back: the next midnight UTC. */
export function nextUtcMidnight(now: number): Date {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/** The Setup form: the settings of a start, and the password field as typed. */
export interface HostForm {
  settings: HostSettings;
  /** **Require a password**. */
  requirePassword: boolean;
  /** What the password field holds, kept while the toggle is off. */
  password: string;
}

/** The form a fresh screen opens with, out of the defaults the core suggests. */
export function formFromSettings(settings: HostSettings, freshPassword: string): HostForm {
  return {
    settings: { ...settings, inviteUserIds: [...settings.inviteUserIds] },
    requirePassword: settings.password !== null,
    password: settings.password ?? freshPassword,
  };
}

/**
 * What `host_start` gets out of the form.
 *
 * A blank name falls back to the name the core suggested, a password that is
 * not required is `null`, and the two lists of friends lose duplicates.
 */
export function settingsToStart(
  form: HostForm,
  fallbackName: string,
  joinAfterStart: boolean,
): HostSettings {
  const name = form.settings.serverName.trim();
  return {
    ...form.settings,
    serverName: name === "" ? fallbackName : name,
    password: form.requirePassword ? form.password : null,
    joinUserIds: [...new Set(form.settings.joinUserIds)],
    inviteUserIds: [...new Set(form.settings.inviteUserIds)],
    joinAfterStart,
  };
}

/**
 * The map to keep after the list changed: the one chosen, while the list still
 * has it; then the default map of the game; then the first of the list.
 */
export function pickMap(names: string[], current: string, preferred: string | null): string {
  if (names.includes(current)) return current;
  if (preferred !== null && names.includes(preferred)) return preferred;
  return names[0] ?? "";
}

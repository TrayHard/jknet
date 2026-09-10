/**
 * The state machine of the first run, kept away from the components.
 *
 * Nothing here touches React or the core, so the rules are readable in one
 * place: which step a reopened launcher resumes at, what the player is picking
 * on the second step, and which folder a name will produce.
 */

import { GAMES, type Client, type Game, type Settings } from "../../lib/ipc";

export type OnboardingStep = 1 | 2 | 3;

/** Labels of the badge strip, in order. */
export const STEP_LABELS = ["Game files", "Client", "Account"];

export const STEP_COUNT = STEP_LABELS.length;

/**
 * Where the setup picks up after the player closed the launcher halfway.
 *
 * The answer is derived from what is configured rather than remembered: a
 * stored step number would send a player who deleted their only client to an
 * account screen with nothing to play.
 */
export function initialStep(
  settings: Settings | undefined,
  clients: Client[] | undefined,
): OnboardingStep {
  // --- slice: game core ---
  // One game is enough to go on. A player who owns Jedi Outcast alone has a
  // complete setup, and demanding both would stop them at the first step.
  if (configuredGames(settings).length === 0) return 1;
  if (!playableClient(settings, clients)) return 2;
  return 3;
}

// --- slice: game core ---
/**
 * The games the player has pointed the launcher at, in the order of `GAMES`.
 *
 * Empty means the first step has not been finished. The first entry is the
 * game the second step creates a client for, which puts Jedi Academy first
 * when both are configured.
 */
export function configuredGames(settings: Settings | undefined): Game[] {
  if (!settings) return [];
  return GAMES.filter((game) => {
    const path = settings.gameDataPaths[game];
    return typeof path === "string" && path.trim() !== "";
  });
}

/** The game the second step makes the first client for. */
export function firstClientGame(settings: Settings | undefined): Game {
  return configuredGames(settings)[0] ?? "ja";
}

/**
 * The default client, when it has an engine on disk.
 *
 * Both halves matter. A client without `engineVersion` has an empty `engine\`
 * folder and cannot start, and a client that is not the default one is not
 * what the Play button would run.
 */
export function playableClient(
  settings: Settings | undefined,
  clients: Client[] | undefined,
): Client | null {
  const id = settings?.defaultClientId;
  if (!id || !clients) return null;
  const client = clients.find((candidate) => candidate.id === id);
  return client && client.engineVersion !== null ? client : null;
}

/** What the second step is about to do when Continue is pressed. */
export type ClientChoice =
  | { kind: "existing"; clientId: string }
  | { kind: "engine"; engineId: string };

/**
 * Existing clients with the default one first, then by name.
 *
 * A player who re-runs the setup from Settings sees the client they already
 * play with at the top, which is the one they mean to keep.
 */
export function orderClients(
  clients: Client[],
  defaultClientId: string | null | undefined,
): Client[] {
  return [...clients].sort((a, b) => {
    if (a.id === defaultClientId) return -1;
    if (b.id === defaultClientId) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The folder `create_client` will make out of a name.
 *
 * A copy of `slugify` in `src-tauri/src/clients.rs`, kept in step with it so
 * the hint under the name field does not promise a path the core will not
 * create. It is a hint: the core appends `-2` when the slug is taken, and it
 * alone decides the final name.
 */
export function folderSlug(name: string): string {
  let slug = "";
  for (const character of name) {
    if (/[0-9A-Za-z]/.test(character)) slug += character.toLowerCase();
    else if (!slug.endsWith("-")) slug += "-";
  }
  slug = slug.replace(/^-+/, "").replace(/-+$/, "");
  return slug === "" ? "client" : slug;
}

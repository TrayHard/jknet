import { ImageIcon, RefreshCw } from "lucide-react";

// --- slice: game switch ---
import { levelshotCounts, useGameNames } from "../lib/game";
import { errorMessage, GAMES } from "../lib/ipc";
import { useLevelshots, useRebuildLevelshots } from "../lib/queries";
import { Button } from "./ui";

/**
 * The Cache card of the Settings screen: how many maps have a picture.
 *
 * The launcher reads the pictures out of the pk3 files the player owns and
 * rebuilds the index by itself whenever one of those files changes. The button
 * is here for the case the rules miss — a picture edited in place, a cache
 * folder emptied by hand — and for the count, which answers "why is this map
 * blank" faster than a log file does.
 */
export function MapPicturesCard() {
  const levelshots = useLevelshots();
  const rebuild = useRebuildLevelshots();
  // --- slice: game switch ---
  // The index keys on `<game>/<map>`, because `ffa_bespin` is a map in both
  // games and a different picture in each. One total for both would leave a
  // player who has just set up Jedi Outcast unable to tell whether the launcher
  // read their archives at all.
  const { label } = useGameNames();
  const perGame = levelshotCounts(levelshots.data);

  const count = levelshots.data?.length ?? null;
  const failure = levelshots.error
    ? errorMessage(levelshots.error)
    : rebuild.error
      ? errorMessage(rebuild.error)
      : null;

  return (
    <section className="rounded-lg border border-line bg-surface p-16 mb-24">
      <h2 className="text-heading-sm text-fg pb-4">Cache</h2>
      <div className="flex items-start justify-between gap-16 pt-12">
        <span className="flex flex-col">
          <span className="text-body-md-medium text-fg">Map pictures</span>
          <span className="text-body-sm text-fg-muted">
            {failure ??
              (count === null
                ? "Reading the index…"
                : `${count} ${count === 1 ? "map has" : "maps have"} a picture, read from the pk3 files you already own. Nothing is downloaded.`)}
          </span>
          {/* --- slice: game switch --- one line per game, always both, so a
              zero is visible rather than absent. */}
          {failure === null && count !== null ? (
            <span className="text-body-sm text-fg-secondary pt-4">
              {GAMES.map((game) => `${perGame[game]} ${label(game)}`).join(", ")}
            </span>
          ) : null}
          {rebuild.data ? (
            <span className="text-body-sm text-fg-secondary pt-4">
              Last rebuild: {rebuild.data.maps} pictures from{" "}
              {rebuild.data.sources} files in {rebuild.data.elapsedMs} ms.
            </span>
          ) : null}
        </span>
        <Button
          icon={rebuild.isPending ? <RefreshCw size={16} /> : <ImageIcon size={16} />}
          disabled={rebuild.isPending}
          onClick={() => rebuild.mutate()}
        >
          {rebuild.isPending ? "Rebuilding…" : "Rebuild"}
        </Button>
      </div>
    </section>
  );
}

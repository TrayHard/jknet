import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Check, FolderOpen, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge, Button, RadioCard } from "../../components/ui";
import {
  errorMessage,
  ipc,
  type Game,
  type GameFilesCandidate,
  type GameInfo,
} from "../../lib/ipc";
import { useGameFiles, useGames, useSettings, useUpdateSettings } from "../../lib/queries";
import { isTauri } from "../../lib/runtime";
import { StepPanel } from "./StepPanel";

interface StepGameFilesProps {
  onContinue: () => void;
}

/**
 * Step 1: point the launcher at the copies of the games the player owns.
 *
 * --- slice: game core ---
 * One section per game, because a player owns one, the other or both, and the
 * launcher has to work for any of the three. Continuing needs one confirmed
 * folder, not two: demanding Jedi Outcast from somebody who only has Jedi
 * Academy would stop the setup at its first step.
 *
 * Everything `detect_game_files` found is offered as a card, including a broken
 * copy: a player whose Steam install is missing an archive has to see which
 * one, or the only message they get is that JKNet found nothing.
 */
export function StepGameFiles({ onContinue }: StepGameFilesProps) {
  const settings = useSettings();
  const gameFiles = useGameFiles();
  const games = useGames();
  const updateSettings = useUpdateSettings();

  const [error, setError] = useState<string | null>(null);
  /** Folders the player picked by hand, one per game. */
  const [picked, setPicked] = useState<Partial<Record<Game, GameFilesCandidate>>>({});
  /** Rows the player selected, one per game. */
  const [selected, setSelected] = useState<Partial<Record<Game, string>>>({});
  /**
   * The game whose folder dialog is open, or whose folder is being checked.
   *
   * One game at a time: the system dialog is modal, and the check that follows
   * it belongs to the game that opened it. Its **Choose another folder** button
   * waits, so a second dialog cannot be asked for while the first answer is on
   * its way. The other game's button stays live.
   */
  const [browsing, setBrowsing] = useState<Game | null>(null);

  const queryError = gameFiles.error ?? settings.error ?? games.error ?? null;
  const failure = error ?? (queryError ? errorMessage(queryError) : null);

  /** The rows of one game: what was detected, plus a folder chosen by hand. */
  const candidatesOf = (game: Game): GameFilesCandidate[] => {
    const detected = gameFiles.data?.[game] ?? [];
    const chosen = picked[game];
    if (!chosen) return detected;
    return [chosen, ...detected.filter((one) => one.path !== chosen.path)];
  };

  /**
   * The row of one game that Continue would save.
   *
   * A preselection, not state: the queries answer after the first render, and
   * a `useEffect` writing the same value back would only add a frame.
   */
  const chosenOf = (game: Game): GameFilesCandidate | null => {
    const rows = candidatesOf(game);
    const configured = settings.data?.gameDataPaths[game] ?? null;
    const path =
      selected[game] ??
      rows.find((one) => one.path === configured)?.path ??
      rows.find((one) => one.valid)?.path ??
      null;
    return rows.find((one) => one.path === path) ?? null;
  };

  const list = games.data ?? [];
  const ready = useMemo(
    () => list.some((entry) => chosenOf(entry.id)?.valid),
    // The folders come from the two queries and from the player's clicks, and
    // every one of them can change what Continue is allowed to do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, gameFiles.data, settings.data, picked, selected],
  );

  /** Asks for a folder and checks it against one game before selecting it. */
  const browse = async (game: GameInfo) => {
    setError(null);
    if (!isTauri()) {
      setError("Tauri runtime is not available");
      return;
    }
    setBrowsing(game.id);
    try {
      const folder = await open({
        directory: true,
        multiple: false,
        title: `Select the ${game.displayName} GameData folder`,
      });
      if (typeof folder !== "string") return;
      const candidate = await ipc.validateGameData(game.id, folder);
      setPicked((current) => ({ ...current, [game.id]: candidate }));
      setSelected((current) => ({ ...current, [game.id]: candidate.path }));
      if (!candidate.valid) {
        setError(
          `${candidate.path} has no ${game.displayName} files. ${missingLine(candidate)}`,
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBrowsing(null);
    }
  };

  /** Saves every folder the player confirmed, in one patch. */
  const save = () => {
    setError(null);
    const paths: Partial<Record<Game, string | null>> = {};
    for (const entry of list) {
      const chosen = chosenOf(entry.id);
      if (chosen?.valid) paths[entry.id] = chosen.path;
    }
    if (Object.keys(paths).length === 0) return;
    updateSettings.mutate(
      { gameDataPaths: paths },
      { onSuccess: () => onContinue(), onError: (e) => setError(errorMessage(e)) },
    );
  };

  return (
    <StepPanel
      step={1}
      heading="Where are the games installed?"
      text="JKNet needs the folder that holds base\assets0.pk3. It reads those archives and writes nothing into the folder. One game is enough to carry on; add the other whenever you like."
      error={failure}
      footer={
        <Button
          variant="primary"
          size="lg"
          disabled={!ready || updateSettings.isPending}
          onClick={save}
        >
          {updateSettings.isPending ? "Saving…" : "Continue"}
        </Button>
      }
    >
      <div className="flex flex-col gap-24">
        {list.map((entry) => {
          const rows = candidatesOf(entry.id);
          const chosen = chosenOf(entry.id);
          return (
            <section key={entry.id} className="flex flex-col gap-8">
              <div className="flex items-center gap-8">
                <h3 className="text-heading-sm text-fg">{entry.displayName}</h3>
                {chosen?.valid ? (
                  <Badge tone="success" icon={<Check size={12} />}>
                    Ready
                  </Badge>
                ) : (
                  <Badge tone="warm">Not found</Badge>
                )}
              </div>

              <div
                className="flex flex-col gap-8"
                role="radiogroup"
                aria-label={`${entry.displayName} folder`}
              >
                {rows.map((candidate) => (
                  <RadioCard
                    key={candidate.path}
                    name={`game-folder-${entry.id}`}
                    selected={candidate.path === chosen?.path}
                    onSelect={() =>
                      setSelected((current) => ({
                        ...current,
                        [entry.id]: candidate.path,
                      }))
                    }
                    title={sourceName(candidate.source)}
                    aside={
                      candidate.valid ? (
                        <Badge tone="success" icon={<Check size={12} />}>
                          {candidate.version ?? "Assets found"}
                        </Badge>
                      ) : (
                        <Badge tone="danger">Assets missing</Badge>
                      )
                    }
                  >
                    <span className="block text-mono-sm text-fg-accent break-all">
                      {candidate.path}
                    </span>
                    {candidate.valid ? null : (
                      <span className="block text-body-sm text-fg-danger pt-4">
                        {missingLine(candidate)}
                      </span>
                    )}
                    {/* A copy that works but is not the build the servers run:
                        Jedi Outcast without the 1.04 patch. */}
                    {candidate.warning ? (
                      <span className="flex items-start gap-4 text-body-sm text-fg-warm pt-4">
                        <AlertTriangle size={14} className="shrink-0 mt-2" />
                        {candidate.warning}
                      </span>
                    ) : null}
                  </RadioCard>
                ))}

                {rows.length === 0 ? (
                  <p className="flex items-center gap-8 rounded-md border border-dashed border-line px-12 py-16 text-body-sm text-fg-muted">
                    <Search size={16} className="shrink-0" />
                    {gameFiles.isLoading
                      ? "Looking through Steam and GOG…"
                      : `No copy of ${entry.displayName} turned up in Steam or GOG. Point JKNet at the folder yourself, or skip this game.`}
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={() => void browse(entry)}
                  disabled={browsing === entry.id}
                  className={[
                    "flex items-center gap-12 rounded-md border border-dashed border-line p-12",
                    "text-left cursor-pointer transition-colors duration-150",
                    "hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60",
                  ].join(" ")}
                >
                  <span className="flex items-center justify-center size-36 shrink-0 rounded-md bg-elevated text-fg-secondary">
                    <FolderOpen size={20} />
                  </span>
                  <span className="flex flex-col">
                    <span className="text-body-md-medium text-fg">
                      Choose another folder
                    </span>
                    <span className="text-body-sm text-fg-muted">
                      Pick the GameData folder of any copy. JKNet checks it before
                      you continue.
                    </span>
                  </span>
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <p className="text-body-sm text-fg-muted pt-24">
        JKNet does not ship game files. You need a licensed copy of Star Wars Jedi
        Knight: Jedi Academy or Jedi Knight II: Jedi Outcast from Steam, GOG or a
        disc.
      </p>
    </StepPanel>
  );
}

/** Names the archives that were not there, so the player can go look. */
function missingLine(candidate: GameFilesCandidate): string {
  const missing = candidate.assets
    .filter((asset) => asset.required && !asset.present)
    .map((asset) => asset.name);
  if (missing.length === 0) return "The folder holds no readable archives.";
  return `Missing: ${missing.join(", ")}.`;
}

/** Human name of a detection source, as on the Clients screen. */
function sourceName(source: string): string {
  switch (source) {
    case "steam":
      return "Steam";
    case "gog":
      return "GOG";
    case "manual":
      return "Chosen by hand";
    default:
      return "Saved earlier";
  }
}

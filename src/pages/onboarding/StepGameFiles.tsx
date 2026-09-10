import { open } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge, Button, RadioCard } from "../../components/ui";
import { errorMessage, ipc, type GameFilesCandidate } from "../../lib/ipc";
import { useGameFiles, useSettings, useUpdateSettings } from "../../lib/queries";
import { isTauri } from "../../lib/runtime";
import { StepPanel } from "./StepPanel";

interface StepGameFilesProps {
  onContinue: () => void;
}

/**
 * Step 1: point the launcher at the copy of the game the player owns.
 *
 * Everything found by `detect_game_files` is offered as a card, including a
 * broken copy: a player whose Steam install is missing an archive has to see
 * which one, or the only message they get is that JKNet found nothing.
 */
export function StepGameFiles({ onContinue }: StepGameFilesProps) {
  const settings = useSettings();
  const gameFiles = useGameFiles();
  const updateSettings = useUpdateSettings();

  const [picked, setPicked] = useState<GameFilesCandidate | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const detected = gameFiles.data ?? [];
  // The folder chosen by hand joins the list rather than replacing it, so the
  // player can still go back to the copy Steam reported.
  const candidates = useMemo(() => {
    if (!picked) return detected;
    return [picked, ...detected.filter((one) => one.path !== picked.path)];
  }, [detected, picked]);

  const configured = settings.data?.gameDataPath ?? null;
  // Preselection, not state: the queries answer after the first render, and a
  // `useEffect` writing the same value back would only add a frame.
  const chosenPath =
    selectedPath ??
    candidates.find((one) => one.path === configured)?.path ??
    candidates.find((one) => one.valid)?.path ??
    null;
  const chosen = candidates.find((one) => one.path === chosenPath) ?? null;

  const queryError = gameFiles.error ?? settings.error ?? null;
  const failure = error ?? (queryError ? errorMessage(queryError) : null);

  /** Asks for a folder and checks it before it can be selected. */
  const browse = async () => {
    setError(null);
    if (!isTauri()) {
      setError("Tauri runtime is not available");
      return;
    }
    setBrowsing(true);
    try {
      const folder = await open({
        directory: true,
        multiple: false,
        title: "Select the GameData folder",
      });
      if (typeof folder !== "string") return;
      const candidate = await ipc.inspectGameFiles(folder);
      setPicked(candidate);
      setSelectedPath(candidate.path);
      if (!candidate.valid) {
        setError(`${candidate.path} has no game files. ${missingLine(candidate)}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBrowsing(false);
    }
  };

  const save = () => {
    if (!chosen?.valid) return;
    setError(null);
    updateSettings.mutate(
      { gameDataPath: chosen.path },
      { onSuccess: () => onContinue(), onError: (e) => setError(errorMessage(e)) },
    );
  };

  return (
    <StepPanel
      step={1}
      heading="Where is the game installed?"
      text="JKNet needs the folder that holds base\assets0.pk3 to assets3.pk3. It reads those four files and writes nothing into the folder."
      error={failure}
      footer={
        <Button
          variant="primary"
          size="lg"
          disabled={!chosen?.valid || updateSettings.isPending}
          onClick={save}
        >
          {updateSettings.isPending ? "Saving…" : "Continue"}
        </Button>
      }
    >
      <div className="flex flex-col gap-8" role="radiogroup" aria-label="Game folder">
        {candidates.map((candidate) => (
          <RadioCard
            key={candidate.path}
            name="game-folder"
            selected={candidate.path === chosenPath}
            onSelect={() => setSelectedPath(candidate.path)}
            title={sourceName(candidate.source)}
            aside={
              candidate.valid ? (
                <Badge tone="success" icon={<Check size={12} />}>
                  Assets found
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
          </RadioCard>
        ))}

        {candidates.length === 0 ? (
          <p className="flex items-center gap-8 rounded-md border border-dashed border-line px-12 py-16 text-body-sm text-fg-muted">
            <Search size={16} className="shrink-0" />
            {gameFiles.isLoading
              ? "Looking through Steam and GOG…"
              : "No copy of Jedi Academy turned up in Steam or GOG. Point JKNet at the folder yourself."}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => void browse()}
          disabled={browsing}
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
              {browsing ? "Waiting for the folder…" : "Choose another folder"}
            </span>
            <span className="text-body-sm text-fg-muted">
              Pick the GameData folder of any copy. JKNet checks it before you
              continue.
            </span>
          </span>
        </button>
      </div>

      <p className="text-body-sm text-fg-muted pt-24">
        JKNet does not ship game files. You need a licensed copy of Star Wars
        Jedi Knight: Jedi Academy from Steam, GOG or a disc.
      </p>
    </StepPanel>
  );
}

/** Names the archives that were not there, so the player can go look. */
function missingLine(candidate: GameFilesCandidate): string {
  const missing = candidate.assets
    .filter((asset) => !asset.present)
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

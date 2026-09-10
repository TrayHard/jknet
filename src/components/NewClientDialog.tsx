import { useEffect, useState } from "react";

import { errorMessage, type Game } from "../lib/ipc";
import {
  useActiveGame,
  useCreateClient,
  useEnginesOfGame,
  useGames,
  useInstallEngine,
  useSettings,
  useUpdateSettings,
} from "../lib/queries";
import { Button, Input, RadioCard, Toggle } from "./ui";

interface NewClientDialogProps {
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * The New client dialog: engine, name, and whether the client becomes the
 * default one.
 *
 * Copying files from another client is in the design but not in the core yet,
 * so the dialog does not offer it.
 */
export function NewClientDialog({ onClose, onError }: NewClientDialogProps) {
  const settings = useSettings();
  // --- slice: game core ---
  // The game comes first: it decides which engines the list below offers.
  // It starts on the active game, which is Jedi Academy until the switcher
  // slice gives the player a way to change it.
  const activeGame = useActiveGame();
  const games = useGames();
  const [game, setGame] = useState<Game>(activeGame);
  const engines = useEnginesOfGame(game);
  const createClient = useCreateClient();
  const updateSettings = useUpdateSettings();
  const installEngine = useInstallEngine();

  const [name, setName] = useState("");
  const [engineId, setEngineId] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [downloadEngine, setDownloadEngine] = useState(true);

  // Follow the active game until the player touches the choice: the settings
  // answer one render after the dialog mounts.
  useEffect(() => setGame(activeGame), [activeGame]);

  // Preselect the recommended engine of the chosen game, and drop a selection
  // that belongs to the other game the moment the game changes.
  useEffect(() => {
    if (engines.length === 0) return;
    if (engines.some((engine) => engine.id === engineId)) return;
    const recommended = engines.find((engine) => engine.recommended);
    setEngineId((recommended ?? engines[0]).id);
  }, [engines, engineId]);

  // The first client is the default one whether the player asks or not.
  useEffect(() => {
    if (settings.data && !settings.data.defaultClientId) setMakeDefault(true);
  }, [settings.data]);

  const canSubmit = name.trim().length > 0 && engineId.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    createClient.mutate(
      { name: name.trim(), engineId, game },
      {
        onSuccess: (client) => {
          // One field, one patch: the rest of the document stays as it is on
          // disk, including anything edited outside the launcher.
          if (makeDefault) {
            // --- slice: game core ---
            // Both fields: the Play button still reads the single one, and
            // the per-game map is what the switcher slice will read.
            updateSettings.mutate({
              defaultClientId: client.id,
              defaultClientIds: { [client.game]: client.id },
            });
          }
          // The dialog closes first: the download takes a minute, and its
          // progress belongs on the card, not in a modal nobody can leave.
          if (downloadEngine) {
            installEngine.mutate(
              { clientId: client.id },
              { onError: (e) => onError(errorMessage(e)) },
            );
          }
          onClose();
        },
        onError: (e) => {
          onError(errorMessage(e));
          onClose();
        },
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-24"
      role="dialog"
      aria-modal="true"
      aria-label="New client"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="w-full max-w-[520px] rounded-xl border border-line bg-surface p-24 shadow-popover">
        <h2 className="text-display-md text-fg">New client</h2>
        <p className="text-body-sm text-fg-secondary pt-4">
          A client is an engine build with its own files and settings. Give it a
          name you will recognise in the client list.
        </p>

        {/* --- slice: game core --- the game before the engine list. */}
        <label className="block text-label-xs text-fg-muted pt-24 pb-8">Game</label>
        <div className="grid grid-cols-2 gap-8" role="radiogroup" aria-label="Game">
          {(games.data ?? []).map((entry) => (
            <RadioCard
              key={entry.id}
              name="new-client-game"
              selected={entry.id === game}
              onSelect={() => setGame(entry.id)}
              title={entry.displayName}
            />
          ))}
        </div>

        <label className="block text-label-xs text-fg-muted pt-24 pb-8">Engine</label>
        <div className="grid grid-cols-2 gap-8">
          {engines.map((engine) => (
            <button
              key={engine.id}
              type="button"
              onClick={() => setEngineId(engine.id)}
              className={[
                "flex flex-col items-start gap-4 rounded-md border p-12 text-left cursor-pointer",
                "transition-colors duration-150",
                engine.id === engineId
                  ? "border-line-accent bg-accent-subtle"
                  : "border-line bg-input hover:bg-surface-hover",
              ].join(" ")}
            >
              <span className="text-body-md-medium text-fg">{engine.name}</span>
              <span className="text-body-sm text-fg-muted">{engine.description}</span>
            </button>
          ))}
        </div>

        <label
          className="block text-label-xs text-fg-muted pt-24 pb-8"
          htmlFor="new-client-name"
        >
          Name
        </label>
        <Input
          id="new-client-name"
          value={name}
          autoFocus
          maxLength={48}
          placeholder="Everyday"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />

        <div className="flex items-center justify-between gap-16 pt-24">
          <span className="flex flex-col">
            <span className="text-body-md-medium text-fg">Make it the default</span>
            <span className="text-body-sm text-fg-muted">
              The Play button on Home starts the default client.
            </span>
          </span>
          <Toggle
            label="Make this client the default one"
            checked={makeDefault}
            onChange={setMakeDefault}
          />
        </div>

        <div className="flex items-center justify-between gap-16 pt-16">
          <span className="flex flex-col">
            <span className="text-body-md-medium text-fg">Download the engine now</span>
            <span className="text-body-sm text-fg-muted">
              Fetches the newest build from GitHub. Progress shows on the client
              card.
            </span>
          </span>
          <Toggle
            label="Download the engine right after creating the client"
            checked={downloadEngine}
            onChange={setDownloadEngine}
          />
        </div>

        <div className="flex items-center justify-end gap-8 pt-24">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canSubmit || createClient.isPending}
            onClick={submit}
          >
            {createClient.isPending ? "Creating…" : "Create client"}
          </Button>
        </div>
      </div>
    </div>
  );
}

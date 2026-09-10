import { useState } from "react";

import { errorMessage, type Client, type Engine } from "../lib/ipc";
import { useUpdateClient } from "../lib/queries";
import { Button, Input } from "./ui";

interface ClientSettingsDialogProps {
  client: Client;
  /** Engine of the client, for the default mod folder in the placeholder. */
  engine: Engine | undefined;
  onClose: () => void;
}

/**
 * The per-client dialog behind the gear on a card: name and mod folder.
 *
 * The two fields are what a player may change after creating a client. The
 * engine, the slug and the installed build are not editable: the slug is a
 * path other parts of the launcher stored, and the engine decides which
 * archive the Install button fetches.
 */
export function ClientSettingsDialog({
  client,
  engine,
  onClose,
}: ClientSettingsDialogProps) {
  const updateClient = useUpdateClient();

  const [name, setName] = useState(client.name);
  const [fsGame, setFsGame] = useState(client.fsGame ?? "");
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0 && !updateClient.isPending;

  const save = () => {
    if (!canSave) return;
    setError(null);
    updateClient.mutate(
      { clientId: client.id, name: name.trim(), fsGame: fsGame.trim() },
      {
        onSuccess: onClose,
        // The dialog stays open on a rejected mod folder: the player has to
        // see which field the core refused.
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-24"
      role="dialog"
      aria-modal="true"
      aria-label="Client settings"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="w-full max-w-[520px] rounded-xl border border-line bg-surface p-24 shadow-popover">
        <h2 className="text-display-md text-fg">Client settings</h2>
        <p className="text-body-sm text-fg-secondary pt-4">
          The folder on disk keeps its name{" "}
          <span className="text-mono-sm">{client.id}</span>, so a rename cannot
          break a path the launcher already stored.
        </p>

        <label
          className="block text-label-xs text-fg-muted pt-24 pb-8"
          htmlFor="client-settings-name"
        >
          Name
        </label>
        <Input
          id="client-settings-name"
          value={name}
          autoFocus
          maxLength={48}
          placeholder="Everyday"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />

        <label
          className="block text-label-xs text-fg-muted pt-16 pb-8"
          htmlFor="client-settings-fs-game"
        >
          Mod folder (fs_game)
        </label>
        <Input
          id="client-settings-fs-game"
          value={fsGame}
          maxLength={64}
          placeholder={engine?.defaultFsGame ?? "base"}
          onChange={(event) => setFsGame(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />
        <p className="text-body-sm text-fg-muted pt-8">
          The client starts in this folder of its home directory, passed as{" "}
          <span className="text-mono-sm">+set fs_game</span>. Letters, digits,{" "}
          <span className="text-mono-sm">_</span>,{" "}
          <span className="text-mono-sm">-</span> and{" "}
          <span className="text-mono-sm">+</span> only. Leave it empty for{" "}
          <span className="text-mono-sm">
            {engine?.defaultFsGame ?? "base"}
          </span>
          , the default of {engine?.name ?? "the engine"}.
        </p>

        {error ? (
          <p role="alert" className="text-body-sm text-fg-danger pt-16">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-8 pt-24">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} onClick={save}>
            {updateClient.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

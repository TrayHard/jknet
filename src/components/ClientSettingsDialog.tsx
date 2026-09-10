import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import type { Client, Engine } from "../lib/ipc";
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
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
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
        onError: (e) => setError(errorText(e)),
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-24"
      role="dialog"
      aria-modal="true"
      aria-label={t("settingsDialog.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="w-full max-w-[520px] rounded-xl border border-line bg-surface p-24 shadow-popover">
        <h2 className="text-display-md text-fg">{t("settingsDialog.title")}</h2>
        <p className="text-body-sm text-fg-secondary pt-4">
          <Trans
            t={t}
            i18nKey="settingsDialog.text"
            values={{ id: client.id }}
            components={[<span className="text-mono-sm" />]}
          />
        </p>

        <label
          className="block text-label-xs text-fg-muted pt-24 pb-8"
          htmlFor="client-settings-name"
        >
          {t("settingsDialog.name")}
        </label>
        <Input
          id="client-settings-name"
          value={name}
          autoFocus
          maxLength={48}
          placeholder={t("settingsDialog.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />

        <label
          className="block text-label-xs text-fg-muted pt-16 pb-8"
          htmlFor="client-settings-fs-game"
        >
          {t("settingsDialog.modFolder")}
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
          <Trans
            t={t}
            i18nKey="settingsDialog.modFolderHint"
            values={{
              folder: engine?.defaultFsGame ?? "base",
              engine: engine?.name ?? t("settingsDialog.engineFallback"),
            }}
            components={[
              <span className="text-mono-sm" />,
              <span className="text-mono-sm" />,
              <span className="text-mono-sm" />,
              <span className="text-mono-sm" />,
              <span className="text-mono-sm" />,
            ]}
          />
        </p>

        {error ? (
          <p role="alert" className="text-body-sm text-fg-danger pt-16">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-8 pt-24">
          <Button onClick={onClose}>{tCommon("actions.cancel")}</Button>
          <Button variant="primary" disabled={!canSave} onClick={save}>
            {updateClient.isPending
              ? tCommon("states.saving")
              : tCommon("actions.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

import { useTranslation } from "react-i18next";

import type { Client } from "../lib/ipc";
import { Button, Dialog } from "./ui";

interface DeleteClientDialogProps {
  client: Client;
  /** Name of the build installed in it, or `null` when there is none. */
  engineName: string | null;
  /** Folder that goes with it, or `null` while the core has not answered. */
  folder: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}

/**
 * The confirmation in front of **Delete** on a client card.
 *
 * Deleting a client is the one irreversible thing the Clients screen does:
 * `delete_client` removes the whole folder, and nothing goes to the recycle
 * bin — the engine alone is tens of megabytes, and the launcher can fetch it
 * again. So the dialog names the folder and says what is inside it, rather
 * than asking «are you sure» about a word.
 */
export function DeleteClientDialog({
  client,
  engineName,
  folder,
  onCancel,
  onConfirm,
  busy = false,
}: DeleteClientDialogProps) {
  const { t } = useTranslation("clients");
  const { t: tCommon } = useTranslation("common");

  return (
    <Dialog
      variant="danger"
      title={t("removeDialog.title", { client: client.name })}
      body={t("removeDialog.body")}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {tCommon("actions.cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? tCommon("states.deleting") : t("removeDialog.confirm")}
          </Button>
        </>
      }
    >
      {folder !== null ? (
        <p className="text-mono-sm text-fg-accent pt-12 break-all">{folder}</p>
      ) : null}
      {engineName !== null ? (
        <p className="text-body-sm text-fg-muted pt-8">
          {t("removeDialog.engine", { engine: engineName })}
        </p>
      ) : null}
    </Dialog>
  );
}

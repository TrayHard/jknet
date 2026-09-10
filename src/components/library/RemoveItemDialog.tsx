import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useFormat } from "../../i18n/useFormat";
import type { LibraryItem } from "../../lib/ipc";
import { Button, Dialog } from "../ui";

interface RemoveItemDialogProps {
  item: LibraryItem;
  clientName: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}

/**
 * The confirmation from the design's Dialogs frame.
 *
 * The file is deleted, not moved aside: the disable toggle already covers
 * "keep it but stop loading it", so a second half-measure would only make the
 * two commands hard to tell apart.
 */
export function RemoveItemDialog({
  item,
  clientName,
  onCancel,
  onConfirm,
  busy = false,
}: RemoveItemDialogProps) {
  const { t } = useTranslation("library");
  const { t: tCommon } = useTranslation("common");
  const format = useFormat();

  return (
    <Dialog
      variant="danger"
      title={t("remove.title", { file: item.displayName, client: clientName })}
      body={t("remove.body", {
        fileName: item.fileName,
        size: format.bytes(item.size),
        folder: item.folder,
      })}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {tCommon("actions.cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? tCommon("states.removing") : t("remove.confirm")}
          </Button>
        </>
      }
    />
  );
}

import type { LibraryItem } from "../../lib/ipc";
import { formatBytes } from "../../lib/format";
import { Button } from "../ui";
import { LibraryDialog } from "./LibraryDialog";

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
  return (
    <LibraryDialog
      title={`Remove ${item.displayName} from ${clientName}?`}
      body={`${item.fileName}, ${formatBytes(item.size)}. The file is deleted from the client's ${item.folder} folder. Other clients keep their own copy.`}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Removing…" : "Remove file"}
          </Button>
        </>
      }
    />
  );
}

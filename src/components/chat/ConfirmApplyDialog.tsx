import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ChatCommandDanger } from "../../lib/ipc";
import { Button, Dialog } from "../ui";
import { DangerList } from "./DangerList";
import { Layer } from "./Layer";

interface ConfirmApplyDialogProps {
  title: string;
  body: string;
  /** The dangerous commands of the text being applied; none for a map or a profile. */
  dangers?: ChatCommandDanger[];
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirming press is on its way: both buttons wait. */
  pending?: boolean;
  /** Nothing to confirm yet, or nothing that can be: the confirming button only. */
  disabled?: boolean;
  /** Why the last press failed, in words. */
  error?: string | null;
  children?: ReactNode;
}

/**
 * --- slice: chat cards ---
 *
 * The last question before something that came in a chat changes anything
 * on this machine: a config with commands to read, a server started or
 * moved to another map.
 *
 * A card never applies itself. The player pressed a button of the card, the
 * editor or the form it opened showed what would happen, and this dialog
 * asks once more, naming the dangerous lines when there are any — then the
 * danger variant paints the dialog, and the button says what it does. It is
 * drawn into the body (`Layer`): a card asks for it from inside a message.
 */
export function ConfirmApplyDialog({
  title,
  body,
  dangers = [],
  confirmLabel,
  onConfirm,
  onCancel,
  pending = false,
  disabled = false,
  error = null,
  children,
}: ConfirmApplyDialogProps) {
  const { t } = useTranslation("common");
  const risky = dangers.length > 0;
  return (
    <Layer>
      <Dialog
        title={title}
        body={body}
        variant={risky ? "danger" : "default"}
        onClose={() => {
          if (!pending) onCancel();
        }}
        actions={
          <>
            <Button variant="ghost" disabled={pending} onClick={onCancel}>
              {t("actions.cancel")}
            </Button>
            <Button variant={risky ? "danger" : "primary"} disabled={pending || disabled} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-12 pt-12">
          {risky ? <DangerList dangers={dangers} /> : null}
          {children}
          {error !== null ? (
            <p role="alert" className="text-body-sm text-fg-danger">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </Layer>
  );
}

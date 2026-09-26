import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fileExtension } from "../../lib/chat/cardDrafts";
import type { ChatFileRef } from "../../lib/ipc";
import { Button, Dialog } from "../ui";

interface SaveDangerDialogProps {
  file: ChatFileRef;
  /** Who sent it: the name the warning asks the player to trust. */
  senderName: string;
  /** What the core found, in English: the names of the programs inside an archive. */
  reasons: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
}

/**
 * --- slice: chat cards ---
 *
 * **Save anyway?** — asked before a program, or an archive with programs
 * inside, leaves the chat for a folder of the player's.
 *
 * The core refused the first save with `confirm_danger` and listed what it
 * found; the dialog says in the player's language what kind of danger it is
 * and shows the list as it came, since it is made of file names. The saved
 * copy is marked as downloaded from the internet, so Windows asks again
 * before it runs, and JKNet never opens it.
 */
export function SaveDangerDialog({ file, senderName, reasons, onConfirm, onCancel, pending = false }: SaveDangerDialogProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const extension = fileExtension(file.name);
  const kind =
    file.class === "archive"
      ? t("safety.save.archive")
      : extension === ""
        ? t("safety.save.program")
        : t("safety.save.programExt", { ext: extension });

  return (
    <Dialog
      variant="danger"
      title={t("safety.save.title", { name: file.name })}
      body={t("safety.save.body", { name: senderName })}
      onClose={() => {
        if (!pending) onCancel();
      }}
      actions={
        <>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            {tCommon("actions.cancel")}
          </Button>
          <Button variant="danger" disabled={pending} onClick={onConfirm}>
            {t("safety.save.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-10 pt-12">
        <p className="flex items-start gap-8 text-body-sm text-fg">
          <ShieldAlert size={16} aria-hidden="true" className="mt-2 shrink-0 text-fg-danger" />
          <span>{kind}</span>
        </p>
        {reasons.trim() !== "" ? (
          <div className="flex flex-col gap-4">
            <span className="text-label-xs text-fg-muted">{t("safety.save.details")}</span>
            <p className="max-h-120 overflow-y-auto rounded-md border border-line bg-input p-10 text-mono-xs text-fg-secondary [overflow-wrap:anywhere]">
              {reasons}
            </p>
          </div>
        ) : null}
        <p className="text-body-sm text-fg-muted">{t("safety.save.marked")}</p>
      </div>
    </Dialog>
  );
}

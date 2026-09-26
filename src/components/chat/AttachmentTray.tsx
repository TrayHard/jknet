import { FileImage, Paperclip, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import type { ChatStagedFile } from "../../lib/ipc";

/**
 * --- slice: chat ---
 *
 * The files waiting to go with the next message, as chips above the text
 * field. The core has already copied them and stripped their metadata;
 * removing a chip lets the core forget the copy.
 */
export function AttachmentTray({ files, onRemove }: { files: ChatStagedFile[]; onRemove: (handle: string) => void }) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  if (files.length === 0) return null;
  return (
    <ul aria-label={t("composer.attachments")} className="flex flex-wrap gap-6 px-10 pt-8">
      {files.map((file) => (
        <li
          key={file.handle}
          className="flex max-w-[240px] items-center gap-6 rounded-md border border-line bg-input py-4 pr-4 pl-8"
        >
          {file.classGuess === "image" ? (
            <FileImage size={14} className="shrink-0 text-fg-secondary" />
          ) : (
            <Paperclip size={14} className="shrink-0 text-fg-secondary" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body-sm text-fg [unicode-bidi:isolate]" title={file.name}>
              {file.name}
            </span>
            <span className="text-mono-xs text-fg-muted">{format.bytes(file.size)}</span>
          </span>
          <button
            type="button"
            aria-label={t("composer.removeFile", { name: file.name })}
            title={t("composer.removeFile", { name: file.name })}
            onClick={() => onRemove(file.handle)}
            className="flex size-20 shrink-0 items-center justify-center rounded-xs text-fg-muted cursor-pointer hover:bg-hover-overlay hover:text-fg"
          >
            <X size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

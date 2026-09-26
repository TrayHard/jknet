import { FolderInput, Save, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import { isScreenshotName } from "../../../lib/chat/cardDrafts";
import { useDefaultClient } from "../../../lib/game";
import type { ChatFileRef, ChatMessage } from "../../../lib/ipc";
import { useImportChatFile } from "../../../lib/queries";
import { Button } from "../../ui";
import { useChatNames, useChatTimes } from "../useChatText";
import type { ChatFileState } from "./useChatFile";

interface ImageLightboxProps {
  file: ChatFileRef;
  message: ChatMessage;
  url: string;
  state: ChatFileState;
  onClose: () => void;
}

/**
 * --- slice: chat cards ---
 *
 * A picture of a message, whole, over everything.
 *
 * Who sent it and when, its size in pixels and in bytes, **Save** through the
 * core's save dialog and, for a PNG or a JPEG, **Add to Media**: the picture
 * goes into the screenshots of the default client of the active game, where
 * the Media screen finds it. Escape, **Close** and a click beside the picture
 * close it, and the focus goes back to the picture in the thread.
 */
export function ImageLightbox({ file, message, url, state, onClose }: ImageLightboxProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const format = useFormat();
  const names = useChatNames();
  const times = useChatTimes();
  const client = useDefaultClient();
  const importFile = useImportChatFile();
  const layer = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    layer.current?.querySelector<HTMLButtonElement>("[data-lightbox-close]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const facts = [
    t("files.image.from", { name: names.personName(message.senderId) }),
    times.full(message.createdAt),
    file.meta?.width && file.meta?.height ? `${file.meta.width}×${file.meta.height}` : null,
    format.bytes(file.size),
  ].filter(Boolean);

  return createPortal(
    <div
      ref={layer}
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      className="fixed inset-0 z-[80] flex flex-col bg-overlay p-16"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-8 rounded-lg border border-line bg-surface px-12 py-8">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body-sm-medium text-fg [unicode-bidi:isolate]" title={file.name}>
            {file.name}
          </span>
          <span className="truncate text-body-sm text-fg-muted">{facts.join(" · ")}</span>
        </span>
        {isScreenshotName(file.name) && client !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderInput size={14} />}
            disabled={importFile.isPending || importFile.isSuccess}
            title={t("files.image.addToMediaHint", { client: client.name })}
            onClick={() => importFile.mutate({ fileId: file.id, target: { kind: "screenshot", clientId: client.id } })}
          >
            {importFile.isSuccess ? t("files.addedToMedia") : t("files.addToMedia")}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" icon={<Save size={14} />} disabled={state.saving} onClick={state.save}>
          {t("files.save")}
        </Button>
        <Button data-lightbox-close="" size="sm" variant="ghost" icon={<X size={14} />} onClick={onClose}>
          {t("files.image.close")}
        </Button>
      </div>
      {importFile.error || state.error !== null || state.savedTo !== null ? (
        <p
          role={importFile.error || state.error !== null ? "alert" : "status"}
          className="mt-8 shrink-0 self-center rounded-md bg-surface px-10 py-6 text-body-sm text-fg"
        >
          {importFile.error ? errorText(importFile.error) : (state.error ?? t("files.saved", { path: state.savedTo ?? "" }))}
        </p>
      ) : null}
      <div
        className="flex min-h-0 flex-1 items-center justify-center pt-12"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img src={url} alt={file.name} className="max-h-full max-w-full rounded-md object-contain shadow-popover" />
      </div>
    </div>,
    document.body,
  );
}

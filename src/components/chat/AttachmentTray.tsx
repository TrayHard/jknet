import { FileCode, FileImage, Film, Paperclip, ShieldAlert, Video, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import { cardTitle, readCard } from "../../lib/chat/cardDrafts";
import type { ChatCard, ChatFileClass, ChatStagedFile } from "../../lib/ipc";
import { CARD_ICONS } from "./cards/icons";

const FILE_ICONS: Partial<Record<ChatFileClass, LucideIcon>> = {
  image: FileImage,
  video: Video,
  demo: Film,
  config: FileCode,
  executable: ShieldAlert,
};

interface AttachmentTrayProps {
  files: ChatStagedFile[];
  onRemove: (handle: string) => void;
  // --- slice: chat cards ---
  /** The cards picked from the attach menu, in the order they go. */
  cards?: ChatCard[];
  onRemoveCard?: (index: number) => void;
}

/**
 * --- slice: chat ---
 *
 * The files waiting to go with the next message, as chips above the text
 * field. The core has already copied them and stripped their metadata;
 * removing a chip lets the core forget the copy.
 *
 * --- slice: chat cards ---
 * The cards picked from the attach menu wait here too, each a chip with the
 * mark of its kind and its title: what the message will carry, before it
 * goes.
 */
export function AttachmentTray({ files, onRemove, cards = [], onRemoveCard }: AttachmentTrayProps) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  if (files.length === 0 && cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-6 px-10 pt-8">
      {cards.length > 0 ? (
        <ul aria-label={t("composer.cards")} className="flex flex-wrap gap-6">
          {cards.map((card, index) => {
            const parsed = readCard(card);
            const Icon = parsed ? CARD_ICONS[parsed.type] : Paperclip;
            const title = parsed ? cardTitle(parsed) : card.fallbackText;
            const kind = parsed ? t(`cards.kinds.${parsed.type}`) : t("summary.card");
            return (
              <Chip
                key={`${index}-${card.type}`}
                icon={<Icon size={14} className="shrink-0 text-fg-accent" />}
                title={title || kind}
                detail={kind}
                removeLabel={t("composer.removeCard", { name: title || kind })}
                onRemove={() => onRemoveCard?.(index)}
              />
            );
          })}
        </ul>
      ) : null}
      {files.length > 0 ? (
        <ul aria-label={t("composer.attachments")} className="flex flex-wrap gap-6">
          {files.map((file) => {
            const Icon = FILE_ICONS[file.classGuess] ?? Paperclip;
            return (
              <Chip
                key={file.handle}
                icon={<Icon size={14} className={file.classGuess === "executable" ? "shrink-0 text-fg-danger" : "shrink-0 text-fg-secondary"} />}
                title={file.name}
                detail={format.bytes(file.size)}
                mono
                removeLabel={t("composer.removeFile", { name: file.name })}
                onRemove={() => onRemove(file.handle)}
              />
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function Chip({
  icon,
  title,
  detail,
  mono = false,
  removeLabel,
  onRemove,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  mono?: boolean;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <li className="flex max-w-[240px] items-center gap-6 rounded-md border border-line bg-input py-4 pr-4 pl-8">
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body-sm text-fg [unicode-bidi:isolate]" title={title}>
          {title}
        </span>
        <span className={mono ? "text-mono-xs text-fg-muted" : "truncate text-body-sm text-fg-muted"}>{detail}</span>
      </span>
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={onRemove}
        className="flex size-20 shrink-0 items-center justify-center rounded-xs text-fg-muted cursor-pointer hover:bg-hover-overlay hover:text-fg"
      >
        <X size={12} />
      </button>
    </li>
  );
}

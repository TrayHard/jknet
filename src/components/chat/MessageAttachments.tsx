import {
  FileArchive,
  FileCode,
  FileImage,
  FileQuestion,
  FileVideo,
  Film,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import type { ChatFileClass, ChatFileRef, ChatMessage } from "../../lib/ipc";
import { cardComponent } from "./cards";
import { CardFallback, KNOWN_CARD_KINDS } from "./cards/CardFallback";

/**
 * --- slice: chat ---
 *
 * The files and cards of a message, under its text.
 *
 * A file is drawn by the component registered for its class — the picture,
 * the video and the demo of the cards slice — and by `FileChip` otherwise.
 */
export interface AttachmentProps {
  file: ChatFileRef;
  message: ChatMessage;
}

export const FILE_KINDS: Partial<Record<ChatFileClass, ComponentType<AttachmentProps>>> = {};

const ICONS: Record<ChatFileClass, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  demo: Film,
  config: FileCode,
  archive: FileArchive,
  executable: ShieldAlert,
  other: FileQuestion,
};

export function MessageAttachments({ message }: { message: ChatMessage }) {
  if (message.files.length === 0 && message.cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-6">
      {message.files.map((file) => {
        const Registered = FILE_KINDS[file.class];
        return Registered ? (
          <Registered key={file.id} file={file} message={message} />
        ) : (
          <FileChip key={file.id} file={file} />
        );
      })}
      {message.cards.map((card, index) => {
        const Card = cardComponent(card.type);
        return Card ? (
          <Card key={index} card={card} message={message} />
        ) : (
          <CardFallback key={index} card={card} message={message} known={KNOWN_CARD_KINDS.has(card.type)} />
        );
      })}
    </div>
  );
}

/** One file as a line: what it is, its name and its size. An executable is marked. */
export function FileChip({ file }: { file: ChatFileRef }) {
  const { t } = useTranslation("chat");
  const format = useFormat();
  const Icon = ICONS[file.class] ?? FileQuestion;
  return (
    <div className="flex w-[300px] max-w-full items-center gap-10 rounded-md border border-line bg-input px-10 py-8">
      <Icon size={20} className={file.danger ? "shrink-0 text-fg-danger" : "shrink-0 text-fg-secondary"} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body-sm-medium text-fg [unicode-bidi:isolate]" title={file.name}>
          {file.name}
        </span>
        <span className="text-mono-xs text-fg-muted">
          {t(`files.class.${file.class}`)} · {format.bytes(file.size)}
        </span>
      </span>
    </div>
  );
}

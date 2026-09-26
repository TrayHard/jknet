import { Copy, Reply, SmilePlus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { ChatMessage } from "../../lib/ipc";
import { Floating } from "./Floating";
import { MessageAttachments } from "./MessageAttachments";
import { MessageText } from "./MessageText";
import { ReactionPicker } from "./ReactionPicker";
import { Reactions } from "./Reactions";
import { ReadMarks } from "./ReadMarks";
import { ReplyQuote } from "./ReplyQuote";
import { useThread } from "./ThreadContext";
import { useChatNames, useChatTimes } from "./useChatText";

interface MessageItemProps {
  message: ChatMessage;
  mine: boolean;
}

/**
 * --- slice: chat ---
 *
 * One message: the bubble with the quote, the text and the time, then the
 * files and cards, the reactions and — under my newest message — the read
 * marks.
 *
 * Mine sit on the right in the accent tint. A message that mentions me, or
 * replies to me, is outlined in the warm colour. The tools appear on hover
 * and on focus: **React**, **Reply** and **Copy text**. There is no edit and
 * no delete: a sent message stays as it is.
 */
export function MessageItem({ message, mine }: MessageItemProps) {
  const { t } = useTranslation("chat");
  const { meId, conversation, onReply, highlightSeq, readMarkSeq } = useThread();
  const names = useChatNames();
  const times = useChatTimes();
  const reactButton = useRef<HTMLButtonElement>(null);
  const [reacting, setReacting] = useState(false);

  const hasText = message.body.trim() !== "";
  const pinged =
    !mine &&
    meId !== null &&
    (message.mentions.includes(meId) || (message.replyTo?.senderId ?? null) === meId);
  const bubble = hasText || message.replyTo !== null;
  const time = (
    <span className="text-mono-xs text-fg-muted select-none" title={times.full(message.createdAt)}>
      {times.time(message.createdAt)}
    </span>
  );

  const copy = () => {
    const text = names.excerpt(message.body, Number.MAX_SAFE_INTEGER);
    navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  return (
    <div
      data-seq={message.seq}
      className={cn(
        "group/msg relative flex items-center gap-6 rounded-md",
        mine && "flex-row-reverse",
        highlightSeq === message.seq && "bg-accent-glow",
      )}
    >
      <div className={cn("flex min-w-0 max-w-[min(480px,85%)] flex-col gap-4", mine ? "items-end" : "items-start")}>
        {bubble ? (
          <div
            className={cn(
              // Clipped: stacked combining marks («zalgo») stay inside the bubble.
              "relative max-w-full overflow-hidden rounded-lg px-10 py-6 text-fg",
              mine ? "bg-accent-subtle" : "bg-elevated",
              pinged && "ring-1 ring-inset ring-line-warm",
            )}
          >
            {message.replyTo !== null ? <ReplyQuote reply={message.replyTo} /> : null}
            {hasText ? <MessageText body={message.body} /> : null}
            {/* Room for the time at the end of the last line, so it never covers a word. */}
            <span aria-hidden="true" className="inline-block h-px w-44" />
            <span className="absolute right-8 bottom-4">{time}</span>
          </div>
        ) : null}
        <MessageAttachments message={message} />
        {bubble ? null : time}
        <Reactions message={message} />
        {mine && readMarkSeq === message.seq ? <ReadMarks seq={message.seq} /> : null}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center gap-2 transition-opacity duration-100",
          reacting ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100",
        )}
      >
        {conversation.canSend ? (
          <>
            <ToolButton
              ref={reactButton}
              label={t("message.react")}
              onClick={() => setReacting((open) => !open)}
            >
              <SmilePlus size={14} />
            </ToolButton>
            <ToolButton label={t("message.reply")} onClick={() => onReply(message)}>
              <Reply size={14} />
            </ToolButton>
          </>
        ) : null}
        {hasText ? (
          <ToolButton label={t("message.copy")} onClick={copy}>
            <Copy size={14} />
          </ToolButton>
        ) : null}
      </div>

      <Floating
        anchor={reacting ? reactButton.current : null}
        onClose={() => setReacting(false)}
        placement={mine ? "top-end" : "top-start"}
        label={t("reactions.pick")}
      >
        <ReactionPicker message={message} onDone={() => setReacting(false)} />
      </Floating>
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  children,
  ref,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-24 items-center justify-center rounded-sm text-fg-muted cursor-pointer hover:bg-hover-overlay hover:text-fg"
    >
      {children}
    </button>
  );
}

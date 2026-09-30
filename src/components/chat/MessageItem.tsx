import { Copy, Reply, SmilePlus } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { ChatMessage } from "../../lib/ipc";
import { useCoarsePointer } from "../../lib/pointer";
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
  /** The sender's name sits right above this message: the first of a run in a group. */
  named?: boolean;
}

/** How far the tools of a touch screen keep off what they must not cover. */
const TOOLS_GAP = 4;

/**
 * Where the tools of a tapped message float, as offsets from its `row`,
 * judged by the part of the message the thread shows. `strip` is the tools
 * laid out, not yet shown: their size and their side. Above the message,
 * and above the sender's name over it (`head`), when the thread shows room
 * there; else below it. A message taller than that room leaves neither: the
 * tools float over its part on screen (`spotOver`). The thread is the pane
 * that scrolls the row, the window when nothing does.
 */
function placeTools(row: HTMLElement, strip: HTMLElement, head: Element | null): CSSProperties {
  let pane = row.parentElement;
  while (pane !== null && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
  const frame = pane?.getBoundingClientRect();
  const top = Math.max(frame?.top ?? 0, 0);
  const bottom = Math.min(frame?.bottom ?? window.innerHeight, window.innerHeight);
  const box = row.getBoundingClientRect();
  const room = strip.offsetHeight + 2 * TOOLS_GAP;
  const clear = Math.min(box.top, head?.getBoundingClientRect().top ?? box.top);
  if (clear - top >= room) return { bottom: `calc(100% + ${box.top - clear + TOOLS_GAP}px)` };
  if (bottom - box.bottom >= room) return { top: `calc(100% + ${TOOLS_GAP}px)` };
  const spot = spotOver(row, strip, Math.max(top, box.top) + TOOLS_GAP, Math.min(bottom, box.bottom) - TOOLS_GAP);
  return { top: spot.top - box.top, left: spot.left - box.left, right: "auto" };
}

/**
 * The spot for the tools between `from` and `to` over a message: where they
 * cover the least of its text, every line counted with `TOOLS_GAP` px round
 * it — none when a band of the message holds none. The side of its bubble
 * before the other end of the row, the topmost of equal spots.
 */
function spotOver(row: HTMLElement, strip: HTMLElement, from: number, to: number): { top: number; left: number } {
  const box = row.getBoundingClientRect();
  const own = strip.getBoundingClientRect();
  const other = own.left - box.left <= box.right - own.right ? box.right - own.width : box.left;
  const lines: DOMRect[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (strip.contains(node) || (node.textContent ?? "").trim() === "") continue;
    range.selectNodeContents(node);
    for (const line of Array.from(range.getClientRects())) if (line.width > 0 && line.height > 0) lines.push(line);
  }
  const last = Math.max(from, to - own.height);
  const tops = [from, last, ...lines.flatMap((line) => [line.bottom + TOOLS_GAP, line.top - TOOLS_GAP - own.height])]
    .filter((top) => top >= from && top <= last)
    .sort((one, next) => one - next);
  let best = { top: from, left: own.left, covered: Number.POSITIVE_INFINITY };
  for (const left of [own.left, other]) {
    for (const top of tops) {
      let covered = 0;
      for (const line of lines) {
        const wide = Math.min(line.right + TOOLS_GAP, left + own.width) - Math.max(line.left - TOOLS_GAP, left);
        const high = Math.min(line.bottom + TOOLS_GAP, top + own.height) - Math.max(line.top - TOOLS_GAP, top);
        if (wide > 0 && high > 0) covered += wide * high;
      }
      if (covered < best.covered) best = { top, left, covered };
    }
  }
  return best;
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
 *
 * --- slice: web app --- a touch screen has no hover: a tap on the message
 * shows its tools, 44 px each, and a tap elsewhere hides them. Hidden, they
 * cannot be tapped by accident. Shown, they float above the message and its
 * sender's name, on the side of its bubble, and below it when the top of the
 * thread leaves no room: over the neighbouring message, never over the one
 * they act on. A message taller than the thread leaves no room either way:
 * the tools float over its part on screen, off its text when they can; a
 * tap on it after a scroll brings them back to its part on screen.
 */
export function MessageItem({ message, mine, named = false }: MessageItemProps) {
  const { t } = useTranslation("chat");
  const { meId, conversation, onReply, highlightSeq, readMarkSeq } = useThread();
  const names = useChatNames();
  const times = useChatTimes();
  const reactButton = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  const [reacting, setReacting] = useState(false);
  const coarse = useCoarsePointer();
  const [tapped, setTapped] = useState(false);
  // Where the shown tools float; `null` while they wait to be measured.
  const [toolsAt, setToolsAt] = useState<CSSProperties | null>(null);
  const floating = coarse && (reacting || tapped);

  // Placed once a tap, before the tools are painted: laid out hidden first,
  // for their size. A tap on a tool does not move them from under the finger.
  useLayoutEffect(() => {
    if (!floating || toolsAt !== null || row.current === null || tools.current === null) return;
    setToolsAt(placeTools(row.current, tools.current, named ? row.current.previousElementSibling : null));
  }, [floating, toolsAt, named]);

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
      ref={row}
      data-seq={message.seq}
      tabIndex={coarse ? -1 : undefined}
      onFocus={
        coarse
          ? () => {
              if (!floating) setToolsAt(null);
              setTapped(true);
            }
          : undefined
      }
      onBlur={
        coarse
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTapped(false);
            }
          : undefined
      }
      onClick={
        coarse
          ? (event) => {
              // A browser that does not focus on a tap: the message still takes it.
              if (!event.currentTarget.contains(document.activeElement)) event.currentTarget.focus({ preventScroll: true });
              // Tapped again, after a scroll through a long message: the tools come to where it is now.
              else if (floating && !reacting && !(tools.current?.contains(event.target as Node) ?? false)) setToolsAt(null);
            }
          : undefined
      }
      className={cn(
        "group/msg relative flex items-center gap-6 rounded-md outline-none",
        mine && "flex-row-reverse",
        highlightSeq === message.seq && "bg-accent-glow",
      )}
    >
      <div className={cn("flex min-w-0 max-w-[min(480px,85%)] flex-col gap-4", mine ? "items-end" : "items-start")}>
        {bubble ? (
          <div
            data-testid="message-bubble"
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

      {/* On a touch screen the tools take no room: 44 px each, kept beside
          the message they took a third of a phone's width from every bubble
          and card. Hidden until a tap, then floating above the message or
          below it, lined up with its bubble: over the message before or
          after, not over this one's text. Over its part on screen when it is
          taller than the thread (`placeTools`). */}
      <div
        ref={tools}
        className={cn(
          "flex items-center gap-2 transition-opacity duration-100",
          coarse
            ? floating
              ? cn("absolute z-10 rounded-md bg-elevated shadow-popover", mine ? "right-0" : "left-0")
              : "hidden"
            : cn("shrink-0", reacting ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100"),
        )}
        style={floating ? (toolsAt ?? { visibility: "hidden" }) : undefined}
        data-testid="message-tools"
        data-floating-tools={floating ? "" : undefined}
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
      className="flex size-24 pointer-coarse:size-44 items-center justify-center rounded-sm text-fg-muted cursor-pointer hover:bg-hover-overlay hover:text-fg"
    >
      {children}
    </button>
  );
}

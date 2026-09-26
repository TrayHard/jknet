import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { isLargeEmoji } from "../../lib/chat/emojiText";
import { linkify } from "../../lib/chat/linkify";
import { splitMentions } from "../../lib/chat/mentions";
import { cn } from "../../lib/format";
import { useThread } from "./ThreadContext";
import { useChatNames } from "./useChatText";

/** Lines a long message shows before **Show more**. */
const CLAMP_LINES = 14;
/** A message this long is clamped whatever its lines: one endless word is one line. */
const CLAMP_CHARS = 1200;

/**
 * --- slice: chat ---
 *
 * The text of one message, as React text nodes and nothing else.
 *
 * No HTML is ever parsed: a `<script>` in a message is the eight characters it
 * looks like. The only elements the text gets are mention chips and links,
 * and a link is `http` or `https` and opens through the core. The text keeps
 * its line breaks, breaks inside an endless word rather than overflowing,
 * and is isolated from the text around it, so right-to-left text or a stray
 * direction mark cannot turn the time or the name next to it around.
 *
 * A message of a few emoji and nothing else is drawn large. A long one is
 * clamped with **Show more**.
 */
export function MessageText({ body, large: allowLarge = true }: { body: string; large?: boolean }) {
  const { t } = useTranslation("chat");
  const { meId, onLink } = useThread();
  const names = useChatNames();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const large = allowLarge && isLargeEmoji(body);
  const clampable = !large && (body.length > CLAMP_CHARS || body.split("\n").length > CLAMP_LINES);

  // Whether the clamp actually hides something: a message of 15 short lines
  // may still fit, and a **Show more** that reveals nothing is a lie.
  useLayoutEffect(() => {
    const node = box.current;
    if (!clampable || expanded || node === null) {
      setOverflows(false);
      return;
    }
    setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [clampable, expanded, body]);

  const openOnKey = (href: string) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onLink(href);
    }
  };

  return (
    <>
      <div
        ref={box}
        dir="auto"
        className={cn(
          "whitespace-pre-wrap [overflow-wrap:anywhere] [unicode-bidi:isolate]",
          large ? "text-[32px] leading-[40px]" : "text-body-md",
          clampable && !expanded && "line-clamp-[14]",
        )}
      >
        {splitMentions(body).map((segment, index) => {
          if (segment.type === "mention") {
            const self = segment.userId !== null && segment.userId === meId;
            return (
              <span
                key={index}
                className={cn(
                  "rounded-xs px-2 font-medium [unicode-bidi:isolate]",
                  segment.userId === null
                    ? "bg-elevated text-fg-secondary"
                    : self
                      ? "bg-warm-subtle text-fg-warm"
                      : "bg-accent-subtle text-fg-accent",
                )}
              >
                @{names.personName(segment.userId)}
              </span>
            );
          }
          return linkify(segment.text).map((part, inner) =>
            part.type === "link" ? (
              <span
                key={`${index}:${inner}`}
                role="link"
                tabIndex={0}
                title={part.href}
                onClick={() => onLink(part.href)}
                onKeyDown={openOnKey(part.href)}
                className="cursor-pointer text-fg-accent underline underline-offset-2 hover:text-fg"
              >
                {part.text}
              </span>
            ) : (
              <span key={`${index}:${inner}`}>{part.text}</span>
            ),
          );
        })}
      </div>
      {clampable && (overflows || expanded) ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="mt-4 text-body-sm-medium text-fg-accent hover:text-fg cursor-pointer select-none"
        >
          {expanded ? t("message.showLess") : t("message.showMore")}
        </button>
      ) : null}
    </>
  );
}

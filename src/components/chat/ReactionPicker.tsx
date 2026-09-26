import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { reactionsBy } from "../../lib/chat/mergeMessages";
import type { ChatMessage } from "../../lib/ipc";
import { useReactToChatMessage } from "../../lib/queries";
import { EmojiPopover } from "./EmojiPopover";
import { DISTINCT_REACTIONS_MAX, MY_REACTIONS_MAX } from "./Reactions";
import { useThread } from "./ThreadContext";

/** The quick row of the reaction bar. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "⚔️"];

interface ReactionPickerProps {
  message: ChatMessage;
  /** Called once a reaction was picked or the bar was left. */
  onDone: () => void;
}

/**
 * --- slice: chat ---
 *
 * The bar that opens from **React**: seven quick emoji and **More** for the
 * whole picker. A reaction the player already has is switched off again.
 * The service's limits are the bar's too: three reactions of mine per
 * message, twenty different emoji per message.
 */
export function ReactionPicker({ message, onDone }: ReactionPickerProps) {
  const { t } = useTranslation("chat");
  const { conversation, meId } = useThread();
  const react = useReactToChatMessage();
  const more = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const mineCount = meId === null ? 0 : reactionsBy(message.reactions, meId);
  const has = (emoji: string) =>
    meId !== null && message.reactions.some((group) => group.emoji === emoji && group.userIds.includes(meId));
  const full = message.reactions.length >= DISTINCT_REACTIONS_MAX;

  const toggle = (emoji: string) => {
    const on = !has(emoji);
    const known = message.reactions.some((group) => group.emoji === emoji);
    if (on && (mineCount >= MY_REACTIONS_MAX || (!known && full))) return;
    react.mutate({ conversationId: conversation.id, seq: message.seq, emoji, on });
    onDone();
  };

  return (
    <div
      role="menu"
      aria-label={t("reactions.pick")}
      className="flex items-center gap-2 rounded-full border border-line-strong bg-elevated p-4 shadow-popover"
    >
      {QUICK_REACTIONS.map((emoji) => {
        const on = has(emoji);
        const blocked = !on && (mineCount >= MY_REACTIONS_MAX || (full && !message.reactions.some((g) => g.emoji === emoji)));
        return (
          <button
            key={emoji}
            type="button"
            role="menuitem"
            aria-pressed={on}
            disabled={blocked}
            onClick={() => toggle(emoji)}
            className="flex size-32 items-center justify-center rounded-full text-[18px] leading-none cursor-pointer select-none hover:bg-hover-overlay aria-pressed:bg-accent-subtle disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {emoji}
          </button>
        );
      })}
      <button
        ref={more}
        type="button"
        role="menuitem"
        aria-label={t("reactions.more")}
        title={mineCount >= MY_REACTIONS_MAX ? t("reactions.limit") : t("reactions.more")}
        disabled={mineCount >= MY_REACTIONS_MAX}
        onClick={() => setPickerOpen(true)}
        className="flex size-32 items-center justify-center rounded-full text-fg-secondary cursor-pointer hover:bg-hover-overlay hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={16} />
      </button>
      <EmojiPopover
        anchor={pickerOpen ? more.current : null}
        onClose={() => setPickerOpen(false)}
        onPick={(emoji) => {
          setPickerOpen(false);
          toggle(emoji);
        }}
      />
    </div>
  );
}

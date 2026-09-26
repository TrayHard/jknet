import { useTranslation } from "react-i18next";

import { reactionsBy } from "../../lib/chat/mergeMessages";
import { cn } from "../../lib/format";
import type { ChatMessage } from "../../lib/ipc";
import { useReactToChatMessage } from "../../lib/queries";
import { useThread } from "./ThreadContext";
import { useChatNames } from "./useChatText";

/** The service keeps three reactions per player per message. */
export const MY_REACTIONS_MAX = 3;
/** And twenty different emoji per message. */
export const DISTINCT_REACTIONS_MAX = 20;

/**
 * --- slice: chat ---
 *
 * The reactions under a message: one pill per emoji with its count, mine
 * outlined in accent. A click switches my reaction; hovering names who
 * reacted.
 */
export function Reactions({ message }: { message: ChatMessage }) {
  const { t } = useTranslation("chat");
  const { conversation, meId } = useThread();
  const names = useChatNames();
  const react = useReactToChatMessage();

  if (message.reactions.length === 0) return null;
  const mineCount = meId === null ? 0 : reactionsBy(message.reactions, meId);

  return (
    <div className="flex flex-wrap gap-4">
      {message.reactions.map((group) => {
        const mine = meId !== null && group.userIds.includes(meId);
        const blocked = !mine && (mineCount >= MY_REACTIONS_MAX || !conversation.canSend);
        const who = group.userIds.map((id) => names.personName(id)).join(", ");
        return (
          <button
            key={group.emoji}
            type="button"
            aria-pressed={mine}
            disabled={blocked || meId === null}
            title={t("reactions.who", { names: who, emoji: group.emoji })}
            onClick={() =>
              react.mutate({ conversationId: conversation.id, seq: message.seq, emoji: group.emoji, on: !mine })
            }
            className={cn(
              "inline-flex h-24 items-center gap-4 rounded-full border px-8 text-mono-xs select-none",
              "transition-colors duration-150 cursor-pointer disabled:cursor-default",
              mine
                ? "border-line-accent bg-accent-subtle text-fg-accent"
                : "border-line bg-input text-fg-secondary hover:bg-surface-hover",
            )}
          >
            <span className="text-[14px] leading-4">{group.emoji}</span>
            {group.userIds.length}
          </button>
        );
      })}
    </div>
  );
}

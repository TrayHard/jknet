import { CornerUpLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ChatReplyRef } from "../../lib/ipc";
import { useThread } from "./ThreadContext";
import { useChatNames } from "./useChatText";

/**
 * --- slice: chat ---
 *
 * The quote at the top of a reply: who wrote the original and its first
 * words. A click scrolls to the original. An original that is out of reach —
 * expired, or older than the moment I joined — says so and goes nowhere; a
 * deleted author reads **Deleted account**.
 */
export function ReplyQuote({ reply }: { reply: ChatReplyRef }) {
  const { t } = useTranslation("chat");
  const { onJump } = useThread();
  const names = useChatNames();

  if (reply.missing) {
    return (
      <div className="mb-6 flex items-center gap-6 rounded-sm bg-selected-overlay px-8 py-4 text-body-sm text-fg-muted">
        <CornerUpLeft size={12} className="shrink-0" />
        {t("reply.missing")}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onJump(reply.seq)}
      title={t("reply.jump")}
      className="mb-6 flex w-full min-w-0 flex-col rounded-sm bg-selected-overlay px-8 py-4 text-left cursor-pointer hover:bg-hover-overlay"
    >
      <span className="flex items-center gap-4 text-body-sm-medium text-fg-accent">
        <CornerUpLeft size={12} className="shrink-0" />
        <span className="truncate [unicode-bidi:isolate]">{names.personName(reply.senderId ?? null)}</span>
      </span>
      <span className="truncate text-body-sm text-fg-secondary [unicode-bidi:isolate]">
        {names.excerpt(reply.excerpt ?? "", 140) || t("reply.noText")}
      </span>
    </button>
  );
}

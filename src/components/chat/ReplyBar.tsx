import { CornerUpLeft, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ChatMessage } from "../../lib/ipc";
import { useChatNames, useMessageSummary } from "./useChatText";

/**
 * --- slice: chat ---
 *
 * **Replying to Kai** above the composer, with the first words of the message
 * and a button to drop the quote. Escape in the text field drops it too.
 */
export function ReplyBar({ message, onClear }: { message: ChatMessage; onClear: () => void }) {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const summary = useMessageSummary();
  return (
    <div className="flex items-center gap-8 border-l-2 border-line-accent bg-selected-overlay px-10 py-6">
      <CornerUpLeft size={14} className="shrink-0 text-fg-accent" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body-sm-medium text-fg-accent [unicode-bidi:isolate]">
          {t("composer.replyingTo", { name: names.personName(message.senderId) })}
        </span>
        <span className="truncate text-body-sm text-fg-secondary [unicode-bidi:isolate]">{summary(message)}</span>
      </span>
      <button
        type="button"
        aria-label={t("composer.cancelReply")}
        title={t("composer.cancelReply")}
        onClick={onClear}
        className="flex size-24 shrink-0 items-center justify-center rounded-sm text-fg-muted cursor-pointer hover:bg-hover-overlay hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}

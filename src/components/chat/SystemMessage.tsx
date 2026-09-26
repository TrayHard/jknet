import type { ChatMessage } from "../../lib/ipc";
import { useChatTimes, useSystemText } from "./useChatText";

/**
 * --- slice: chat ---
 *
 * A system line of the thread: somebody joined, left, was added or removed,
 * the group was renamed or changed owner, the history setting changed. The
 * ids it names may belong to an account that is gone: **Deleted account**.
 */
export function SystemMessage({ message, highlighted }: { message: ChatMessage; highlighted?: boolean }) {
  const text = useSystemText()(message);
  const times = useChatTimes();
  return (
    <p
      data-seq={message.seq}
      className={
        "px-16 pt-8 pb-2 text-center text-body-sm text-fg-secondary [unicode-bidi:isolate] " +
        (highlighted ? "bg-accent-glow" : "")
      }
    >
      {text}
      <span className="pl-6 text-mono-xs text-fg-muted" title={times.full(message.createdAt)}>
        {times.time(message.createdAt)}
      </span>
    </p>
  );
}

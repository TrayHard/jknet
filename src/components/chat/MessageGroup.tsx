import { cn } from "../../lib/format";
import type { ChatMessage } from "../../lib/ipc";
import { Avatar } from "../ui";
import { MessageItem } from "./MessageItem";
import { useThread } from "./ThreadContext";
import { useChatNames } from "./useChatText";

interface MessageGroupProps {
  senderId: string | null;
  mine: boolean;
  messages: ChatMessage[];
}

/**
 * --- slice: chat ---
 *
 * Messages of one sender within five minutes: one face and one name above
 * them, in groups and server chats; a direct chat needs neither.
 *
 * A message of a deleted account (`senderId: null`) carries **Deleted
 * account** and the neutral circle. The author of an old message who left a
 * group and is not a friend is **Former member**: the service sends ids,
 * and nobody here remembers the name.
 */
export function MessageGroup({ senderId, mine, messages }: MessageGroupProps) {
  const { conversation } = useThread();
  const names = useChatNames();
  const sender = names.person(senderId);
  const showWho = !mine && conversation.kind !== "direct";

  return (
    <div className={cn("flex gap-8 px-16 pt-10", mine && "flex-row-reverse")}>
      {showWho ? (
        <Avatar
          name={senderId === null ? null : (sender?.displayName ?? names.personName(senderId))}
          src={sender?.avatarUrl}
          size="sm"
          className="mt-20"
        />
      ) : null}
      <div className={cn("flex min-w-0 flex-1 flex-col gap-2", mine && "items-end")}>
        {showWho ? (
          <span
            className={cn(
              "px-2 text-body-sm-medium [unicode-bidi:isolate] truncate max-w-full",
              senderId === null ? "text-fg-muted" : "text-fg-secondary",
            )}
          >
            {names.personName(senderId)}
          </span>
        ) : null}
        {messages.map((message) => (
          <MessageItem key={message.seq} message={message} mine={mine} />
        ))}
      </div>
    </div>
  );
}

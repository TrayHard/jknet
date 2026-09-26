import { Server } from "lucide-react";

import { peerOf } from "../../lib/chat/conversation";
import { cn } from "../../lib/format";
import type { Conversation } from "../../lib/ipc";
import { useFriendPresence } from "../../lib/queries";
import { Avatar } from "../ui";

interface ConversationAvatarProps {
  conversation: Conversation;
  meId: string | null;
  /** `md` in the list, `sm` in a compact header. */
  size?: "sm" | "md";
}

/**
 * --- slice: chat ---
 *
 * The picture of a conversation: the friend with their presence dot, two
 * members of a group stacked, or the server of a server chat. A direct chat
 * with a deleted account shows the neutral circle, like a guest.
 */
export function ConversationAvatar({ conversation, meId, size = "md" }: ConversationAvatarProps) {
  const peer = peerOf(conversation, meId);
  const presence = useFriendPresence(peer?.id ?? null);
  const box = size === "md" ? "size-32" : "size-24";

  if (conversation.kind === "direct") {
    return (
      <Avatar
        name={peer?.displayName ?? null}
        src={peer?.avatarUrl}
        size={size}
        status={presence?.status}
      />
    );
  }

  if (conversation.kind === "server") {
    return (
      <span
        aria-hidden="true"
        className={cn(box, "inline-flex shrink-0 items-center justify-center rounded-full bg-accent-subtle text-fg-accent")}
      >
        <Server size={size === "md" ? 16 : 12} />
      </span>
    );
  }

  const others = conversation.members.filter((member) => member.user.id !== meId).slice(0, 2);
  if (others.length < 2) {
    return <Avatar name={others[0]?.user.displayName ?? null} src={others[0]?.user.avatarUrl} size={size} />;
  }
  // Two faces, the second one tucked behind the first: the group reads as
  // people, not as one person with a badge. Each face sits in a box of its
  // own, because the avatar's own box is positioned already.
  // Smaller than the circle of one person, so the two overlap by a corner
  // only and both initials stay readable.
  const face = size === "sm" ? "scale-[0.6]" : "scale-75";
  return (
    <span aria-hidden="true" className={cn(box, "relative inline-flex shrink-0")}>
      <span className={cn("absolute top-0 right-0 flex origin-top-right", face)}>
        <Avatar name={others[1].user.displayName} src={others[1].user.avatarUrl} size="sm" />
      </span>
      <span className={cn("absolute bottom-0 left-0 flex rounded-full ring-2 ring-app origin-bottom-left", face)}>
        <Avatar name={others[0].user.displayName} src={others[0].user.avatarUrl} size="sm" />
      </span>
    </span>
  );
}

import { Gamepad2 } from "lucide-react";

import { cn } from "../../lib/format";
import type { Friend } from "../../lib/ipc";
import { Avatar, Button } from "../ui";
import { canJoin, statusLine } from "./presence";

interface FriendRowProps {
  friend: Friend;
  selected: boolean;
  onSelect: () => void;
  /** Shows the Join button on hover. Left out while a game already runs. */
  onJoin?: () => void;
  joining?: boolean;
}

/**
 * One line of the friends list: the FriendRow of the design, in its three
 * states.
 *
 * The Join button appears on hover and on focus rather than always, so a list
 * of twenty friends does not turn into a wall of buttons. It stays reachable
 * from the keyboard, and the same action sits permanently in the panel on the
 * right for anybody who does not find it.
 */
export function FriendRow({
  friend,
  selected,
  onSelect,
  onJoin,
  joining = false,
}: FriendRowProps) {
  const offline = friend.presence.status === "offline";
  const joinable = onJoin !== undefined && canJoin(friend);

  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex items-center gap-12 h-48 px-12 rounded-md cursor-pointer",
        "transition-colors duration-100",
        selected ? "bg-selected-overlay" : "hover:bg-hover-overlay",
      )}
    >
      <Avatar
        name={friend.user.displayName}
        src={friend.user.avatarUrl}
        status={friend.presence.status}
      />
      <span className="flex-1 min-w-0 flex flex-col">
        <span
          className={cn(
            "text-body-md-medium truncate",
            offline ? "text-fg-secondary" : "text-fg",
          )}
        >
          {friend.user.displayName}
        </span>
        <span className="text-body-sm text-fg-muted truncate">
          {statusLine(friend.presence)}
        </span>
      </span>

      {joinable ? (
        <Button
          size="sm"
          variant="primary"
          icon={<Gamepad2 size={14} />}
          disabled={joining}
          onClick={(event) => {
            event.stopPropagation();
            onJoin();
          }}
          // One branch, not `opacity-0` plus an override: two utilities of the
          // same property in one class list are settled by the order Tailwind
          // emits them in, which is not the order they are written in.
          className={cn(
            "transition-opacity duration-100",
            selected
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          {joining ? "Starting…" : "Join"}
        </Button>
      ) : null}
    </div>
  );
}

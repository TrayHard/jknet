import { Gamepad2, MessageCircle } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { Friend } from "../../lib/ipc";
// --- slice: selection context menu ---
import { hasTextSelection } from "../../lib/selection";
import { Avatar, Button } from "../ui";
// --- slice: play with friends ---
import { canJoin, inviteOnly } from "./presence";
import { useStatusLine } from "./useStatusLine";

interface FriendRowProps {
  friend: Friend;
  selected: boolean;
  onSelect: () => void;
  /** Shows the Join button on hover. Left out while a game already runs. */
  onJoin?: () => void;
  joining?: boolean;
  // --- slice: selection context menu ---
  /**
   * A right click anywhere in the row.
   *
   * The screen owns the menu: it is the one that knows how to join, invite
   * and remove, and one layer serves the whole list.
   */
  onContextMenu?: (event: ReactMouseEvent) => void;
  // --- slice: chat ---
  /** **Message**: the direct chat with this friend, on hover like **Join**. */
  onMessage?: () => void;
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
  onContextMenu,
  onMessage,
}: FriendRowProps) {
  const { t } = useTranslation("friends");
  const { t: tHost } = useTranslation("host");
  const statusLine = useStatusLine();
  const offline = friend.presence.status === "offline";
  // --- slice: play with friends ---
  // A private server the host keeps to invites still shows its **Join**, off,
  // so the row says why the game is out of reach instead of looking idle.
  const locked = onJoin !== undefined && inviteOnly(friend);
  const joinable = onJoin !== undefined && (canJoin(friend) || locked);

  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected}
      // --- slice: selection context menu ---
      // The drag that copied a friend's name ends as a click on the row; it
      // was not a press on the row, so it selects nobody.
      onClick={() => {
        if (hasTextSelection()) return;
        onSelect();
      }}
      // --- slice: selection context menu ---
      onContextMenu={onContextMenu}
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

      {/* --- slice: chat --- beside **Join**, and like it only on hover,
          focus or selection: twenty rows of chat bubbles would be a wall. */}
      {onMessage ? (
        <button
          type="button"
          aria-label={t("row.messageTo", { name: friend.user.displayName })}
          title={t("row.messageTo", { name: friend.user.displayName })}
          onClick={(event) => {
            event.stopPropagation();
            onMessage();
          }}
          className={cn(
            "flex size-28 shrink-0 items-center justify-center rounded-sm cursor-pointer select-none",
            "text-fg-secondary hover:bg-hover-overlay hover:text-fg transition-opacity duration-100",
            selected
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          <MessageCircle size={14} />
        </button>
      ) : null}

      {joinable ? (
        <Button
          size="sm"
          variant="primary"
          icon={<Gamepad2 size={14} />}
          disabled={joining || locked}
          title={locked ? tHost("friends.inviteOnly", { name: friend.user.displayName }) : undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (!locked) onJoin();
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
          {joining ? t("row.joining") : t("row.join")}
        </Button>
      ) : null}
    </div>
  );
}

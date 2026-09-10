import { Gamepad2, Send, UserMinus } from "lucide-react";
import { useEffect, useState } from "react";

import type { Friend, Presence } from "../../lib/ipc";
import { Avatar, Badge, Button } from "../ui";
import { canJoin, myServer, providerHandle, statusLine } from "./presence";

interface FriendPanelProps {
  friend: Friend;
  /** What the launcher reports about the player, for the Invite button. */
  mine: Presence;
  onJoin: () => void;
  onInvite: () => void;
  onRemove: () => void;
  joining: boolean;
  inviting: boolean;
  removing: boolean;
  /** Result of the last invite to this friend, or `null`. */
  inviteNote: string | null;
}

/**
 * The panel on the right of the Friends screen: who the selected friend is and
 * the three things that can be done about them.
 *
 * Removing is two clicks. It is the one irreversible action on the screen and
 * it sits next to a button that starts a game, so a single misplaced click
 * must not end a friendship. The confirmation is inline rather than a dialog:
 * the panel already has the name and the face in view, which is everything a
 * dialog would repeat.
 */
export function FriendPanel({
  friend,
  mine,
  onJoin,
  onInvite,
  onRemove,
  joining,
  inviting,
  removing,
  inviteNote,
}: FriendPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const server = myServer(mine);
  const joinable = canJoin(friend);

  // Selecting somebody else drops a confirmation the player left open, so the
  // red button is never armed for a friend they are no longer looking at.
  useEffect(() => setConfirming(false), [friend.user.id]);

  return (
    <aside className="flex flex-col gap-16 w-320 shrink-0 rounded-lg border border-line bg-surface p-16 overflow-y-auto">
      <div className="flex items-center gap-12">
        <Avatar
          name={friend.user.displayName}
          src={friend.user.avatarUrl}
          size="lg"
          status={friend.presence.status}
        />
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <span className="text-heading-sm text-fg truncate">
            {friend.user.displayName}
          </span>
          <span className="text-mono-xs text-fg-muted truncate">
            {providerHandle(friend)}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-8">
        <span className="text-label-xs text-fg-muted">Status</span>
        <div className="flex flex-wrap items-center gap-8">
          <Badge
            tone={
              friend.presence.status === "in_game"
                ? "accent"
                : friend.presence.status === "online"
                  ? "success"
                  : "neutral"
            }
          >
            {friend.presence.status === "in_game"
              ? "In game"
              : friend.presence.status === "online"
                ? "Online"
                : "Offline"}
          </Badge>
          {friend.presence.clientName ? (
            <Badge>{friend.presence.clientName}</Badge>
          ) : null}
        </div>
        <p className="text-body-sm text-fg-secondary break-words">
          {statusLine(friend.presence)}
        </p>
      </div>

      <div className="flex flex-col gap-8">
        <Button
          variant="primary"
          block
          icon={<Gamepad2 size={16} />}
          disabled={!joinable || joining}
          onClick={onJoin}
        >
          {joining ? "Starting the game…" : "Join game"}
        </Button>
        <Button
          block
          icon={<Send size={16} />}
          disabled={server === null || inviting}
          onClick={onInvite}
          title={
            server === null
              ? "Join a server first, then invite your friends to it"
              : `Invite to ${server.name ?? server.address}`
          }
        >
          {inviting ? "Sending…" : "Invite to my game"}
        </Button>
        {inviteNote ? (
          <p className="text-body-sm text-fg-muted">{inviteNote}</p>
        ) : null}
        {server === null && friend.presence.status !== "offline" ? (
          <p className="text-body-sm text-fg-muted">
            Join a server from the Servers screen to invite anyone to it.
          </p>
        ) : null}
      </div>

      <div className="mt-auto pt-16 border-t border-line-subtle flex flex-col gap-8">
        {confirming ? (
          <>
            <p className="text-body-sm text-fg-secondary">
              Remove {friend.user.displayName}? You will both have to send a new
              request to be friends again.
            </p>
            <div className="flex items-center gap-8">
              <Button
                variant="danger"
                size="sm"
                disabled={removing}
                onClick={onRemove}
              >
                {removing ? "Removing…" : "Remove"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={<UserMinus size={14} />}
            onClick={() => setConfirming(true)}
          >
            Remove friend
          </Button>
        )}
      </div>
    </aside>
  );
}

import { Gamepad2, MessageCircle, Send, Swords, UserMinus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// --- slice: chat layout ---
import { cn } from "../../lib/format";
import type { Friend, HostSession, Presence } from "../../lib/ipc";
import { FoldedPanelBack } from "../FoldedPanel";
// --- slice: play with friends ---
import { isHostLive } from "../host/hostModel";
import { Avatar, Badge, Button } from "../ui";
import { canJoin, inviteOnly, myServer, providerHandle } from "./presence";
import { useStatusLine } from "./useStatusLine";

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
  // --- slice: play with friends ---
  /** The private server of this launcher, or `null`. */
  hostSession: HostSession | null;
  /** **Invite to my game** while the private server runs: `host_invite`. */
  onHostInvite: () => void;
  /** **Host and invite**: the screen of the private server, this friend marked. */
  onHostAndInvite: () => void;
  // --- slice: chat ---
  /** **Message**: the direct chat with this friend. Absent: no button. */
  onMessage?: () => void;
  messaging?: boolean;
  // --- slice: chat layout ---
  /** Extra classes: how the screen folds the panel on a narrow page. */
  className?: string;
  /** **Back** of the folded panel: clears the selection. */
  onBack?: () => void;
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
  hostSession,
  onHostInvite,
  onHostAndInvite,
  onMessage,
  messaging = false,
  className,
  onBack,
}: FriendPanelProps) {
  const { t } = useTranslation("friends");
  const { t: tCommon } = useTranslation("common");
  const { t: tHost } = useTranslation("host");
  const statusLine = useStatusLine();
  const [confirming, setConfirming] = useState(false);
  const server = myServer(mine);
  const joinable = canJoin(friend);
  // --- slice: play with friends ---
  const locked = inviteOnly(friend);
  const hosting = isHostLive(hostSession);
  const hostReady = hosting && hostSession.status === "running";
  const name = friend.user.displayName;

  // Selecting somebody else drops a confirmation the player left open, so the
  // red button is never armed for a friend they are no longer looking at.
  useEffect(() => setConfirming(false), [friend.user.id]);

  return (
    <aside
      className={cn(
        "flex flex-col gap-16 w-320 shrink-0 rounded-lg border border-line bg-surface p-16 overflow-y-auto",
        className,
      )}
    >
      {/* --- slice: chat layout --- */}
      {onBack ? <FoldedPanelBack onBack={onBack} /> : null}
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
        <span className="text-label-xs text-fg-muted">{t("panel.status")}</span>
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
            {t(`groups.${friend.presence.status}`)}
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
          {joining ? t("panel.joining") : t("panel.join")}
        </Button>
        {/* --- slice: chat --- */}
        {onMessage ? (
          <Button block icon={<MessageCircle size={16} />} disabled={messaging} onClick={onMessage}>
            {t("panel.message")}
          </Button>
        ) : null}
        {/* --- slice: play with friends --- the host kept this server to
            invites: the button is off, and the line says whose door it is. */}
        {locked ? (
          <p className="text-body-sm text-fg-muted">{tHost("friends.inviteOnly", { name })}</p>
        ) : null}
        {hosting ? (
          // --- slice: play with friends --- my own private server comes
          // first: the invite carries its addresses and its password.
          <Button
            block
            icon={<Send size={16} />}
            disabled={!hostReady || inviting}
            onClick={onHostInvite}
            title={
              hostReady
                ? tHost("friends.inviteToServer", { name, server: hostSession.settings.serverName })
                : tHost("friends.notReady")
            }
          >
            {inviting ? tCommon("states.sending") : t("panel.invite")}
          </Button>
        ) : server !== null ? (
          <Button
            block
            icon={<Send size={16} />}
            disabled={inviting}
            onClick={onInvite}
            title={t("panel.inviteHint", { server: server.name ?? server.address })}
          >
            {inviting ? tCommon("states.sending") : t("panel.invite")}
          </Button>
        ) : (
          // --- slice: play with friends --- not in a game and no server:
          // the way to play together is to host one.
          <Button
            block
            icon={<Swords size={16} />}
            onClick={onHostAndInvite}
            title={tHost("friends.hostAndInviteHint", { name })}
          >
            {tHost("friends.hostAndInvite")}
          </Button>
        )}
        {inviteNote ? (
          <p className="text-body-sm text-fg-muted">{inviteNote}</p>
        ) : null}
      </div>

      <div className="mt-auto pt-16 border-t border-line-subtle flex flex-col gap-8">
        {confirming ? (
          <>
            <p className="text-body-sm text-fg-secondary">
              {t("panel.removeConfirm", { name: friend.user.displayName })}
            </p>
            <div className="flex items-center gap-8">
              <Button
                variant="danger"
                size="sm"
                disabled={removing}
                onClick={onRemove}
              >
                {removing ? tCommon("states.removing") : tCommon("actions.remove")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
              >
                {tCommon("actions.cancel")}
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
            {t("panel.remove")}
          </Button>
        )}
      </div>
    </aside>
  );
}

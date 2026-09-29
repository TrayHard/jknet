import { MessageCircle, UserMinus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useMessageFriend } from "../../../../src/components/chat/useOpenChat.ts";
import { providerHandle, webDevice } from "../../../../src/components/friends/presence.ts";
import { useStatusLine } from "../../../../src/components/friends/useStatusLine.ts";
import { Avatar, Badge, Button, Dialog } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useFormat } from "../../../../src/i18n/useFormat.ts";
import { useFriendsState, useRemoveFriend } from "../../../../src/lib/queries.ts";
import { HostedServer } from "../JoinableServers.tsx";

/** The name of the friend a route shows, for the top bar and the header. */
export function FriendTitle({ userId }: { userId: string }) {
  const { t } = useTranslation("web");
  const friend = useFriendsState().data?.friends.find((entry) => entry.user.id === userId);
  return (
    <span className="min-w-0 truncate pl-6 font-display text-[20px] leading-[28px] font-semibold text-fg">
      {friend?.user.displayName ?? t("nav.sections.friends")}
    </span>
  );
}

/**
 * One friend: who they are, where they are, **Message** — the direct chat,
 * made on first use — and **Remove friend** behind a confirmation. A friend
 * who hosts a private server shows it, with **Join chat** while its chat is
 * open to the player. Joining their game stays in the launcher.
 */
export function FriendDetailsScreen({ userId }: { userId: string }) {
  const { t } = useTranslation("friends");
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const format = useFormat();
  const statusLine = useStatusLine();
  const navigate = useNavigate();
  const friends = useFriendsState();
  const remove = useRemoveFriend();
  const message = useMessageFriend();
  const [confirming, setConfirming] = useState(false);

  const view = friends.data;
  if (view === undefined) {
    return <p className="px-24 py-24 text-body-sm text-fg-muted">{tCommon("states.loading")}</p>;
  }
  const friend = view.friends.find((entry) => entry.user.id === userId);
  if (friend === undefined) {
    return <p className="px-24 py-24 text-body-md text-fg-secondary">{tWeb("friendsScreen.gone")}</p>;
  }

  const status = friend.presence.status;
  const name = friend.user.displayName;

  return (
    <div className="flex flex-col gap-20 px-16 py-24 sm:px-40 sm:py-32" data-testid="friend-details">
      <div className="flex items-center gap-16">
        <Avatar name={name} src={friend.user.avatarUrl} size="lg" status={status} device={webDevice(friend.presence)} />
        <div className="flex min-w-0 flex-col gap-4">
          <span className="truncate text-display-md text-fg">{name}</span>
          <span className="truncate text-mono-xs text-fg-muted">{providerHandle(friend)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-8">
        <span className="text-label-xs text-fg-muted">{t("panel.status")}</span>
        <div className="flex flex-wrap items-center gap-8">
          <Badge tone={status === "in_game" ? "accent" : status === "online" ? "success" : "neutral"}>
            {t(`groups.${status}`)}
          </Badge>
          {friend.presence.clientName ? <Badge>{friend.presence.clientName}</Badge> : null}
        </div>
        <p data-testid="friend-status" className="text-body-md text-fg-secondary break-words">
          {statusLine(friend.presence)}
        </p>
        <p className="text-body-sm text-fg-muted">{tWeb("friendsScreen.since", { date: format.date(friend.friendsSince) })}</p>
      </div>

      <HostedServer friend={friend} />

      <div>
        <Button
          variant="primary"
          icon={<MessageCircle size={16} />}
          disabled={message.pending}
          onClick={() => message.open(friend.user.id)}
        >
          {t("panel.message")}
        </Button>
      </div>

      {remove.error != null ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {errorText(remove.error)}
        </p>
      ) : null}

      <div className="border-t border-line-subtle pt-16">
        <Button variant="ghost" icon={<UserMinus size={16} />} onClick={() => setConfirming(true)}>
          {t("panel.remove")}
        </Button>
      </div>

      {confirming ? (
        <Dialog
          variant="danger"
          title={t("panel.remove")}
          body={t("panel.removeConfirm", { name })}
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  setConfirming(false);
                  remove.mutate(friend.user.id, {
                    onSuccess: () => void navigate("/friends", { replace: true }),
                  });
                }}
              >
                {remove.isPending ? tCommon("states.removing") : tCommon("actions.remove")}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

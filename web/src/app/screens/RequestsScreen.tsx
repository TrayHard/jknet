import { AlertTriangle, Server, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { RequestList } from "../../../../src/components/friends/RequestList.tsx";
import { Avatar, Button } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import type { Invite, JoinableServer } from "../../../../src/lib/ipc.ts";
import {
  useAcceptFriendRequest,
  useDeclineFriendRequest,
  useDismissInvite,
  useFriendsState,
  useJoinableServers,
} from "../../../../src/lib/queries.ts";
import { openInvites } from "../../core/friends.ts";
import { closeNotificationsWhere } from "../../core/index.ts";
import { JoinChatButton, JoinRefusal, useJoinChat } from "../JoinableServers.tsx";

/**
 * Friend requests both ways and the server invites addressed to me.
 *
 * An invite can be dismissed here, and an invite to a private server whose
 * chat is open to me has **Join chat**; joining the game stays in the
 * launcher.
 */
export function RequestsScreen() {
  const { t } = useTranslation("friends");
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const friends = useFriendsState();
  const accept = useAcceptFriendRequest();
  const decline = useDeclineFriendRequest();
  const dismiss = useDismissInvite();
  const joinable = useJoinableServers().data ?? [];
  const chat = useJoinChat();

  // What the notifications of requests and invites said is on screen now.
  useEffect(() => {
    void closeNotificationsWhere(
      (tag) => tag === "friends:requests" || tag === "friends:accepted" || tag === "invites" || tag.startsWith("invite:"),
    );
  }, []);

  const view = friends.data;
  if (view === undefined) {
    return <p className="px-24 py-24 text-body-sm text-fg-muted">{tCommon("states.loading")}</p>;
  }

  const invites = openInvites(view.invites, Date.now());
  const error = accept.error ?? decline.error ?? dismiss.error;
  const empty = view.incoming.length === 0 && view.outgoing.length === 0 && invites.length === 0;

  return (
    <div className="flex flex-col gap-8 px-8 pb-24 sm:px-16">
      {error != null ? (
        <p role="alert" className="mx-8 mt-12 flex items-start gap-8 rounded-md border border-line-danger bg-surface px-12 py-8 text-body-sm text-fg-danger">
          <AlertTriangle size={16} className="mt-2 shrink-0" />
          <span>{errorText(error)}</span>
        </p>
      ) : null}

      <JoinRefusal error={chat.error} className="mx-8 mt-12" />

      {empty ? <p className="px-12 py-24 text-body-md text-fg-secondary">{tWeb("friendsScreen.none")}</p> : null}

      <RequestList
        title={t("requests.incoming")}
        requests={view.incoming}
        side="from"
        onAccept={(id) => accept.mutate(id)}
        onDismiss={(id) => decline.mutate(id)}
        dismissLabel={t("requests.decline")}
        busyId={accept.isPending ? accept.variables : decline.isPending ? decline.variables : undefined}
      />
      <RequestList
        title={t("requests.outgoing")}
        requests={view.outgoing}
        side="to"
        onDismiss={(id) => decline.mutate(id)}
        dismissLabel={t("requests.cancel")}
        busyId={decline.isPending ? decline.variables : undefined}
      />

      {invites.length > 0 ? (
        <section data-testid="server-invites" className="flex flex-col gap-4 pt-16">
          <span className="px-12 pb-4 text-label-xs text-fg-muted">
            {t("requests.heading", { title: tWeb("friendsScreen.invites"), count: invites.length })}
          </span>
          {invites.map((invite) => {
            const server = joinableOf(invite, joinable);
            return (
              <div
                key={invite.id}
                data-testid="server-invite"
                className="flex flex-wrap items-center gap-12 rounded-md px-12 py-8 hover:bg-hover-overlay"
              >
                <Avatar name={invite.from.displayName} src={invite.from.avatarUrl} />
                <span className="flex min-w-0 flex-1 basis-[160px] flex-col">
                  <span className="text-body-md-medium text-fg break-words">
                    {tWeb("friendsScreen.inviteFrom", {
                      name: invite.from.displayName,
                      server: invite.serverName ?? invite.serverAddress,
                    })}
                  </span>
                  <span className="flex items-center gap-4 text-body-sm text-fg-muted">
                    <Server size={12} />
                    {tWeb("friendsScreen.inviteNote")}
                  </span>
                </span>
                <span className="ml-auto flex items-center gap-8">
                  {server !== null ? <JoinChatButton server={server} chat={chat} /> : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<X size={14} />}
                    disabled={dismiss.isPending && dismiss.variables === invite.id}
                    onClick={() => dismiss.mutate(invite.id)}
                  >
                    {tCommon("actions.dismiss")}
                  </Button>
                </span>
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}

/** The joinable chat an invite to a private server leads to, if its chat is open to me. */
function joinableOf(invite: Invite, joinable: JoinableServer[]): JoinableServer | null {
  const sessionId = invite.hosting?.sessionId;
  if (!sessionId) return null;
  return joinable.find((server) => server.hostUserId === invite.from.id && server.sessionId === sessionId) ?? null;
}

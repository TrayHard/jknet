import {
  AlertTriangle,
  Gamepad2,
  Search,
  Send,
  UserMinus,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { FriendPanel } from "../components/friends/FriendPanel";
import { FriendRow } from "../components/friends/FriendRow";
// --- slice: game switch ---
import { useMissingClientToast } from "../components/MissingClientToast";
import {
  // --- slice: selection context menu ---
  canJoin,
  GROUPS,
  groupFriends,
  matchesSearch,
  myServer,
} from "../components/friends/presence";
import { RequestList } from "../components/friends/RequestList";
import { Page, PageHeader } from "../components/PageHeader";
// --- slice: selection context menu ---
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  useContextMenu,
  type MenuItem,
} from "../components/ui";
// --- slice: i18n ---
import { useErrorText } from "../i18n/errors";
import type { Friend, Presence } from "../lib/ipc";
// --- slice: game switch ---
import { findDefaultClient, gameFromServerAddress } from "../lib/game";
import {
  useAcceptFriendRequest,
  useClients,
  useDeclineFriendRequest,
  useFriendsState,
  useGames,
  useOnlineConfigured,
  useJoinFriend,
  useRemoveFriend,
  useRunningGame,
  useSendFriendRequest,
  useSendInvite,
  useSettings,
} from "../lib/queries";

/** What the panel reads before the first answer arrives: no game, no server. */
const NO_PRESENCE: Presence = {
  status: "offline",
  serverAddress: null,
  serverName: null,
  clientName: null,
  since: "",
};

/**
 * Friends, requests and the panel of the selected friend.
 *
 * Everything on this screen reads one query — `get_friends_state` — and every
 * mutation answers with the same document, so the four lists cannot disagree
 * with each other while a write settles.
 */
export function FriendsPage() {
  const { t } = useTranslation("friends");
  const { t: tAccount } = useTranslation("account");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const friends = useFriendsState();
  const running = useRunningGame();
  // --- slice: online gate ---
  const onlineConfigured = useOnlineConfigured();

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const sendRequest = useSendFriendRequest();
  const accept = useAcceptFriendRequest();
  const decline = useDeclineFriendRequest();
  const remove = useRemoveFriend();
  const invite = useSendInvite();
  const join = useJoinFriend();

  // --- slice: game switch ---
  // Presence names a server, not a game, so the port of the address answers
  // for it — the same rule as `Game::from_server_port` in the core, which is
  // what `join_friend` uses to pick the client. Checking it here as well is
  // what turns «no default Jedi Outcast client» from an error line under the
  // list into a toast that offers to make one.
  const clients = useClients();
  const settings = useSettings();
  const games = useGames().data;
  const missingClientToast = useMissingClientToast();

  const joinFriend = (friend: Friend) => {
    const game = gameFromServerAddress(friend.presence.serverAddress, games);
    if (findDefaultClient(clients.data, settings.data, game) === undefined) {
      missingClientToast(game);
      return;
    }
    setNote(null);
    join.mutate(friend.user.id);
  };

  const view = friends.data;
  const groups = useMemo(
    () => groupFriends((view?.friends ?? []).filter((f) => matchesSearch(f, search))),
    [view?.friends, search],
  );
  const selected =
    view?.friends.find((friend) => friend.user.id === selectedId) ?? undefined;
  const online =
    view?.friends.filter((friend) => friend.presence.status !== "offline").length ?? 0;
  const visible = GROUPS.reduce((total, group) => total + groups[group].length, 0);

  // A second game cannot start while one runs, so the join buttons say so
  // instead of letting the core refuse the click.
  const canLaunch = running.data == null;

  // --- slice: selection context menu ---
  /** The friend the confirmation is about, or `null` while it is closed. */
  const [removing, setRemoving] = useState<Friend | null>(null);
  // --- slice: selection context menu ---
  // A right click on a row, with the three things the screen already does to
  // a friend: the **Join** of the row, and the **Invite to my game** and
  // **Remove friend** of the panel. Removing asks first, exactly as the panel
  // does — the two rows of the list and the panel are one screen.
  const onMyServer = myServer(view?.presence ?? NO_PRESENCE);
  const rowMenu = useContextMenu<Friend>({
    ariaLabel: t("row.actions"),
    items: (friend): MenuItem[] => [
      {
        id: "join",
        label: t("row.join"),
        icon: <Gamepad2 size={14} />,
        disabled: !canLaunch || !canJoin(friend) || join.isPending,
      },
      {
        id: "invite",
        label: t("panel.invite"),
        icon: <Send size={14} />,
        disabled: onMyServer === null || invite.isPending,
      },
      {
        id: "remove",
        label: t("panel.remove"),
        icon: <UserMinus size={14} />,
        danger: true,
        disabled: remove.isPending,
      },
    ],
    onSelect: (id, friend) => {
      if (id === "join") {
        joinFriend(friend);
        return;
      }
      if (id === "invite") {
        if (onMyServer === null) return;
        setNote(null);
        invite.mutate({
          toUserId: friend.user.id,
          serverAddress: onMyServer.address,
          serverName: onMyServer.name,
        });
        return;
      }
      setRemoving(friend);
    },
  });

  const addFriend = () => {
    const query = search.trim();
    if (query === "") return;
    setNote(null);
    sendRequest.mutate(query, {
      onSuccess: (result) => {
        setSearch("");
        setNote(
          result.outcome === "accepted"
            ? t("notices.nowFriends", { name: result.displayName })
            : t("notices.requestSent", { name: result.displayName }),
        );
      },
    });
  };

  // --- slice: online gate ---
  // Before the sign-in prompt: with no service there is nothing to sign in to, and
  // a **Sign in** button here would send the player to a card that says the
  // same thing. No counters either — there is nobody to count.
  if (onlineConfigured === false) {
    return (
      <Page>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState
          icon={<Users size={24} />}
          title={t("empty.offTitle")}
          text={tAccount("notConfigured")}
        />
      </Page>
    );
  }

  if (view !== undefined && !view.signedIn) {
    return (
      <Page>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState
          icon={<Users size={24} />}
          title={t("empty.signInTitle")}
          text={t("empty.signInText")}
          action={
            <Button
              variant="primary"
              // Straight to the Account card rather than the top of the
              // Settings screen: the card is what signs the player in, and it
              // sits under three others.
              onClick={() => void navigate("/settings?section=account")}
            >
              {t("empty.signIn")}
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <div className="flex flex-col h-full p-24">
      <PageHeader
        title={t("title")}
        subtitle={
          view === undefined
            ? t("loading")
            : t("subtitleCounts", { friends: view.friends.length, online })
        }
        actions={
          <>
            <Input
              icon={<Search size={16} />}
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addFriend();
              }}
              className="w-260"
            />
            <Button
              variant="primary"
              icon={<UserPlus size={16} />}
              disabled={search.trim() === "" || sendRequest.isPending}
              onClick={addFriend}
            >
              {sendRequest.isPending ? tCommon("states.sending") : t("addFriend")}
            </Button>
          </>
        }
      />

      {view?.signedIn ? (
        <div className="flex items-center gap-8 pb-8">
          <Badge tone={view.live ? "success" : "neutral"}>
            {view.live ? <Wifi size={12} /> : <WifiOff size={12} />}
            {view.live ? t("live.on") : t("live.off")}
          </Badge>
          <span className="text-body-sm text-fg-muted">
            {view.live ? t("live.onText") : t("live.offText")}
          </span>
        </div>
      ) : null}

      <Notice text={note} onClear={() => setNote(null)} />
      <Notice
        text={errorOf(errorText, friends.error ?? sendRequest.error)}
        tone="error"
      />
      <Notice
        text={errorOf(errorText, join.error ?? remove.error ?? accept.error)}
        tone="error"
      />

      <div className="flex flex-1 min-h-0 gap-16 pt-8">
        <div className="flex flex-col flex-1 min-w-0 overflow-y-auto">
          {view === undefined ? (
            <p className="text-body-sm text-fg-muted px-12 py-24">
              {tCommon("states.loading")}
            </p>
          ) : view.friends.length === 0 ? (
            <EmptyState
              className="mt-24"
              icon={<Users size={24} />}
              title={t("empty.noneTitle")}
              text={t("empty.noneText")}
            />
          ) : visible === 0 ? (
            <EmptyState
              className="mt-24"
              icon={<Search size={24} />}
              title={t("empty.noMatchTitle", { query: search.trim() })}
              text={t("empty.noMatchText")}
            />
          ) : (
            GROUPS.map((group) =>
              groups[group].length === 0 ? null : (
                <section key={group} className="flex flex-col gap-4 pb-12">
                  <span className="text-label-xs text-fg-muted px-12 pb-4">
                    {t("requests.heading", {
                      title: t(`groups.${group}`),
                      count: groups[group].length,
                    })}
                  </span>
                  {groups[group].map((friend) => (
                    <FriendRow
                      key={friend.user.id}
                      friend={friend}
                      selected={friend.user.id === selectedId}
                      onSelect={() => setSelectedId(friend.user.id)}
                      onJoin={canLaunch ? () => joinFriend(friend) : undefined}
                      joining={join.isPending && join.variables === friend.user.id}
                      // --- slice: selection context menu ---
                      onContextMenu={(event) => rowMenu.open(event, friend)}
                    />
                  ))}
                </section>
              ),
            )
          )}

          <RequestList
            title={t("requests.incoming")}
            requests={view?.incoming ?? []}
            side="from"
            onAccept={(id) => accept.mutate(id)}
            onDismiss={(id) => decline.mutate(id)}
            dismissLabel={t("requests.decline")}
            busyId={accept.isPending ? accept.variables : decline.variables}
          />
          <RequestList
            title={t("requests.outgoing")}
            requests={view?.outgoing ?? []}
            side="to"
            onDismiss={(id) => decline.mutate(id)}
            dismissLabel={t("requests.cancel")}
            busyId={decline.isPending ? decline.variables : undefined}
          />
        </div>

        {selected === undefined ? (
          <aside className="flex flex-col items-center justify-center gap-12 w-320 shrink-0 rounded-lg border border-dashed border-line text-center px-24">
            <span className="flex items-center justify-center size-48 rounded-full bg-surface text-fg-muted">
              <Users size={24} />
            </span>
            <p className="text-body-sm text-fg-muted">{t("empty.pickFriend")}</p>
          </aside>
        ) : (
          <FriendPanel
            friend={selected}
            mine={view?.presence ?? NO_PRESENCE}
            joining={join.isPending}
            inviting={invite.isPending}
            removing={remove.isPending}
            inviteNote={
              invite.error
                ? errorText(invite.error)
                : invite.isSuccess && invite.variables?.toUserId === selected.user.id
                  ? t("notices.inviteSent", { name: selected.user.displayName })
                  : null
            }
            onJoin={() => joinFriend(selected)}
            onInvite={() => {
              const server = myServer(view?.presence ?? NO_PRESENCE);
              if (server === null) return;
              invite.mutate({
                toUserId: selected.user.id,
                serverAddress: server.address,
                serverName: server.name,
              });
            }}
            onRemove={() =>
              remove.mutate(selected.user.id, {
                onSuccess: () => setSelectedId(null),
              })
            }
          />
        )}
      </div>

      {/* --- slice: selection context menu --- the list of the right click,
          and the question it asks before taking a friend off the list. */}
      {rowMenu.menu}
      {removing === null ? null : (
        <Dialog
          variant="danger"
          title={t("panel.remove")}
          body={t("panel.removeConfirm", { name: removing.user.displayName })}
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  const id = removing.user.id;
                  setRemoving(null);
                  remove.mutate(id, {
                    onSuccess: () => {
                      if (selectedId === id) setSelectedId(null);
                    },
                  });
                }}
              >
                {tCommon("actions.remove")}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}

/** One line above the list: a confirmation, or a refusal from the core. */
function Notice({
  text,
  tone = "info",
  onClear,
}: {
  text: string | null;
  tone?: "info" | "error";
  onClear?: () => void;
}) {
  const { t } = useTranslation("common");
  if (text === null) return null;
  return (
    <div
      className={
        tone === "error"
          ? "flex items-start gap-8 rounded-md border border-line-danger bg-surface px-12 py-8 mb-8 text-body-sm text-fg-danger"
          : "flex items-start gap-8 rounded-md border border-line bg-surface px-12 py-8 mb-8 text-body-sm text-fg-secondary"
      }
    >
      {tone === "error" ? <AlertTriangle size={16} className="shrink-0 mt-2" /> : null}
      <span className="flex-1">{text}</span>
      {onClear ? (
        <button
          type="button"
          className="text-fg-muted hover:text-fg cursor-pointer"
          onClick={onClear}
        >
          {t("actions.dismiss")}
        </button>
      ) : null}
    </div>
  );
}

/** The message of the first failure among several mutations, or `null`. */
function errorOf(
  errorText: (error: unknown) => string,
  error: unknown,
): string | null {
  return error == null ? null : errorText(error);
}

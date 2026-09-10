import { AlertTriangle, Search, UserPlus, Users, Wifi, WifiOff } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { FriendPanel } from "../components/friends/FriendPanel";
import { FriendRow } from "../components/friends/FriendRow";
import {
  GROUPS,
  GROUP_TITLES,
  groupFriends,
  matchesSearch,
  myServer,
} from "../components/friends/presence";
import { RequestList } from "../components/friends/RequestList";
import { Page, PageHeader } from "../components/PageHeader";
import { Badge, Button, EmptyState, Input } from "../components/ui";
import {
  errorMessage,
  HUB_NOT_CONFIGURED_TEXT,
  type Presence,
} from "../lib/ipc";
import {
  useAcceptFriendRequest,
  useDeclineFriendRequest,
  useFriendsState,
  useHubConfigured,
  useJoinFriend,
  useRemoveFriend,
  useRunningGame,
  useSendFriendRequest,
  useSendInvite,
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
  const navigate = useNavigate();
  const friends = useFriendsState();
  const running = useRunningGame();
  // --- slice: hub gate ---
  const hubConfigured = useHubConfigured();

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const sendRequest = useSendFriendRequest();
  const accept = useAcceptFriendRequest();
  const decline = useDeclineFriendRequest();
  const remove = useRemoveFriend();
  const invite = useSendInvite();
  const join = useJoinFriend();

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

  const addFriend = () => {
    const query = search.trim();
    if (query === "") return;
    setNote(null);
    sendRequest.mutate(query, {
      onSuccess: (result) => {
        setSearch("");
        setNote(
          result.outcome === "accepted"
            ? `You and ${result.displayName} are now friends.`
            : `Request sent to ${result.displayName}.`,
        );
      },
    });
  };

  // --- slice: hub gate ---
  // Before the sign-in prompt: with no hub there is nothing to sign in to, and
  // a **Sign in** button here would send the player to a card that says the
  // same thing. No counters either — there is nobody to count.
  if (hubConfigured === false) {
    return (
      <Page>
        <PageHeader
          title="Friends"
          subtitle="See who is online and join their server in one click."
        />
        <EmptyState
          icon={<Users size={24} />}
          title="Friends are not switched on yet"
          text={HUB_NOT_CONFIGURED_TEXT}
        />
      </Page>
    );
  }

  if (view !== undefined && !view.signedIn) {
    return (
      <Page>
        <PageHeader
          title="Friends"
          subtitle="See who is online and join their server in one click."
        />
        <EmptyState
          icon={<Users size={24} />}
          title="Sign in to see your friends"
          text="JKNet keeps your friends list on the hub, so it follows you to any machine you sign in on."
          action={
            <Button
              variant="primary"
              // Straight to the Account card rather than the top of the
              // Settings screen: the card is what signs the player in, and it
              // sits under three others.
              onClick={() => void navigate("/settings?section=account")}
            >
              Sign in
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <div className="flex flex-col h-full p-24">
      <PageHeader
        title="Friends"
        subtitle={
          view === undefined
            ? "Loading your friends…"
            : `${view.friends.length} friends · ${online} online`
        }
        actions={
          <>
            <Input
              icon={<Search size={16} />}
              placeholder="Search, or type a name to add"
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
              {sendRequest.isPending ? "Sending…" : "Add friend"}
            </Button>
          </>
        }
      />

      {view?.signedIn ? (
        <div className="flex items-center gap-8 pb-8">
          <Badge tone={view.live ? "success" : "neutral"}>
            {view.live ? <Wifi size={12} /> : <WifiOff size={12} />}
            {view.live ? "Live" : "Reconnecting"}
          </Badge>
          <span className="text-body-sm text-fg-muted">
            {view.live
              ? "Changes arrive the moment they happen."
              : "The hub is out of reach; the list refreshes every 30 seconds."}
          </span>
        </div>
      ) : null}

      <Notice text={note} onClear={() => setNote(null)} />
      <Notice text={errorOf(friends.error ?? sendRequest.error)} tone="error" />
      <Notice text={errorOf(join.error ?? remove.error ?? accept.error)} tone="error" />

      <div className="flex flex-1 min-h-0 gap-16 pt-8">
        <div className="flex flex-col flex-1 min-w-0 overflow-y-auto">
          {view === undefined ? (
            <p className="text-body-sm text-fg-muted px-12 py-24">Loading…</p>
          ) : view.friends.length === 0 ? (
            <EmptyState
              className="mt-24"
              icon={<Users size={24} />}
              title="No friends yet"
              text="Type a display name, a jkhub: name or a user id in the box above and press Add friend."
            />
          ) : visible === 0 ? (
            <EmptyState
              className="mt-24"
              icon={<Search size={24} />}
              title={`Nobody matches “${search.trim()}”`}
              text="Press Add friend to send them a request instead."
            />
          ) : (
            GROUPS.map((group) =>
              groups[group].length === 0 ? null : (
                <section key={group} className="flex flex-col gap-4 pb-12">
                  <span className="text-label-xs text-fg-muted px-12 pb-4">
                    {GROUP_TITLES[group]} · {groups[group].length}
                  </span>
                  {groups[group].map((friend) => (
                    <FriendRow
                      key={friend.user.id}
                      friend={friend}
                      selected={friend.user.id === selectedId}
                      onSelect={() => setSelectedId(friend.user.id)}
                      onJoin={
                        canLaunch
                          ? () => {
                              setNote(null);
                              join.mutate(friend.user.id);
                            }
                          : undefined
                      }
                      joining={join.isPending && join.variables === friend.user.id}
                    />
                  ))}
                </section>
              ),
            )
          )}

          <RequestList
            title="Friend requests"
            requests={view?.incoming ?? []}
            side="from"
            onAccept={(id) => accept.mutate(id)}
            onDismiss={(id) => decline.mutate(id)}
            dismissLabel="Decline"
            busyId={accept.isPending ? accept.variables : decline.variables}
          />
          <RequestList
            title="Sent requests"
            requests={view?.outgoing ?? []}
            side="to"
            onDismiss={(id) => decline.mutate(id)}
            dismissLabel="Cancel"
            busyId={decline.isPending ? decline.variables : undefined}
          />
        </div>

        {selected === undefined ? (
          <aside className="flex flex-col items-center justify-center gap-12 w-320 shrink-0 rounded-lg border border-dashed border-line text-center px-24">
            <span className="flex items-center justify-center size-48 rounded-full bg-surface text-fg-muted">
              <Users size={24} />
            </span>
            <p className="text-body-sm text-fg-muted">
              Select a friend to join their game or invite them to yours.
            </p>
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
                ? errorMessage(invite.error)
                : invite.isSuccess && invite.variables?.toUserId === selected.user.id
                  ? `Invite sent to ${selected.user.displayName}.`
                  : null
            }
            onJoin={() => {
              setNote(null);
              join.mutate(selected.user.id);
            }}
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
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/** The message of the first failure among several mutations, or `null`. */
function errorOf(error: unknown): string | null {
  return error == null ? null : errorMessage(error);
}

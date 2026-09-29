import { AlertTriangle, MessageCircle, Monitor, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { useChatNames } from "../../../src/components/chat/useChatText.ts";
import { Badge, Button } from "../../../src/components/ui/index.ts";
import { useErrorText } from "../../../src/i18n/errors.ts";
import { useGametypeLabels } from "../../../src/i18n/useGameLabels.ts";
import { cn } from "../../../src/lib/format.ts";
import type { Friend, JoinableServer } from "../../../src/lib/ipc.ts";
import { useFriendsState, useJoinableServers, useJoinServerChat } from "../../../src/lib/queries.ts";
import { threadPath } from "./screens/chatPaths.ts";

/**
 * The chats of friends' private servers the player may join from here,
 * without playing (spec 1.11): the list the web core keeps
 * (`chat_joinable_servers`) and **Join chat** (`chat_join_server`).
 *
 * The service decides who may join: a friend of the host, by the server's
 * join policy or a live invite, unless the host keeps the chat to players
 * in the game. A server is joinable here only while that list names it.
 * Joining opens the chat; a refusal says why and the list is read again, so
 * a row the host closed in the meantime goes. Nothing here joins the game.
 */

/** The row of the list for this host's session, or `null` when its chat is not open to the player. */
export function useJoinableServer(hostUserId: string | null | undefined, sessionId: string | null | undefined): JoinableServer | null {
  const joinable = useJoinableServers();
  if (!hostUserId || !sessionId) return null;
  return (joinable.data ?? []).find((server) => server.hostUserId === hostUserId && server.sessionId === sessionId) ?? null;
}

export interface JoinChat {
  join(server: { hostUserId: string; sessionId: string }): void;
  /** `host:session` of the join on its way, if any. */
  pendingKey: string | null;
  /** The last refusal, kept after the list dropped its row. */
  error: unknown;
  /** Forgets the last refusal. */
  clearError(): void;
}

function keyOf(server: { hostUserId: string; sessionId: string }): string {
  return `${server.hostUserId}:${server.sessionId}`;
}

/**
 * **Join chat**, then the chat itself. Awaited rather than an `onSuccess` of
 * the call: the list is read again after the join, which takes the row out,
 * and React Query drops the callbacks of a caller that went.
 */
export function useJoinChat(): JoinChat {
  const navigate = useNavigate();
  const join = useJoinServerChat();
  const [error, setError] = useState<unknown>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const { mutateAsync } = join;

  const start = useCallback(
    (server: { hostUserId: string; sessionId: string }) => {
      setError(null);
      setPendingKey(keyOf(server));
      void mutateAsync({ hostUserId: server.hostUserId, sessionId: server.sessionId })
        .then((conversation) => void navigate(threadPath(conversation.id)))
        .catch((failure: unknown) => setError(failure))
        .finally(() => setPendingKey(null));
    },
    [mutateAsync, navigate],
  );
  const clearError = useCallback(() => setError(null), []);

  return { join: start, pendingKey, error, clearError };
}

/** What a row of the list says, for telling one list from the next. */
function signatureOf(servers: JoinableServer[] | undefined): string {
  return JSON.stringify(
    (servers ?? []).map((server) => [server.hostUserId, server.sessionId, server.map, server.gametype, server.mod, server.members, server.invited]),
  );
}

/**
 * Keeps a refusal of **Join chat** on screen through the read of the list
 * that follows it — the one that takes the refused row away — and lets it
 * go once the list changes after that: the row came back, another server
 * opened, a map changed. The reason then no longer describes what is on
 * screen.
 */
function useRefusalUntilListChanges(chat: JoinChat, servers: JoinableServer[] | undefined, updatedAt: number): void {
  const { error, clearError } = chat;
  const signature = signatureOf(servers);
  const watch = useRef<{ error: unknown; at: number; baseline: string | null }>({ error: null, at: 0, baseline: null });

  useEffect(() => {
    const current = watch.current;
    if (error === null) {
      watch.current = { error: null, at: 0, baseline: null };
      return;
    }
    if (current.error !== error) {
      watch.current = { error, at: Date.now(), baseline: null };
      return;
    }
    // The read the refusal started has not answered yet.
    if (updatedAt < current.at) return;
    if (current.baseline === null) {
      current.baseline = signature;
      return;
    }
    if (signature !== current.baseline) clearError();
  }, [error, signature, updatedAt, clearError]);
}

/** The facts of a row: the map, the mode, how many are in the chat. */
function useFacts(): (server: JoinableServer) => string {
  const { t: tChat } = useTranslation("chat");
  const labels = useGametypeLabels();
  return useCallback(
    (server: JoinableServer) => {
      const facts: string[] = [];
      if (server.map !== "") facts.push(server.map);
      facts.push(labels.label(server.game, server.gametype));
      facts.push(tChat("thread.members", { count: server.members }));
      return facts.join(" · ");
    },
    [labels, tChat],
  );
}

/** The host's name as the friends list has it, the chat's name for anyone else. */
function useHostName(): (hostUserId: string) => { name: string; friend: Friend | null } {
  const friends = useFriendsState().data?.friends ?? [];
  const names = useChatNames();
  return (hostUserId) => {
    const friend = friends.find((entry) => entry.user.id === hostUserId) ?? null;
    return { name: friend?.user.displayName ?? names.personName(hostUserId), friend };
  };
}

/** A refusal of **Join chat**, in the player's language. */
export function JoinRefusal({ error, className }: { error: unknown; className?: string }) {
  const errorText = useErrorText();
  if (error === null || error === undefined) return null;
  return (
    <p
      role="alert"
      data-testid="join-refusal"
      className={cn(
        "flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle px-12 py-8 text-body-sm text-fg",
        className,
      )}
    >
      <AlertTriangle size={16} className="mt-2 shrink-0 text-fg-danger" />
      <span className="min-w-0 break-words">{errorText(error)}</span>
    </p>
  );
}

/** The button of a joinable server. */
export function JoinChatButton({
  server,
  chat,
  variant = "primary",
}: {
  server: JoinableServer;
  chat: JoinChat;
  variant?: "primary" | "secondary";
}) {
  const { t } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const busy = chat.pendingKey !== null;
  return (
    <Button
      size="sm"
      variant={variant}
      icon={<MessageCircle size={14} />}
      disabled={busy}
      onClick={() => chat.join(server)}
    >
      {chat.pendingKey === keyOf(server) ? t("serverChats.joining") : tChat("cards.joinChat")}
    </Button>
  );
}

/**
 * The top of the chat list: "Kyle hosts a server" with **Join chat**, one
 * row per friend's server whose chat the player may join now. Nothing while
 * there is none, except the reason of a join that was just refused.
 */
export function JoinableServers() {
  const { t } = useTranslation("web");
  const joinable = useJoinableServers();
  const chat = useJoinChat();
  const facts = useFacts();
  const hostOf = useHostName();
  const servers = joinable.data ?? [];
  useRefusalUntilListChanges(chat, joinable.data, joinable.dataUpdatedAt);

  if (servers.length === 0 && chat.error === null) return null;

  return (
    <section aria-label={t("serverChats.title")} data-testid="joinable-servers" className="flex flex-col gap-4 pb-8">
      <h3 className="px-8 pt-4 text-label-xs text-fg-muted">{t("serverChats.title")}</h3>
      <JoinRefusal error={chat.error} />
      {servers.map((server) => {
        const { name, friend } = hostOf(server.hostUserId);
        return (
          // The button goes under the words where the list is narrow, as
          // the wide layout's list pane is.
          <div
            key={keyOf(server)}
            data-testid="joinable-row"
            className="flex flex-wrap items-center gap-10 rounded-md border border-line bg-surface p-10"
          >
            <span
              aria-hidden="true"
              className="flex size-36 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-fg-accent"
            >
              <Server size={18} />
            </span>
            <span className="flex min-w-0 flex-1 basis-[180px] flex-col gap-2">
              <span className="truncate text-body-md-medium text-fg [unicode-bidi:isolate]" title={friend?.user.displayName}>
                {t("serverChats.hosts", { name })}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-6 text-body-sm text-fg-muted">
                <span className="min-w-0 truncate">{facts(server)}</span>
                {server.invited ? <Badge tone="accent">{t("serverChats.invited")}</Badge> : null}
              </span>
            </span>
            <span className="ml-auto">
              <JoinChatButton server={server} chat={chat} />
            </span>
          </div>
        );
      })}
    </section>
  );
}

/**
 * The private server a friend hosts, on the friend's page: where it runs,
 * **Join chat** while its chat is open to the player, and that the game
 * itself is the launcher's.
 */
export function HostedServer({ friend }: { friend: Friend }) {
  const { t } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const { t: tErrors } = useTranslation("errors");
  const labels = useGametypeLabels();
  const hosting = friend.presence.status === "offline" ? null : (friend.presence.hosting ?? null);
  const server = useJoinableServer(friend.user.id, hosting?.sessionId);
  const chat = useJoinChat();
  if (hosting === null) return null;

  const facts: string[] = [];
  if (hosting.map) facts.push(hosting.map);
  facts.push(labels.label(hosting.game, hosting.gametype));
  facts.push(tChat("cards.server.players", { players: hosting.players, max: hosting.maxPlayers }));

  return (
    <section
      aria-label={t("serverChats.hosts", { name: friend.user.displayName })}
      data-testid="hosted-server"
      className="flex flex-col gap-10 rounded-md border border-line bg-surface p-12"
    >
      <div className="flex items-center gap-10">
        <span
          aria-hidden="true"
          className="flex size-36 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-fg-accent"
        >
          <Server size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="truncate text-body-md-medium text-fg [unicode-bidi:isolate]">
            {t("serverChats.hosts", { name: friend.user.displayName })}
          </span>
          <span className="text-body-sm text-fg-muted [overflow-wrap:anywhere]">{facts.join(" · ")}</span>
        </span>
        {server?.invited ? <Badge tone="accent">{t("serverChats.invited")}</Badge> : null}
      </div>
      {server !== null ? (
        <div>
          <JoinChatButton server={server} chat={chat} />
        </div>
      ) : hosting.chatFromWeb === false ? (
        <p className="text-body-sm text-fg-muted">{tErrors("online.webJoinOff")}</p>
      ) : null}
      <JoinRefusal error={chat.error} />
      <p className="flex items-center gap-6 text-body-sm text-fg-muted">
        <Monitor size={14} className="shrink-0" />
        {t("friendsScreen.inviteNote")}
      </p>
    </section>
  );
}

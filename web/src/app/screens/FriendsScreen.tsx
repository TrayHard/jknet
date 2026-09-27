import { AlertTriangle, ChevronRight, Inbox, Search, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { useMessageFriend } from "../../../../src/components/chat/useOpenChat.ts";
import { FriendRow } from "../../../../src/components/friends/FriendRow.tsx";
import { GROUPS, groupFriends, matchesSearch } from "../../../../src/components/friends/presence.ts";
import { Button, EmptyState, Input } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { cn } from "../../../../src/lib/format.ts";
import { useFriendsState, useSendFriendRequest } from "../../../../src/lib/queries.ts";
import { openInvites } from "../../core/friends.ts";
import { NavCount } from "../layouts/NavCount.tsx";

interface FriendsScreenProps {
  /** The friend whose details are open. */
  selectedId?: string;
  /** Whether the requests are open. */
  requestsOpen?: boolean;
}

/**
 * The friends list: the search box that also adds a friend, the row that
 * leads to requests and server invites, and the friends in three groups —
 * in a game, online, offline — each sorted by name.
 *
 * A friend online only in the web app reads "Online from phone" or "Online
 * in browser"; the launcher's status always wins.
 */
export function FriendsScreen({ selectedId, requestsOpen = false }: FriendsScreenProps) {
  const { t } = useTranslation("friends");
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const message = useMessageFriend();
  const friends = useFriendsState();
  const send = useSendFriendRequest();
  const [search, setSearch] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const view = friends.data;
  const groups = useMemo(
    () => groupFriends((view?.friends ?? []).filter((friend) => matchesSearch(friend, search))),
    [view?.friends, search],
  );
  const visible = GROUPS.reduce((total, group) => total + groups[group].length, 0);
  const asks = (view?.incoming.length ?? 0) + openInvites(view?.invites ?? [], Date.now()).length;

  const add = () => {
    const query = search.trim();
    if (query === "") return;
    setNote(null);
    send.mutate(query, {
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

  const error = friends.error ?? send.error;

  return (
    <div className="flex flex-col pb-16">
      <div className="flex flex-col gap-8 px-16 pt-4 pb-12">
        <div className="flex gap-8">
          <Input
            icon={<Search size={16} />}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
            }}
            className="min-w-0 flex-1"
          />
          <Button
            variant="primary"
            icon={<UserPlus size={16} />}
            aria-label={t("addFriend")}
            title={t("addFriend")}
            disabled={search.trim() === "" || send.isPending}
            onClick={add}
          >
            <span className="sr-only">{t("addFriend")}</span>
          </Button>
        </div>
        {note !== null ? (
          <p role="status" className="rounded-md border border-line bg-surface px-12 py-8 text-body-sm text-fg-secondary">
            {note}
          </p>
        ) : null}
        {error != null ? (
          <p role="alert" className="flex items-start gap-8 rounded-md border border-line-danger bg-surface px-12 py-8 text-body-sm text-fg-danger">
            <AlertTriangle size={16} className="mt-2 shrink-0" />
            <span>{errorText(error)}</span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-col px-8">
        <Link
          to="/friends/requests"
          data-testid="requests-row"
          aria-current={requestsOpen ? "page" : undefined}
          className={cn(
            "flex min-h-56 items-center gap-12 rounded-[10px] px-12 transition-colors duration-100",
            requestsOpen ? "bg-selected-overlay" : "hover:bg-hover-overlay",
          )}
        >
          <span className="flex size-40 shrink-0 items-center justify-center rounded-[10px] bg-elevated text-fg-secondary">
            <Inbox size={18} />
          </span>
          <span className="min-w-0 flex-1 truncate text-body-md-medium text-fg">{tWeb("friendsScreen.requests")}</span>
          <NavCount badge={asks > 0 ? asks : undefined} />
          <ChevronRight size={16} className="text-fg-secondary" />
        </Link>

        {view === undefined ? (
          <p className="px-12 py-24 text-body-sm text-fg-muted">{tCommon("states.loading")}</p>
        ) : view.friends.length === 0 ? (
          <EmptyState
            className="mx-8 mt-16"
            icon={<Users size={24} />}
            title={t("empty.noneTitle")}
            text={t("empty.noneText")}
          />
        ) : visible === 0 ? (
          <EmptyState
            className="mx-8 mt-16"
            icon={<Search size={24} />}
            title={t("empty.noMatchTitle", { query: search.trim() })}
            text={t("empty.noMatchText")}
          />
        ) : (
          GROUPS.map((group) =>
            groups[group].length === 0 ? null : (
              <section key={group} data-group={group} className="flex flex-col gap-2 pt-12">
                <span className="px-12 pb-4 text-label-xs uppercase text-fg-secondary">
                  {t("requests.heading", { title: t(`groups.${group}`), count: groups[group].length })}
                </span>
                {groups[group].map((friend) => (
                  <FriendRow
                    key={friend.user.id}
                    friend={friend}
                    selected={friend.user.id === selectedId}
                    onSelect={() => void navigate(`/friends/${encodeURIComponent(friend.user.id)}`)}
                    onMessage={() => message.open(friend.user.id)}
                  />
                ))}
              </section>
            ),
          )
        )}
      </div>
    </div>
  );
}

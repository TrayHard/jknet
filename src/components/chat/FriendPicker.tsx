import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { GROUP_MAX_MEMBERS, pickCandidates } from "../../lib/chat/groups";
import { cn } from "../../lib/format";
import type { Friend } from "../../lib/ipc";
import { useStatusLine } from "../friends/useStatusLine";
import { Avatar, Input } from "../ui";

interface FriendPickerProps {
  /** Everybody who could be picked: my friends. */
  friends: Friend[];
  /** Friends already in the group: not offered. */
  exclude: ReadonlySet<string>;
  picked: string[];
  onChange: (picked: string[]) => void;
  /** How many may be picked at most: the room left in the group. */
  room: number;
  /** The count line above the list: «4 of 20». */
  countText: string;
  /** Said instead of the list when nobody is left to pick. */
  noneLeftText: string;
  disabled?: boolean;
}

/**
 * --- slice: chat groups ---
 *
 * The friends list of **New group** and **Add friends**: a search field, the
 * picked friends as chips, and a row with a check box per friend, the ones
 * who are around first. Once the group is full the rows that are not picked
 * switch off; a friend who asks before being added still appears, since
 * nobody can tell until the service answers with an invitation.
 */
export function FriendPicker({
  friends,
  exclude,
  picked,
  onChange,
  room,
  countText,
  noneLeftText,
  disabled = false,
}: FriendPickerProps) {
  const { t } = useTranslation("chat");
  const statusLine = useStatusLine();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => pickCandidates(friends, exclude, query), [friends, exclude, query]);
  const anybody = useMemo(() => pickCandidates(friends, exclude, "").length > 0, [friends, exclude]);
  const byId = useMemo(() => new Map(friends.map((friend) => [friend.user.id, friend])), [friends]);
  const full = picked.length >= room;

  const toggle = (id: string) =>
    onChange(picked.includes(id) ? picked.filter((other) => other !== id) : [...picked, id]);

  if (!anybody) {
    return <p className="px-4 py-12 text-body-sm text-fg-muted">{noneLeftText}</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-8">
      <div className="flex items-center justify-between gap-8">
        <span className="text-label-xs text-fg-muted">{t("group.members")}</span>
        <span className="text-mono-xs text-fg-muted">{countText}</span>
      </div>
      <Input
        icon={<Search size={14} />}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("group.find")}
        aria-label={t("group.find")}
        className="h-32"
        disabled={disabled}
      />
      {picked.length > 0 ? (
        <ul aria-label={t("group.picked")} className="flex flex-wrap gap-4">
          {picked.map((id) => {
            const name = byId.get(id)?.user.displayName ?? t("people.former");
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(id)}
                  aria-label={t("group.unpick", { name })}
                  title={t("group.unpick", { name })}
                  className="flex h-24 items-center gap-4 rounded-full bg-accent-subtle pr-6 pl-8 text-body-sm text-fg-accent select-none cursor-pointer hover:bg-selected-overlay disabled:cursor-not-allowed"
                >
                  <span className="max-w-[140px] truncate [unicode-bidi:isolate]">{name}</span>
                  <X size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ul className="flex max-h-[40vh] min-h-120 flex-col gap-2 overflow-y-auto">
        {rows.length === 0 ? (
          <li className="px-8 py-12 text-body-sm text-fg-muted">{t("group.noMatch", { query: query.trim() })}</li>
        ) : (
          rows.map((friend) => {
            const on = picked.includes(friend.user.id);
            const off = disabled || (!on && full);
            return (
              <li key={friend.user.id}>
                <label
                  className={cn(
                    "flex min-w-0 items-center gap-10 rounded-md px-8 py-6",
                    off ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-hover-overlay",
                    on && "bg-selected-overlay",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={off}
                    onChange={() => toggle(friend.user.id)}
                    className="shrink-0"
                  />
                  <Avatar
                    name={friend.user.displayName}
                    src={friend.user.avatarUrl}
                    size="sm"
                    status={friend.presence.status}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body-md text-fg [unicode-bidi:isolate]">
                      {friend.user.displayName}
                    </span>
                    <span className="truncate text-body-sm text-fg-muted">{statusLine(friend.presence)}</span>
                  </span>
                </label>
              </li>
            );
          })
        )}
      </ul>
      {full ? <p className="text-body-sm text-fg-warm">{t("group.full", { max: GROUP_MAX_MEMBERS })}</p> : null}
    </div>
  );
}

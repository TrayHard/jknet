import { ChevronRight, LogIn } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { Friend, HostJoinPolicy, HostSession } from "../../lib/ipc";
import { Button } from "../ui";
import { inviteGroups, isInMyGame, lastInvite, relayDown } from "./hostModel";
import { InviteRow, type InviteRowState } from "./InviteRow";
import { JoinPolicy } from "./JoinPolicy";
import { Notice } from "./Notice";

/**
 * How the panel is used.
 *
 * - `select`: before a start (Setup, Starting, Stopped, Failed): checkboxes,
 *   and the join policy of the form.
 * - `live`: while the server runs: **Invite** buttons, and the join policy of
 *   the session, which changes on the core at once.
 * - `signedOut`: nobody is signed in to JKNet Online.
 * - `off`: this build has no JKNet Online at all.
 */
export type InvitePanelMode = "select" | "live" | "signedOut" | "off";

interface InvitePanelProps {
  mode: InvitePanelMode;
  friends: Friend[];
  /** The join policy on screen, form or session. */
  policy: HostJoinPolicy;
  joinUserIds: string[];
  onPolicyChange: (policy: HostJoinPolicy, joinUserIds: string[]) => void;
  /** `select`: the friends to invite once the server is ready. */
  marked?: string[];
  /** `select`: marks the core already has and a click cannot take back. */
  lockedMarks?: string[];
  onToggleMark?: (userId: string) => void;
  /** `live`: the running session. */
  session?: HostSession | null;
  onInvite?: (userId: string) => void;
  /** `live`: the friend an invite is on its way to. */
  inviting?: string | null;
  /** `live`: invites this screen sent that the session does not list yet. */
  sentAt?: Record<string, string>;
  onSignIn?: () => void;
  /** The text for `off`. */
  offText?: string;
  now: number;
  className?: string;
}

/**
 * The **Invite friends** panel: who may walk in on their own, and who gets
 * an invite.
 *
 * The join policy sits at the top in every state of the screen, so the host
 * closes the door mid-game in the same place they set it before the start.
 * Friends who can take an invite now come first; offline ones wait in a
 * collapsed group at the bottom.
 */
export function InvitePanel({
  mode,
  friends,
  policy,
  joinUserIds,
  onPolicyChange,
  marked = [],
  lockedMarks = [],
  onToggleMark,
  session = null,
  onInvite,
  inviting = null,
  sentAt = {},
  onSignIn,
  offText,
  now,
  className,
}: InvitePanelProps) {
  const { t } = useTranslation("host");
  const [offlineOpen, setOfflineOpen] = useState(false);
  const groups = inviteGroups(friends);
  const ordered = [...groups.active, ...groups.offline];

  const shell = cn(
    "flex flex-col gap-12 w-320 shrink-0 rounded-lg border border-line bg-surface p-16 overflow-y-auto",
    className,
  );

  if (mode === "off") {
    return (
      <aside className={shell}>
        <h2 className="text-heading-sm text-fg">{t("panel.title")}</h2>
        <p className="text-body-sm text-fg-muted">{offText}</p>
      </aside>
    );
  }

  if (mode === "signedOut") {
    return (
      <aside className={shell}>
        <div className="flex flex-col gap-4">
          <h2 className="text-heading-sm text-fg">{t("panel.title")}</h2>
          <p className="text-body-sm text-fg-muted">{t("panel.signIn")}</p>
        </div>
        <Button icon={<LogIn size={16} />} onClick={onSignIn} className="self-start">
          {t("panel.signInAction")}
        </Button>
        <JoinPolicy
          policy={policy}
          joinUserIds={joinUserIds}
          friends={[]}
          onChange={onPolicyChange}
          disabled
        />
      </aside>
    );
  }

  const rowState = (friend: Friend): InviteRowState => {
    if (friend.presence.status === "offline") return { kind: "offline" };
    const id = friend.user.id;
    if (mode === "select") {
      const locked = lockedMarks.includes(id);
      return {
        kind: "select",
        checked: locked || marked.includes(id),
        locked,
        onToggle: () => onToggleMark?.(id),
      };
    }
    if (session !== null && isInMyGame(friend.presence, session)) return { kind: "in-game" };
    // The core has the last word: an invite it lists as failed offers
    // **Invite** again, whatever this screen stamped when it sent it. The stamp
    // only bridges the moment before the core lists the invite at all.
    const last = session === null ? undefined : lastInvite(session.invited, id);
    const at = last !== undefined ? (last.ok ? last.at : undefined) : sentAt[id];
    if (at !== undefined) return { kind: "invited", at };
    return {
      kind: "invite",
      pending: inviting === id,
      onInvite: () => onInvite?.(id),
    };
  };

  return (
    <aside className={shell}>
      <h2 className="text-heading-sm text-fg">{t("panel.title")}</h2>
      <JoinPolicy
        policy={policy}
        joinUserIds={joinUserIds}
        friends={ordered}
        onChange={onPolicyChange}
      />
      <div aria-hidden="true" className="h-px shrink-0 bg-line-subtle" />
      {mode === "select" ? (
        <p className="text-body-sm text-fg-muted">{t("panel.caption")}</p>
      ) : session !== null && relayDown(session) ? (
        <Notice tone="warm">{t("panel.relayNeeded")}</Notice>
      ) : null}

      {friends.length === 0 ? (
        <p className="text-body-sm text-fg-muted">{t("panel.noFriends")}</p>
      ) : (
        <>
          {groups.active.length > 0 ? (
            <div className="flex flex-col gap-2">
              {groups.active.map((friend) => (
                <InviteRow key={friend.user.id} friend={friend} state={rowState(friend)} now={now} />
              ))}
            </div>
          ) : null}
          {groups.offline.length > 0 ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                aria-expanded={offlineOpen}
                onClick={() => setOfflineOpen((open) => !open)}
                className="flex items-center gap-8 py-8 pl-8 rounded-md text-fg-muted hover:text-fg-secondary cursor-pointer select-none"
              >
                <ChevronRight
                  size={16}
                  aria-hidden="true"
                  className={cn("transition-transform duration-150", offlineOpen && "rotate-90")}
                />
                <span className="text-label-xs">
                  {t("panel.offline", { count: groups.offline.length })}
                </span>
              </button>
              {offlineOpen
                ? groups.offline.map((friend) => (
                    <InviteRow
                      key={friend.user.id}
                      friend={friend}
                      state={{ kind: "offline" }}
                      now={now}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

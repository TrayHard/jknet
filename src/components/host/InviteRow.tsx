import { Check, Send } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type { Friend } from "../../lib/ipc";
import { useStatusLine } from "../friends/useStatusLine";
import { Avatar, Badge, Button } from "../ui";
import { CheckboxBox } from "./Choice";
import { secondsSince } from "./hostModel";

/**
 * What the row offers.
 *
 * - `select`: a checkbox, before the server runs: marked friends get an invite
 *   once it is ready. `locked` keeps a mark the core already has.
 * - `invite`: the **Invite** button while the server runs.
 * - `invited`: **Invited**, off, with the time of the invite under it.
 * - `in-game`: **In your game**, for a friend whose presence points here.
 * - `offline`: nothing; offline friends sit in the collapsed group.
 */
export type InviteRowState =
  | { kind: "select"; checked: boolean; locked?: boolean; onToggle: () => void }
  | { kind: "invite"; pending: boolean; onInvite: () => void }
  | { kind: "invited"; at: string }
  | { kind: "in-game" }
  | { kind: "offline" };

/** The InviteRow of the design: a friend in the **Invite friends** panel. */
export function InviteRow({
  friend,
  state,
  now,
}: {
  friend: Friend;
  state: InviteRowState;
  now: number;
}) {
  const { t } = useTranslation("host");
  const { t: tCommon } = useTranslation("common");
  const statusLine = useStatusLine();
  const format = useFormat();

  const person = (
    <>
      <Avatar
        name={friend.user.displayName}
        src={friend.user.avatarUrl}
        status={friend.presence.status}
      />
      <span className="flex-1 min-w-0 flex flex-col gap-2">
        <span className="text-body-md-medium text-fg truncate">{friend.user.displayName}</span>
        <span className="text-body-sm text-fg-muted truncate">{statusLine(friend.presence)}</span>
      </span>
    </>
  );

  if (state.kind === "select") {
    const locked = state.locked === true;
    return (
      <label
        title={t("panel.markFriend", { name: friend.user.displayName })}
        className={cn(
          "flex items-center gap-12 p-8 rounded-md select-none",
          locked ? "cursor-default" : "cursor-pointer hover:bg-hover-overlay",
        )}
      >
        <input
          type="checkbox"
          checked={state.checked}
          disabled={locked}
          onChange={state.onToggle}
          className="peer sr-only"
        />
        <CheckboxBox checked={state.checked} />
        {person}
      </label>
    );
  }

  let aside = null;
  if (state.kind === "invite") {
    aside = (
      <Button
        size="sm"
        icon={<Send size={14} />}
        disabled={state.pending}
        onClick={state.onInvite}
        className="shrink-0"
      >
        {state.pending ? tCommon("states.sending") : t("panel.invite")}
      </Button>
    );
  } else if (state.kind === "invited") {
    const seconds = secondsSince(state.at, now) ?? 0;
    aside = (
      <span className="flex flex-col items-end gap-2 shrink-0">
        <Button size="sm" disabled icon={<Check size={14} />}>
          {t("panel.invited")}
        </Button>
        <span className="text-label-xs text-fg-muted">
          {seconds < 60
            ? t("panel.invitedJustNow")
            : t("panel.invitedAgo", { time: format.age(seconds) })}
        </span>
      </span>
    );
  } else if (state.kind === "in-game") {
    aside = (
      <Badge tone="accent" className="shrink-0">
        {t("panel.inYourGame")}
      </Badge>
    );
  }

  return (
    <div className="flex items-center gap-12 p-8 rounded-md">
      {person}
      {aside}
    </div>
  );
}

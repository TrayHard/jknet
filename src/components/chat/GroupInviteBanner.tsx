import { ArrowLeft, Clock, EyeOff, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import type { ChatGroupInvite } from "../../lib/ipc";
import { useAnswerGroupInvite, useChatPrivacy } from "../../lib/queries";
import { Avatar, Button } from "../ui";
import { useChatTimes } from "./useChatText";

interface GroupInviteBannerProps {
  invite: ChatGroupInvite;
  /** The group was joined: it is a conversation now, under the same id. */
  onJoined: (conversationId: string) => void;
  /** Declined: nothing is left to show. */
  onDeclined: () => void;
  /** The back arrow of the stacked and compact layouts. */
  onBack?: () => void;
  /** The buttons of the layout, as the thread header carries them. */
  actions?: ReactNode;
  dense?: boolean;
}

/**
 * --- slice: chat groups ---
 *
 * An invitation into a group, where its thread will be once the player
 * joins: who invited them, how many are in it, until when it holds, and
 * **Join** and **Decline**.
 *
 * Only a player who asks before being added gets one (privacy «ask»). The
 * group's history before the join may stay hidden: its owner decides (D1),
 * and the invitation does not say how the group is set, so the banner says
 * who decides instead of guessing. Declining holds the group off for a day.
 */
export function GroupInviteBanner({
  invite,
  onJoined,
  onDeclined,
  onBack,
  actions,
  dense = false,
}: GroupInviteBannerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const times = useChatTimes();
  const privacy = useChatPrivacy();
  const answer = useAnswerGroupInvite();
  const title = invite.title?.trim() || t("invites.untitled");
  const by = invite.invitedBy;

  return (
    <section aria-label={t("invites.bannerLabel", { title })} className="flex h-full min-h-0 flex-col">
      {onBack || actions ? (
        <header className={cn("flex shrink-0 items-center gap-8 border-b border-line-subtle", dense ? "h-44 px-8" : "h-56 px-12")}>
          {onBack ? (
            <button
              type="button"
              aria-label={t("thread.back")}
              title={t("thread.back")}
              onClick={onBack}
              className="flex size-28 shrink-0 items-center justify-center rounded-sm text-fg-secondary cursor-pointer select-none hover:bg-hover-overlay hover:text-fg"
            >
              <ArrowLeft size={16} />
            </button>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-body-md-medium text-fg [unicode-bidi:isolate]">{title}</span>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-24">
        <div className="flex w-full max-w-[400px] flex-col gap-16 rounded-lg border border-line-accent bg-surface p-16 shadow-card">
          <div className="flex items-start gap-12">
            <span className="flex size-40 shrink-0 items-center justify-center rounded-full bg-purple-subtle text-fg-purple">
              <Users size={18} />
            </span>
            <div className="flex min-w-0 flex-col gap-4">
              <h3 className="text-heading-sm text-fg [unicode-bidi:isolate] [overflow-wrap:anywhere]">
                {t("invites.bannerTitle", { name: by.displayName, title })}
              </h3>
              <p className="text-body-sm text-fg-secondary">{t("invites.bannerText")}</p>
            </div>
          </div>

          <ul className="flex flex-col gap-8 text-body-sm text-fg-secondary">
            <li className="flex items-center gap-8">
              <Avatar name={by.displayName} src={by.avatarUrl} size="sm" />
              <span className="min-w-0 truncate">
                {t("invites.invitedBy", { name: by.displayName, time: times.full(invite.createdAt) })}
              </span>
            </li>
            <li className="flex items-center gap-8">
              <Users size={14} className="shrink-0 text-fg-muted" />
              {t("invites.members", { count: invite.memberCount })}
            </li>
            <li className="flex items-center gap-8">
              <Clock size={14} className="shrink-0 text-fg-muted" />
              {t("invites.expires", { time: times.full(invite.expiresAt) })}
            </li>
            <li className="flex items-start gap-8">
              <EyeOff size={14} className="mt-2 shrink-0 text-fg-muted" />
              <span>{t("invites.historyNote")}</span>
            </li>
          </ul>

          {privacy?.groupAdd === "ask" ? (
            <p className="rounded-md bg-selected-overlay px-10 py-8 text-body-sm text-fg-muted">{t("invites.askNote")}</p>
          ) : null}

          <div className="flex items-center gap-8">
            <Button
              variant="primary"
              disabled={answer.isPending}
              onClick={() =>
                answer.mutate(
                  { conversationId: invite.conversationId, accept: true },
                  { onSuccess: (conversation) => onJoined(conversation?.id ?? invite.conversationId) },
                )
              }
            >
              {t("invites.join")}
            </Button>
            <Button
              variant="ghost"
              disabled={answer.isPending}
              onClick={() =>
                answer.mutate({ conversationId: invite.conversationId, accept: false }, { onSuccess: onDeclined })
              }
            >
              {t("invites.decline")}
            </Button>
          </div>
          {answer.error ? (
            <p role="alert" className="text-body-sm text-fg-danger">
              {errorText(answer.error)}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

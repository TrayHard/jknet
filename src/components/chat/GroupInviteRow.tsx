import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import type { ChatGroupInvite } from "../../lib/ipc";
import { useAnswerGroupInvite } from "../../lib/queries";
import { Button } from "../ui";

interface GroupInviteRowProps {
  invite: ChatGroupInvite;
  /** The group was joined: show it. */
  onJoined: (conversationId: string) => void;
  /**
   * --- slice: chat groups --- a press on the invitation itself: the
   * surface shows it in full, where the thread will be.
   */
  onOpen?: () => void;
  selected?: boolean;
}

/**
 * --- slice: chat ---
 *
 * An invitation into a group, at the top of the list: a player who asks
 * before being added decides here.
 */
export function GroupInviteRow({ invite, onJoined, onOpen, selected = false }: GroupInviteRowProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const answer = useAnswerGroupInvite();
  const title = invite.title?.trim() || t("invites.untitled");

  const head = (
    <>
      <span className="flex size-32 shrink-0 items-center justify-center rounded-full bg-purple-subtle text-fg-purple">
        <Users size={16} />
      </span>
      <span className="flex min-w-0 flex-col gap-2">
        <span className="truncate text-body-md-medium text-fg [unicode-bidi:isolate]">{title}</span>
        <span className="text-body-sm text-fg-muted">
          {t("invites.from", { name: invite.invitedBy.displayName, count: invite.memberCount })}
        </span>
      </span>
    </>
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-8 rounded-md border bg-surface p-10",
        selected ? "border-line-accent" : "border-line",
      )}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-current={selected ? "true" : undefined}
          aria-label={t("invites.open", { title })}
          className="-m-4 flex items-start gap-10 rounded-sm p-4 text-left cursor-pointer select-none hover:bg-hover-overlay"
        >
          {head}
        </button>
      ) : (
        <div className="flex items-start gap-10">{head}</div>
      )}
      <div className="flex items-center gap-8">
        <Button
          size="sm"
          variant="primary"
          disabled={answer.isPending}
          onClick={() =>
            answer.mutate(
              { conversationId: invite.conversationId, accept: true },
              { onSuccess: (conversation) => conversation && onJoined(conversation.id) },
            )
          }
        >
          {t("invites.join")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={answer.isPending}
          onClick={() => answer.mutate({ conversationId: invite.conversationId, accept: false })}
        >
          {t("invites.decline")}
        </Button>
      </div>
      {answer.error ? (
        <p role="alert" className="text-body-sm text-fg-danger">{errorText(answer.error)}</p>
      ) : null}
    </div>
  );
}

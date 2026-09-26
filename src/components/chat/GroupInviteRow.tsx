import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import type { ChatGroupInvite } from "../../lib/ipc";
import { useAnswerGroupInvite } from "../../lib/queries";
import { Button } from "../ui";

interface GroupInviteRowProps {
  invite: ChatGroupInvite;
  /** The group was joined: show it. */
  onJoined: (conversationId: string) => void;
}

/**
 * --- slice: chat ---
 *
 * An invitation into a group, at the top of the list: a player who asks
 * before being added decides here.
 */
export function GroupInviteRow({ invite, onJoined }: GroupInviteRowProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const answer = useAnswerGroupInvite();
  const title = invite.title?.trim() || t("invites.untitled");

  return (
    <div className="flex flex-col gap-8 rounded-md border border-line bg-surface p-10">
      <div className="flex items-start gap-10">
        <span className="flex size-32 shrink-0 items-center justify-center rounded-full bg-purple-subtle text-fg-purple">
          <Users size={16} />
        </span>
        <div className="flex min-w-0 flex-col gap-2">
          <span className="truncate text-body-md-medium text-fg [unicode-bidi:isolate]">{title}</span>
          <span className="text-body-sm text-fg-muted">
            {t("invites.from", { name: invite.invitedBy.displayName, count: invite.memberCount })}
          </span>
        </div>
      </div>
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

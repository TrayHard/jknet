import { CloudOff, LogIn, MessageCircleOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";

/** Why the chat has nothing to show. */
export type ChatUnavailableReason = "notConfigured" | "signedOut" | "noChat" | "failed";

/**
 * --- slice: chat ---
 *
 * What the chat surface says instead of the chats: this build has no
 * service, nobody is signed in, the service has no chat yet, or the state
 * could not be read. One sentence of what to do next, no error codes.
 */
export function ChatUnavailable({
  reason,
  detail,
  className,
}: {
  reason: ChatUnavailableReason;
  /** The failure in words, for `failed`. */
  detail?: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const Icon = reason === "signedOut" ? LogIn : reason === "failed" ? CloudOff : MessageCircleOff;
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-12 p-24 text-center", className)}>
      <span className="flex size-48 items-center justify-center rounded-full bg-surface text-fg-muted">
        <Icon size={20} />
      </span>
      <div className="flex max-w-[320px] flex-col gap-4">
        <p className="text-heading-sm text-fg">{t(`unavailable.${reason}.title`)}</p>
        <p className="text-body-sm text-fg-muted">{detail ?? t(`unavailable.${reason}.text`)}</p>
      </div>
    </div>
  );
}

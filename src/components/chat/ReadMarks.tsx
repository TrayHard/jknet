import { Check, CheckCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readersOf } from "../../lib/chat/unread";
import { cn } from "../../lib/format";
import { useChatPrivacy } from "../../lib/queries";
import { Avatar } from "../ui";
import { useThread } from "./ThreadContext";
import { useChatNames } from "./useChatText";

/** Faces of readers drawn before the rest become a number. */
const FACES = 3;

/**
 * --- slice: chat ---
 *
 * Under my newest message: **Read** or **Sent** in a direct chat, the faces
 * of the members who read it in a group.
 *
 * Nothing while my own **Show others when I've read their messages** is off:
 * the switch works both ways, so I see nobody's marks, and the marks go the
 * moment the switch does, without waiting for the service. A member whose
 * marker the service hides is left out rather than counted as unread.
 */
export function ReadMarks({ seq }: { seq: number }) {
  const { t } = useTranslation("chat");
  const { conversation, meId } = useThread();
  const privacy = useChatPrivacy();
  const names = useChatNames();

  if (privacy?.shareReadReceipts === false) return null;
  const readers = readersOf(conversation.members, seq, meId);

  if (conversation.kind === "direct") {
    const read = readers.length > 0;
    return (
      <span className={cn("inline-flex items-center gap-4 text-mono-xs", read ? "text-fg-accent" : "text-fg-muted")}>
        {read ? <CheckCheck size={12} /> : <Check size={12} />}
        {read ? t("delivery.read") : t("delivery.sent")}
      </span>
    );
  }

  if (readers.length === 0) {
    return (
      <span className="inline-flex items-center gap-4 text-mono-xs text-fg-muted">
        <Check size={12} />
        {t("delivery.sent")}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-6 text-mono-xs text-fg-muted"
      title={readers.map((reader) => names.personName(reader.user.id)).join(", ")}
    >
      <span className="flex -space-x-6">
        {readers.slice(0, FACES).map((reader) => (
          <Avatar
            key={reader.user.id}
            name={reader.user.displayName}
            src={reader.user.avatarUrl}
            size="sm"
            className="scale-75 rounded-full ring-2 ring-app"
          />
        ))}
      </span>
      {t("delivery.readBy", { count: readers.length })}
    </span>
  );
}

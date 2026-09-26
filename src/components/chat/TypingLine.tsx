import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useChatPrivacy, useChatTyping } from "../../lib/queries";
import { useChatNames } from "./useChatText";

/**
 * --- slice: chat ---
 *
 * «Kai is typing…» under the thread.
 *
 * Nothing at all while my own **Show when I'm typing** is off: the switch
 * works both ways, and the line goes the moment the switch does, before the
 * service stops relaying.
 */
export function TypingLine({ conversationId }: { conversationId: string }) {
  const typing = useChatTyping(conversationId);
  const privacy = useChatPrivacy();
  const text = useTypingText()(typing);
  const hidden = privacy?.shareTyping === false || text === "";

  return (
    <div aria-live="polite" className="h-18 px-16 text-body-sm text-fg-muted truncate">
      {hidden ? null : (
        <span className="inline-flex items-center gap-6">
          <TypingDots />
          <span className="[unicode-bidi:isolate]">{text}</span>
        </span>
      )}
    </div>
  );
}

/** The sentence for a list of typists: one, two, or several. Empty for nobody. */
export function useTypingText(): (userIds: readonly string[]) => string {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  return useCallback(
    (userIds: readonly string[]) => {
      const others = userIds.filter((id) => id !== names.meId);
      if (others.length === 0) return "";
      if (others.length === 1) return t("typing.one", { name: names.personName(others[0]) });
      if (others.length === 2) {
        return t("typing.two", { first: names.personName(others[0]), second: names.personName(others[1]) });
      }
      return t("typing.several", { count: others.length });
    },
    [t, names],
  );
}

function TypingDots() {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-2">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="size-4 rounded-full bg-fg-muted animate-pulse"
          style={{ animationDelay: `${dot * 150}ms` }}
        />
      ))}
    </span>
  );
}

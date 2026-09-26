import type { Ref } from "react";
import { useTranslation } from "react-i18next";

/**
 * --- slice: chat ---
 *
 * **New messages**: where reading starts, as it was when the thread opened.
 * It stays put while the thread is open, so it does not jump away from under
 * the eyes of a player who is catching up. The thread scrolls to it on open.
 */
export function UnreadDivider({ ref }: { ref?: Ref<HTMLDivElement> }) {
  const { t } = useTranslation("chat");
  return (
    <div
      ref={ref}
      role="separator"
      className="flex items-center gap-12 px-16 pt-10 pb-2 text-label-xs uppercase tracking-[0.06em] text-fg-accent select-none before:h-px before:flex-1 before:bg-line-accent after:h-px after:flex-1 after:bg-line-accent"
    >
      {t("thread.newMessages")}
    </div>
  );
}

import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { badgeLabel } from "../../lib/chat/unread";
import { cn } from "../../lib/format";
import { useChatUnread, useOnlineConfigured } from "../../lib/queries";
import { currentChatLayout, useChatLayout } from "./ChatLayoutContext";
import { useOpenChat } from "./useOpenChat";

/**
 * --- slice: chat ---
 *
 * **Chats** in the title bar of the main window, before the window buttons:
 * the unread count of the chats that are not muted, and `@` while a mention
 * waits, muted chats included. A click opens or closes the chat drawer of
 * layout B; it stays pressed while the drawer is open. A window without the
 * drawer opens the chat window instead.
 */
export function ChatTitleButton() {
  const { t } = useTranslation("chat");
  const configured = useOnlineConfigured();
  const { unread, mentions } = useChatUnread();
  const layout = useChatLayout();
  const openChat = useOpenChat();

  if (configured === false) return null;

  const base = unread > 0 ? t("titleBar.chatsUnread", { count: unread }) : t("titleBar.chats");
  const label = mentions > 0 ? t("titleBar.withMentions", { label: base, count: mentions }) : base;
  const open = layout?.isOpen === true;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={layout === null ? undefined : open}
      onClick={() => {
        const target = layout ?? currentChatLayout();
        if (target !== null) target.toggle();
        else openChat(null);
      }}
      className={cn(
        "relative flex h-40 w-44 items-center justify-center cursor-pointer select-none",
        "transition-colors duration-150 hover:bg-hover-overlay hover:text-fg",
        open ? "bg-selected-overlay text-fg-accent" : "text-fg-secondary",
      )}
    >
      <MessageCircle size={16} />
      {unread > 0 ? (
        <span className="absolute top-4 right-4 inline-flex h-16 min-w-16 items-center justify-center rounded-full bg-accent px-4 text-[10px] leading-none font-semibold text-fg-on-accent">
          {badgeLabel(unread)}
        </span>
      ) : null}
      {mentions > 0 ? (
        <span className="absolute bottom-4 right-4 inline-flex size-14 items-center justify-center rounded-full bg-warm text-[9px] leading-none font-semibold text-fg-on-accent">
          @
        </span>
      ) : null}
    </button>
  );
}

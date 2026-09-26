import { MessageCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cn } from "../../lib/format";
import { useChatState, useOnlineConfigured } from "../../lib/queries";
import { ChatUnavailable } from "./ChatUnavailable";
import { ConversationList } from "./ConversationList";
import { Thread, type ChatSurfaceVariant, type ThreadJump } from "./Thread";

export type { ChatSurfaceVariant } from "./Thread";

interface ChatSurfaceProps {
  /**
   * `split`: the list and the thread side by side, the chat window.
   * `stacked`: the list, then the thread with a back arrow, the drawer.
   * `compact`: `stacked` in tighter rows, the chat window over a game.
   */
  variant: ChatSurfaceVariant;
  /** The open conversation; `null` shows the list alone, or an empty pane beside it. */
  conversationId: string | null;
  onSelect: (conversationId: string | null) => void;
  /** Buttons the layout adds to the header of the thread. */
  threadActions?: ReactNode;
  /** A bar the layout puts above the list: the title and the buttons of the drawer. */
  listHeader?: ReactNode;
  className?: string;
}

/**
 * --- slice: chat ---
 *
 * The chat, as every layout mounts it: the drawer of the main window, the
 * chat window and its compact mode. It takes an id and a callback and nothing
 * else: which conversation is open belongs to the layout, not to the surface,
 * and none of it reads the router or the window.
 */
export function ChatSurface({
  variant,
  conversationId,
  onSelect,
  threadActions,
  listHeader,
  className,
}: ChatSurfaceProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const configured = useOnlineConfigured();
  const state = useChatState();
  const [jump, setJump] = useState<(ThreadJump & { conversationId: string }) | null>(null);

  const openMessage = (id: string, seq: number) => {
    onSelect(id);
    setJump({ conversationId: id, seq, key: Date.now() });
  };

  if (configured === false) return <ChatUnavailable reason="notConfigured" className={className} />;
  if (state.isPending) {
    return (
      <div className={cn("flex h-full items-center justify-center p-24 text-body-sm text-fg-muted", className)}>
        {t("surface.loading")}
      </div>
    );
  }
  if (state.isError) {
    return <ChatUnavailable reason="failed" detail={errorText(state.error)} className={className} />;
  }
  const view = state.data;
  if (!view.signedIn) return <ChatUnavailable reason="signedOut" className={className} />;
  if (!view.available) return <ChatUnavailable reason="noChat" className={className} />;

  const dense = variant === "compact";
  const list = (
    <ConversationList
      state={view}
      selectedId={conversationId}
      onSelect={(id) => onSelect(id)}
      onOpenMessage={openMessage}
      dense={dense}
      className={variant === "split" ? "min-h-0 flex-1" : "h-full"}
    />
  );
  const thread =
    conversationId === null ? null : (
      <Thread
        key={conversationId}
        conversationId={conversationId}
        variant={variant}
        onBack={variant === "split" ? undefined : () => onSelect(null)}
        headerActions={threadActions}
        jump={jump !== null && jump.conversationId === conversationId ? jump : null}
      />
    );

  if (variant === "split") {
    return (
      <div className={cn("flex h-full min-h-0", className)}>
        <div className="flex w-[300px] min-h-0 shrink-0 flex-col border-r border-line-subtle">
          {listHeader}
          {list}
        </div>
        <div className="min-w-0 flex-1">
          {thread ?? (
            <div className="flex h-full flex-col items-center justify-center gap-8 p-24 text-center">
              <MessageCircle size={24} className="text-fg-muted" />
              <p className="text-body-sm text-fg-muted">{t("surface.pick")}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {thread ?? (
        <>
          {listHeader}
          <div className="min-h-0 flex-1">{list}</div>
        </>
      )}
    </div>
  );
}

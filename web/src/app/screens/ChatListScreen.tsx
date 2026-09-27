import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { ChatUnavailable } from "../../../../src/components/chat/ChatUnavailable.tsx";
import { ConversationList } from "../../../../src/components/chat/ConversationList.tsx";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useChatState } from "../../../../src/lib/queries.ts";
import { threadPath } from "./chatPaths.ts";

/**
 * The chats: the launcher's conversation list — its search over names and
 * messages, the filter, the group invitations and **New group** — as the
 * list of the chats section. Picking a chat, or a message a search found,
 * is a navigation: the thread is a route of its own.
 */
export function ChatListScreen({ selectedId }: { selectedId: string | null }) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const navigate = useNavigate();
  const state = useChatState();

  if (state.isPending) {
    return (
      <p role="status" className="px-24 py-24 text-body-sm text-fg-muted">
        {t("surface.loading")}
      </p>
    );
  }
  if (state.isError) return <ChatUnavailable reason="failed" detail={errorText(state.error)} />;
  const view = state.data;
  if (!view.signedIn) return <ChatUnavailable reason="signedOut" />;
  if (!view.available) return <ChatUnavailable reason="noChat" />;

  return (
    <ConversationList
      state={view}
      selectedId={selectedId}
      onSelect={(conversationId) => void navigate(threadPath(conversationId))}
      onOpenMessage={(conversationId, seq) => void navigate(threadPath(conversationId, seq))}
      className="min-h-0 flex-1"
    />
  );
}

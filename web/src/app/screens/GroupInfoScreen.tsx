import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router";

import { GroupInfoPanel } from "../../../../src/components/chat/GroupInfoPanel.tsx";
import { useChatConversation } from "../../../../src/lib/queries.ts";
import { useWebCore } from "../CoreContext.tsx";
import { threadPath } from "./chatPaths.ts";

/**
 * The info of a group or a server chat: the launcher's panel — members,
 * **Add friends**, the history switch, the notification level, **Leave** —
 * in the details column of a wide screen, or full screen on a phone. The
 * layout draws the title and the way back, so the panel leaves its own out.
 * `?mode=rename` opens it on the name field, `?mode=add` on **Add friends**.
 */
export function GroupInfoScreen({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation("chat");
  const core = useWebCore();
  const synced = useSyncExternalStore(core.chat.subscribe, core.chat.synced, core.chat.synced);
  const conversation = useChatConversation(conversationId);
  const navigate = useNavigate();
  const location = useLocation();
  const mode = new URLSearchParams(location.search).get("mode");

  if (conversation === null) {
    return (
      <p role="status" className="px-16 py-24 text-body-sm text-fg-muted">
        {synced ? t("thread.gone") : t("thread.loading")}
      </p>
    );
  }
  // A direct chat has no info of its own: the thread is all there is.
  if (conversation.kind === "direct") return <Navigate to={threadPath(conversationId)} replace />;

  return (
    <GroupInfoPanel
      key={`${conversationId}:${mode ?? "view"}`}
      conversation={conversation}
      header={false}
      renaming={mode === "rename"}
      adding={mode === "add"}
      onClose={() => void navigate(threadPath(conversationId))}
      onLeft={() => void navigate("/chats", { replace: true })}
    />
  );
}

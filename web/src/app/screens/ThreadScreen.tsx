import { MessageCircle } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";

import { GroupInviteBanner } from "../../../../src/components/chat/GroupInviteBanner.tsx";
import { Thread } from "../../../../src/components/chat/Thread.tsx";
import { useChatMeId, useChatState } from "../../../../src/lib/queries.ts";
import { useWebCore } from "../CoreContext.tsx";
import { useLayoutActions } from "../layouts/LayoutActions.ts";
import { infoPath, jumpSeq, threadPath } from "./chatPaths.ts";

/**
 * One conversation: the launcher's thread — header, messages, composer —
 * under the route `/c/:conversationId`.
 *
 * The thread draws its own header (the layout leaves its own out): on the
 * phone with the way up in front, on a wide screen without it. The info of a
 * group or a server chat opens as the route `/c/:id/info`, the details
 * column. An id that is a group invitation shows the invitation. Until the
 * core has read the chats the screen waits; if the chat is still unknown
 * after that — a stale link, a push of a chat the player left — it says so.
 */
export function ThreadScreen({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation("chat");
  const { t: tWeb } = useTranslation("web");
  const core = useWebCore();
  const synced = useSyncExternalStore(core.chat.subscribe, core.chat.synced, core.chat.synced);
  const state = useChatState().data;
  const meId = useChatMeId();
  const navigate = useNavigate();
  const location = useLocation();
  const { up } = useLayoutActions();

  const at = jumpSeq(location.search);
  // A new jump for each visit of the address, so the same hit found twice scrolls twice.
  const jump = useMemo(() => (at === null ? null : { seq: at, key: Date.now() }), [at, location.key]);

  const conversation = state?.conversations.find((entry) => entry.id === conversationId) ?? null;
  const invite =
    conversation === null ? (state?.groupInvites.find((entry) => entry.conversationId === conversationId) ?? null) : null;

  const back = up ?? undefined;
  const toList = () => void navigate("/chats", { replace: true });

  if (conversation === null && invite === null) {
    if (state === undefined || !synced) {
      return (
        <div data-testid="thread-waiting" className="flex flex-1 flex-col items-center justify-center gap-8 p-24 text-center">
          <MessageCircle size={24} className="text-fg-muted" />
          <p role="status" className="text-body-sm text-fg-muted">
            {t("thread.loading")}
          </p>
        </div>
      );
    }
    return (
      <div data-testid="thread-gone" className="flex flex-1 flex-col items-center justify-center gap-12 p-24 text-center">
        <p className="text-body-md text-fg-secondary">{t("thread.gone")}</p>
        <Link to="/chats" replace className="text-body-md-medium text-fg-accent hover:underline">
          {t("thread.back")}
        </Link>
      </div>
    );
  }

  if (invite !== null) {
    return (
      <GroupInviteBanner
        invite={invite}
        onBack={back}
        onJoined={(id) => void navigate(threadPath(id), { replace: true })}
        onDeclined={toList}
      />
    );
  }

  const guest = conversation?.kind === "server" && meId !== null && conversation.server?.hostId !== meId;

  return (
    <Thread
      conversationId={conversationId}
      variant={up === null ? "split" : "stacked"}
      onBack={back}
      jump={jump}
      onOpenMessage={(id, seq) => void navigate(threadPath(id, seq))}
      onGone={toList}
      onInfo={(mode) => void navigate(infoPath(conversationId, mode === "view" ? undefined : mode))}
      composerNote={
        guest ? (
          <p data-testid="guest-note" className="px-16 pb-4 text-body-sm text-fg-muted">
            {tWeb("serverChats.guestNote")}
          </p>
        ) : null
      }
    />
  );
}

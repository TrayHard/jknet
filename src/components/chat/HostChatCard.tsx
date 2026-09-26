import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { serverChatOf } from "../../lib/chat/groups";
import {
  useChatMeId,
  useChatState,
  useHostChatEnded,
  useOnlineConfigured,
  useSetHistoryForNewMembers,
} from "../../lib/queries";
import { Badge, Button, Toggle } from "../ui";
import { useOpenChat } from "./useOpenChat";

interface HostChatCardProps {
  /** The hosted session, 16 hex characters: the server chat names it. */
  sessionId: string;
  /** The server is stopping: its chat goes with it. */
  stopping?: boolean;
}

/**
 * --- slice: chat groups ---
 *
 * The chat of the running private server on the Play with friends screen:
 * **Open chat**, and the host's switch «New members see history» (D1).
 *
 * The core opens the chat after the first heartbeat that carries the
 * hosting, so for a few seconds after the start there is nothing to switch
 * yet; the switch waits, off, and says why. Every new server starts with it
 * off. The chat is found by the session each time: a chat the service ended
 * while the server still runs comes back under a new id, while one the host
 * ended with **End chat** stays ended until the next server, and the card
 * says that instead.
 *
 * Nothing shows without chats: a build without JKNet Online, a player who is
 * signed out, a service that has no chats yet.
 */
export function HostChatCard({ sessionId, stopping = false }: HostChatCardProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const configured = useOnlineConfigured();
  const state = useChatState().data;
  const meId = useChatMeId();
  const history = useSetHistoryForNewMembers();
  const openChat = useOpenChat();
  const ended = useHostChatEnded(sessionId);

  if (configured === false || state === undefined || !state.signedIn || !state.available) return null;
  const chat = serverChatOf(state.conversations, sessionId, meId);
  const ready = chat !== null && !stopping;

  return (
    <section aria-label={t("hostChat.title")} className="flex flex-col gap-12 rounded-lg border border-line bg-surface p-16">
      <div className="flex items-center gap-12">
        <h3 className="text-heading-sm text-fg">{t("hostChat.title")}</h3>
        {chat !== null ? (
          <Badge tone="success" className="shrink-0">
            {t("list.live")}
          </Badge>
        ) : null}
        <Button
          size="sm"
          icon={<MessageCircle size={14} />}
          className="ml-auto"
          disabled={!ready}
          onClick={() => chat !== null && openChat(chat.id)}
        >
          {t("hostChat.open")}
        </Button>
      </div>
      <p className="text-body-sm text-fg-secondary">{t("hostChat.text")}</p>
      <div className="flex items-start gap-12">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-body-md text-fg">{t("info.historySwitch")}</span>
          <span className="text-body-sm text-fg-muted">{t("hostChat.historyHint")}</span>
        </div>
        <Toggle
          checked={chat?.historyForNewMembers ?? false}
          disabled={!ready || history.isPending}
          label={t("info.historySwitch")}
          onChange={(on) => chat !== null && history.mutate({ conversationId: chat.id, on })}
        />
      </div>
      {chat === null && !stopping ? (
        <p className="text-body-sm text-fg-muted">{ended ? t("hostChat.ended") : t("hostChat.pending")}</p>
      ) : null}
      {history.error ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {errorText(history.error)}
        </p>
      ) : null}
    </section>
  );
}

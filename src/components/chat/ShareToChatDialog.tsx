import { Clapperboard, MessageCircle, Search, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { cardDetail, cardTitle, readCard } from "../../lib/chat/cardDrafts";
import { fold, peerOf, sortConversations } from "../../lib/chat/conversation";
import { cn } from "../../lib/format";
import type { ChatCard, Conversation } from "../../lib/ipc";
import {
  useChatState,
  useFriendsState,
  useOnlineConfigured,
  useShareToChat,
  useStageChatFiles,
} from "../../lib/queries";
import { useToasts } from "../ToastsProvider";
import { Avatar, Button, Dialog, Input } from "../ui";
import { CARD_ICONS } from "./cards/icons";
import { ConversationAvatar } from "./ConversationAvatar";
import { MAX_BODY_CHARS } from "./Composer";
import { useOpenChat } from "./useOpenChat";
import { useChatNames } from "./useChatText";

/**
 * What a screen shares: a card it built, a card the core builds on the way
 * (a player profile), or a file of the Media screen, which the core stages.
 */
export type ShareSource =
  | { kind: "card"; card: ChatCard }
  | { kind: "build"; build: () => Promise<ChatCard> }
  | { kind: "media"; mediaId: string; name: string };

/** Where a share goes: a conversation, or a friend whose direct chat is made on the way. */
type Target = { conversationId: string } | { friendId: string };

function targetKey(target: Target): string {
  return "conversationId" in target ? `c:${target.conversationId}` : `f:${target.friendId}`;
}

/**
 * --- slice: chat cards ---
 *
 * **Share to chat** of the screens: a server, the private server, a bundle, a
 * JKHub file, a Media item, a player profile, a config, key binds, a map.
 *
 * The dialog shows what goes — the kind and the title of the card, or the
 * name of the file — and lists where it can go: the chats that take
 * messages, newest first, then the friends without a chat yet, whose chat is
 * made on the way. A few words may go with it. After **Send** the message is
 * in the outbox; a toast says where it went and opens that chat.
 */
export function ShareToChatDialog({ source, onClose }: { source: ShareSource; onClose: () => void }) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const names = useChatNames();
  const state = useChatState();
  const friends = useFriendsState().data?.friends;
  const share = useShareToChat();
  const stage = useStageChatFiles();
  const toasts = useToasts();
  const openChat = useOpenChat();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Target | null>(null);
  const [text, setText] = useState("");
  const [card, setCard] = useState<ChatCard | null>(source.kind === "card" ? source.card : null);
  const [prepareError, setPrepareError] = useState<unknown>(null);

  // A card the core builds — a player profile — is asked for once, when the
  // dialog opens, so its preview and its refusal show before anything goes.
  useEffect(() => {
    if (source.kind !== "build") return;
    let live = true;
    source
      .build()
      .then((built) => live && setCard(built))
      .catch((error: unknown) => live && setPrepareError(error));
    return () => {
      live = false;
    };
    // The source is fixed for the life of the dialog.
  }, []);

  const view = state.data;
  const usable = view !== undefined && view.signedIn && view.available;
  const needle = fold(query.trim());

  const rows = useMemo(() => {
    const out: Array<{ target: Target; title: string; hint: string; avatar: ReactNode }> = [];
    if (!usable || view === undefined) return out;
    const directPeers = new Set<string>();
    for (const conversation of sortConversations(view.conversations)) {
      const peer = conversation.kind === "direct" ? peerOf(conversation, names.meId) : null;
      if (peer !== null) directPeers.add(peer.id);
      if (!conversation.canSend) continue;
      out.push({
        target: { conversationId: conversation.id },
        title: names.title(conversation),
        hint: t(`share.kinds.${conversation.kind}`),
        avatar: <ConversationAvatar conversation={conversation} meId={names.meId} />,
      });
    }
    for (const friend of friends ?? []) {
      if (directPeers.has(friend.user.id)) continue;
      out.push({
        target: { friendId: friend.user.id },
        title: friend.user.displayName,
        hint: t("share.newChat"),
        avatar: <Avatar name={friend.user.displayName} src={friend.user.avatarUrl} status={friend.presence.status} />,
      });
    }
    return out;
  }, [usable, view, friends, names, t]);

  const shown = needle === "" ? rows : rows.filter((row) => fold(row.title).includes(needle));
  const pickedKey = picked === null ? null : targetKey(picked);
  const tooLong = Array.from(text).length > MAX_BODY_CHARS;
  const ready = source.kind === "media" || card !== null;
  const busy = share.isPending || stage.media.isPending;

  const send = () => {
    if (picked === null || !ready || busy || tooLong) return;
    const title = rows.find((row) => targetKey(row.target) === pickedKey)?.title ?? "";
    const done = (conversation: Conversation) => {
      const id = `chat-share:${conversation.id}`;
      toasts.show(id, {
        variant: "success",
        title: t("share.sent", { name: title }),
        action: (
          <Button
            size="sm"
            variant="primary"
            icon={<MessageCircle size={14} />}
            onClick={() => {
              toasts.dismiss(id);
              openChat(conversation.id);
            }}
          >
            {t("share.open")}
          </Button>
        ),
      });
      window.setTimeout(() => toasts.dismiss(id), 8_000);
      onClose();
    };
    const body = text.trim();
    if (source.kind === "media") {
      stage.media.mutate(source.mediaId, {
        onSuccess: (file) =>
          share.mutate(
            { target: picked, draft: { body, cards: [], attachments: [file.handle], replySeq: null } },
            {
              onSuccess: done,
              onError: () => stage.unstage.mutate(file.handle),
            },
          ),
      });
      return;
    }
    if (card === null) return;
    share.mutate({ target: picked, draft: { body, cards: [card], attachments: [], replySeq: null } }, { onSuccess: done });
  };

  const failure = prepareError ?? stage.media.error ?? share.error;

  return (
    <Dialog
      wide
      title={t("share.title")}
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            icon={<Send size={14} />}
            disabled={!usable || picked === null || !ready || busy || tooLong}
            onClick={send}
          >
            {busy ? t("share.sending") : t("share.send")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12 pt-12">
        <SharePreview source={source} card={card} />
        {!usable ? (
          <p className="text-body-sm text-fg-muted">
            {view === undefined && state.isPending ? t("surface.loading") : t("share.unavailable")}
          </p>
        ) : (
          <>
            <Input
              icon={<Search size={14} />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("share.search")}
              aria-label={t("share.search")}
            />
            <ul role="listbox" aria-label={t("share.targets")} className="flex max-h-[34vh] min-h-96 flex-col gap-2 overflow-y-auto">
              {shown.length === 0 ? (
                <li className="px-8 py-12 text-body-sm text-fg-muted">
                  {rows.length === 0 ? t("share.empty") : t("share.noMatch", { query: query.trim() })}
                </li>
              ) : (
                shown.map((row) => {
                  const key = targetKey(row.target);
                  const selected = key === pickedKey;
                  return (
                    <li key={key} role="option" aria-selected={selected}>
                      <button
                        type="button"
                        onClick={() => setPicked(row.target)}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-10 rounded-md px-8 py-6 text-left select-none cursor-pointer",
                          selected ? "bg-accent-subtle ring-1 ring-inset ring-line-accent" : "hover:bg-hover-overlay",
                        )}
                      >
                        {row.avatar}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-body-sm-medium text-fg [unicode-bidi:isolate]">{row.title}</span>
                          <span className="truncate text-body-sm text-fg-muted">{row.hint}</span>
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
            <label className="flex flex-col gap-6 text-body-sm text-fg-secondary">
              {t("share.message")}
              <textarea
                rows={2}
                dir="auto"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
                className={cn(
                  "resize-none rounded-md border bg-input px-10 py-6 text-body-md text-fg outline-none [overflow-wrap:anywhere]",
                  tooLong ? "border-line-danger" : "border-line focus:border-line-focus",
                )}
              />
            </label>
          </>
        )}
        {failure ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {errorText(failure)}
          </p>
        ) : tooLong ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {t("composer.tooLong", { max: MAX_BODY_CHARS })}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** What goes: the mark and the title of the card, or the name of the Media file. */
function SharePreview({ source, card }: { source: ShareSource; card: ChatCard | null }) {
  const { t } = useTranslation("chat");
  const parsed = card === null ? null : readCard(card);
  const title =
    source.kind === "media" ? source.name : parsed !== null ? cardTitle(parsed) : (card?.fallbackText ?? t("share.preparing"));
  const kind = source.kind === "media" ? t("share.mediaFile") : parsed !== null ? t(`cards.kinds.${parsed.type}`) : t("summary.card");
  const detail = parsed !== null ? cardDetail(parsed) : null;
  const Icon = source.kind === "media" ? Clapperboard : parsed !== null ? CARD_ICONS[parsed.type] : MessageCircle;
  return (
    <div className="flex min-w-0 items-center gap-10 rounded-md border border-line bg-input px-10 py-8">
      <span aria-hidden="true" className="flex size-32 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-fg-accent">
        <Icon size={16} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body-sm-medium text-fg [unicode-bidi:isolate]" title={title}>
          {title || kind}
        </span>
        <span className="truncate text-body-sm text-fg-muted">
          {kind}
          {detail ? ` · ${detail}` : ""}
        </span>
      </span>
    </div>
  );
}

/**
 * The **Share to chat** of a screen: `open` with what to share, render
 * `dialog`. `available` is whether chats are on at all — this build has a
 * service, a player is signed in and the service has chats — so a screen can
 * leave the button out rather than offer one that leads nowhere.
 */
export function useShareDialog(): { available: boolean; open: (source: ShareSource) => void; dialog: ReactNode } {
  const configured = useOnlineConfigured();
  const state = useChatState().data;
  const [source, setSource] = useState<ShareSource | null>(null);
  const open = useCallback((next: ShareSource) => setSource(next), []);
  const available = configured !== false && state !== undefined && state.signedIn && state.available;
  const dialog = source === null ? null : <ShareToChatDialog source={source} onClose={() => setSource(null)} />;
  return { available, open, dialog };
}

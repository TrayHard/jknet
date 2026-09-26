import { ArrowDown, EyeOff, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { layoutThread } from "../../lib/chat/grouping";
import { flattenPages } from "../../lib/chat/mergeMessages";
import { badgeLabel } from "../../lib/chat/unread";
import { cn } from "../../lib/format";
import type { ChatKind, ChatMessage } from "../../lib/ipc";
import {
  useChatConversation,
  useChatMeId,
  useChatOutbox,
  useChatThread,
  useChatThreadJumps,
  useReportChatViewing,
} from "../../lib/queries";
import { Button, Input } from "../ui";
import { ChatSearchResults } from "./ChatSearchResults";
import { Composer } from "./Composer";
import { DayDivider } from "./DayDivider";
import { useLinkOpener } from "./LinkConfirmDialog";
import { MessageGroup } from "./MessageGroup";
import { OutboxStatus } from "./OutboxStatus";
import { SystemMessage } from "./SystemMessage";
import { ThreadContext, type ThreadActions } from "./ThreadContext";
import { ThreadHeader } from "./ThreadHeader";
import { TypingLine } from "./TypingLine";
import { UnreadDivider } from "./UnreadDivider";
import { useChatNames } from "./useChatText";

/** The three shapes a chat surface takes. */
export type ChatSurfaceVariant = "split" | "stacked" | "compact";

/** A jump the surface asks for: a search hit. `key` makes the same jump twice a new one. */
export interface ThreadJump {
  seq: number;
  key: number;
}

interface ThreadProps {
  conversationId: string;
  variant: ChatSurfaceVariant;
  /** The back arrow of the stacked and compact layouts. */
  onBack?: () => void;
  /** Buttons the layout adds to the header. */
  headerActions?: ReactNode;
  jump?: ThreadJump | null;
}

/** Closer to the top than this, the older page is fetched. */
const LOAD_EDGE_PX = 400;
/** Closer to the bottom than this counts as being at the bottom. */
const BOTTOM_PX = 48;
/** How long a message a jump landed on stays highlighted. */
const HIGHLIGHT_MS = 2_000;

/** The message on screen the view is held by while pages come and go around it. */
interface Anchor {
  seq: string;
  offset: number;
}

/**
 * --- slice: chat ---
 *
 * One conversation: the header, the messages and the composer.
 *
 * The thread loads its newest page and walks back a page at a time as the
 * player scrolls up; it keeps at most a dozen pages, dropping the far end and
 * reading it again when the player comes back, so a long history never sits
 * in the DOM whole. The view is held by the message on screen while pages
 * are added or dropped above it, and follows new messages only while it is at
 * the bottom. It opens at the **New messages** divider when there is one.
 *
 * The window reports what it shows, which is what the core reads messages as
 * read by and holds notifications back for.
 */
export function Thread({ conversationId, variant, onBack, headerActions, jump = null }: ThreadProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const names = useChatNames();
  const conversation = useChatConversation(conversationId);
  const meId = useChatMeId();
  const thread = useChatThread(conversationId);
  const jumps = useChatThreadJumps(conversationId);
  const outbox = useChatOutbox(conversationId);
  const link = useLinkOpener();
  const dense = variant === "compact";

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const scroller = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<Anchor | null>(null);
  const openedFor = useRef<string | null>(null);
  const scrollTo = useRef<number | null>(null);

  // Where reading starts, as it was when the thread opened. Read during the
  // render so the first frame already has the divider it scrolls to.
  const unreadAt = useRef<{ id: string; seq: number } | null>(null);
  if (conversation !== null && unreadAt.current?.id !== conversationId) {
    unreadAt.current = { id: conversationId, seq: Math.max(conversation.readSeq, conversation.visibleFromSeq) };
  }
  const unreadAfter = unreadAt.current?.id === conversationId ? unreadAt.current.seq : null;

  useEffect(() => {
    setReplyTo(null);
    setHighlight(null);
    setSearching(false);
    setSearchQuery("");
    stick.current = true;
    anchor.current = null;
  }, [conversationId]);

  const messages = useMemo(() => flattenPages(thread.data?.pages ?? []), [thread.data]);
  const items = useMemo(
    () => layoutThread(messages, { meId, unreadAfterSeq: unreadAfter }),
    [messages, meId, unreadAfter],
  );
  const readMarkSeq = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.kind === "user" && meId !== null && message.senderId === meId) return message.seq;
    }
    return null;
  }, [messages, meId]);

  const hasBefore = thread.hasPreviousPage;
  const hasAfter = thread.hasNextPage;
  const loaded = thread.isSuccess;

  /**
   * The first message on screen and how far below the top of the view it sits.
   *
   * The blocks of the thread are measured first and only the first visible
   * one is searched for its message: a block off screen is skipped by
   * `content-visibility`, and measuring the messages inside it would lay it
   * out again on every scroll.
   */
  const captureAnchor = useCallback(() => {
    const node = scroller.current;
    if (node === null) return;
    const top = node.getBoundingClientRect().top;
    for (const block of node.querySelectorAll<HTMLElement>("[data-block]")) {
      if (block.getBoundingClientRect().bottom <= top) continue;
      for (const element of block.querySelectorAll<HTMLElement>("[data-seq]")) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > top) {
          anchor.current = { seq: element.dataset.seq ?? "", offset: rect.top - top };
          return;
        }
      }
    }
    anchor.current = null;
  }, []);

  const fetchOlder = thread.fetchPreviousPage;
  const fetchNewer = thread.fetchNextPage;
  const fetchingOlder = thread.isFetchingPreviousPage;
  const fetchingNewer = thread.isFetchingNextPage;

  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (node === null) return;
    const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const bottom = fromBottom < BOTTOM_PX;
    stick.current = bottom && !hasAfter;
    setAtBottom(bottom && !hasAfter);
    captureAnchor();
    if (node.scrollTop < LOAD_EDGE_PX && hasBefore && !fetchingOlder) void fetchOlder();
    if (fromBottom < LOAD_EDGE_PX && hasAfter && !fetchingNewer) void fetchNewer();
  }, [hasAfter, hasBefore, fetchingOlder, fetchingNewer, fetchOlder, fetchNewer, captureAnchor]);

  // After every change of the messages: open at the divider or at the bottom
  // the first time, follow the bottom while stuck to it, and otherwise hold
  // the message that was on screen where it was.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null || !loaded) return;
    const target =
      scrollTo.current === null ? null : node.querySelector<HTMLElement>(`[data-seq="${scrollTo.current}"]`);
    if (target !== null) {
      // A jump wins over everything, the first opening included: a search
      // hit opens its thread on the hit, not on the divider.
      node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - node.clientHeight / 3;
      stick.current = false;
      scrollTo.current = null;
      openedFor.current = conversationId;
    } else if (openedFor.current !== conversationId) {
      openedFor.current = conversationId;
      if (divider.current !== null) {
        node.scrollTop += divider.current.getBoundingClientRect().top - node.getBoundingClientRect().top - 24;
        stick.current = false;
      } else {
        node.scrollTop = node.scrollHeight;
        stick.current = true;
      }
    } else if (stick.current) {
      node.scrollTop = node.scrollHeight;
    } else if (anchor.current !== null) {
      const element = node.querySelector<HTMLElement>(`[data-seq="${anchor.current.seq}"]`);
      if (element !== null) {
        node.scrollTop += element.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.current.offset;
      }
    }
    captureAnchor();
    const fromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setAtBottom(fromBottom < BOTTOM_PX && !hasAfter);
    // A first page shorter than the view leaves nothing to scroll: fetch on.
    if (node.scrollHeight <= node.clientHeight + BOTTOM_PX && hasBefore && !fetchingOlder) void fetchOlder();
  }, [items, outbox.length, loaded, conversationId, hasAfter, hasBefore, fetchingOlder, fetchOlder, captureAnchor]);

  const jumpTo = useCallback(
    (seq: number) => {
      void jumps.jumpTo(seq).then((found) => {
        if (!found) return;
        scrollTo.current = seq;
        stick.current = false;
        setHighlight(seq);
        window.setTimeout(() => setHighlight((current) => (current === seq ? null : current)), HIGHLIGHT_MS);
        // Already loaded: no data change comes to run the layout effect.
        requestAnimationFrame(() => {
          const node = scroller.current;
          const target = node?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
          if (node && target && scrollTo.current === seq) {
            node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - node.clientHeight / 3;
            scrollTo.current = null;
            captureAnchor();
          }
        });
      });
    },
    [jumps, captureAnchor],
  );

  useEffect(() => {
    if (jump !== null) jumpTo(jump.seq);
  }, [jump, jumpTo]);

  const toBottom = () => {
    stick.current = true;
    if (hasAfter) {
      void jumps.toPresent();
      return;
    }
    const node = scroller.current;
    if (node !== null) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };

  useReportChatViewing(
    conversation === null ? null : conversationId,
    atBottom && loaded && !hasAfter,
    conversation?.canSend ?? false,
  );

  const actions = useMemo<ThreadActions | null>(
    () =>
      conversation === null
        ? null
        : {
            conversation,
            meId,
            onReply: setReplyTo,
            onJump: jumpTo,
            onLink: link.open,
            highlightSeq: highlight,
            readMarkSeq,
          },
    [conversation, meId, jumpTo, link.open, highlight, readMarkSeq],
  );

  if (conversation === null || actions === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-8 p-24 text-center text-body-sm text-fg-muted">
        {onBack ? (
          <Button size="sm" variant="ghost" onClick={onBack}>
            {t("thread.back")}
          </Button>
        ) : null}
        {t("thread.gone")}
      </div>
    );
  }

  const title = names.title(conversation);
  const empty = loaded && messages.length === 0 && outbox.length === 0;

  return (
    <ThreadContext value={actions}>
      <div className="flex h-full min-h-0 flex-col">
        <ThreadHeader
          conversation={conversation}
          onBack={onBack}
          onSearch={() => setSearching((open) => !open)}
          searching={searching}
          actions={headerActions}
          dense={dense}
        />

        {searching ? (
          <div className="flex max-h-[45%] shrink-0 flex-col border-b border-line-subtle">
            <div className="p-8">
              <Input
                autoFocus
                icon={<Search size={14} />}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("thread.searchPlaceholder", { name: title })}
                aria-label={t("thread.search")}
                className="h-32"
                trailing={
                  <button
                    type="button"
                    aria-label={t("thread.closeSearch")}
                    title={t("thread.closeSearch")}
                    onClick={() => setSearching(false)}
                    className="flex size-20 items-center justify-center rounded-xs text-fg-muted cursor-pointer hover:text-fg"
                  >
                    <X size={12} />
                  </button>
                }
              />
            </div>
            {searchQuery.trim() !== "" ? (
              <div className="min-h-0 overflow-y-auto px-4 pb-8">
                <ChatSearchResults
                  query={searchQuery}
                  conversationId={conversationId}
                  onOpenMessage={(_, seq) => jumpTo(seq)}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            onScroll={onScroll}
            className="h-full overflow-y-auto pb-8 [overflow-anchor:none]"
            role="log"
            aria-label={t("thread.messages", { name: title })}
          >
            {thread.isPending ? (
              <p className="p-24 text-center text-body-sm text-fg-muted">{t("thread.loading")}</p>
            ) : thread.isError ? (
              <div className="flex flex-col items-center gap-8 p-24 text-center">
                <p role="alert" className="text-body-sm text-fg-danger">{errorText(thread.error)}</p>
                <Button size="sm" onClick={() => void thread.refetch()}>
                  {t("thread.retry")}
                </Button>
              </div>
            ) : (
              <>
                {hasBefore ? (
                  <p className="p-12 text-center text-body-sm text-fg-muted">
                    {fetchingOlder ? t("thread.loadingOlder") : " "}
                  </p>
                ) : (
                  <ThreadStart hidden={conversation.visibleFromSeq > 0} kind={conversation.kind} />
                )}
                {empty ? (
                  <div className="flex flex-col items-center gap-4 px-24 py-32 text-center">
                    <p className="text-heading-sm text-fg">{t("thread.emptyTitle")}</p>
                    <p className="text-body-sm text-fg-muted">
                      {conversation.kind === "server"
                        ? t("thread.emptyServer")
                        : t("thread.emptyText", { name: title })}
                    </p>
                  </div>
                ) : null}
                {items.map((item) => {
                  switch (item.type) {
                    case "day":
                      return <DayDivider key={item.key} at={item.at} />;
                    case "unread":
                      return <UnreadDivider key={item.key} ref={divider} />;
                    case "system":
                      return (
                        <div key={item.key} data-block="">
                          <SystemMessage message={item.message} highlighted={highlight === item.message.seq} />
                        </div>
                      );
                    case "group":
                      // Off screen, a group is not rendered at all: the thread
                      // keeps hundreds of them without paying for their layout.
                      return (
                        <div
                          key={item.key}
                          data-block=""
                          className="[content-visibility:auto] [contain-intrinsic-size:auto_64px]"
                        >
                          <MessageGroup senderId={item.senderId} mine={item.mine} messages={item.messages} />
                        </div>
                      );
                  }
                })}
                {hasAfter && fetchingNewer ? (
                  <p className="p-12 text-center text-body-sm text-fg-muted">{t("thread.loadingNewer")}</p>
                ) : null}
                <OutboxStatus entries={outbox} />
              </>
            )}
          </div>

          {!atBottom && loaded ? (
            <button
              type="button"
              aria-label={t("thread.toLatest")}
              title={t("thread.toLatest")}
              onClick={toBottom}
              className="absolute right-16 bottom-12 flex size-36 items-center justify-center rounded-full border border-line-strong bg-elevated text-fg-secondary shadow-popover cursor-pointer hover:text-fg"
            >
              <ArrowDown size={16} />
              {conversation.unread > 0 ? (
                <span className="absolute -top-6 -right-4 inline-flex h-18 min-w-18 items-center justify-center rounded-full bg-accent px-4 text-label-xs text-fg-on-accent">
                  {badgeLabel(conversation.unread)}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>

        <TypingLine conversationId={conversationId} />
        <Composer
          conversation={conversation}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          onSent={() => {
            stick.current = true;
            if (hasAfter) void jumps.toPresent();
          }}
          dense={dense}
        />
      </div>
      {link.dialog}
    </ThreadContext>
  );
}

/**
 * The top of a thread whose history is all loaded: how long messages are
 * kept, and — for a player who joined later — that the history before is
 * hidden and who can change that.
 */
function ThreadStart({ hidden, kind }: { hidden: boolean; kind: ChatKind }) {
  const server = kind === "server";
  const { t } = useTranslation("chat");
  if (hidden) {
    return (
      <div className="mx-16 mt-12 flex items-start gap-8 rounded-md border border-line bg-surface px-12 py-10">
        <EyeOff size={14} className="mt-2 shrink-0 text-fg-muted" />
        <div className="flex flex-col gap-2">
          <p className="text-body-sm text-fg">{t("thread.historyHidden")}</p>
          <p className="text-body-sm text-fg-muted">
            {server ? t("thread.historyHiddenServer") : t("thread.historyHiddenGroup")}
          </p>
        </div>
      </div>
    );
  }
  return (
    <p className={cn("px-16 pt-12 pb-4 text-center text-body-sm text-fg-muted")}>
      {server ? t("thread.retentionServer") : t("thread.retention")}
    </p>
  );
}

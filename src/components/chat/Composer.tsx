import { Lock, SendHorizontal, Smile } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { fold, peerOf } from "../../lib/chat/conversation";
import {
  decodeMentions,
  encodeMentions,
  insertMention,
  mentionQueryAt,
  type MentionPick,
  type MentionQuery,
} from "../../lib/chat/mentions";
import { CARDS_MAX } from "../../lib/chat/cardDrafts";
import { cn } from "../../lib/format";
import type { ChatCard, ChatMessage, ChatStagedFile, Conversation, OnlineUser } from "../../lib/ipc";
import {
  useChatDraft,
  useChatDroppedFiles,
  useChatTypingPing,
  useSendChatMessage,
  useSetChatDraft,
  useStageChatFiles,
} from "../../lib/queries";
import { ATTACH_KINDS, AttachMenu, type AttachKind } from "./AttachMenu";
import { AttachmentTray } from "./AttachmentTray";
import { Layer } from "./Layer";
import { AttachPicker } from "./pickers/AttachPicker";
import { EmojiPopover } from "./EmojiPopover";
import { MentionPopover } from "./MentionPopover";
import { ReplyBar } from "./ReplyBar";
import { useChatNames } from "./useChatText";

/** The service's limit on a message body, in characters. */
export const MAX_BODY_CHARS = 4000;
/** The counter shows from here on. */
const COUNTER_FROM = 3600;
/** The composer grows up to this height, then scrolls. */
const MAX_HEIGHT = 160;
/** How long the draft waits after the last key before it goes to the core. */
const DRAFT_DEBOUNCE_MS = 400;
/** Members the mention list offers at once. */
const MENTION_LIMIT = 8;

interface ComposerProps {
  conversation: Conversation;
  replyTo: ChatMessage | null;
  onClearReply: () => void;
  /** After a send: the thread scrolls to the bottom. */
  onSent?: () => void;
  dense?: boolean;
}

/** At most this many files go with one message: the service's limit. */
const FILES_MAX = 10;
/** Every kind of the attach menu: the cards slice gave each its picker. */
const ALL_KINDS: ReadonlySet<AttachKind> = new Set(ATTACH_KINDS);

/**
 * --- slice: chat ---
 *
 * Where a message is written: the reply bar, the staged files, the text
 * field with its `@` list, and the attach, emoji and send buttons.
 *
 * Enter sends and Shift+Enter breaks the line. The draft lives in the core
 * and follows the player between the drawer and the chat window; a mention
 * is kept as `@Name` in the field and turned into its token when the message
 * leaves. A chat that cannot take messages any more — a friend removed, an
 * account deleted — shows why instead of a field.
 */
export function Composer({
  conversation,
  replyTo,
  onClearReply,
  onSent,
  dense = false,
}: ComposerProps) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const names = useChatNames();
  const conversationId = conversation.id;

  const draft = useChatDraft(conversationId);
  const setDraft = useSetChatDraft();
  const send = useSendChatMessage();
  const stage = useStageChatFiles();
  const dropped = useChatDroppedFiles();
  const ping = useChatTypingPing(conversationId);

  const [text, setText] = useState("");
  const [picks, setPicks] = useState<MentionPick[]>([]);
  const [staged, setStaged] = useState<ChatStagedFile[]>([]);
  // --- slice: chat cards --- the cards picked for the next message, and
  // the picker of the attach menu while one is open.
  const [cards, setCards] = useState<ChatCard[]>([]);
  const [picking, setPicking] = useState<AttachKind | null>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const loadedFor = useRef<string | null>(null);
  const lastSaved = useRef("");
  // --- slice: chat layout --- what the timer below has not saved yet, and
  // whether a draft of the core was put into the field since it last ran.
  const unsaved = useRef<{ conversationId: string; text: string } | null>(null);
  const justLoaded = useRef(false);

  // A new conversation starts from its own draft and its own files.
  useEffect(() => {
    loadedFor.current = null;
    setText("");
    setPicks([]);
    setStaged([]);
    setCards([]);
    setPicking(null);
    setMention(null);
    setError(null);
  }, [conversationId]);

  // The draft of the core, once it is read, and again when another window
  // changed it while this field is not the one being typed in.
  const nameOf = (id: string) => names.person(id)?.displayName ?? null;
  useEffect(() => {
    const stored = draft.data;
    if (stored === undefined) return;
    const focused = document.activeElement === field.current;
    if (loadedFor.current === conversationId && (focused || stored === lastSaved.current)) return;
    loadedFor.current = conversationId;
    lastSaved.current = stored;
    // --- slice: chat layout --- the field is replaced: nothing typed is pending.
    unsaved.current = null;
    justLoaded.current = true;
    const decoded = decodeMentions(stored, nameOf, t("people.deleted"));
    setText(decoded.text);
    setPicks(decoded.picks);
    // Only a new draft or a new conversation re-reads the field: the names
    // and the translation changing under a draft being typed must not.
  }, [draft.data, conversationId]);

  // The draft goes to the core a moment after the last key.
  const body = useMemo(() => encodeMentions(text, picks), [text, picks]);
  useEffect(() => {
    if (loadedFor.current !== conversationId) return;
    // --- slice: chat layout --- run in the commit of a load, this effect
    // still sees the text from before it; the render with the loaded text
    // follows and decides. Taken for typing, the old text would be saved
    // over the draft just read when the composer closes at once.
    if (justLoaded.current) {
      justLoaded.current = false;
      if (body !== lastSaved.current) return;
    }
    if (body === lastSaved.current) {
      unsaved.current = null;
      return;
    }
    unsaved.current = { conversationId, text: body };
    const timer = setTimeout(() => {
      unsaved.current = null;
      lastSaved.current = body;
      setDraft.mutate({ conversationId, text: body });
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // The mutation object changes identity on every state change of its own;
    // the text and the conversation are what start a save.
  }, [body, conversationId]);

  // --- slice: chat layout ---
  // A composer goes away with its thread: **Close** or `Escape` in the
  // drawer, **Back**, another chat. The keys of the last moment go to the
  // core then instead of waiting for a timer that no longer runs. The save is
  // read through a ref so that only leaving the conversation runs the flush,
  // whatever the identity of `mutate` does between renders.
  const saveDraft = useRef(setDraft.mutate);
  saveDraft.current = setDraft.mutate;
  useEffect(
    () => () => {
      const pending = unsaved.current;
      if (pending === null) return;
      unsaved.current = null;
      lastSaved.current = pending.text;
      saveDraft.current(pending);
    },
    [conversationId],
  );

  // --- slice: chat cards ---
  // Files and cards join the tray up to the service's limits; what does not
  // fit is left out with a line saying why, and a file the core staged for
  // nothing is let go at once.
  const addFiles = (files: ChatStagedFile[]) => {
    const room = FILES_MAX - staged.length;
    const taken = files.slice(0, Math.max(0, room));
    for (const file of files.slice(taken.length)) stage.unstage.mutate(file.handle);
    if (taken.length < files.length) setError(t("composer.tooManyFiles", { max: FILES_MAX }));
    if (taken.length > 0) setStaged((current) => [...current, ...taken]);
  };

  // Files dropped on the window, staged by the core, join the tray by the
  // same rule as picked ones: the cap holds, and what does not fit is let go.
  const takeDropped = dropped.take;
  useEffect(() => {
    if (dropped.count === 0 || !conversation.canSend) return;
    const files = takeDropped();
    if (files.length > 0) addFiles(files);
    // `addFiles` is new each render; a drop is what runs this, and the
    // render it runs after is the one whose tray it counts.
  }, [dropped.count, takeDropped, conversation.canSend]);

  // The field grows with its text up to `MAX_HEIGHT`, then scrolls.
  useLayoutEffect(() => {
    const node = field.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  // A reply puts the caret in the field.
  useEffect(() => {
    if (replyTo !== null) field.current?.focus();
  }, [replyTo]);

  const candidates = useMemo<OnlineUser[]>(() => {
    if (mention === null) return [];
    const needle = fold(mention.query);
    return conversation.members
      .map((member) => member.user)
      .filter((user) => user.id !== names.meId && fold(user.displayName).includes(needle))
      .sort((a, b) => Number(!fold(a.displayName).startsWith(needle)) - Number(!fold(b.displayName).startsWith(needle)))
      .slice(0, MENTION_LIMIT);
  }, [mention, conversation.members, names.meId]);

  if (!conversation.canSend) {
    const deleted = conversation.kind === "direct" && peerOf(conversation, names.meId) === null;
    return (
      <div className={cn("flex items-center gap-8 border-t border-line-subtle text-body-sm text-fg-muted", dense ? "px-10 py-8" : "px-16 py-12")}>
        <Lock size={14} className="shrink-0" />
        {deleted
          ? t("composer.deletedPeer")
          : conversation.kind === "direct"
            ? t("composer.notFriends")
            : t("composer.readOnly")}
      </div>
    );
  }

  const chars = Array.from(body).length;
  const tooLong = chars > MAX_BODY_CHARS;
  const empty = body.trim() === "" && staged.length === 0 && cards.length === 0;

  // --- slice: chat cards --- a card joins the tray up to the service's limit.
  const addCard = (card: ChatCard) => {
    if (cards.length >= CARDS_MAX) {
      setError(t("composer.tooManyCards", { max: CARDS_MAX }));
      return;
    }
    setError(null);
    setCards((current) => [...current, card]);
  };

  const updateMention = (value: string, caret: number) => {
    const next = mentionQueryAt(value, caret);
    setMention(next);
    if (next === null || next.query !== mention?.query) setActive(0);
  };

  const pick = (user: OnlineUser) => {
    const node = field.current;
    if (node === null || mention === null) return;
    const result = insertMention(text, mention, node.selectionStart, user.displayName);
    setText(result.text);
    setPicks((current) => [...current.filter((p) => p.id !== user.id), { id: user.id, name: user.displayName }]);
    setMention(null);
    requestAnimationFrame(() => {
      node.focus();
      node.setSelectionRange(result.caret, result.caret);
    });
  };

  const insertText = (value: string) => {
    const node = field.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + value + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(start + value.length, start + value.length);
    });
  };

  const submit = () => {
    if (empty || send.isPending) return;
    if (tooLong) {
      setError(t("composer.tooLong", { max: MAX_BODY_CHARS }));
      return;
    }
    setError(null);
    const message = body.replace(/^\s+|\s+$/g, "");
    // --- slice: chat layout --- the text goes into the outbox now, not
    // into a draft, even if the thread closes before the core answers.
    unsaved.current = null;
    send.mutate(
      {
        conversationId,
        draft: {
          body: message,
          cards,
          attachments: staged.map((file) => file.handle),
          replySeq: replyTo?.seq ?? null,
        },
      },
      {
        onSuccess: () => {
          setText("");
          setPicks([]);
          setStaged([]);
          setCards([]);
          setMention(null);
          lastSaved.current = "";
          setDraft.mutate({ conversationId, text: "" });
          onClearReply();
          onSent?.();
        },
        onError: (failure) => setError(errorText(failure)),
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (candidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(candidates[Math.min(active, candidates.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (event.key === "Escape" && replyTo !== null) {
      event.preventDefault();
      event.stopPropagation();
      onClearReply();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const hasImage = Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"));
    if (!hasImage) return;
    // The core reads the picture off the clipboard itself and strips it.
    event.preventDefault();
    stage.clipboard.mutate(undefined, {
      onSuccess: (file) => addFiles([file]),
      onError: (failure) => setError(errorText(failure)),
    });
  };

  const onAttach = (kind: AttachKind) => {
    if (kind === "file") {
      stage.pick.mutate(undefined, {
        onSuccess: (files) => addFiles(files),
        onError: (failure) => setError(errorText(failure)),
      });
    } else if (kind === "clipboard") {
      stage.clipboard.mutate(undefined, {
        onSuccess: (file) => addFiles([file]),
        onError: (failure) => setError(errorText(failure)),
      });
    } else {
      setPicking(kind);
    }
  };

  const placeholder =
    conversation.kind === "direct"
      ? t("composer.placeholderDirect", { name: names.title(conversation) })
      : t("composer.placeholderGroup", { name: names.title(conversation) });

  return (
    <div className="relative shrink-0 border-t border-line-subtle">
      {replyTo !== null ? <ReplyBar message={replyTo} onClear={onClearReply} /> : null}
      <AttachmentTray
        files={staged}
        onRemove={(handle) => {
          setStaged((current) => current.filter((file) => file.handle !== handle));
          stage.unstage.mutate(handle);
        }}
        cards={cards}
        onRemoveCard={(index) => setCards((current) => current.filter((_, at) => at !== index))}
      />
      <MentionPopover candidates={candidates} active={active} onPick={pick} onHover={setActive} />
      <div className={cn("flex items-end gap-4", dense ? "p-6" : "p-8")}>
        <AttachMenu available={ALL_KINDS} onPick={onAttach} />
        <textarea
          ref={field}
          rows={1}
          value={text}
          dir="auto"
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
            updateMention(event.target.value, event.target.selectionStart);
            if (event.target.value.trim() !== "") ping();
          }}
          onSelect={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => setMention(null)}
          className={cn(
            "min-h-32 flex-1 resize-none rounded-md border bg-input px-10 py-6 text-body-md text-fg outline-none",
            "placeholder:text-fg-muted [overflow-wrap:anywhere]",
            tooLong ? "border-line-danger" : "border-line focus:border-line-focus",
          )}
        />
        <button
          ref={emojiButton}
          type="button"
          aria-label={t("composer.emoji")}
          title={t("composer.emoji")}
          onClick={() => setEmojiOpen((open) => !open)}
          className="flex size-32 shrink-0 items-center justify-center rounded-md text-fg-secondary cursor-pointer hover:bg-hover-overlay hover:text-fg"
        >
          <Smile size={16} />
        </button>
        <button
          type="button"
          aria-label={t("composer.send")}
          title={t("composer.send")}
          disabled={empty || tooLong || send.isPending}
          onClick={submit}
          className="flex size-32 shrink-0 items-center justify-center rounded-md bg-accent text-fg-on-accent cursor-pointer hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-elevated disabled:text-fg-disabled"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
      {error !== null || chars >= COUNTER_FROM ? (
        <div className={cn("flex items-center gap-8 pb-6 text-body-sm", dense ? "px-8" : "px-12")}>
          {error !== null ? (
            <span role="alert" className="min-w-0 flex-1 text-fg-danger">{error}</span>
          ) : (
            <span className="flex-1" />
          )}
          {chars >= COUNTER_FROM ? (
            <span className={cn("text-mono-xs", tooLong ? "text-fg-danger" : "text-fg-muted")}>
              {t("composer.counter", { used: chars, max: MAX_BODY_CHARS })}
            </span>
          ) : null}
        </div>
      ) : null}
      <EmojiPopover
        anchor={emojiOpen ? emojiButton.current : null}
        onClose={() => setEmojiOpen(false)}
        onPick={(emoji) => insertText(emoji)}
      />
      {picking !== null ? (
        <Layer>
          <AttachPicker
            kind={picking}
            onClose={() => {
              setPicking(null);
              field.current?.focus();
            }}
            onPick={(picked) => {
              setPicking(null);
              if ("card" in picked) addCard(picked.card);
              else addFiles([picked.file]);
              field.current?.focus();
            }}
          />
        </Layer>
      ) : null}
    </div>
  );
}

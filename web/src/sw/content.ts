/**
 * What a push becomes on screen: the notification's title, body, tag and
 * address, out of the service's payload (`push/payload.rs`, version 1).
 *
 * The service sends names and text, never a sentence: the words come from
 * the `push` section of the web app's catalogs in the subscription's
 * language (`strings.ts`). The device's preview level has already cut the
 * payload down:
 *
 * | Preview  | Payload                         | Notification                       |
 * | -------- | ------------------------------- | ---------------------------------- |
 * | `full`   | sender, group title, text       | sender (· group) and the text      |
 * | `sender` | sender, group title             | sender (· group) and "New message" |
 * | `none`   | kind and conversation only      | "JKNet" and "Activity in JKNet"    |
 *
 * One notification per conversation (`c:<id>`), one for friend requests, one
 * per server invite; a mention alerts again (`renotify`). While a window of
 * the app is open the notification is silent: the page has played the
 * chat's sound already.
 *
 * Pure, so `content.test.mjs` checks it under `node --test`.
 */

/** The words of the `push` section of `web/src/locales/<lang>/web.json`. */
export interface PushStrings {
  activity: string;
  newMessage: string;
  sentFiles: string;
  sharedCard: string;
  reaction: string;
  reactionPlain: string;
  groupInvite: string;
  groupInvitePlain: string;
  friendRequest: string;
  friendAccepted: string;
  invite: string;
  test: string;
}

/** The fields of a payload the notification reads; anything else is ignored. */
export interface PushPayload {
  v?: number;
  kind?: string;
  lang?: string;
  conversationId?: string;
  conversationKind?: string;
  title?: string;
  sender?: string;
  text?: string;
  files?: number;
  cards?: string[];
  mention?: boolean;
  emoji?: string;
  inviteId?: string;
  badge?: number;
  silent?: boolean;
}

export interface NotificationPlan {
  title: string;
  options: {
    body: string;
    tag: string;
    renotify: boolean;
    silent: boolean;
    icon: string;
    data: { url: string };
  };
  /** The number for the app icon, or `null` when the payload has none. */
  badge: number | null;
}

/** The app's name: the title of a notification that names no one. */
export const APP_TITLE = "JKNet";
export const ICON = "/icons/icon-192.png";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** Reads a payload leniently: a field of the wrong type is a field left out. */
export function payloadOf(raw: unknown): PushPayload {
  if (raw === null || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const cards = Array.isArray(value.cards) ? value.cards.filter((card): card is string => typeof card === "string") : undefined;
  return {
    v: typeof value.v === "number" ? value.v : undefined,
    kind: text(value.kind) ?? undefined,
    lang: text(value.lang) ?? undefined,
    conversationId: text(value.conversationId) ?? undefined,
    conversationKind: text(value.conversationKind) ?? undefined,
    title: text(value.title) ?? undefined,
    sender: text(value.sender) ?? undefined,
    text: text(value.text) ?? undefined,
    files: typeof value.files === "number" ? value.files : undefined,
    cards,
    mention: value.mention === true,
    emoji: text(value.emoji) ?? undefined,
    inviteId: text(value.inviteId) ?? undefined,
    badge: typeof value.badge === "number" && Number.isFinite(value.badge) ? Math.max(0, Math.floor(value.badge)) : undefined,
    silent: value.silent === true,
  };
}

/** The address a conversation's notification opens. */
export function threadUrl(conversationId: string): string {
  return `/c/${encodeURIComponent(conversationId)}`;
}

/** The tag and the address of a kind: one notification per conversation, request list or invite. */
export function targetOf(payload: PushPayload): { tag: string; url: string } {
  const conversation = payload.conversationId;
  switch (payload.kind) {
    case "chat.message":
    case "chat.reaction":
    case "chat.groupInvite":
      if (conversation !== undefined) return { tag: `c:${conversation}`, url: threadUrl(conversation) };
      return { tag: "chats", url: "/chats" };
    case "friend.request":
      return { tag: "friends:requests", url: "/friends/requests" };
    case "friend.accepted":
      return { tag: "friends:accepted", url: "/friends" };
    case "invite":
      return { tag: payload.inviteId === undefined ? "invites" : `invite:${payload.inviteId}`, url: "/friends/requests" };
    case "test":
      return { tag: "test", url: "/settings/notifications" };
    default:
      if (conversation !== undefined) return { tag: `c:${conversation}`, url: threadUrl(conversation) };
      return { tag: "jknet", url: "/chats" };
  }
}

/** The sender, with the group's title when the service sent one (groups only). */
function senderTitle(payload: PushPayload): string | null {
  if (payload.sender === undefined) return null;
  return payload.title === undefined ? payload.sender : `${payload.sender} · ${payload.title}`;
}

/** What a message says without its text: its files, its cards, or just that it came. */
function messageBody(payload: PushPayload, strings: PushStrings): string {
  if (payload.text !== undefined) return payload.text;
  if ((payload.files ?? 0) > 0) return strings.sentFiles;
  if ((payload.cards ?? []).length > 0) return strings.sharedCard;
  return strings.newMessage;
}

function wordsOf(payload: PushPayload, strings: PushStrings): { title: string; body: string } {
  const generic = { title: APP_TITLE, body: strings.activity };
  switch (payload.kind) {
    case "chat.message": {
      const title = senderTitle(payload);
      return title === null ? generic : { title, body: messageBody(payload, strings) };
    }
    case "chat.reaction": {
      if (payload.sender === undefined) return generic;
      const body = payload.emoji === undefined ? strings.reactionPlain : fill(strings.reaction, { emoji: payload.emoji });
      return { title: payload.sender, body };
    }
    case "chat.groupInvite": {
      if (payload.sender === undefined) return generic;
      const body = payload.title === undefined ? strings.groupInvitePlain : fill(strings.groupInvite, { title: payload.title });
      return { title: payload.sender, body };
    }
    case "friend.request":
      return payload.sender === undefined ? generic : { title: payload.sender, body: strings.friendRequest };
    case "friend.accepted":
      return payload.sender === undefined ? generic : { title: payload.sender, body: strings.friendAccepted };
    case "invite":
      return payload.sender === undefined ? generic : { title: payload.sender, body: strings.invite };
    case "test":
      return { title: APP_TITLE, body: strings.test };
    default:
      return generic;
  }
}

/**
 * The notification of one push. `windowOpen`: a window of the app is open,
 * so the page has sounded already and the notification stays silent.
 */
export function notificationOf(raw: unknown, stringsFor: (lang: string) => PushStrings, windowOpen: boolean): NotificationPlan {
  const payload = payloadOf(raw);
  const strings = stringsFor(payload.lang ?? "en");
  const { title, body } = wordsOf(payload, strings);
  const { tag, url } = targetOf(payload);
  return {
    title,
    options: {
      body,
      tag,
      renotify: payload.mention === true,
      silent: windowOpen || payload.silent === true,
      icon: ICON,
      data: { url },
    },
    badge: payload.badge ?? null,
  };
}

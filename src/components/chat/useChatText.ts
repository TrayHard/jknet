import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useLocale } from "../../i18n/useFormat";
import { conversationName } from "../../lib/chat/conversation";
import { plainText } from "../../lib/chat/mentions";
import type { ChatMessage, Conversation, OnlineUser } from "../../lib/ipc";
import { useChatMeId, useChatPeople } from "../../lib/queries";

/**
 * --- slice: chat ---
 *
 * The words of the chat that depend on who is who: names, titles, excerpts
 * and times. One hook per subject, so the list row, the thread header and the
 * toast of a notification call the same function for the same thing.
 */

export interface ChatNames {
  meId: string | null;
  /** The account behind an id, when the launcher knows it. */
  person: (userId: string | null) => OnlineUser | null;
  /**
   * A name to print: the display name, **Deleted account** for `null`, and
   * **Former member** for an id nobody here knows any more.
   */
  personName: (userId: string | null) => string;
  /** The title of a conversation as the list and the header show it. */
  title: (conversation: Conversation) => string;
  /** A message body as one line of plain text, mentions as names. */
  excerpt: (body: string, max?: number) => string;
}

export function useChatNames(): ChatNames {
  const { t } = useTranslation("chat");
  const person = useChatPeople();
  const meId = useChatMeId();

  return useMemo<ChatNames>(() => {
    const personName = (userId: string | null): string => {
      if (userId === null) return t("people.deleted");
      return person(userId)?.displayName ?? t("people.former");
    };
    const title = (conversation: Conversation): string => {
      const name = conversationName(conversation, meId);
      switch (name.kind) {
        case "peer":
          return name.user.displayName;
        case "deleted":
          return t("people.deleted");
        case "group":
          return name.title;
        case "members":
          if (name.names.length === 0) return t("list.onlyYou");
          return name.more > 0
            ? t("list.namesAndMore", { names: name.names.join(", "), count: name.more })
            : name.names.join(", ");
        case "server":
          return t("list.serverTitle", { name: name.host?.displayName ?? t("people.former") });
      }
    };
    const excerpt = (body: string, max = 140) => plainText(body, personName, max);
    return { meId, person, personName, title, excerpt };
  }, [t, person, meId]);
}

/** Times of the chat in the language on screen. */
export interface ChatTimes {
  /** `19:38`. */
  time: (iso: string) => string;
  /** The day divider: **Today**, **Yesterday**, or the date. */
  day: (iso: string) => string;
  /** The time of a list row: the time today, the weekday this week, the date before. */
  row: (iso: string) => string;
  /** The full date and time, for a tooltip. */
  full: (iso: string) => string;
}

const DAY_MS = 24 * 60 * 60_000;

/** Midnight of the local day of a moment, as a number. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function useChatTimes(): ChatTimes {
  const { t } = useTranslation("chat");
  const locale = useLocale();

  return useMemo<ChatTimes>(() => {
    const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const longDay = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" });
    const longDayYear = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" });
    const shortDate = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
    const full = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

    const parse = (iso: string): Date | null => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const daysAgo = (date: Date) => Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY_MS);

    return {
      time: (iso) => {
        const date = parse(iso);
        return date === null ? "" : clock.format(date);
      },
      day: (iso) => {
        const date = parse(iso);
        if (date === null) return "";
        const ago = daysAgo(date);
        if (ago === 0) return t("time.today");
        if (ago === 1) return t("time.yesterday");
        return date.getFullYear() === new Date().getFullYear()
          ? longDay.format(date)
          : longDayYear.format(date);
      },
      row: (iso) => {
        const date = parse(iso);
        if (date === null) return "";
        const ago = daysAgo(date);
        if (ago <= 0) return clock.format(date);
        if (ago < 7) return weekday.format(date);
        return shortDate.format(date);
      },
      full: (iso) => {
        const date = parse(iso);
        return date === null ? "" : full.format(date);
      },
    };
  }, [locale, t]);
}

/**
 * The one line a message leaves in a list row or a notification: the text,
 * or what it carries when it has no text.
 */
export function useMessageSummary(): (message: ChatMessage) => string {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  const system = useSystemText();
  return useCallback(
    (message: ChatMessage) => {
      if (message.kind === "system") return system(message);
      const text = names.excerpt(message.body, 120);
      if (text !== "") return text;
      if (message.files.length > 0) {
        return message.files.length === 1
          ? t("summary.file", { name: message.files[0].name })
          : t("summary.files", { count: message.files.length });
      }
      if (message.cards.length > 0) return message.cards[0].fallbackText || t("summary.card");
      return "";
    },
    [t, names, system],
  );
}

/** The sentence of a system line. */
export function useSystemText(): (message: ChatMessage) => string {
  const { t } = useTranslation("chat");
  const names = useChatNames();
  return useCallback(
    (message: ChatMessage) => {
      const system = message.system;
      if (system === null) return "";
      const user = names.personName(system.userId ?? null);
      const by = names.personName(system.by ?? null);
      switch (system.event) {
        case "created":
          return t("system.created", { by: system.by === undefined ? user : by });
        case "memberAdded":
          return t("system.memberAdded", { by, user });
        case "memberJoined":
          return t("system.memberJoined", { user });
        case "memberLeft":
          return t("system.memberLeft", { user });
        case "memberRemoved":
          return t("system.memberRemoved", { by, user });
        case "renamed":
          return system.title
            ? t("system.renamed", { by, title: system.title })
            : t("system.renamedEmpty", { by });
        case "ownerChanged":
          return t("system.ownerChanged", { user });
        case "historyForNewMembers":
          return system.on ? t("system.historyOn", { by }) : t("system.historyOff", { by });
        case "serverStarted":
          return t("system.serverStarted");
        default:
          return t("system.unknown");
      }
    },
    [t, names],
  );
}

/**
 * The words of the tray and of the notifications the core shows itself.
 *
 * --- slice: chat notifications ---
 *
 * The core has no catalogs, so the launcher window sends it finished texts
 * through `set_tray_labels`, again whenever the language or the unread count
 * changes: the menu, the tooltip, and the few lines of the Windows
 * notifications it writes on its own — a message whose text is hidden, the
 * sender of a deleted account, the summary after a game and the hint of the
 * first hide into the tray.
 *
 * The summary keeps two tokens of the core's own, `{messages}` and
 * `{chats}`, which it replaces with the counts when it shows the
 * notification. The catalog spells them as ordinary `{{messages}}` and
 * `{{chats}}` placeholders, so the translation check guards them like any
 * other, and they are filled here with the core's tokens.
 *
 * No React: `tray.test.mjs` runs it under `node --test` with a stand-in `t`.
 */

import type { TrayLabels } from "../ipc";

/** `t` of the `chat` namespace, as far as this module uses it. */
export type ChatTranslate = (key: string, options?: Record<string, unknown>) => string;

/** The tokens the core replaces in the summary after a game. */
export const SUMMARY_TOKENS = { messages: "{messages}", chats: "{chats}" } as const;

/** Every label of the tray, in the language `t` speaks, for `unread` unread messages. */
export function trayLabels(t: ChatTranslate, unread: number): TrayLabels {
  const count = Math.max(0, Math.floor(unread));
  return {
    open: t("tray.open"),
    chat: count > 0 ? t("tray.chatCount", { count }) : t("tray.chat"),
    dnd: t("tray.dnd"),
    quit: t("tray.quit"),
    tooltip: count > 0 ? t("tray.tooltipUnread", { count }) : t("tray.tooltip"),
    newMessage: t("tray.newMessage"),
    deletedAccount: t("people.deleted"),
    summaryTitle: t("tray.summaryTitle"),
    summary: t("tray.summary", { ...SUMMARY_TOKENS }),
    hintTitle: t("tray.hintTitle"),
    hint: t("tray.hint"),
  };
}

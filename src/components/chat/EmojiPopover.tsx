import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { Floating, type FloatingPlacement } from "./Floating";

/** The picker and its data are a chunk of their own: most sessions never open it. */
const EmojiPicker = lazy(() => import("./EmojiPicker"));

interface EmojiPopoverProps {
  /** The button the picker opens from; `null` keeps it closed. */
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (emoji: string) => void;
  placement?: FloatingPlacement;
}

const RECENT_KEY = "jknet.chat.recentEmoji";
const RECENT_MAX = 24;

/**
 * The emoji this player picked last, newest first.
 *
 * A convenience of one machine, so browser storage is enough: a private
 * window or cleared storage only empties the **Recent** tab.
 */
function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function remember(emoji: string): void {
  try {
    const next = [emoji, ...readRecent().filter((item) => item !== emoji)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the pick still goes through.
  }
}

/**
 * --- slice: chat ---
 *
 * The emoji picker in a floating layer, loaded on first use.
 */
export function EmojiPopover({ anchor, onClose, onPick, placement = "top-end" }: EmojiPopoverProps) {
  const { t } = useTranslation("chat");
  // Read once per opening: the list does not reorder under the pointer.
  const [recent] = useState(readRecent);
  return (
    <Floating anchor={anchor} onClose={onClose} placement={placement} label={t("emoji.title")}>
      <Suspense
        fallback={
          <div className="flex h-[300px] w-[320px] items-center justify-center rounded-lg border border-line-strong bg-elevated text-body-sm text-fg-muted shadow-popover">
            {t("emoji.loading")}
          </div>
        }
      >
        <EmojiPicker
          recent={recent}
          onPick={(emoji) => {
            remember(emoji);
            onPick(emoji);
          }}
        />
      </Suspense>
    </Floating>
  );
}

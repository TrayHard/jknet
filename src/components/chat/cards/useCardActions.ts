import { useCallback, useEffect, useRef, useState } from "react";

import { readCard, type ParsedCard } from "../../../lib/chat/cardDrafts";
import type { ChatCard } from "../../../lib/ipc";
import { useCheckChatCard } from "../../../lib/queries";

/**
 * --- slice: chat cards ---
 *
 * A label that changes for a moment after a press: **Copy address** turns
 * into **Copied** and back. Answers whether it is on and the switch.
 */
export function useFlash(ms = 2_000): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setOn(true);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash];
}

/**
 * Runs a button of a card on the card as the core checked it.
 *
 * A card was written by another player and only read leniently to be drawn;
 * before a button starts a game, installs a file or fills a form, the core
 * reads it again with the rules of the service (`chat_check_card`) and the
 * button takes the clean fields. A card the core refuses leaves `error` set,
 * which the card prints, and the button does nothing.
 */
export function useCheckedCard() {
  const check = useCheckChatCard();
  const { mutate, reset } = check;
  const run = useCallback(
    (card: ChatCard, act: (parsed: ParsedCard) => void) => {
      mutate(card, {
        onSuccess: (clean) => {
          const parsed = readCard(clean);
          if (parsed !== null) act(parsed);
        },
      });
    },
    [mutate],
  );
  return { run, checking: check.isPending, error: check.error, reset };
}

/** Copies a text to the clipboard; resolves whether it worked. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

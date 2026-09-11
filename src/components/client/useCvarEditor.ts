/**
 * The cvars the client window binds a control to, and the one writer of them.
 *
 * Every control in the window edits the same string — the `launchArgs` field
 * of the client — and the core owns the rules for reading one cvar out of it
 * and putting one back (`src-tauri/src/launch_tokens.rs`). The window reads
 * all of them in one call and writes them one at a time, which is what keeps
 * a hand-written `+exec duel.cfg` next to a dropdown intact.
 */

import { useState } from "react";

import { useErrorText } from "../../i18n/errors";
import { useLaunchCvars, useWriteLaunchCvar } from "../../lib/queries";

/**
 * The cvars the window has a control for, in the order the cards show them.
 *
 * The list is the query key as well, so adding a control refetches instead of
 * reading a cached answer that knows nothing about the new name.
 */
export const WINDOW_CVARS = [
  "r_mode",
  "r_customwidth",
  "r_customheight",
  "r_fullscreen",
  "s_volume",
  "s_musicvolume",
  "name",
  "com_maxfps",
  "rate",
  "snaps",
] as const;

export type WindowCvar = (typeof WINDOW_CVARS)[number];

export interface CvarEditor {
  /** The value on the line, or `null` when the line does not carry the cvar. */
  read: (name: WindowCvar) => string | null;
  /** Writes one cvar. `null` removes it from the line. */
  write: (name: WindowCvar, value: string | null) => void;
  /** True until the first answer, so a control does not flash an empty value. */
  isLoading: boolean;
  /** The refusal of the last write, or of the read, as a sentence. */
  error: string | null;
}

export function useCvarEditor(clientId: string): CvarEditor {
  const cvars = useLaunchCvars(clientId, WINDOW_CVARS);
  const writeCvar = useWriteLaunchCvar();
  const errorText = useErrorText();
  const [failure, setFailure] = useState<string | null>(null);

  return {
    read: (name) => cvars.data?.[name] ?? null,
    write: (name, value) => {
      setFailure(null);
      writeCvar.mutate(
        { clientId, name, value },
        { onError: (e) => setFailure(errorText(e)) },
      );
    },
    isLoading: cvars.isLoading,
    error: failure ?? (cvars.error ? errorText(cvars.error) : null),
  };
}

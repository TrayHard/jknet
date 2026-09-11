/**
 * The sentence behind a warning about a command line.
 *
 * The core answers with a code — `eternaljk_s_initsound` — and the sentence
 * lives in the `clients` catalog, so the warning arrives in the language on
 * screen. Two places show it: the toast `GameEventsProvider` raises when a
 * game starts, and the command line preview in the client window, which asks
 * the core about arguments nobody has launched yet.
 *
 * A table rather than a key built out of the code: the codes are the core's
 * spelling and the keys are the catalog's, and a mapping written down is a
 * mapping `npm run typecheck` can check. A new code that nobody translated
 * fails to compile here, which is the right place to find out.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { LaunchWarningCode } from "../lib/ipc";

export const LAUNCH_WARNING_KEYS = {
  eternaljk_s_initsound: "launchWarning.eternaljkSInitsound",
} as const satisfies Record<LaunchWarningCode, `launchWarning.${string}`>;

/** Prints one warning code as a sentence. */
export function useLaunchWarningText(): (code: LaunchWarningCode) => string {
  const { t } = useTranslation("clients");
  return useCallback((code: LaunchWarningCode) => t(LAUNCH_WARNING_KEYS[code]), [t]);
}

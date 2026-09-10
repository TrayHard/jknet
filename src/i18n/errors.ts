/**
 * Turning a refusal from the core into a sentence in the player's language.
 *
 * Every command answers a failure with `{ code, message, details }` — see
 * `src-tauri/src/error.rs`. The code names a key of the `errors` namespace and
 * `details` fills its placeholders, so «Jedi Outcast game files: the folder is
 * not set» becomes «Файлы Jedi Outcast: папка не задана» without the core
 * knowing a word of Russian.
 *
 * The fallback is the rendered English `message`, never a blank line and never
 * a bare code. A variant added to the core before its catalog key exists
 * therefore still reads as a sentence; the Rust test
 * `every_code_is_a_key_of_the_english_error_catalog` is what keeps that case
 * from lasting past the next `cargo test`.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { errorEnvelope, type AppErrorEnvelope } from "../lib/ipc";
import { NO_RUNTIME_MESSAGE } from "../lib/runtime";
import { i18next } from "./index";

/** How a service code from the contract is spelled in the catalog. */
function onlineKey(code: string): string {
  // The contract writes `provider_error`, the catalogs write `providerError`:
  // one shape for every key, and no snake_case island under `errors.online`.
  const camel = code.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return `online.${camel}`;
}

/** The catalog key a failure should be printed from, or `null` for none. */
export function errorKey(envelope: AppErrorEnvelope): string | null {
  if (envelope.code === "") {
    // The one failure the frontend raises itself, from the guard in
    // `lib/ipc.ts`. It reaches a screen only in `npm run dev`, and it has no
    // code because it never went through `AppError`.
    return envelope.message === NO_RUNTIME_MESSAGE ? "frontend.noRuntime" : null;
  }
  if (envelope.code === "online") {
    const code = typeof envelope.details.code === "string" ? envelope.details.code : "";
    const key = code === "" ? null : onlineKey(code);
    return key !== null && i18next.exists(key, { ns: "errors" }) ? key : null;
  }
  return i18next.exists(envelope.code, { ns: "errors" }) ? envelope.code : null;
}

/**
 * The one place a dynamic key is used.
 *
 * `t` is typed against the English catalogs, and a code computed at runtime
 * cannot be one of those literals. The cast is confined here, behind the
 * `exists` check above: a key that is not in the catalog never reaches it.
 */
type LooseT = (key: string, options?: Record<string, unknown>) => string;

/** Translates one failure, falling back to the English message it carries. */
export function errorTextWith(t: LooseT, error: unknown): string {
  const envelope = errorEnvelope(error);
  const key = errorKey(envelope);
  if (key === null) {
    return envelope.message === "" ? t("frontend.unexpected") : envelope.message;
  }
  return t(key, { ...envelope.details, defaultValue: envelope.message });
}

/**
 * The message of a failure, in the language on screen.
 *
 * Use it wherever a screen prints a rejected command. The raw
 * `errorMessage` from `lib/ipc.ts` stays for the console and the log file,
 * which are English on purpose.
 */
export function useErrorText(): (error: unknown) => string {
  const { t } = useTranslation("errors");
  return useCallback(
    (error: unknown) => errorTextWith(t as unknown as LooseT, error),
    [t],
  );
}

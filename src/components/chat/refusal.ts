import { errorEnvelope } from "../../lib/ipc";

/**
 * --- slice: chat cards ---
 *
 * The chat refusal behind a failed command: `details.code` and
 * `details.message` of an `online` error, or `null` for any other failure.
 *
 * Two refusals of the core are questions rather than failures:
 * `confirm_danger` (a file to save is a program; `message` lists what the
 * core found) and `confirm_link` (a link leads to another host; `message` is
 * the host). A window answers them with a dialog and calls again confirmed.
 */
export function chatRefusal(error: unknown): { code: string; message: string } | null {
  const envelope = errorEnvelope(error);
  if (envelope.code !== "online") return null;
  const code = envelope.details.code;
  if (typeof code !== "string" || code === "") return null;
  const message = envelope.details.message;
  return { code, message: typeof message === "string" ? message : "" };
}

/** The code of a file save the player has to confirm. */
export const CONFIRM_DANGER = "confirm_danger";
/** The code of a link the player has to confirm. */
export const CONFIRM_LINK = "confirm_link";

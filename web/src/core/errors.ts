/**
 * Refusals of the web core, in the shape the launcher's core answers with.
 *
 * The shared screens read a failure through `errorEnvelope` of `lib/ipc.ts`:
 * an object with a string `code`, a string `message` and `details`. The
 * launcher's Rust core sends exactly that; the web core throws an `Error`
 * that carries the same three fields, so `onlineErrorCode()`,
 * `useErrorText()` and the console all read it the same way, and a stack
 * trace still comes with it.
 *
 * A refusal of the service becomes code `online` with the contract's own code
 * in `details.code` and the message `online <code>: <message>`, which is
 * what the Rust core renders `AppError::Online` as.
 */

export class CoreError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
  }
}

/** The code of a command the web app leaves to the launcher. */
export const NEEDS_LAUNCHER = "needs_launcher";

/** A refusal of the service: `401 unauthorized`, `409 conflict`, … */
export function onlineError(code: string, message: string, status = 0): CoreError {
  return new CoreError("online", `online ${code}: ${message}`, { code, message, status });
}

/** A call that never got an answer: offline, refused, timed out. */
export function networkError(reason: string): CoreError {
  return new CoreError("network", `The network call failed: ${reason}`, { reason });
}

/**
 * A command the web app does not run: it needs the game, local files or a
 * native window. Any refusal during e2e is a gating bug of the component
 * that called it.
 */
export function needsLauncher(command: string): CoreError {
  return new CoreError(NEEDS_LAUNCHER, NEEDS_LAUNCHER, { command });
}

/** Arguments the core refuses before any request, `AppError::InvalidInput` of the launcher. */
export function invalidInput(reason: string): CoreError {
  return new CoreError("invalidInput", `Invalid input: ${reason}`, { reason });
}

/** Something the command names is not there, `AppError::NotFound` of the launcher. */
export function notFound(what: string): CoreError {
  return new CoreError("notFound", `Not found: ${what}`, { what });
}

/** A command that needs an account while nobody is signed in. */
export function signedOut(): CoreError {
  return onlineError("unauthorized", "Sign in to JKNet first", 401);
}

/** The status code of a service refusal, or `0` for anything else. */
export function statusOf(error: unknown): number {
  if (error instanceof CoreError && typeof error.details.status === "number") {
    return error.details.status;
  }
  return 0;
}

/** The contract code of a service refusal, or `null`. */
export function serviceCode(error: unknown): string | null {
  if (error instanceof CoreError && error.code === "online" && typeof error.details.code === "string") {
    return error.details.code;
  }
  return null;
}

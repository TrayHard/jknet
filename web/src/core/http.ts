/**
 * Requests to JKNet Online, the way `online/client.rs` of the launcher makes
 * them.
 *
 * The token goes in the `Authorization` header of every call that needs it,
 * never in a cookie or a query string. A refusal of the service becomes a
 * `CoreError` with its contract code (`errors.ts`), and a `401` on a call that
 * carried the token — outside the sign-in routes, which answer `401` to a
 * token they already forgot — tells the session the token is gone, which is
 * how an expired or revoked sign-in reaches the screens.
 */

import { networkError, onlineError } from "./errors.ts";

/** How long a call may take before it counts as a network failure. */
export const TIMEOUT_MS = 12_000;

/** The routes whose `401` does not mean the stored token is gone. */
const AUTH_PREFIX = "/v1/auth/";

export interface HttpOptions {
  /** `https://api.jknet.app`, without a trailing slash. */
  apiBase: string;
  /** The stored token, or `null` while signed out. */
  token: () => string | null;
  /** Runs once per refusal of the token, before the call rejects. */
  onUnauthorized: () => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** Send the token. On by default; the sign-in routes turn it off. */
  auth?: boolean;
}

export interface Answer<T> {
  status: number;
  data: T;
}

export interface Http {
  readonly apiBase: string;
  /** The body of a successful answer, `undefined` for `204`. */
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  /** The same, with the status code: `201` and `200` can mean different things. */
  send<T>(method: string, path: string, options?: RequestOptions): Promise<Answer<T>>;
  /** An absolute address on the service. */
  url(path: string): string;
}

/** A path segment made safe: an id can never climb out of its route. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

export function createHttp(options: HttpOptions): Http {
  const apiBase = options.apiBase.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  async function send<T>(method: string, path: string, request: RequestOptions = {}): Promise<Answer<T>> {
    const headers: Record<string, string> = {};
    const token = request.auth === false ? null : options.token();
    if (request.auth !== false && token === null) {
      throw onlineError("unauthorized", "Sign in to JKNet first", 401);
    }
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(request.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
        // The API is on its own origin and carries no cookie of ours.
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw networkError(`the service did not answer ${method} ${path} within ${timeoutMs / 1000} s`);
      }
      throw networkError(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw networkError(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      if (response.status === 401 && token !== null && !path.startsWith(AUTH_PREFIX)) {
        options.onUnauthorized();
      }
      throw refusal(response.status, text, path);
    }

    if (response.status === 204 || text === "") return { status: response.status, data: undefined as T };
    try {
      return { status: response.status, data: JSON.parse(text) as T };
    } catch {
      throw onlineError("internal", `the service answered ${method} ${path} with something that is not JSON`, response.status);
    }
  }

  return {
    apiBase,
    send,
    request: async <T>(method: string, path: string, request?: RequestOptions) =>
      (await send<T>(method, path, request)).data,
    url: (path: string) => `${apiBase}${path}`,
  };
}

/** The path prefix of the chat API, whose refusals name their cause in `details.reason`. */
export const CHAT_PREFIX = "/v1/chat/";

/**
 * The code of a service that has no chat API at all: an older deployment
 * answers every `/v1/chat/*` route with `404 No such endpoint`. The chat
 * screens say "Chat is not available" instead of an error.
 */
export const CHAT_UNAVAILABLE_CODE = "chat_unavailable";

/** The contract's code for an answer without an error document, as `code_for_status` of the launcher. */
export function codeForStatus(status: number): string {
  if (status === 400 || status === 422) return "invalid";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status >= 502 && status <= 504) return "provider_error";
  return "internal";
}

/**
 * The refusal an answer becomes: the error envelope of the contract,
 * `{ "error": { "code", "message", "details" } }`, or the code of the status
 * when the body is not one (a proxy's page, an empty body).
 *
 * A refusal of the chat API follows `chat_refusal` of the launcher's
 * `online/client.rs`: `403 forbidden` is `owner_only` in one place and
 * `not_friends` in another, so `details.reason` becomes the code the screens
 * read, and `404 No such endpoint` becomes `chat_unavailable`.
 */
export function refusal(status: number, text: string, path = "") {
  let code: string | null = null;
  let message: string | null = null;
  let reason: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: { reason?: unknown } } };
    code = typeof parsed.error?.code === "string" && parsed.error.code.trim() !== "" ? parsed.error.code : null;
    message = typeof parsed.error?.message === "string" && parsed.error.message.trim() !== "" ? parsed.error.message : null;
    const raw = parsed.error?.details?.reason;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed !== "" && trimmed.length <= 40 && /^[a-z_]+$/.test(trimmed)) reason = trimmed;
    }
  } catch {
    // Not the contract's envelope.
  }
  if (code === null) return onlineError(codeForStatus(status), `the service answered ${status}`, status);
  const said = message ?? `the service answered ${status}`;
  if (path.startsWith(CHAT_PREFIX)) {
    if (status === 404 && code === "not_found" && said.trim().toLowerCase() === "no such endpoint") {
      return onlineError(CHAT_UNAVAILABLE_CODE, "this JKNet Online service has no chat", status);
    }
    if (reason !== null) return onlineError(reason, said, status);
  }
  return onlineError(code, said, status);
}

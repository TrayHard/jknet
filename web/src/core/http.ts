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
      throw refusal(response.status, text);
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

/** The error envelope of the contract: `{ "error": { "code", "message" } }`. */
function refusal(status: number, text: string) {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : null;
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : null;
    if (code !== null) return onlineError(code, message ?? `HTTP ${status}`, status);
  } catch {
    // Not the contract's envelope: a proxy's page, an empty body.
  }
  return onlineError(status === 401 ? "unauthorized" : status >= 500 ? "internal" : "invalid", `HTTP ${status}`, status);
}

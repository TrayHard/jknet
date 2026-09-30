import React, { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { createRoot } from "react-dom/client";
import { CommunityBrowser, type CommunityLabels } from "./components/community/CommunityBrowser";
import type { CommunityRequest } from "./components/community/types";
import en from "./locales/en/servers.json";
import ru from "./locales/ru/servers.json";
import de from "./locales/de/servers.json";
import es from "./locales/es/servers.json";
import fr from "./locales/fr/servers.json";
import hu from "./locales/hu/servers.json";
import pl from "./locales/pl/servers.json";
import uk from "./locales/uk/servers.json";

const catalogs: Record<string, { community: CommunityLabels }> = { en, ru, de, es, fr, hu, pl, uk };
const l = (catalogs[document.documentElement.lang] ?? en).community;
const local = location.hostname === "127.0.0.1" || location.hostname === "localhost";
const api = local ? "http://127.0.0.1:8787" : "https://api.jknet.app";
const TOKEN_KEY = "jknet-community-session";
function Website() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [user, setUser] = useState<{ id: string; displayName: string }>();
  const [pageId, setPageId] = useState(() => new URLSearchParams(location.search).get("id") ?? undefined);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const login = useRef<{ controller: AbortController; popup: Window | null } | null>(null);
  const send = useCallback(async <T,>(method: string, path: string, body?: unknown, authenticated = false): Promise<T> => {
    const response = await fetch(api + path, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000), credentials: "omit" });
    const result = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      if (response.status === 401 && authenticated) { sessionStorage.removeItem(TOKEN_KEY); setToken(""); setUser(undefined); }
      throw new Error(result?.error?.message ?? `HTTP ${response.status}`);
    }
    return result as T;
  }, [token]);
  const request: CommunityRequest = useCallback((method, path, body) => send(method, `/v1/community/${path}`, body, !(method === "GET" && path.startsWith("servers"))), [send]);
  useEffect(() => {
    let active = true;
    if (token) send<{ user: { id: string; displayName: string } }>("GET", "/v1/me", undefined, true).then(result => { if (active) setUser(result.user); }).catch(err => { if (active) setError(String(err.message)); });
    return () => { active = false; };
  }, [send, token]);
  useEffect(() => { const pop = () => setPageId(new URLSearchParams(location.search).get("id") ?? undefined); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  useEffect(() => {
    if (loginOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [loginOpen]);
  useEffect(() => () => { login.current?.controller.abort(); login.current?.popup?.close(); }, []);
  function navigate(id?: string) { const url = new URL(location.href); url.search = id ? new URLSearchParams({ id }).toString() : ""; history.pushState(null, "", url); setPageId(id); window.scrollTo(0, 0); }
  function cancelLogin(close = true) {
    const attempt = login.current;
    login.current = null;
    attempt?.controller.abort(); attempt?.popup?.close();
    setLoginBusy(false); setLoginUrl(""); setNotice(""); setError("");
    if (close) setLoginOpen(false);
  }
  async function signIn(provider: "discord" | "jkhub") {
    if (login.current) return;
    const controller = new AbortController();
    const attempt = { controller, popup: null as Window | null };
    login.current = attempt;
    setLoginBusy(true); setError(""); setNotice(l.signInHint); setLoginUrl("");
    try {
      // Reserve the window during the click so popup blockers can allow it.
      const popup = window.open("about:blank", "jknet-community-login");
      attempt.popup = popup;
      if (popup) popup.opener = null;
      const authRequest = async (path: string, body?: unknown) => {
        const response = await fetch(api + path, {
          method: body === undefined ? "GET" : "POST",
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "omit", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok) throw new Error(l.loginFailed);
        return response.json();
      };
      const session = await authRequest("/v1/auth/login-sessions", { provider, deviceName: "JKNet community website" });
      controller.signal.throwIfAborted();
      if (popup?.closed) { setNotice(l.loginCancelled); return; }
      if (popup) popup.location.href = session.url;
      else { setLoginUrl(session.url); setNotice(l.loginBlocked); }
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 2000);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
        controller.signal.throwIfAborted();
        const result = await authRequest(`/v1/auth/login-sessions/${session.id}`);
        controller.signal.throwIfAborted();
        if (result.status === "done" && result.token && result.user) {
          sessionStorage.setItem(TOKEN_KEY, result.token); setToken(result.token); setUser(result.user); setNotice(""); setLoginOpen(false); popup?.close(); return;
        }
        if (result.status !== "pending") throw new Error(l.loginFailed);
        // COOP can sever the window reference while OAuth is still in progress.
        // Keep polling until a result or an explicit retry/cancel from the player.
        if (popup?.closed) setNotice(l.loginWindowHint);
      }
      throw new Error(l.loginFailed);
    } catch {
      if (!controller.signal.aborted) { setError(l.loginFailed); setNotice(""); attempt.popup?.close(); }
    } finally {
      if (login.current === attempt) { login.current = null; setLoginBusy(false); setLoginUrl(""); }
    }
  }
  return <>
    <div className="community-site-account">{user ? <><span>{user.displayName}</span><button onClick={() => { void send("POST", "/v1/auth/logout", undefined, true).then(() => { sessionStorage.removeItem(TOKEN_KEY); setToken(""); setUser(undefined); }).catch(err => setError(String(err.message))); }}>{l.signOut}</button></> : null}</div>
    {!loginOpen && error && <p className="community-site-message" role="alert">{error}</p>}
    <dialog ref={dialog} className="community-app community-login" aria-labelledby="community-login-title" onCancel={event => { event.preventDefault(); cancelLogin(); }}>
      <h2 id="community-login-title">{l.signIn}</h2>
      <p>{l.loginChoose}</p>
      <div className="community-stack">
        <button disabled={loginBusy} onClick={() => void signIn("jkhub")}>{l.signInJkhub}</button>
        <button disabled={loginBusy} onClick={() => void signIn("discord")}>{l.signInDiscord}</button>
      </div>
      {loginBusy && <p className="community-login-wait" role="status"><LoaderCircle className="community-login-spinner" size={18} aria-hidden="true" />{l.loginWaiting}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {loginUrl && <p><a href={loginUrl} target="_blank" rel="noopener noreferrer">{l.loginOpen}</a></p>}
      <div className="community-actions">{loginBusy && <button onClick={() => cancelLogin(false)}>{l.loginRetry}</button>}<button onClick={() => cancelLogin()}>{l.cancel}</button></div>
    </dialog>
    <CommunityBrowser request={request} labels={l} signedIn={!!user && !!token} accountKey={user?.id ?? ""} signIn={() => { setError(""); setLoginOpen(true); }} pageId={pageId} navigate={navigate} />
  </>;
}
createRoot(document.getElementById("community-root")!).render(<React.StrictMode><Website /></React.StrictMode>);

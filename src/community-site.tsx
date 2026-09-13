import React, { useCallback, useEffect, useState } from "react";
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
  function navigate(id?: string) { const url = new URL(location.href); url.search = id ? new URLSearchParams({ id }).toString() : ""; history.pushState(null, "", url); setPageId(id); window.scrollTo(0, 0); }
  async function signIn() {
    if (loginBusy) return;
    setLoginBusy(true); setError(""); setNotice(l.signInHint); setLoginUrl("");
    // Reserve a tab in the click handler, before the asynchronous session call.
    const popup = window.open("about:blank", "jknet-community-login");
    if (popup) popup.opener = null;
    try {
      const session = await send<{ id: string; url: string }>("POST", "/v1/auth/login-sessions", { provider: local ? "dev" : "discord", deviceName: "JKNet community website" });
      if (popup) popup.location.href = session.url;
      else setLoginUrl(session.url);
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const result = await send<{ status: string; token?: string; user?: { id: string; displayName: string } }>("GET", `/v1/auth/login-sessions/${session.id}`);
        if (result.status === "done" && result.token && result.user) {
          sessionStorage.setItem(TOKEN_KEY, result.token); setToken(result.token); setUser(result.user); setNotice(""); setLoginUrl(""); return;
        }
        if (result.status === "expired" || result.status === "failed") throw new Error(l.loginFailed);
      }
      throw new Error(l.loginFailed);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoginBusy(false); }
  }
  return <><div className="community-site-account">{user ? <><span>{user.displayName}</span><button onClick={() => { void send("POST", "/v1/auth/logout", undefined, true).then(() => { sessionStorage.removeItem(TOKEN_KEY); setToken(""); setUser(undefined); }).catch(err => setError(String(err.message))); }}>{l.signOut}</button></> : null}</div>{error && <p className="community-site-message" role="alert">{error}</p>}{notice && <p className="community-site-message" role="status">{notice}</p>}{loginUrl && <p className="community-site-message"><a href={loginUrl} target="_blank" rel="noopener noreferrer">{l.signIn}</a></p>}<CommunityBrowser request={request} labels={l} signedIn={!!user && !!token} accountKey={user?.id ?? ""} signIn={() => void signIn()} pageId={pageId} navigate={navigate} /></>;
}
createRoot(document.getElementById("community-root")!).render(<React.StrictMode><Website /></React.StrictMode>);

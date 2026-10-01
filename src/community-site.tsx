/**
 * The community screens of the website, jknet.app/servers/: the catalogue at
 * `/servers/`, a page at `/servers/?id=…&tab=…` and its management screen at
 * `/servers/?id=…&view=manage&section=…`, and the events of communities at
 * `?events`, `?event=…` and `?id=…&new-event` (`events-site.ts`), in each
 * of the site's languages. The management screen, with its editors, and the
 * screens of events come as chunks of their own.
 *
 * The screens are the launcher's own (`components/community`,
 * `components/events`); this entry gives them the website — requests over
 * `fetch` with the session of the sign-in dialog below, a new tab for every
 * link, the address bar for the route — and starts i18next with the
 * `community` and `events` catalogs of the page's language, English under
 * them. The build (`jknet-site/scripts/build-community.mjs`)
 * bundles it with Tailwind and `styles/community-site.css`.
 */

import i18next from "i18next";
import { LoaderCircle, LogIn, LogOut } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next, useTranslation } from "react-i18next";

import {
  catalogTab,
  CommunityApp,
  CommunityFrame,
  CommunityPlatformProvider,
  manageSection,
  pageTab,
  type CommunityBundleRef,
  type CommunityPerson,
  type CommunityPlatform,
  type CommunityRequest,
  type CommunityRoute,
  type Game,
} from "./components/community";
import { CommunityManage, CommunityNewsComposer } from "./components/community/manage";
import { Button, Dialog } from "./components/ui";
// --- slice: community events ---
import { EventsPlatformProvider, type EventsRoute } from "./components/events/platform";
import { eventsRouteOfSearch, searchOfEvents, siteEventsPlatform } from "./events-site";
import "./styles/community-site.css";

type Catalog = Record<string, unknown>;

// The screens of events come as chunks of their own: most visits open a community page.
const EventsCalendar = React.lazy(() => import("./components/events/EventsCalendar").then((module) => ({ default: module.EventsCalendar })));
const EventView = React.lazy(() => import("./components/events/EventView").then((module) => ({ default: module.EventView })));
const EventEditor = React.lazy(() => import("./components/events/EventEditor").then((module) => ({ default: module.EventEditor })));

/** English, in the bundle: the fallback of every other language. */
const ENGLISH = import.meta.glob<Catalog>("./locales/en/community.json", { eager: true, import: "default" });
/** The other languages, a chunk each: a page fetches only its own. */
const TRANSLATED = import.meta.glob<Catalog>(["./locales/*/community.json", "!./locales/en/community.json"], {
  import: "default",
});
// --- slice: community events --- the events screens' own catalog, loaded the same way.
const ENGLISH_EVENTS = import.meta.glob<Catalog>("./locales/en/events.json", { eager: true, import: "default" });
const TRANSLATED_EVENTS = import.meta.glob<Catalog>(["./locales/*/events.json", "!./locales/en/events.json"], {
  import: "default",
});
const LANGUAGE = document.documentElement.lang || "en";

/** Starts i18next with English and the page's language, so the first render is in that language. */
async function startI18n() {
  const resources: Record<string, Record<string, Catalog>> = {
    en: { community: ENGLISH["./locales/en/community.json"], events: ENGLISH_EVENTS["./locales/en/events.json"] },
  };
  const own = TRANSLATED[`./locales/${LANGUAGE}/community.json`];
  if (own) {
    try {
      resources[LANGUAGE] = { community: await own() };
    } catch {
      // A chunk that did not load leaves the page in English rather than blank.
    }
  }
  // --- slice: community events ---
  const ownEvents = TRANSLATED_EVENTS[`./locales/${LANGUAGE}/events.json`];
  if (ownEvents) {
    try {
      resources[LANGUAGE] = { ...(resources[LANGUAGE] ?? {}), events: await ownEvents() };
    } catch {
      // The events then read in English, the rest of the page in its language.
    }
  }
  await i18next.use(initReactI18next).init({
    lng: LANGUAGE,
    fallbackLng: "en",
    ns: ["community", "events"],
    defaultNS: "community",
    resources,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    pluralSeparator: "_",
    react: { useSuspense: false },
  });
}

const local = location.hostname === "127.0.0.1" || location.hostname === "localhost";
const API = local ? "http://127.0.0.1:8787" : "https://api.jknet.app";
const TOKEN_KEY = "jknet-community-session";

/**
 * The route the address names: `?id=` for a page, `?tab=` for its tab or the
 * catalogue's, `?id=&view=manage&section=` for the management screen.
 */
function routeOfLocation(): CommunityRoute {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  if (id && params.get("view") === "manage") return { view: "manage", id, section: manageSection(params.get("section")) };
  return id ? { view: "community", id, tab: pageTab(params.get("tab")) } : { view: "catalog", tab: catalogTab(params.get("tab")) };
}

/** The query of a route, relative to the page: `?id=…&tab=…`. */
function searchOf(route: CommunityRoute): string {
  const params = new URLSearchParams();
  if (route.view === "community") {
    params.set("id", route.id);
    if (route.tab !== "overview") params.set("tab", route.tab);
  } else if (route.view === "manage") {
    params.set("id", route.id);
    params.set("view", "manage");
    if (route.section) params.set("section", route.section);
  } else if (route.tab !== "catalog") {
    params.set("tab", route.tab);
  }
  const query = params.toString();
  return query === "" ? location.pathname : `?${query}`;
}

/** The public bundles of a game whose name matches: the community's client on the management screen. */
async function findBundles(query: string, game: Game): Promise<CommunityBundleRef[]> {
  const params = new URLSearchParams({ game, sort: "popular", limit: "100" });
  if (query.trim() !== "") params.set("q", query.trim());
  const response = await fetch(`${API}/v1/bundles?${params}`, { credentials: "omit", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw refusal(response.status, await response.json().catch(() => null));
  const body = (await response.json()) as { items?: { id?: unknown; name?: unknown }[] };
  return (body.items ?? []).flatMap((item) =>
    typeof item.id === "string" && typeof item.name === "string" ? [{ id: item.id, name: item.name }] : [],
  );
}

/** A refusal of the service in the envelope the screens read: code `online`, the contract's code in `details`. */
function refusal(status: number, body: { error?: { code?: unknown; message?: unknown } } | null) {
  const code = typeof body?.error?.code === "string" ? body.error.code : status === 404 ? "not_found" : status === 401 ? "unauthorized" : "internal";
  const message = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${status}`;
  return Object.assign(new Error(message), { code: "online", details: { code, message, status } });
}

function Website() {
  const { t } = useTranslation("community");
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [user, setUser] = useState<{ id: string; displayName: string }>();
  const [route, setRoute] = useState<CommunityRoute>(routeOfLocation);
  // The management screen holds edits nobody saved: leaving the page or a
  // route of the screens asks first (`setUnsaved` of the platform).
  const unsaved = useRef(false);
  const routeRef = useRef(route);
  routeRef.current = route;
  const [leaving, setLeaving] = useState<{ go: () => void } | null>(null);
  // --- slice: community events --- the calendar, an event or its editor, when the address names one.
  const [eventsRoute, setEventsRoute] = useState<EventsRoute | null>(() => eventsRouteOfSearch(location.search));
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const login = useRef<{ controller: AbortController; popup: Window | null } | null>(null);

  const forget = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setUser(undefined);
  }, []);

  const send = useCallback(
    async <T,>(method: string, path: string, body?: unknown, auth: "none" | "optional" | "required" = "optional"): Promise<T> => {
      const bearer = auth === "none" ? "" : token;
      if (auth === "required" && bearer === "") throw refusal(401, null);
      let response: Response;
      try {
        response = await fetch(API + path, {
          method,
          headers: {
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(12000),
          credentials: "omit",
        });
      } catch (failure) {
        throw Object.assign(new Error(failure instanceof Error ? failure.message : String(failure)), { code: "network", details: {} });
      }
      const text = response.status === 204 ? "" : await response.text();
      let result: unknown = null;
      try {
        result = text === "" ? null : JSON.parse(text);
      } catch {
        result = null;
      }
      if (!response.ok) {
        if (response.status === 401 && bearer) forget();
        throw refusal(response.status, result as { error?: { code?: unknown; message?: unknown } } | null);
      }
      return result as T;
    },
    [token, forget],
  );

  // Reads carry the session when there is one, so a page says what the
  // reader is to it; the player's own lists and every write need it.
  const request: CommunityRequest = useCallback(
    <T,>(method: string, path: string, body?: unknown) => {
      const own = method !== "GET" || path === "me" || path === "following" || path.startsWith("admin/");
      return send<T>(method, `/v1/community/${path}`, body, own ? "required" : "optional");
    },
    [send],
  );

  // A logo or a cover of the management screen, or the cover of an event:
  // `HEAD` first, so a picture the store holds is not sent again, then the
  // bytes under their hash.
  const putBlob = useCallback(
    async (sha256: string, file: Blob) => {
      if (token === "") throw refusal(401, null);
      const path = `${API}/v1/blobs/${sha256}`;
      try {
        const head = await fetch(path, { method: "HEAD", credentials: "omit", signal: AbortSignal.timeout(12000) });
        if (head.ok) return;
      } catch {
        // The upload below answers for the store.
      }
      let response: Response;
      try {
        response = await fetch(path, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
          body: file,
          credentials: "omit",
          signal: AbortSignal.timeout(60000),
        });
      } catch (failure) {
        throw Object.assign(new Error(failure instanceof Error ? failure.message : String(failure)), { code: "network", details: {} });
      }
      if (!response.ok) {
        if (response.status === 401) forget();
        throw refusal(response.status, await response.json().catch(() => null));
      }
    },
    [token, forget],
  );

  useEffect(() => {
    let active = true;
    if (token) {
      send<{ user: { id: string; displayName: string } }>("GET", "/v1/me", undefined, "required")
        .then((result) => {
          if (active) setUser(result.user);
        })
        .catch((failure: unknown) => {
          if (active) setError(failure instanceof Error ? failure.message : String(failure));
        });
    }
    return () => {
      active = false;
    };
  }, [send, token]);

  useEffect(() => {
    const pop = () => {
      if (unsaved.current) {
        // The browser has moved already: back to the screen with the edits, and ask.
        history.pushState(null, "", searchOf(routeRef.current));
        setLeaving({
          go: () => {
            unsaved.current = false;
            history.back();
          },
        });
        return;
      }
      setRoute(routeOfLocation());
      setEventsRoute(eventsRouteOfSearch(location.search));
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (!unsaved.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);

  useEffect(() => {
    if (loginOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [loginOpen]);

  useEffect(
    () => () => {
      login.current?.controller.abort();
      login.current?.popup?.close();
    },
    [],
  );

  const navigate = useCallback((next: CommunityRoute) => {
    const go = () => {
      unsaved.current = false;
      history.pushState(null, "", searchOf(next));
      setEventsRoute(null);
      setRoute(next);
      window.scrollTo(0, 0);
    };
    if (unsaved.current) setLeaving({ go });
    else go();
  }, []);
  const setUnsaved = useCallback((dirty: boolean) => {
    unsaved.current = dirty;
  }, []);
  // The tab of the JKNet bot's link opens during the click; the address comes after it, and only one over HTTPS fills it.
  const openExternalLater = useCallback(() => {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    return (url: string | null) => {
      const safe = url !== null && /^https:\/\//i.test(url) ? url : null;
      if (tab === null) {
        if (safe) window.open(safe, "_blank", "noopener,noreferrer");
        return;
      }
      if (safe) tab.location.href = safe;
      else tab.close();
    };
  }, []);

  function cancelLogin(close = true) {
    const attempt = login.current;
    login.current = null;
    attempt?.controller.abort();
    attempt?.popup?.close();
    setLoginBusy(false);
    setLoginUrl("");
    setNotice("");
    setError("");
    if (close) setLoginOpen(false);
  }

  async function signIn(provider: "discord" | "jkhub") {
    if (login.current) return;
    const controller = new AbortController();
    const attempt = { controller, popup: null as Window | null };
    login.current = attempt;
    setLoginBusy(true);
    setError("");
    setNotice(t("site.signInHint"));
    setLoginUrl("");
    try {
      // Reserve the window during the click so popup blockers can allow it.
      const popup = window.open("about:blank", "jknet-community-login");
      attempt.popup = popup;
      if (popup) popup.opener = null;
      const authRequest = async (path: string, body?: unknown) => {
        const response = await fetch(API + path, {
          method: body === undefined ? "GET" : "POST",
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: "omit",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok) throw new Error(t("site.loginFailed"));
        return response.json();
      };
      const session = await authRequest("/v1/auth/login-sessions", { provider, deviceName: "JKNet community website" });
      controller.signal.throwIfAborted();
      if (popup?.closed) {
        setNotice(t("site.loginCancelled"));
        return;
      }
      if (popup) popup.location.href = session.url;
      else {
        setLoginUrl(session.url);
        setNotice(t("site.loginBlocked"));
      }
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(controller.signal.reason);
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 2000);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
        controller.signal.throwIfAborted();
        const result = await authRequest(`/v1/auth/login-sessions/${session.id}`);
        controller.signal.throwIfAborted();
        if (result.status === "done" && result.token && result.user) {
          sessionStorage.setItem(TOKEN_KEY, result.token);
          setToken(result.token);
          setUser(result.user);
          setNotice("");
          setLoginOpen(false);
          popup?.close();
          return;
        }
        if (result.status !== "pending") throw new Error(t("site.loginFailed"));
        // COOP can sever the window reference while OAuth is still in progress.
        // Keep polling until a result or an explicit retry/cancel from the player.
        if (popup?.closed) setNotice(t("site.loginWindowHint"));
      }
      throw new Error(t("site.loginFailed"));
    } catch {
      if (!controller.signal.aborted) {
        setError(t("site.loginFailed"));
        setNotice("");
        attempt.popup?.close();
      }
    } finally {
      if (login.current === attempt) {
        login.current = null;
        setLoginBusy(false);
        setLoginUrl("");
      }
    }
  }

  const signedIn = !!user && !!token;
  const openSignIn = useCallback(() => {
    setError("");
    setLoginOpen(true);
  }, []);

  // The friends name editors on the management screen, and only there: the
  // catalogue and the pages never ask for them. A list that failed leaves the
  // account id to type.
  const managing = route.view === "manage" && signedIn;
  const [friends, setFriends] = useState<CommunityPerson[] | null | undefined>(null);
  useEffect(() => {
    if (!managing) return;
    let active = true;
    setFriends(null);
    send<{ friends?: { user?: CommunityPerson }[] }>("GET", "/v1/friends", undefined, "required")
      .then((result) => {
        if (!active) return;
        setFriends(
          (result.friends ?? []).flatMap((friend) =>
            friend.user ? [{ id: friend.user.id, displayName: friend.user.displayName, avatarUrl: friend.user.avatarUrl ?? null }] : [],
          ),
        );
      })
      .catch(() => {
        if (active) setFriends(undefined);
      });
    return () => {
      active = false;
    };
  }, [managing, send]);

  const platform = useMemo<CommunityPlatform>(
    () => ({
      host: "website",
      request,
      signedIn,
      accountId: signedIn ? user?.id ?? null : null,
      apiBase: API,
      signIn: openSignIn,
      openExternal: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      navigate,
      href: searchOf,
      canManage: true,
      pageUrl: (id) => `${location.origin}${location.pathname}?id=${encodeURIComponent(id)}`,
      putBlob,
      friends,
      findBundles,
      renderNewsComposer: (props) => <CommunityNewsComposer {...props} />,
      openExternalLater,
      setUnsaved,
    }),
    [request, signedIn, user?.id, openSignIn, navigate, putBlob, friends, openExternalLater, setUnsaved],
  );

  // --- slice: community events ---
  const navigateEvents = useCallback((next: EventsRoute) => {
    history.pushState(null, "", searchOfEvents(next));
    setEventsRoute(next);
    window.scrollTo(0, 0);
  }, []);
  const eventsPlatform = useMemo(
    () => siteEventsPlatform({ api: API, navigate: navigateEvents }),
    [navigateEvents],
  );

  return (
    <>
      <CommunityFrame className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center justify-end gap-12 px-24 pt-16 @max-[560px]/community:px-16">
        {user ? (
          <>
            <span className="text-body-sm text-fg-secondary">{user.displayName}</span>
            <Button
              size="sm"
              wrap
              icon={<LogOut size={14} />}
              onClick={() => {
                void send("POST", "/v1/auth/logout", undefined, "required")
                  .then(forget)
                  .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
              }}
            >
              {t("site.signOut")}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" wrap icon={<LogIn size={14} />} onClick={openSignIn}>
            {t("site.signIn")}
          </Button>
        )}
        {!loginOpen && error ? (
          <p role="alert" className="basis-full rounded-md border border-line-danger bg-danger-subtle px-12 py-8 text-body-sm text-fg">
            {error}
          </p>
        ) : null}
        <dialog
          ref={dialog}
          aria-labelledby="community-login-title"
          onCancel={(event) => {
            event.preventDefault();
            cancelLogin();
          }}
          className="m-auto w-[calc(100%-32px)] max-w-[440px] rounded-xl border border-line bg-surface p-24 text-fg shadow-popover backdrop:bg-overlay"
        >
          <div className="flex flex-col gap-16">
            <h2 id="community-login-title" className="text-display-md text-fg">
              {t("site.signIn")}
            </h2>
            <p className="text-body-sm text-fg-secondary">{t("site.loginChoose")}</p>
            <div className="flex flex-col gap-8">
              <Button size="lg" block wrap disabled={loginBusy} onClick={() => void signIn("jkhub")}>
                {t("site.signInJkhub")}
              </Button>
              <Button size="lg" block wrap disabled={loginBusy} onClick={() => void signIn("discord")}>
                {t("site.signInDiscord")}
              </Button>
            </div>
            {loginBusy ? (
              <p role="status" className="flex items-center gap-8 text-body-sm text-fg-secondary">
                <LoaderCircle size={18} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
                {t("site.loginWaiting")}
              </p>
            ) : null}
            {notice ? (
              <p role="status" className="text-body-sm text-fg-secondary">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-body-sm text-fg-danger">
                {error}
              </p>
            ) : null}
            {loginUrl ? (
              <p>
                <a href={loginUrl} target="_blank" rel="noopener noreferrer" className="text-body-sm-medium text-fg-accent underline">
                  {t("site.loginOpen")}
                </a>
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-8">
              {loginBusy ? (
                <Button wrap onClick={() => cancelLogin(false)}>
                  {t("site.loginRetry")}
                </Button>
              ) : null}
              <Button variant="ghost" wrap onClick={() => cancelLogin()}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        </dialog>
      </CommunityFrame>
      <div className="mx-auto w-full max-w-[1280px]">
        <EventsPlatformProvider platform={eventsPlatform}>
          {eventsRoute ? (
            <CommunityPlatformProvider platform={platform}>
              <CommunityFrame className="p-24 @max-[560px]/community:p-16">
                <React.Suspense
                  fallback={
                    <p role="status" className="flex items-center gap-8 text-body-sm text-fg-muted">
                      <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                      {t("common.loading")}
                    </p>
                  }
                >
                  {eventsRoute.view === "calendar" ? (
                    <EventsCalendar />
                  ) : eventsRoute.view === "event" ? (
                    <EventView key={eventsRoute.id} id={eventsRoute.id} />
                  ) : eventsRoute.view === "edit" ? (
                    <EventEditor key={`edit:${eventsRoute.id}`} target={{ mode: "edit", id: eventsRoute.id }} />
                  ) : (
                    <EventEditor
                      key={`new:${eventsRoute.communityId}:${eventsRoute.copyOf ?? ""}`}
                      target={{ mode: "new", communityId: eventsRoute.communityId, copyOf: eventsRoute.copyOf }}
                    />
                  )}
                </React.Suspense>
              </CommunityFrame>
            </CommunityPlatformProvider>
          ) : (
            <CommunityApp
              platform={platform}
              route={route}
              renderManage={(screen) => <CommunityManage id={screen.id} section={screen.section} />}
            />
          )}
        </EventsPlatformProvider>
      </div>
      {leaving ? (
        <CommunityFrame>
          <Dialog
            variant="danger"
            title={t("manage.leave.title")}
            body={t("manage.leave.body")}
            onClose={() => setLeaving(null)}
            actions={
              <>
                <Button size="sm" variant="ghost" wrap onClick={() => setLeaving(null)}>
                  {t("manage.leave.keep")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  wrap
                  onClick={() => {
                    const next = leaving.go;
                    setLeaving(null);
                    next();
                  }}
                >
                  {t("manage.leave.discard")}
                </Button>
              </>
            }
          />
        </CommunityFrame>
      ) : null}
    </>
  );
}

void startI18n().then(() => {
  createRoot(document.getElementById("community-root")!).render(
    <React.StrictMode>
      <Website />
    </React.StrictMode>,
  );
});

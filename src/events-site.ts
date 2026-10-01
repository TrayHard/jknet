/**
 * The website as a host of the events screens, beside its community screens
 * (`community-site.tsx`): the routes in the address bar, the browser's file
 * picker and download, and the JKHub catalogue of JKNet Online for the
 * editor.
 *
 * | Route | Address |
 * | --- | --- |
 * | the calendar | `/servers/?events` |
 * | an event | `/servers/?event=ID` |
 * | its editor | `/servers/?event=ID&edit` |
 * | a new event of a community | `/servers/?id=COMMUNITY&new-event`, `&copy=ID` for a copy a week later |
 */

import type { Game } from "./components/community/types";
import type { EventsPlatform, EventsRoute, JkhubPick } from "./components/events/platform";

/** The route of the events screens the address names, or `null` for a community screen. */
export function eventsRouteOfSearch(search: string): EventsRoute | null {
  const params = new URLSearchParams(search);
  const event = params.get("event");
  if (event !== null) return params.has("edit") ? { view: "edit", id: event } : { view: "event", id: event };
  const community = params.get("id");
  if (community !== null && params.has("new-event")) {
    const copy = params.get("copy");
    return { view: "new", communityId: community, copyOf: copy ?? undefined };
  }
  if (params.has("events")) return { view: "calendar" };
  return null;
}

/** The query of an events route, relative to the page. */
export function searchOfEvents(route: EventsRoute): string {
  switch (route.view) {
    case "calendar":
      return "?events";
    case "event":
      return `?event=${encodeURIComponent(route.id)}`;
    case "edit":
      return `?event=${encodeURIComponent(route.id)}&edit`;
    case "new":
      return `?id=${encodeURIComponent(route.communityId)}&new-event${route.copyOf ? `&copy=${encodeURIComponent(route.copyOf)}` : ""}`;
  }
}

/** The largest cover the service takes. */
const COVER_MAX_BYTES = 3 * 1024 * 1024;

/** PNG, JPEG or WebP by the first bytes, as the service checks a picture. */
export function pictureType(head: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const text = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (head.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Lowercase hex SHA-256 of bytes, with the browser's crypto. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The browser's file picker for one picture; `null` when the player closes it without one. */
function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.style.display = "none";
    let settled = false;
    const done = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

/** A refusal in the envelope the screens read: code `online`, the contract's code in `details`. */
function refusal(code: string, message: string) {
  return Object.assign(new Error(message), { code: "online", details: { code, message } });
}

export interface SiteEventsDeps {
  /** The service, `https://api.jknet.app`. */
  api: string;
  /** The session token, `""` for a guest. */
  token: () => string;
  /** Moves to a route: the address bar and the screen. */
  navigate: (route: EventsRoute) => void;
}

/** The website's events platform. */
export function siteEventsPlatform({ api, token, navigate }: SiteEventsDeps): EventsPlatform {
  return {
    href: searchOfEvents,
    navigate,
    eventUrl: (id) => `${location.origin}${location.pathname}?event=${encodeURIComponent(id)}`,
    pickCover: async () => {
      const bearer = token();
      if (bearer === "") throw refusal("unauthorized", "Sign in to JKNet Online first.");
      const file = await pickFile();
      if (file === null) return null;
      if (file.size > COVER_MAX_BYTES) throw refusal("invalid", "The cover may take at most 3 MiB");
      const bytes = await file.arrayBuffer();
      if (pictureType(new Uint8Array(bytes.slice(0, 16))) === null) throw refusal("invalid", "Use a PNG, JPEG or WebP picture");
      const sha256 = await sha256Hex(bytes);
      let response: Response;
      try {
        response = await fetch(`${api}/v1/blobs/${sha256}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/octet-stream" },
          body: bytes,
          credentials: "omit",
        });
      } catch (failure) {
        throw Object.assign(new Error(failure instanceof Error ? failure.message : String(failure)), { code: "network", details: {} });
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        throw refusal(body?.error?.code ?? (response.status === 401 ? "unauthorized" : "internal"), body?.error?.message ?? `HTTP ${response.status}`);
      }
      return sha256;
    },
    searchJkhub: async (game: Game, query: string): Promise<JkhubPick[]> => {
      const response = await fetch(
        `${api}/v1/jkhub/search?game=${game}&q=${encodeURIComponent(query.trim().slice(0, 200))}&sort=mostDownloaded&page=1&perPage=8`,
        { credentials: "omit" },
      );
      if (!response.ok) throw refusal(response.status === 503 ? "provider_error" : "internal", `HTTP ${response.status}`);
      const body = (await response.json()) as { cards?: Array<{ id?: unknown; title?: unknown }> };
      return (body.cards ?? [])
        .filter((card): card is { id: number; title: string } => typeof card.id === "number" && typeof card.title === "string")
        .map((card) => ({ jkhubId: card.id, title: card.title }));
    },
  };
}

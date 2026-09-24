/**
 * --- slice: bundles ---
 *
 * The video links a bundle description may carry, and what to draw for each.
 *
 * A description is Markdown, and a video is a link to its page on its own
 * line. YouTube pages have an embeddable player and a still the site serves
 * by id, so a YouTube link is drawn as a block: the still with a play
 * button, and the player only after a click. Twitch and VK Video players
 * need the domain of the parent page, which the window of the launcher has
 * none of, so their links are drawn as a card that opens the browser. The
 * rules are pure and live here so the editor, which marks such a paragraph
 * as a block, and the view, which draws it, agree on what a video link is.
 */

/** The three hosts a description may embed or card. */
export type VideoHost = "youtube" | "twitch" | "vk";

/** A recognised video link: the host, and the video id when the host has one to embed. */
export interface VideoLink {
  host: VideoHost;
  /** The YouTube video id; `null` for the two hosts drawn as a card. */
  id: string | null;
  /** The address as written. */
  href: string;
}

/** What each host is called on the card and the block: proper names, not translated. */
export const VIDEO_HOST_NAMES: Record<VideoHost, string> = {
  youtube: "YouTube",
  twitch: "Twitch",
  vk: "VK Video",
};

/** A YouTube id is eleven characters of the URL-safe alphabet. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The YouTube id inside a link, or `null` when the link is not a video page. */
function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") id = url.searchParams.get("v");
    else if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") id = parts[1] ?? null;
  }
  return id !== null && YOUTUBE_ID.test(id) ? id : null;
}

/**
 * Reads a link as a video link, or answers `null` for any other address.
 *
 * Only `http` and `https` count, the way every link of a description does.
 * A YouTube link without a video id — a channel, a playlist — is not a
 * video and stays a link.
 */
export function videoLink(href: string): VideoLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  const id = youtubeId(url);
  if (id !== null) return { host: "youtube", id, href };
  if (host === "twitch.tv" || host === "clips.twitch.tv" || host.endsWith(".twitch.tv")) {
    return url.pathname.length > 1 ? { host: "twitch", id: null, href } : null;
  }
  if (host === "vk.com" || host === "vkvideo.ru" || host === "vk.ru") {
    // `vk.com/video-123_456`, `vk.com/video/…`, `vkvideo.ru/video-123_456`,
    // `vk.com/clip…`: the address names a video or a clip.
    return /^\/(?:video|clip)/i.test(url.pathname) ? { host: "vk", id: null, href } : null;
  }
  return null;
}

/** The still YouTube serves for a video, at 480 × 360. */
export function youtubeThumbnail(id: string): string {
  return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
}

/** The player of a video on the cookieless domain, started at once: it is loaded only after a click. */
export function youtubeEmbed(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`;
}

/** True for the two schemes a description link may use. */
export function isWebLink(href: string): boolean {
  return /^https?:\/\/\S+$/i.test(href.trim());
}

/** True for the one web scheme an outside picture of a description may use. */
export function isSecureLink(href: string): boolean {
  return /^https:\/\/\S+$/i.test(href.trim());
}

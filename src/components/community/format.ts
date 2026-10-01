/**
 * Names and small computations the community screens share.
 *
 * The names here are printed the same in every language: the two games, the
 * languages written in themselves (as the language setting of the launcher
 * writes them) and the services a link can lead to. Everything else a
 * community screen prints comes from the `community` catalog.
 */

import type { CommunityCard, CommunityServer, Game } from "./types";

/** The two games, as `GameSpec` of the core names them. */
export const GAME_NAMES: Record<Game, string> = {
  ja: "Jedi Academy",
  jo: "Jedi Outcast",
};

/** Every language of the service's list, written in itself. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ru: "Русский",
  uk: "Українська",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  pt: "Português",
  pl: "Polski",
  hu: "Magyar",
  it: "Italiano",
  tr: "Türkçe",
  cs: "Čeština",
  nl: "Nederlands",
  sv: "Svenska",
  fi: "Suomi",
};

/** The services a community link may lead to, by `kind`. `other` shows its host. */
export const LINK_NAMES: Record<string, string> = {
  youtube: "YouTube",
  twitch: "Twitch",
  telegram: "Telegram",
  vk: "VK",
  steam: "Steam",
  github: "GitHub",
};

/**
 * The hue of a community's placeholder cover and logo, out of its id: the
 * same community has the same colour on every screen and every machine.
 */
export function communityHue(id: string): number {
  let hash = 0;
  for (let at = 0; at < id.length; at += 1) hash = (hash * 31 + id.charCodeAt(at)) % 3607;
  return (hash * 7) % 360;
}

/** Two letters for a logo without a picture: the first letters of the first two words. */
export function monogram(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join("").toUpperCase();
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

/** The host of an address without `www.`, for a link row. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

/** Whether an address is one the page may open: `https:` only. */
export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The servers a card shows, in the order of the page. */
export function orderedServers(card: CommunityCard): CommunityServer[] {
  return [...card.servers].sort((a, b) => a.position - b.position);
}

/** What a server is called on the page: its label, or its address. */
export function serverName(server: CommunityServer): string {
  return server.label.trim() !== "" ? server.label : server.address;
}

/** Whole days between a `YYYY-MM-DD` day and today, both in UTC. */
export function daysSince(day: string, now: Date = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return null;
  const then = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

/** A number in the reader's language: `1 234`, `1,234`. */
export function formatCount(value: number, language: string): string {
  try {
    return new Intl.NumberFormat(language).format(value);
  } catch {
    return String(value);
  }
}

/** A moment in the reader's language, with the time. */
export function formatMoment(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** A list of names in the reader's language: «Jan, Rosh and Kyle». */
export function joinNames(names: string[], language: string): string {
  const format = (Intl as unknown as {
    ListFormat?: new (locale: string, options: { type: string }) => { format: (list: string[]) => string };
  }).ListFormat;
  if (format === undefined) return names.join(", ");
  try {
    return new format(language, { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

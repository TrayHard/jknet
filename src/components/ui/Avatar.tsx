import { Globe, Smartphone } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/format";

export type AvatarSize = "sm" | "md" | "lg";

/** The three states the status dot shows, matching `Presence.status`. */
export type AvatarStatus = "online" | "in_game" | "offline";

// --- slice: web app ---
/** The web app's two kinds of device, matching `Presence.device`. */
export type AvatarDevice = "phone" | "desktop";

interface AvatarProps {
  /** Full name; the initials are taken from it. `null` draws the guest circle. */
  name: string | null;
  /** Picture from the identity provider. Falls back to the initials. */
  src?: string | null;
  size?: AvatarSize;
  /** Draws the dot in the corner. Omit it where presence is not the point. */
  status?: AvatarStatus;
  // --- slice: web app ---
  /**
   * Online only in the web app: the dot grows into a badge with a phone or
   * a globe in it. Only next to `status: "online"`.
   */
  device?: AvatarDevice | null;
  className?: string;
}

/** Figma sizes: sm 24, md 32, lg 40. */
const SIZES: Record<AvatarSize, string> = {
  sm: "size-24 text-[10px]",
  md: "size-32 text-body-sm-medium",
  lg: "size-40 text-body-md-medium",
};

const DOT_SIZE: Record<AvatarSize, string> = {
  sm: "size-8",
  md: "size-10",
  lg: "size-12",
};

const DOT_TONE: Record<AvatarStatus, string> = {
  in_game: "bg-accent",
  online: "bg-success",
  offline: "bg-elevated",
};

// --- slice: web app ---
/**
 * The badge that replaces the dot, and the icon in it: the prototypes'
 * badge, scaled to the kit's avatars, which are smaller than theirs.
 */
const BADGE_SIZE: Record<AvatarSize, { box: string; icon: number }> = {
  sm: { box: "size-12 -bottom-2 -right-2", icon: 8 },
  md: { box: "size-14 -bottom-3 -right-3", icon: 9 },
  lg: { box: "size-18 -bottom-3 -right-3", icon: 11 },
};

/**
 * Initials of a display name: at most two letters.
 *
 * Names on the service carry whatever the identity provider allowed, so the split
 * is on anything that is not a letter or a digit — `kyle_k`, `Kyle-Katarn` and
 * `Kyle Katarn` all have to give something better than a blank circle.
 */
export function initials(name: string): string {
  const parts = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length > 0)
    .slice(0, 2);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return parts.map((part) => part[0].toUpperCase()).join("");
}

/**
 * The Avatar of the design: a circle with initials, a picture when the
 * provider gave one, and an optional presence dot.
 *
 * A service account may have no picture at all — the dev provider never sets one,
 * and a JKHub account without one is common — so initials are the normal case
 * rather than the fallback. A picture that fails to load falls back to them
 * too: the service stores whatever URL the provider gave it, and that URL outlives
 * neither a renamed CDN nor an account deleted on the provider's side.
 */
export function Avatar({ name, src, size = "md", status, device, className }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const circle = cn("rounded-full", SIZES[size]);
  // --- slice: web app ---
  const badge = status === "online" && device ? BADGE_SIZE[size] : null;
  const BadgeIcon = device === "desktop" ? Globe : Smartphone;

  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      {src && !broken ? (
        <img
          src={src}
          alt=""
          className={cn(circle, "object-cover bg-elevated")}
          onError={() => setBroken(true)}
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            circle,
            "inline-flex items-center justify-center",
            "bg-elevated text-fg-secondary select-none",
          )}
        >
          {name === null ? "?" : initials(name)}
        </span>
      )}
      {badge !== null ? (
        // --- slice: web app --- the dot of an online player, grown to carry
        // the device: the status line under the name says it in words.
        <span
          aria-hidden="true"
          className={cn(
            "absolute flex items-center justify-center rounded-full ring-2 ring-app",
            "bg-success text-fg-inverse",
            badge.box,
          )}
        >
          <BadgeIcon size={badge.icon} strokeWidth={2.5} />
        </span>
      ) : status === undefined ? null : (
        <span
          // The ring is the app background, not a border colour: the dot has to
          // read as a hole punched in the avatar on every surface it sits on.
          className={cn(
            "absolute -bottom-1 -right-1 rounded-full ring-2 ring-app",
            DOT_SIZE[size],
            DOT_TONE[status],
          )}
        />
      )}
    </span>
  );
}

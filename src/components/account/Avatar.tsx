import { useState } from "react";

import { cn } from "../../lib/format";
import type { HubUser } from "../../lib/ipc";

export type AvatarSize = "sm" | "md" | "lg";

interface AvatarProps {
  /** `null` draws the guest avatar. */
  user: HubUser | null;
  size?: AvatarSize;
  className?: string;
}

/** The three sizes of the Avatar component in the Figma kit. */
const SIZES: Record<AvatarSize, string> = {
  sm: "size-24 text-mono-xs",
  md: "size-32 text-body-sm-medium",
  lg: "size-40 text-body-md-medium",
};

/**
 * The player's picture, or their initials.
 *
 * A hub account may have no avatar at all — the dev provider never sets one,
 * and a JKHub account without a picture is common — so initials are the normal
 * case rather than the fallback. A picture that fails to load falls back to
 * them too: the hub stores whatever URL the provider gave it, and that URL
 * outlives neither a renamed CDN nor an account deleted on the provider's side.
 */
export function Avatar({ user, size = "md", className }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const shell = cn(
    "flex items-center justify-center shrink-0 rounded-full overflow-hidden",
    SIZES[size],
    className,
  );

  if (user?.avatarUrl && !broken) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        className={cn(shell, "object-cover")}
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        shell,
        user ? "bg-accent-subtle text-fg-accent" : "bg-elevated text-fg-secondary",
      )}
      aria-hidden="true"
    >
      {user ? initials(user.displayName) : "?"}
    </span>
  );
}

/**
 * Up to two letters from a display name.
 *
 * Words first, so "Kyle Katarn" gives KK; a single word gives its first two
 * letters. A name of symbols alone gives nothing, and the circle stays empty
 * rather than showing a mangled glyph.
 */
export function initials(displayName: string): string {
  const words = displayName
    .split(/\s+/)
    .map((word) => [...word].find((c) => /\p{L}|\p{N}/u.test(c)))
    .filter((letter): letter is string => letter !== undefined);

  if (words.length >= 2) return (words[0] + words[1]).toUpperCase();
  const letters = [...displayName].filter((c) => /\p{L}|\p{N}/u.test(c));
  return letters.slice(0, 2).join("").toUpperCase();
}

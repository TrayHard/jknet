import { Map as MapIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/format";
import { levelshotUrl } from "../lib/ipc";
import { useLevelshot } from "../lib/queries";

interface MapPreviewProps {
  /** Map as a server reports it. The core lowercases it into the cache key. */
  map: string;
  /** Printed above the map name, for a hero that names its server. */
  serverName?: string;
  /**
   * Thinner caption band and a shorter fade, for a box under ~120 px tall.
   * The band is the ground for the text, so it cannot shrink below the text
   * itself; what gives way is the padding around it.
   */
  compact?: boolean;
  /** Sizing and placement. The box fills whatever it is given. */
  className?: string;
}

/**
 * A shadow under the caption, for the light letters that end up over a light
 * part of the picture while the band fades out above them.
 */
const CAPTION_SHADOW = "[text-shadow:0_1px_2px_rgba(0,0,0,0.9)]";

/**
 * The picture of a map, or the gradient the design falls back to.
 *
 * The launcher ships no map art: the picture is extracted from the pk3 files
 * the player already has, and plenty of maps have none — every custom map
 * whose author left the levelshot out, and every map that is not installed on
 * this machine. The placeholder is therefore the normal case, not an error
 * state, and it carries the map name just like the picture does.
 *
 * The caption sits inside a scrim band rather than on the picture. A levelshot
 * is a screenshot of a game: it can be bright anywhere, so nothing about the
 * picture can be assumed. The band is flat under the text and fades only above
 * it, which is what keeps the contrast of the text a known number instead of a
 * property of whichever map the server happens to run.
 */
export function MapPreview({
  map,
  serverName,
  compact = false,
  className,
}: MapPreviewProps) {
  const shot = useLevelshot(map);
  // A file that vanished between the index and the paint: the cache is
  // throwaway data and the placeholder is already the right answer.
  const [broken, setBroken] = useState<string | null>(null);

  const path = shot.data?.path ?? null;
  const url = path !== null && path !== broken ? levelshotUrl(path) : null;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-line-subtle bg-app",
        className,
      )}
    >
      {url === null ? (
        <>
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-br from-accent-subtle to-purple-subtle opacity-60"
          />
          <MapIcon
            aria-hidden="true"
            size={20}
            className="absolute right-12 top-10 text-fg-muted"
          />
        </>
      ) : (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={() => setBroken(path)}
        />
      )}

      {/* The caption band. It spans the box, grows with its one or two lines,
          and is the same on the picture and on the placeholder. */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-scrim",
          compact ? "px-10 pb-8 pt-6" : "px-12 pb-10 pt-8",
        )}
      >
        {/* The fade lives above the band, not under the text: a gradient that
            ran behind the letters would make their contrast depend on how many
            lines the caption happens to have. */}
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-x-0 bottom-full bg-gradient-to-t from-scrim to-transparent",
            compact ? "h-20" : "h-32",
          )}
        />
        {serverName ? (
          <span
            className={cn(
              "text-body-sm text-fg-secondary truncate",
              CAPTION_SHADOW,
            )}
          >
            {serverName}
          </span>
        ) : null}
        <span className={cn("text-mono-sm text-fg truncate", CAPTION_SHADOW)}>
          {map || "unknown map"}
        </span>
      </div>
    </div>
  );
}

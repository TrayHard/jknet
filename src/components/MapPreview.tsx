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
  /** Sizing and placement. The box fills whatever it is given. */
  className?: string;
}

/**
 * The picture of a map, or the gradient the design falls back to.
 *
 * The launcher ships no map art: the picture is extracted from the pk3 files
 * the player already has, and plenty of maps have none — every custom map
 * whose author left the levelshot out, and every map that is not installed on
 * this machine. The placeholder is therefore the normal case, not an error
 * state, and it carries the map name just like the picture does.
 */
export function MapPreview({ map, serverName, className }: MapPreviewProps) {
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
        <>
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 size-full object-cover"
            onError={() => setBroken(path)}
          />
          {/* The caption sits on the picture, so it needs its own ground. */}
          <div
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-app to-transparent"
          />
        </>
      )}

      <div className="absolute left-12 bottom-10 flex flex-col gap-2 max-w-[calc(100%-24px)]">
        {serverName ? (
          <span className="text-body-sm text-fg-secondary truncate">
            {serverName}
          </span>
        ) : null}
        <span className="text-mono-sm text-fg truncate">
          {map || "unknown map"}
        </span>
      </div>
    </div>
  );
}

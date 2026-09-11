import { useState } from "react";

import { cn } from "../lib/format";

interface EngineLogoProps {
  /** Engine id from the registry: the file is `<id>.png`, by convention. */
  engineId: string;
  /** Engine name, for the two letters drawn when there is no file. */
  name: string;
  /** Side of the square, in pixels. */
  size?: number;
  className?: string;
}

/**
 * The mark of one engine, out of `public/brand/engines/<engineId>.png`.
 *
 * The convention is the whole mechanism: no import, no map from id to file,
 * nothing to register. A build added to `src-tauri/src/engines.rs` shows its
 * icon as soon as a file named after its id lands in that folder, and shows
 * the first two letters of its name until then — which is what every card
 * looked like before the icons existed.
 *
 * The files are rebuilt from the upstream projects by
 * `scripts/make-engine-icons.ps1`. A failed load is remembered per id, so a
 * component that outlives a route change tries the new engine's file again
 * instead of inheriting the last one's failure.
 */
export function EngineLogo({ engineId, name, size = 44, className }: EngineLogoProps) {
  const [failed, setFailed] = useState<string | null>(null);

  if (failed === engineId) {
    return (
      <span
        style={{ width: size, height: size }}
        className={cn(
          "flex items-center justify-center rounded-md shrink-0",
          "bg-elevated text-fg-accent text-display-md select-none",
          className,
        )}
      >
        {name.slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      src={`/brand/engines/${engineId}.png`}
      width={size}
      height={size}
      // The name is printed next to every place this is drawn, so a screen
      // reader that also read the mark would say it twice.
      alt=""
      draggable={false}
      onError={() => setFailed(engineId)}
      className={cn("rounded-md shrink-0 select-none object-contain", className)}
    />
  );
}

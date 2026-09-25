import { Map as MapIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { levelshotUrl, type HostMap } from "../../lib/ipc";
import { Badge } from "../ui";

/**
 * The picture of a map, 64×36: its levelshot, or the gradient of the design
 * when the archives carry none.
 */
export function MapThumb({ map }: { map: HostMap }) {
  const [broken, setBroken] = useState<string | null>(null);
  const url =
    map.levelshot !== null && map.levelshot !== broken ? levelshotUrl(map.levelshot) : null;
  return (
    <span className="relative flex items-center justify-center w-64 h-36 shrink-0 overflow-hidden rounded-xs bg-gradient-to-br from-line-strong to-accent-subtle">
      {url === null ? (
        <MapIcon size={16} aria-hidden="true" className="text-fg-secondary" />
      ) : (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={() => setBroken(map.levelshot)}
        />
      )}
    </span>
  );
}

/**
 * The MapOption of the design: the picture, the map name in mono and, for a
 * map from the client's own files, the **From your library** badge.
 *
 * The badge carries **Friends need this map too.** on hover: a friend without
 * the pk3 gets a download prompt, or nothing, from the server.
 */
export function MapOption({ map, selected = false }: { map: HostMap; selected?: boolean }) {
  const { t } = useTranslation("host");
  return (
    <span className="flex items-center gap-12 min-w-0">
      <MapThumb map={map} />
      <span className="flex-1 min-w-0 flex flex-col items-start gap-4">
        <span
          className={cn("text-mono-sm truncate max-w-full", selected ? "text-fg-accent" : "text-fg")}
          title={map.title ?? map.name}
        >
          {map.name}
        </span>
        {map.source === "client" ? (
          <Badge tone="accent" title={t("setup.map.libraryHint")}>
            {t("setup.map.library")}
          </Badge>
        ) : null}
      </span>
    </span>
  );
}

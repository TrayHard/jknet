import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { filePreviewIpc, type FilePreview, type FilePreviewEntry } from "../../lib/ipc";
import { LibraryObjectIcon } from "./LibraryObjectIcon";

function candidates(map: string): string[] {
  const key = map.replace(/^maps\//, "").replace(/\.bsp$/, "");
  const names = [...new Set([key, key.slice(key.lastIndexOf("/") + 1)])];
  return names.flatMap(name => ["jpg", "jpeg", "png", "tga"].map(extension => `levelshots/${name}.${extension}`));
}

/** One batch per catalogue, through its stock-only preview session. */
export function useBaseGameMapShots(preview: FilePreview | undefined) {
  const maps = useMemo(() => preview?.entries.filter(entry => entry.kind === "map") ?? [], [preview]);
  return useQuery({
    queryKey: ["base-game-map-shots", preview?.id],
    enabled: !!preview && maps.length > 0,
    queryFn: async ({ signal }) => {
      const names = [...new Set(maps.flatMap(entry => candidates(entry.name)))];
      const images = new Map<string, string>();
      for (let at = 0; at < names.length && !signal.aborted; at += 256) {
        const assets = await filePreviewIpc.assets({ previewId: preview!.id, archive: 0 }, names.slice(at, at + 256));
        for (const asset of assets) if (asset.path) images.set(asset.name, asset.path);
      }
      return new Map(maps.map(entry => [entry.id, candidates(entry.name).flatMap(name => images.get(name) ?? [])]));
    },
    staleTime: Infinity, gcTime: 0, retry: false,
  });
}

export function BaseGameMapCard({ entry, archive, images, onOpen }: {
  entry: FilePreviewEntry; archive: string; images?: string[]; onOpen: () => void;
}) {
  const { t } = useTranslation("library");
  const [broken, setBroken] = useState<string[]>([]);
  const image = images?.find(url => !broken.includes(url));
  return <button type="button" onClick={onOpen} aria-label={t("preview.open", { name: entry.label })}
    className="w-full h-full flex flex-col overflow-hidden rounded-lg border border-line bg-surface hover:bg-hover-overlay text-left cursor-pointer">
    <span className="relative block w-full aspect-video overflow-hidden bg-app">
      {image ? <img src={image} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover"
        onError={() => setBroken(previous => [...previous, image])} />
        : <span className="absolute inset-0 flex items-center justify-center"><LibraryObjectIcon kind="map" size={40} className="text-fg-muted" /></span>}
    </span>
    <span className="block p-16 min-w-0 w-full">
      <span className="block text-body-md-medium text-fg break-words">{entry.label}</span>
      <span className="block text-body-xs text-fg-muted mt-4">{archive}</span>
    </span>
  </button>;
}

import { AlertTriangle, Power, PowerOff, Trash2 } from "lucide-react";
import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type { LibraryItem } from "../../lib/ipc";
import { isTauri } from "../../lib/runtime";
// --- slice: selection context menu ---
import { Badge, Toggle, useContextMenu, type MenuItem } from "../ui";
import { categoryInfo } from "./categories";

interface LibraryCardProps {
  item: LibraryItem;
  /** True when another enabled archive changes the same content. */
  conflicting: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onConflict?: () => void;
  onPreview?: () => void;
  busy?: boolean;
}

/**
 * One file of the library, the ModCard of the design.
 *
 * Artwork comes from this archive, with the catalogue thumbnail as fallback.
 */
export function LibraryCard({
  item,
  conflicting,
  onToggle,
  onRemove,
  onConflict,
  onPreview,
  busy = false,
}: LibraryCardProps) {
  const { t } = useTranslation("library");
  const { t: tCommon } = useTranslation("common");
  const format = useFormat();
  const info = categoryInfo(item.category);
  const localImage = isTauri() && item.previewPath ? convertFileSrc(item.previewPath) : null;
  const revision = JSON.stringify([item.id, localImage, item.thumbnailUrl]);
  const [failures, setFailures] = useState<{ revision: string; urls: string[] }>({ revision, urls: [] });
  const failedImages = failures.revision === revision ? failures.urls : [];
  const image = [localImage, item.thumbnailUrl].find(
    (url): url is string => Boolean(url) && !failedImages.includes(url as string),
  );

  // --- slice: selection context menu ---
  // The two controls the card already carries: the switch that loads the
  // archive into the client and the bin that takes it out. There is no third
  // line, because the launcher has no command that opens the folder of one
  // file — the folder it could show is the client's, which the card does not
  // know about.
  const menu = useContextMenu<LibraryItem>({
    ariaLabel: t("card.actions"),
    items: (): MenuItem[] => [
      item.enabled
        ? {
            id: "disable",
            label: tCommon("actions.disable"),
            icon: <PowerOff size={14} />,
            disabled: busy,
          }
        : {
            id: "enable",
            label: tCommon("actions.enable"),
            icon: <Power size={14} />,
            disabled: busy,
          },
      {
        id: "remove",
        label: tCommon("actions.remove"),
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: busy,
      },
    ],
    onSelect: (id) => {
      if (id === "remove") onRemove();
      else onToggle(id === "enable");
    },
  });

  return (
    <li
      className={cn(
        "flex flex-col rounded-lg border bg-surface overflow-hidden",
        "transition-colors duration-150",
        item.enabled ? "border-line" : "border-line-subtle",
        onPreview && "cursor-pointer hover:border-line-accent",
      )}
      // --- slice: selection context menu ---
      onContextMenu={(event) => menu.open(event, item)}
      onClick={event => {
        if (!(event.target as HTMLElement).closest("button, input, a, [role='switch']")) onPreview?.();
      }}
    >
      {menu.menu}
      {image ? (
        <img src={image} alt="" loading="lazy" className="w-full h-96 object-contain bg-elevated"
          key={image}
          onError={() => setFailures((previous) => ({
            revision,
            urls: [...new Set([...(previous.revision === revision ? previous.urls : []), image])],
          }))} />
      ) : null}

      <div className="flex flex-col gap-8 p-12">
        <div className="flex items-start gap-8">
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <button
              type="button"
              onClick={onPreview}
              aria-label={t("preview.open", { name: item.displayName })}
              className={cn(
                "text-body-md-medium truncate text-left cursor-pointer",
                item.enabled ? "text-fg" : "text-fg-muted",
              )}
              title={item.displayName}
            >
              {item.displayName}
            </button>
            <span className="text-body-sm text-fg-muted truncate" title={item.fileName}>
              {sourceLine(item, t)}
            </span>
          </div>
          <Toggle
            label={t("card.enable", { file: item.displayName })}
            checked={item.enabled}
            disabled={busy}
            onChange={onToggle}
          />
        </div>

        {item.mapNames?.length ? (
          <ul className="flex flex-col gap-2 text-mono-xs text-fg-secondary">
            {item.mapNames.map((name) => <li key={name} className="break-all">{name}</li>)}
          </ul>
        ) : null}
        <div className="flex items-center gap-8">
          {/* The row wraps instead of squeezing: a size that breaks across
              two lines is unreadable, a badge on the next line is not. */}
          <div className="flex flex-wrap items-center gap-6 flex-1 min-w-0">
            <Badge tone={info.tone}>{t(`categoryOne.${item.category}`)}</Badge>
            <span className="text-mono-xs text-fg-muted whitespace-nowrap">
              {format.bytes(item.size)}
            </span>
            {conflicting ? (
              <button
                type="button"
                onClick={onConflict}
                title={t("conflicts.showNotice")}
                className="cursor-pointer rounded-sm"
              >
                <Badge tone="warm" icon={<AlertTriangle size={12} />}>
                  {t("card.conflict")}
                </Badge>
              </button>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={t("card.remove", { file: item.displayName })}
            title={t("card.removeHint")}
            disabled={busy}
            onClick={onRemove}
            className={cn(
              "inline-flex items-center justify-center size-28 rounded-sm shrink-0",
              "cursor-pointer text-fg-muted hover:bg-hover-overlay hover:text-fg-danger",
              "transition-colors duration-150 disabled:cursor-not-allowed",
            )}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * The line under the title: where the file came from, and which folder it
 * loads from when that is not the usual one.
 */
function sourceLine(
  item: LibraryItem,
  t: ReturnType<typeof useTranslation<"library">>["t"],
): string {
  // A source other than `local` is the name of the site the file came from —
  // `jkhub` — which is a proper noun and stays as it is.
  const origin =
    item.source === "local" || item.source == null
      ? t("card.addedByHand")
      : item.source;
  return item.folder === "base"
    ? origin
    : t("card.sourceWithFolder", { source: origin, folder: item.folder });
}

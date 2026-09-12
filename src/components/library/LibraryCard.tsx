import { AlertTriangle, Power, PowerOff, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useFormat } from "../../i18n/useFormat";
import { cn } from "../../lib/format";
import type { LibraryItem } from "../../lib/ipc";
// --- slice: selection context menu ---
import { Badge, Toggle, useContextMenu, type MenuItem } from "../ui";
import { categoryInfo } from "./categories";

interface LibraryCardProps {
  item: LibraryItem;
  /** True when another enabled archive changes the same content. */
  conflicting: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  busy?: boolean;
}

/**
 * One file of the library, the ModCard of the design.
 *
 * The thumbnail is the category icon: JKHub previews arrive with downloads,
 * and an empty grey box says less than the icon does.
 */
export function LibraryCard({
  item,
  conflicting,
  onToggle,
  onRemove,
  busy = false,
}: LibraryCardProps) {
  const { t } = useTranslation("library");
  const { t: tCommon } = useTranslation("common");
  const format = useFormat();
  const info = categoryInfo(item.category);
  const Icon = info.icon;

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
      )}
      // --- slice: selection context menu ---
      onContextMenu={(event) => menu.open(event, item)}
    >
      {menu.menu}
      <div
        className={cn(
          "flex items-center justify-center h-96 bg-elevated",
          item.enabled ? "text-fg-secondary" : "text-fg-disabled",
        )}
      >
        <Icon size={28} />
      </div>

      <div className="flex flex-col gap-8 p-12">
        <div className="flex items-start gap-8">
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <span
              className={cn(
                "text-body-md-medium truncate",
                item.enabled ? "text-fg" : "text-fg-muted",
              )}
              title={item.displayName}
            >
              {item.displayName}
            </span>
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

        <div className="flex items-center gap-8">
          {/* The row wraps instead of squeezing: a size that breaks across
              two lines is unreadable, a badge on the next line is not. */}
          <div className="flex flex-wrap items-center gap-6 flex-1 min-w-0">
            <Badge tone={info.tone}>{t(`categoryOne.${item.category}`)}</Badge>
            <span className="text-mono-xs text-fg-muted whitespace-nowrap">
              {format.bytes(item.size)}
            </span>
            {conflicting ? (
              <Badge tone="warm" icon={<AlertTriangle size={12} />}>
                {t("card.conflict")}
              </Badge>
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

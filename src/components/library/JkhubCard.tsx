import { ArrowDownCircle, Check, Download, Star } from "lucide-react";
import { useState } from "react";

import { formatBytes } from "../../lib/format";
import type { JkhubCardData } from "../../lib/ipc";
import { Badge, Button } from "../ui";

interface JkhubCardProps {
  card: JkhubCardData;
  /** Name of the category the card sits in, when the tree knows it. */
  categoryName?: string;
  /** True when provenance says this file is already in the chosen client. */
  installed: boolean;
  /** Bytes of the archive received so far, while this card is installing. */
  progress?: { received: number; total: number } | null;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
}

/**
 * One file of JKHub, the ModCard of the design with a real thumbnail.
 *
 * The picture is loaded straight from jkhub.org by the webview: caching it on
 * disk would be a second copy to keep fresh, and the site serves its images
 * with a month-long lifetime already. `loading="lazy"` keeps a grid of
 * twenty-five cards from asking for twenty-five pictures at once.
 *
 * `referrerPolicy="no-referrer"` is what makes the picture appear at all. The
 * site refuses hotlinked images: the same address answers `200 image/jpeg`
 * with no `Referer` and `403 text/plain` with the webview's own origin in one,
 * so every card used to show an empty box. The rule is also in `index.html`;
 * this attribute is the copy that holds inside a Tauri custom scheme.
 */
export function JkhubCard({
  card,
  categoryName,
  installed,
  progress,
  busy,
  onOpen,
  onInstall,
}: JkhubCardProps) {
  // The address that failed rather than a flag: a card reused for another file
  // gets its picture back without an effect to reset anything.
  const [broken, setBroken] = useState<string | null>(null);
  const thumbnail =
    card.thumbnailUrl && card.thumbnailUrl !== broken ? card.thumbnailUrl : null;
  const downloading = progress != null;

  return (
    <li className="flex flex-col rounded-lg border border-line bg-surface overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${card.title}`}
        className="block h-120 bg-elevated cursor-pointer overflow-hidden"
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            // A picture the site withdrew, renamed or refuses leaves the same
            // placeholder a file without a screenshot gets, never a blank box.
            onError={() => setBroken(thumbnail)}
            className="size-full object-cover"
          />
        ) : (
          <span className="flex size-full items-center justify-center text-fg-muted">
            <Download size={28} />
          </span>
        )}
      </button>

      <div className="flex flex-col gap-8 p-12 flex-1">
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onOpen}
            title={card.title}
            className="text-body-md-medium text-fg text-left truncate cursor-pointer hover:text-fg-accent"
          >
            {card.title}
          </button>
          <span className="text-body-sm text-fg-muted truncate">
            {[card.author?.name, categoryName].filter(Boolean).join(" · ") ||
              "JKHub"}
          </span>
        </div>

        <p className="text-body-sm text-fg-secondary line-clamp-2">
          {card.description}
        </p>

        <div className="flex flex-wrap items-center gap-6">
          {card.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
        </div>

        {/* The row wraps rather than squeezing: three columns of cards leave
            about 200 px here, and a truncated date says less than a second
            line does. */}
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-mono-xs text-fg-muted mt-auto">
          {card.downloads != null ? (
            <span className="inline-flex items-center gap-4 whitespace-nowrap">
              <ArrowDownCircle size={12} aria-hidden />
              {card.downloads.toLocaleString("en-US")}
            </span>
          ) : null}
          {card.rating ? (
            <span className="inline-flex items-center gap-4 whitespace-nowrap">
              <Star size={12} aria-hidden />
              {card.rating.value.toFixed(1)}
            </span>
          ) : null}
          <span className="whitespace-nowrap">{dateLine(card)}</span>
        </div>

        <div className="flex items-center gap-8">
          {installed ? (
            <Badge tone="success" icon={<Check size={12} />}>
              Installed
            </Badge>
          ) : null}
          <span className="flex-1" />
          <Button
            size="sm"
            variant={installed ? "secondary" : "primary"}
            icon={<Download size={14} />}
            disabled={busy}
            onClick={onInstall}
          >
            {downloading ? received(progress) : installed ? "Reinstall" : "Install"}
          </Button>
        </div>
      </div>
    </li>
  );
}

/** `Updated Sep 2, 2026`, or nothing when the card printed no date. */
function dateLine(card: JkhubCardData): string {
  if (!card.date) return "";
  const when = new Date(card.date);
  if (Number.isNaN(when.getTime())) return "";
  return `${card.dateLabel ?? "Updated"} ${when.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
}

/** What the button says while the archive is coming down. */
function received(progress: { received: number; total: number }): string {
  if (progress.total > 0) {
    const percent = Math.round((progress.received / progress.total) * 100);
    return `${percent}%`;
  }
  return formatBytes(progress.received);
}

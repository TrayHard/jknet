import { ArrowDownCircle, Check, Download, Star } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

// --- slice: i18n ---
import { useFormat, type Formatters } from "../../i18n/useFormat";
import type { JkhubCardData } from "../../lib/ipc";
import { Badge, Button } from "../ui";

interface JkhubCardProps {
  card: JkhubCardData;
  /** Name of the category the card sits in, when the tree knows it. */
  categoryName?: string;
  /** True when provenance says this file is already in the chosen client. */
  installed: boolean;
  // --- slice: library cleanup ---
  /**
   * True once an install answered that there is nothing here to install: the
   * archive is a `.rar`, or the entry links to another site instead of
   * carrying a file. Neither is knowable before the try — a listing card of
   * jkhub.org names no archive — so the button offers the site from the
   * second press on.
   */
  openOnly: boolean;
  /** Bytes of the archive received so far, while this card is installing. */
  progress?: { received: number; total: number } | null;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
  /** Opens the file page of jkhub.org in the system browser. */
  onOpenSite: () => void;
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
 *
 * --- slice: library cleanup ---
 * The foot of the card is one button across its whole width. Three cards to a
 * row leave about 200 px here, and a badge and a button sharing that line left
 * whichever of them was longer to be squeezed — **Reinstall** and its
 * translations first. The state a card is in is what its button says, and
 * **Installed** moved up beside the author, where a truncated line is a line
 * the player can read in the dialog anyway.
 */
export function JkhubCard({
  card,
  categoryName,
  installed,
  openOnly,
  progress,
  busy,
  onOpen,
  onInstall,
  onOpenSite,
}: JkhubCardProps) {
  const { t } = useTranslation("jkhub");
  const format = useFormat();
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
        aria-label={t("card.open", { title: card.title })}
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
          {/* Author and category are the site's own words. */}
          <span className="flex items-center gap-6 min-w-0">
            <span className="text-body-sm text-fg-muted truncate flex-1">
              {[card.author?.name, categoryName].filter(Boolean).join(" · ") ||
                t("card.fallbackAuthor")}
            </span>
            {installed ? (
              <Badge tone="success" icon={<Check size={12} />} className="shrink-0">
                {t("card.installed")}
              </Badge>
            ) : null}
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
              {format.number(card.downloads)}
            </span>
          ) : null}
          {card.rating ? (
            <span className="inline-flex items-center gap-4 whitespace-nowrap">
              <Star size={12} aria-hidden />
              {card.rating.value.toFixed(1)}
            </span>
          ) : null}
          <span className="whitespace-nowrap">{dateLine(card, t, format)}</span>
        </div>

        {/* No icon on this one. Three cards to a row leave 216 px inside a
            card at the 1280 px of the design, and the longest translation of
            the label — Hungarian, 25 characters — needs all of it: an icon
            and its gap would push the text past the edge of the button, and
            a label a player cannot read whole is worse than one without a
            picture. The two labels below are short in every language. */}
        {openOnly ? (
          <Button block onClick={onOpenSite}>
            {t("details.openOnSite")}
          </Button>
        ) : (
          <Button
            block
            variant={installed ? "secondary" : "primary"}
            icon={<Download size={16} />}
            disabled={busy}
            onClick={onInstall}
          >
            {downloading
              ? received(progress, format)
              : installed
                ? t("card.reinstall")
                : t("card.install")}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * `Updated 2 Sep 2026`, or nothing when the card printed no date.
 *
 * The site prints either «Updated» or «Submitted» over the date, and which of
 * the two it was is the only part of the line that is not the date itself.
 */
function dateLine(
  card: JkhubCardData,
  t: ReturnType<typeof useTranslation<"jkhub">>["t"],
  format: Formatters,
): string {
  if (!card.date) return "";
  const when = format.date(card.date);
  if (when === card.date) return "";
  return card.dateLabel === "Submitted"
    ? t("card.submitted", { date: when })
    : t("card.updated", { date: when });
}

/** What the button says while the archive is coming down. */
function received(
  progress: { received: number; total: number },
  format: Formatters,
): string {
  if (progress.total > 0) {
    return format.percent(progress.received / progress.total);
  }
  return format.bytes(progress.received);
}

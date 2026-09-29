import { ArrowDownCircle, ExternalLink, ImageOff, Library, Share2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useShareDialog } from "../../../../src/components/chat/ShareToChatDialog.tsx";
import { JkhubRating } from "../../../../src/components/library/JkhubRating.tsx";
import { Badge, Button, EmptyState } from "../../../../src/components/ui/index.ts";
import { useErrorText } from "../../../../src/i18n/errors.ts";
import { useFormat } from "../../../../src/i18n/useFormat.ts";
import { backend } from "../../../../src/lib/backend.ts";
import { jkhubModCard } from "../../../../src/lib/chat/cardDrafts.ts";
import { useGameNames } from "../../../../src/lib/game.ts";
import { onlineErrorCode, type Game, type JkhubCardData } from "../../../../src/lib/ipc.ts";
import { useJkhubCategories, useJkhubIndexStatus } from "../../../../src/lib/queries.ts";
import { useJkhubFileCard, useSectionOf } from "../catalog/jkhub.ts";
import { PlatformNote } from "../catalog/PlatformNote.tsx";
import { catalogUnavailable } from "../catalog/serverList.ts";

/** The picture of the file, or the placeholder a card without one gets. */
function Thumbnail({ url }: { url: string | null }) {
  // The address that failed, so a picture the site withdrew leaves the
  // placeholder rather than a blank box.
  const [broken, setBroken] = useState<string | null>(null);
  const shown = url !== null && url !== broken ? url : null;
  return (
    <div className="flex h-160 w-full items-center justify-center overflow-hidden rounded-lg bg-elevated text-fg-muted sm:h-200">
      {shown !== null ? (
        <img
          src={shown}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBroken(shown)}
          className="size-full object-cover"
        />
      ) : (
        <ImageOff size={32} aria-hidden="true" />
      )}
    </div>
  );
}

/** What the index knows of one file. */
function FileFacts({ card, game }: { card: JkhubCardData; game: Game }) {
  const { t } = useTranslation("jkhub");
  const { t: tWeb } = useTranslation("web");
  const { t: tChat } = useTranslation("chat");
  const format = useFormat();
  const gameNames = useGameNames();
  const share = useShareDialog();
  const categories = useJkhubCategories(game);
  const status = useJkhubIndexStatus(game);
  const sectionOf = useSectionOf(categories.data?.categories ?? []);
  const section = sectionOf(card.categoryId);
  const date = card.date ? format.date(card.date) : "";

  return (
    <>
      <Thumbnail url={card.thumbnailUrl} />
      <div className="flex flex-col gap-4">
        <h1 className="text-display-md text-fg [overflow-wrap:anywhere]">{card.title}</h1>
        <p className="text-body-md text-fg-secondary [overflow-wrap:anywhere]">
          {[card.author?.name ?? t("card.fallbackAuthor"), section, gameNames.label(game)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap gap-8">
        <Button variant="primary" icon={<ExternalLink size={16} />} onClick={() => void backend().openExternal(card.url)}>
          {t("details.openOnSite")}
        </Button>
        {share.available ? (
          <Button icon={<Share2 size={16} />} onClick={() => share.open({ kind: "card", card: jkhubModCard({ ...card, game }, game) })}>
            {tChat("share.action")}
          </Button>
        ) : null}
      </div>
      <PlatformNote text={tWeb("catalog.installNote")} />
      {card.description.trim() !== "" ? (
        <section className="flex flex-col gap-6" aria-label={tWeb("jkhub.description")}>
          <h2 className="text-label-xs text-fg-muted">{tWeb("jkhub.description")}</h2>
          <p className="text-body-md text-fg [overflow-wrap:anywhere] whitespace-pre-line" data-testid="jkhub-description">
            {card.description}
          </p>
        </section>
      ) : null}
      <div className="flex flex-col gap-8 text-body-sm" data-testid="jkhub-facts">
        <div className="flex flex-wrap items-center gap-x-12 gap-y-4 text-fg-muted">
          {card.downloads != null ? (
            <span className="inline-flex items-center gap-4">
              <ArrowDownCircle size={14} aria-hidden="true" />
              {t("details.downloads", { count: format.number(card.downloads) })}
            </span>
          ) : null}
          {date !== "" && date !== card.date ? (
            <span>{card.dateLabel === "Submitted" ? t("card.submitted", { date }) : t("card.updated", { date })}</span>
          ) : null}
        </div>
        <JkhubRating rating={card.rating} />
        {card.tags.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-6" aria-label={tWeb("jkhub.tags")}>
            {card.tags.map((tag) => (
              <li key={tag}>
                <Badge tone="neutral">{tag}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {status.data?.updatedAt ? (
        <p className="text-body-sm text-fg-muted">{tWeb("jkhub.indexedAt", { date: format.date(status.data.updatedAt) })}</p>
      ) : null}
      {share.dialog}
    </>
  );
}

/**
 * One JKHub file, from the catalog JKNet Online keeps: the picture, the
 * title, the author, the section, the description the index holds, the
 * downloads, the date, the rating and the tags. **Open on JKHub** opens the
 * file's page on jkhub.org in a new tab, the one place with its screenshots,
 * comments and download; **Share to chat** sends it as a card. Installing is
 * JKNet's on the PC, and the page says so.
 *
 * The page reads its file from the service by id, so it opens from a link
 * as well as from the list.
 */
export function JkhubDetailsScreen({ game, fileId }: { game: Game; fileId: number }) {
  const { t: tWeb } = useTranslation("web");
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("jkhub");
  const errorText = useErrorText();
  const file = useJkhubFileCard(game, fileId);

  return (
    <div className="flex flex-col gap-16 px-16 py-20 sm:px-32 sm:py-24" data-testid="jkhub-details">
      {file.data !== undefined ? (
        <FileFacts card={file.data} game={game} />
      ) : file.isLoading ? (
        <p role="status" className="text-body-sm text-fg-muted">
          {t("details.loadingTitle")}
        </p>
      ) : file.error !== null && catalogUnavailable(file.error) ? (
        <EmptyState icon={<Library size={24} />} title={tWeb("jkhub.unavailableTitle")} text={tWeb("jkhub.unavailableText")} />
      ) : file.error !== null && onlineErrorCode(file.error) === "not_found" ? (
        <div role="alert">
          <EmptyState icon={<Library size={24} />} title={tWeb("jkhub.notFoundTitle")} text={tWeb("jkhub.notFoundText")} />
        </div>
      ) : (
        <EmptyState
          icon={<Library size={24} />}
          title={t("empty.categoryTitle")}
          text={file.error !== null ? errorText(file.error) : tWeb("jkhub.notFoundText")}
          action={
            <Button disabled={file.isFetching} onClick={() => void file.refetch()}>
              {tCommon("actions.tryAgain")}
            </Button>
          }
        />
      )}
    </div>
  );
}

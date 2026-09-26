import { Box, Download, ExternalLink, ImageOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import { jkhubFileUrl } from "../../../lib/chat/cardDrafts";
import { useDefaultClient, useGameNames } from "../../../lib/game";
import { useJkhubFile, useJkhubInstall } from "../../../lib/queries";
import { Button } from "../../ui";
import { useLinkOpener } from "../LinkConfirmDialog";
import { CardShell, CardStatus } from "./CardShell";
import { useCheckedCard } from "./useCardActions";
import type { CardViewProps } from "./withFields";

/**
 * --- slice: chat cards ---
 *
 * A file of JKHub.
 *
 * The card reads the file page the way the JKHub tab of the Library does —
 * the first screenshot, the author, the category, the downloads — and
 * **Install** puts it into the default client of its game through the same
 * install, which the download toasts of the main window follow. A file JKHub
 * hosts elsewhere, or an archive without pk3 files, says so and leaves
 * **Open on JKHub**.
 *
 * Every picture carries `referrerPolicy="no-referrer"`: the site refuses a
 * hotlinked image otherwise, as `JkhubCard` explains.
 */
export function JkhubModCardView({ card, fields }: CardViewProps<"jkhubMod">) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const format = useFormat();
  const games = useGameNames();
  const file = useJkhubFile(fields.fileId);
  const client = useDefaultClient(fields.game);
  const install = useJkhubInstall(client?.id ?? null);
  const check = useCheckedCard();
  const link = useLinkOpener();
  const [broken, setBroken] = useState(false);

  const page = file.data;
  const title = page?.title ?? fields.title;
  const shot = page?.screenshots[0];
  const picture = shot ? (shot.thumbnailUrl ?? shot.url) : null;
  const subtitle = [
    page?.author ? t("cards.jkhubMod.by", { author: page.author.name }) : t("cards.kinds.jkhubMod"),
    page?.categoryName ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  const onInstall = () => {
    if (client === undefined) return;
    install.reset();
    check.run(card, (clean) => {
      if (clean.type === "jkhubMod") install.mutate({ id: clean.fields.fileId });
    });
  };

  const result = install.data;
  const busy = install.isPending || check.checking;
  const failure = install.error ?? check.error;
  const noClient = t("cards.noClient", { game: games.label(fields.game) });

  let outcome: { tone: "success" | "warm"; text: string } | null = null;
  if (result?.kind === "installed") outcome = { tone: "success", text: t("cards.jkhubMod.installed", { client: client?.name ?? "" }) };
  else if (result?.kind === "conflicts") outcome = { tone: "warm", text: t("cards.jkhubMod.conflicts") };
  else if (result?.kind === "external") outcome = { tone: "warm", text: t("cards.jkhubMod.external") };
  else if (result?.kind === "noPk3Files") outcome = { tone: "warm", text: t("cards.jkhubMod.noPk3") };
  else if (result?.kind === "unsupported") outcome = { tone: "warm", text: t("cards.jkhubMod.unsupported", { format: result.format }) };

  return (
    <>
      <CardShell
        label={t("cards.label", { kind: t("cards.kinds.jkhubMod"), title })}
        media={
          picture !== null ? (
            <div className="flex h-140 items-center justify-center overflow-hidden border-b border-line-subtle bg-elevated">
              {broken ? (
                <ImageOff size={20} className="text-fg-muted" aria-hidden="true" />
              ) : (
                <img
                  src={picture}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={() => setBroken(true)}
                  className="size-full object-contain"
                />
              )}
            </div>
          ) : undefined
        }
        icon={<Box size={16} />}
        title={title}
        titleText={title}
        subtitle={subtitle}
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={14} />}
              disabled={client === undefined || busy}
              title={client === undefined ? noClient : undefined}
              onClick={onInstall}
            >
              {busy
                ? t("cards.jkhubMod.installing")
                : client === undefined
                  ? t("cards.jkhubMod.installPlain")
                  : t("cards.jkhubMod.install", { client: client.name })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<ExternalLink size={14} />}
              onClick={() => link.open(page?.url ?? jkhubFileUrl(fields.fileId, fields.slug))}
            >
              {t("cards.jkhubMod.open")}
            </Button>
          </>
        }
        status={
          failure ? (
            <CardStatus tone="danger">{errorText(failure)}</CardStatus>
          ) : outcome !== null ? (
            <CardStatus tone={outcome.tone}>{outcome.text}</CardStatus>
          ) : client === undefined ? (
            <CardStatus>{noClient}</CardStatus>
          ) : null
        }
      >
        {page ? (
          <p className="text-mono-xs text-fg-muted">
            {t("cards.jkhubMod.downloads", { count: page.downloads, formatted: format.number(page.downloads) })}
          </p>
        ) : null}
      </CardShell>
      {link.dialog}
    </>
  );
}

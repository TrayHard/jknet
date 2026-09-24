import { Check, Download, Heart, ShieldAlert, Star } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useFormat } from "../../i18n/useFormat";
import { bundleLanguages, localizedBundleText, useInterfaceLanguage } from "../../lib/bundleText";
import type { BundleCard as BundleCardData } from "../../lib/ipc";
import { EngineLogo } from "../EngineLogo";
import { Avatar, Badge } from "../ui";
import { LanguageBadge } from "./LanguageSwitch";
import { useBasedOnLine, useEngineName } from "./bundleFiles";

interface BundleCardProps {
  card: BundleCardData;
  /** True when a client of this machine was installed from the bundle. */
  installed: boolean;
  onOpen: () => void;
}

/**
 * --- slice: bundles ---
 *
 * One bundle of the catalogue, in the grid of the Bundles tab.
 *
 * The shape of the JKHub card next door, with the marks of the engines where
 * the thumbnail would be: a bundle has no picture of its own in this version,
 * and the engines are the first thing a player wants to know about one — one
 * mark per engine, and the «Based on …» line names them with their tags. The
 * whole card opens the record; there is no **Install** here, because an
 * install asks for a name, which components to make and, for a bundle with
 * executables, for a word of trust, and all three belong in the dialog.
 *
 * The **Preview** section of the editor draws the same card out of a draft,
 * so an author sees what the catalogue will show.
 */
export function BundleCard({ card, installed, onOpen }: BundleCardProps) {
  const { t } = useTranslation("bundles");
  const format = useFormat();
  const engineName = useEngineName();
  const basedOn = useBasedOnLine();
  // The name and the summary in the language of the launcher, where the
  // author translated them, and in the language of the bundle otherwise.
  const text = localizedBundleText(card, useInterfaceLanguage());
  const languages = bundleLanguages(card);

  // One mark per engine, in the order of the components; a bundle without a
  // published version has no components yet and shows its first engine.
  const engineIds: string[] = [];
  for (const component of card.components) {
    if (!engineIds.includes(component.engineId)) engineIds.push(component.engineId);
  }
  if (engineIds.length === 0 && card.engineId) engineIds.push(card.engineId);
  const line =
    card.components.length > 0
      ? basedOn(card.components)
      : card.engineId
        ? `${engineName(card.engineId)}${card.releaseTag ? ` ${card.releaseTag}` : ""}`
        : "";

  return (
    <li className="flex flex-col rounded-lg border border-line bg-surface overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("card.open", { name: text.name })}
        className="flex flex-col gap-8 p-12 text-left cursor-pointer hover:bg-surface-hover transition-colors duration-150 flex-1"
      >
        <span className="flex items-start gap-12">
          <span className="flex items-center gap-4 shrink-0">
            {engineIds.map((engineId) => (
              <EngineLogo key={engineId} engineId={engineId} name={engineName(engineId)} size={engineIds.length > 1 ? 28 : 40} />
            ))}
          </span>
          <span className="flex-1 min-w-0 flex flex-col gap-2">
            <span className="text-body-md-medium text-fg truncate" title={text.name}>
              {text.name}
            </span>
            {line !== "" ? (
              <span className="text-body-sm text-fg-muted truncate" title={line}>
                {t("card.basedOn", { engines: line })}
              </span>
            ) : null}
          </span>
        </span>

        <span className="flex items-center gap-6 min-w-0">
          <Avatar name={card.owner?.displayName ?? null} src={card.owner?.avatarUrl} size="sm" />
          <span className="text-body-sm text-fg-muted truncate">
            {card.owner
              ? t("card.by", { author: card.owner.displayName })
              : t("card.ownerUnknown")}
          </span>
        </span>

        <span className="text-body-sm text-fg-secondary line-clamp-2">{text.summary}</span>

        {card.hasExecutables || card.featured || installed || languages.length > 1 ? (
          <span className="flex flex-wrap items-center gap-6">
            {installed ? (
              <Badge tone="success" icon={<Check size={12} />}>
                {t("card.installed")}
              </Badge>
            ) : null}
            {card.featured ? (
              <Badge tone="accent" icon={<Star size={12} />}>
                {t("card.featured")}
              </Badge>
            ) : null}
            {card.hasExecutables ? (
              <Badge tone="warm" icon={<ShieldAlert size={12} />}>
                {t("card.executables")}
              </Badge>
            ) : null}
            <LanguageBadge languages={languages} />
          </span>
        ) : null}

        {/* The row wraps rather than squeezing: three columns of cards leave
            about 200 px here, and a truncated number says less than a second
            line does. */}
        <span className="flex flex-wrap items-center gap-x-10 gap-y-2 text-mono-xs text-fg-muted mt-auto pt-4">
          <span className="whitespace-nowrap" title={t("card.download", { size: format.bytes(card.blobBytes) })}>
            {format.bytes(card.blobBytes)}
          </span>
          {card.components.length > 1 ? (
            <span className="whitespace-nowrap">{t("card.components", { count: card.components.length })}</span>
          ) : null}
          <span className="whitespace-nowrap">{t("card.files", { count: card.fileCount })}</span>
          <span className="inline-flex items-center gap-4 whitespace-nowrap" title={t("card.likes")}>
            <Heart size={12} aria-hidden />
            {format.number(card.likes)}
          </span>
          <span className="inline-flex items-center gap-4 whitespace-nowrap" title={t("card.installs")}>
            <Download size={12} aria-hidden />
            {format.number(card.installs)}
          </span>
        </span>
      </button>
    </li>
  );
}

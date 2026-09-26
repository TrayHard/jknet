import { Heart, Package } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { useFormat } from "../../../i18n/useFormat";
import { localizedBundleText, useInterfaceLanguage } from "../../../lib/bundleText";
import { useGameNames } from "../../../lib/game";
import { useBundle } from "../../../lib/queries";
import { BundleDetailsDialog } from "../../bundles/BundleDetailsDialog";
import { useEngineName } from "../../bundles/bundleFiles";
import { EngineLogo } from "../../EngineLogo";
import { Button } from "../../ui";
import { Layer } from "../Layer";
import { CardShell, CardStatus } from "./CardShell";
import { useCheckedCard } from "./useCardActions";
import type { CardViewProps } from "./withFields";

/**
 * --- slice: chat cards ---
 *
 * A bundle of the JKNet catalogue.
 *
 * The card reads the record of the bundle, so the name is in the language of
 * the interface where the author translated it, and the owner, the engines,
 * the size and the likes are today's. **View** opens the record itself, the
 * dialog of the Bundles tab, which is where an install asks for a name and
 * for the components to make.
 */
export function BundleCardView({ card, fields }: CardViewProps<"bundle">) {
  const { t } = useTranslation("chat");
  const errorText = useErrorText();
  const format = useFormat();
  const games = useGameNames();
  const engineName = useEngineName();
  const language = useInterfaceLanguage();
  const record = useBundle(fields.bundleId);
  const check = useCheckedCard();
  const [open, setOpen] = useState<string | null>(null);

  const details = record.data;
  const name = details ? localizedBundleText(details, language).name : fields.name;
  const owner = details ? (details.owner?.displayName ?? t("people.deleted")) : null;

  const engineIds: string[] = [];
  for (const component of details?.components ?? []) {
    if (!engineIds.includes(component.engineId)) engineIds.push(component.engineId);
  }

  const subtitle = [
    owner === null ? t("cards.kinds.bundle") : t("cards.bundle.by", { author: owner }),
    details?.latestLabel ? t("cards.bundle.version", { label: details.latestLabel }) : null,
    games.short(fields.game),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <CardShell
        label={t("cards.label", { kind: t("cards.kinds.bundle"), title: name })}
        icon={<Package size={16} />}
        title={name}
        titleText={name}
        subtitle={subtitle}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={check.checking || record.isError}
            onClick={() =>
              check.run(card, (clean) => {
                if (clean.type === "bundle") setOpen(clean.fields.bundleId);
              })
            }
          >
            {t("cards.bundle.view")}
          </Button>
        }
        status={
          check.error ? (
            <CardStatus tone="danger">{errorText(check.error)}</CardStatus>
          ) : record.isError ? (
            <CardStatus>{t("cards.bundle.unavailable")}</CardStatus>
          ) : null
        }
      >
        {details ? (
          <div className="flex flex-col gap-6">
            {engineIds.length > 0 ? (
              <span className="flex items-center gap-4">
                {engineIds.map((engineId) => (
                  <EngineLogo key={engineId} engineId={engineId} name={engineName(engineId)} size={20} />
                ))}
                <span className="ml-4 truncate text-body-sm text-fg-secondary">
                  {engineIds.map(engineName).join(", ")}
                </span>
              </span>
            ) : null}
            <span className="flex flex-wrap items-center gap-x-10 text-mono-xs text-fg-muted">
              <span>{t("cards.bundle.size", { size: format.bytes(details.blobBytes) })}</span>
              <span className="inline-flex items-center gap-4">
                <Heart size={12} aria-hidden="true" />
                {format.number(details.likes)}
              </span>
            </span>
          </div>
        ) : null}
      </CardShell>
      {open !== null ? (
        <Layer>
          <BundleDetailsDialog bundleId={open} onClose={() => setOpen(null)} />
        </Layer>
      ) : null}
    </>
  );
}

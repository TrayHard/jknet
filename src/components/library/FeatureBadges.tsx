import { useTranslation } from "react-i18next";

import { featureBadge, languageCode } from "../../lib/previewKinds";
import { cn } from "../../lib/format";
import { Badge } from "../ui";

/**
 * --- slice: pk3 contents ---
 * What an archive holds beside its category, as short badges: **Level
 * shots**, **Splash**, **RU strings**. The codes come from the core with the
 * file (`LibraryItem.features`, `library.features` of a bundle file); a code
 * the catalog does not know is printed as it is rather than dropped, so a
 * feature added to the core before its label shows up still shows up.
 *
 * At most `max` badges, then «+N» with the rest in its tooltip: a card has
 * one line for them, and an archive that is everything at once would fill
 * it with nine.
 */
export function FeatureBadges({ features, max = 4, className }: {
  features: readonly string[] | undefined;
  max?: number;
  className?: string;
}) {
  const { t } = useTranslation("library");
  const label = (feature: string): string => {
    const spec = featureBadge(feature);
    if (spec.code === "strings") return t("features.strings", { language: languageCode(spec.language) });
    if (spec.code === "unknown") return spec.raw;
    return t(`features.${spec.code}`);
  };
  const shown = features?.slice(0, max) ?? [];
  const rest = features?.slice(max) ?? [];
  if (shown.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-4", className)} aria-label={t("features.label")}>
      {shown.map(feature => (
        <li key={feature}><Badge tone="neutral">{label(feature)}</Badge></li>
      ))}
      {rest.length > 0 ? (
        <li>
          <Badge tone="neutral" title={rest.map(label).join(" · ")}>{t("features.more", { count: rest.length })}</Badge>
        </li>
      ) : null}
    </ul>
  );
}

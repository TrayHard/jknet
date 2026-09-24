import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { languageCode, languageName } from "../../lib/bundleText";
import { cn } from "../../lib/format";
import { Badge } from "../ui";

/**
 * --- slice: bundles ---
 *
 * The languages a bundle is written in, on the screens that read one.
 *
 * `LanguageSwitch` is the row of code buttons over the record of a bundle:
 * one per language, the native name on hover, the shape of the mode pair of
 * the client window. `LanguageBadge` is the mark on a card, «EN · RU», for a
 * bundle that carries a translation; a bundle in one language wears none.
 */

export function LanguageSwitch({
  languages,
  value,
  onChange,
  className,
}: {
  /** Codes, the default first, as `bundleLanguages` orders them. */
  languages: string[];
  value: string;
  onChange: (code: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("bundles");
  if (languages.length < 2) return null;
  return (
    <div role="tablist" aria-label={t("details.language")} className={cn("flex flex-wrap items-center gap-4", className)}>
      <Languages size={14} className="text-fg-muted mr-4" aria-hidden />
      {languages.map((code) => (
        <button
          key={code}
          type="button"
          role="tab"
          aria-selected={code === value}
          title={languageName(code)}
          onClick={() => onChange(code)}
          className={cn(
            "h-24 px-8 rounded-sm text-label-xs select-none cursor-pointer transition-colors duration-150",
            code === value ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
          )}
        >
          {languageCode(code)}
        </button>
      ))}
    </div>
  );
}

/** The codes of the languages of a card, «EN · RU», with the names on hover. */
export function LanguageBadge({ languages }: { languages: string[] }) {
  const { t } = useTranslation("bundles");
  if (languages.length < 2) return null;
  return (
    <Badge
      tone="neutral"
      icon={<Languages size={12} />}
      title={t("card.languages", { languages: languages.map(languageName).join(", ") })}
    >
      {languages.map(languageCode).join(" · ")}
    </Badge>
  );
}

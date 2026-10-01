import { Check } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Select } from "../../ui";
import { COMMUNITY_LANGUAGES, COMMUNITY_REGIONS, COMMUNITY_TAGS } from "../api";
import { LANGUAGE_NAMES } from "../format";
import type { ManageDraft } from "./model";
import { Chip, Section } from "./parts";
import { LIMITS } from "./validate";

/**
 * A code toggled in a list. A new one goes last: the page lists tags and
 * languages in the order the organizers chose, the main language first.
 */
function toggled(list: string[], code: string): string[] {
  return list.includes(code) ? list.filter((item) => item !== code) : [...list, code];
}

/**
 * **Tags, languages and region**: chips of the two closed lists with how
 * many of the limit are taken, and the region in the heading row. A chip
 * that would pass the limit is off until another one goes.
 */
export function TagsSection({ draft, edit }: { draft: ManageDraft; edit: (patch: Partial<ManageDraft>) => void }) {
  const { t } = useTranslation("community");
  const loose = t as unknown as (key: string) => string;
  const id = useId();
  const counter = (count: number, max: number, text: string) => (
    <span className={count >= max ? "text-mono-xs text-fg-warm" : "text-mono-xs text-fg-secondary"}>{text}</span>
  );

  return (
    <Section
      section="tags"
      title={t("manage.sections.tags")}
      tools={
        <div className="flex min-w-0 flex-wrap items-center gap-8">
          <span id={`${id}-region`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.tags.region")}
          </span>
          <Select
            value={draft.region ?? ""}
            onChange={(value) => edit({ region: value === "" ? null : value })}
            ariaLabel={t("manage.tags.region")}
            className="min-w-200"
            options={[
              { value: "", label: t("manage.tags.noRegion") },
              ...COMMUNITY_REGIONS.map((region) => ({ value: region, label: loose(`regions.${region}`) })),
            ]}
          />
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-8">
        <div className="flex items-baseline justify-between gap-8">
          <span id={`${id}-tags`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.tags.tags")}
          </span>
          {counter(draft.tags.length, LIMITS.tags, t("manage.tags.tagsCount", { count: draft.tags.length, max: LIMITS.tags }))}
        </div>
        <div role="group" aria-labelledby={`${id}-tags`} className="flex flex-wrap gap-8">
          {COMMUNITY_TAGS.map((tag) => {
            const on = draft.tags.includes(tag);
            return (
              <Chip
                key={tag}
                on={on}
                disabled={!on && draft.tags.length >= LIMITS.tags}
                onClick={() => edit({ tags: toggled(draft.tags, tag) })}
              >
                {on ? <Check size={12} strokeWidth={2.5} aria-hidden="true" /> : null}
                {loose(`tagNames.${tag}`)}
              </Chip>
            );
          })}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <div className="flex items-baseline justify-between gap-8">
          <span id={`${id}-languages`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.tags.languages")}
          </span>
          {counter(
            draft.languages.length,
            LIMITS.languages,
            t("manage.tags.languagesCount", { count: draft.languages.length, max: LIMITS.languages }),
          )}
        </div>
        <div role="group" aria-labelledby={`${id}-languages`} className="flex flex-wrap gap-8">
          {COMMUNITY_LANGUAGES.map((language) => {
            const on = draft.languages.includes(language);
            return (
              <Chip
                key={language}
                on={on}
                disabled={!on && draft.languages.length >= LIMITS.languages}
                onClick={() => edit({ languages: toggled(draft.languages, language) })}
              >
                {on ? <Check size={12} strokeWidth={2.5} aria-hidden="true" /> : null}
                {LANGUAGE_NAMES[language] ?? language}
              </Chip>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

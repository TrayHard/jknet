import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Input } from "../../ui";
import { MarkdownEditor } from "./MarkdownEditor";
import type { ManageDraft } from "./model";
import { Counter, Field, FieldNote, Section, useProblemText } from "./parts";
import { LIMITS, type DraftProblems } from "./validate";

/**
 * **Profile**: the name and the tagline in one row, the description and
 * the rules in Markdown in the next. Everything here waits for **Save
 * changes**.
 */
export function ProfileSection({
  draft,
  problems,
  edit,
}: {
  draft: ManageDraft;
  problems: DraftProblems;
  edit: (patch: Partial<ManageDraft>) => void;
}) {
  const { t } = useTranslation("community");
  const problemText = useProblemText();
  const id = useId();
  const note = (problem: DraftProblems["name"], max: number, hint?: string, noteId?: string) =>
    problem ? (
      <FieldNote id={noteId} tone="bad">
        {problemText(problem, { max })}
      </FieldNote>
    ) : hint ? (
      <FieldNote id={noteId}>{hint}</FieldNote>
    ) : null;

  return (
    <Section section="profile" title={t("manage.sections.profile")}>
      <div className="grid grid-cols-2 gap-16 @max-[880px]/community:grid-cols-1">
        <Field
          label={t("manage.profile.name")}
          htmlFor={`${id}-name`}
          counter={<Counter value={draft.name} max={LIMITS.name} />}
          note={note(problems.name, LIMITS.name, undefined, `${id}-name-note`)}
        >
          <Input
            id={`${id}-name`}
            value={draft.name}
            invalid={problems.name !== undefined}
            aria-describedby={problems.name ? `${id}-name-note` : undefined}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </Field>
        <Field
          label={t("manage.profile.tagline")}
          htmlFor={`${id}-tagline`}
          counter={<Counter value={draft.tagline} max={LIMITS.tagline} />}
          note={note(problems.tagline, LIMITS.tagline, t("manage.profile.taglineHint"), `${id}-tagline-note`)}
        >
          <Input
            id={`${id}-tagline`}
            value={draft.tagline}
            invalid={problems.tagline !== undefined}
            aria-describedby={`${id}-tagline-note`}
            onChange={(event) => edit({ tagline: event.target.value })}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-16 @max-[880px]/community:grid-cols-1">
        <Field
          label={t("manage.profile.description")}
          labelId={`${id}-description-label`}
          counter={<Counter value={draft.description} max={LIMITS.description} />}
          note={note(problems.description, LIMITS.description, undefined, `${id}-description-note`)}
        >
          <MarkdownEditor
            value={draft.description}
            onChange={(description) => edit({ description })}
            labelledBy={`${id}-description-label`}
            describedBy={problems.description ? `${id}-description-note` : undefined}
            toolbarLabel={t("manage.editor.toolbar", { field: t("manage.profile.description") })}
            placeholder={t("manage.profile.descriptionPlaceholder")}
            invalid={problems.description !== undefined}
          />
        </Field>
        <Field
          label={t("manage.profile.rules")}
          labelId={`${id}-rules-label`}
          counter={<Counter value={draft.rules} max={LIMITS.rules} />}
          note={note(problems.rules, LIMITS.rules, undefined, `${id}-rules-note`)}
        >
          <MarkdownEditor
            value={draft.rules}
            onChange={(rules) => edit({ rules })}
            labelledBy={`${id}-rules-label`}
            describedBy={problems.rules ? `${id}-rules-note` : undefined}
            toolbarLabel={t("manage.editor.toolbar", { field: t("manage.profile.rules") })}
            placeholder={t("manage.profile.rulesPlaceholder")}
            invalid={problems.rules !== undefined}
          />
        </Field>
      </div>
    </Section>
  );
}

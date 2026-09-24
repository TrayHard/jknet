import { Copy, Link2, Trash2 } from "lucide-react";
import { lazy, Suspense, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { LANGUAGES } from "../../../i18n/languages";
import { bundlesTabRoute } from "../../../lib/bundleRoutes";
import { bundleLanguages, languageName } from "../../../lib/bundleText";
import { cn } from "../../../lib/format";
import type { Draft, DraftTranslation } from "../../../lib/ipc";
import type { DraftActions } from "../../../lib/queries";
import { Badge, Button, Dialog, Input, Select } from "../../ui";
import { Section } from "../bundleFiles";
import { DISCORD, HTTPS, LIMITS, TAG, parseTags } from "./draftModel";
import { Field, TextArea, useCommitField } from "./fields";

/** TipTap and its Markdown bridge come in their own chunk: only the editor of a draft needs them. */
const DescriptionEditor = lazy(() =>
  import("./DescriptionEditor").then((module) => ({ default: module.DescriptionEditor })),
);

/** The count of characters as the service counts them: code points, not UTF-16 units. */
function length(value: string): number {
  return [...value.trim()].length;
}

/** A translation with nothing in it yet: what **Add language** writes. */
const EMPTY_TRANSLATION: DraftTranslation = { name: "", summary: "", description: "" };

/** Whether a translation says anything: what decides if **Remove** asks first. */
function hasText(translation: DraftTranslation | undefined): boolean {
  return (
    translation !== undefined &&
    (translation.name.trim() !== "" || translation.summary.trim() !== "" || translation.description.trim() !== "")
  );
}

/**
 * --- slice: bundles ---
 *
 * **Overview**: the fields of the bundle and of its next version.
 *
 * Every field commits on blur through `update_bundle_draft`; the limits are
 * the ones the service applies, and a value outside them stays in the field
 * with the reason under it rather than going to the core to be refused.
 * The description is the one exception: `DescriptionEditor` holds Markdown
 * and commits half a second after the last keystroke as well as on blur.
 * A draft bound to a published bundle says which, with the way to its card.
 *
 * The name, the summary and the description exist once per language: in
 * the default language of the bundle and in every translation the author
 * adds. A strip over the three fields picks which language they show; the
 * strip writes whatever the fields still hold before it switches, and the
 * fields mount afresh for the language picked. A translation is one entry
 * of `translations`, which the core takes whole, so every edit of one goes
 * out as the whole set, built from the newest set this section sent while
 * an earlier edit is still on its way.
 */
export function OverviewSection({ draft, actions }: { draft: Draft; actions: DraftActions }) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const update = (patch: Parameters<typeof actions.update.mutate>[0]) => actions.update.mutate(patch);

  // --- languages ---

  // The code the strip was pressed on, or `null` for the default language.
  // Checked against the draft on every render: a code the draft no longer
  // holds — the translation was removed, the default moved — falls back to
  // the default language rather than to empty fields.
  const [picked, setPicked] = useState<string | null>(null);
  const language =
    picked !== null && (picked === draft.language || picked in draft.translations) ? picked : draft.language;
  const isDefault = language === draft.language;
  const languages = bundleLanguages(draft);
  const remaining = LANGUAGES.filter((entry) => !languages.includes(entry.id));

  // The set of translations as this section last wrote it, or as the core
  // answered its move of the default language: the next edit builds on it
  // rather than on the record. The record lags behind twice over — it does
  // not carry an edit still in flight, and the render that carries an
  // answer comes a tick after the answer itself — and an edit built on it
  // would write the set without the last one. The record is read only
  // before the first write, and again after a write the core refused: the
  // refusal re-reads the disk, and the disk is the truth then.
  const sent = useRef<Record<string, DraftTranslation> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const latestTranslations = () => sent.current ?? draftRef.current.translations;
  const writeTranslations = (next: Record<string, DraftTranslation>): Promise<unknown> => {
    sent.current = next;
    return actions.update.mutateAsync({ translations: next }).catch((error: unknown) => {
      sent.current = null;
      throw error;
    });
  };
  const setTranslation = (code: string, partial: Partial<DraftTranslation>): Promise<unknown> => {
    const latest = latestTranslations();
    return writeTranslations({ ...latest, [code]: { ...(latest[code] ?? EMPTY_TRANSLATION), ...partial } });
  };

  // What the fields still hold goes to the draft before the strip acts, and
  // the strip waits for the answer: the fields mount afresh for the language
  // it switches to, and would otherwise lose what was typed. A field outside
  // its limits, or an edit the core refused, keeps the strip where it is;
  // the reason stands under the field or in the header.
  const flushRef = useRef<(() => Promise<void> | null) | null>(null);
  const [busy, setBusy] = useState(false);
  const settle = async (): Promise<boolean> => {
    const flushed = flushRef.current === null ? Promise.resolve() : flushRef.current();
    if (flushed === null) return false;
    try {
      await flushed;
      return true;
    } catch {
      return false;
    }
  };
  const act = async (step: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await settle()) await step();
    } catch {
      // The header says why the edit was refused; the strip stays put.
    } finally {
      setBusy(false);
    }
  };

  const show = (code: string) => {
    if (code === language) return;
    void act(async () => setPicked(code));
  };
  const add = (code: string) =>
    void act(async () => {
      await writeTranslations({ ...latestTranslations(), [code]: EMPTY_TRANSLATION });
      setPicked(code);
    });
  // The translation goes out of the set, and what the fields hold for it
  // goes with it. Reached only after `settle`, from `act` or from a step
  // of one: the writes on their way have answered by then, and the set
  // without the language is built on the newest one.
  const drop = async (code: string) => {
    const { [code]: _gone, ...rest } = latestTranslations();
    await writeTranslations(rest);
    setPicked(null);
  };
  const remove = (code: string) => void act(() => drop(code));
  const copyFromDefault = () =>
    void act(async () => {
      const current = latestTranslations()[language] ?? EMPTY_TRANSLATION;
      const main = draftRef.current;
      await setTranslation(language, {
        name: current.name.trim() === "" ? main.name : current.name,
        summary: current.summary.trim() === "" ? main.summary : current.summary,
        description: current.description.trim() === "" ? main.description : current.description,
      });
    });
  // The default moves to another language. The core swaps the fields with
  // the translation into that language when the draft holds one, and
  // relabels the fields otherwise: a draft that opened in the language of
  // the launcher and was written in another is put right by the label
  // alone. The strip stays on the code it showed, so the text under the
  // author's eyes is the same text — now a translation, or now under the
  // new default.
  const changeDefault = (code: string) => {
    if (code === draft.language) return;
    void act(async () => {
      setPicked(language);
      const answer = await actions.update.mutateAsync({ language: code });
      // The swap rewrote the set: what this section knows is the answer.
      sent.current = answer.translations;
    });
  };

  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  // Whether the translation says anything is decided only once the fields
  // are written down and answered: `act` settles them before the step, so
  // the set read here holds what was typed up to the click — whether or
  // not the click took the focus out of a field first. A translation with
  // text is asked about, and a yes goes through `remove`; one without goes
  // at once, without settling the same fields a second time. A field
  // outside its limits keeps the translation, like it keeps the strip: the
  // reason stands under the field.
  const askRemove = () =>
    void act(async () => {
      if (hasText(latestTranslations()[language])) setPendingRemove(language);
      else await drop(language);
    });
  // Read off the newest set, as the actions read it, not off the record:
  // the record lags behind an edit on its way, and the button would stay
  // enabled for a translation whose last field has just been filled in.
  const translation = isDefault ? undefined : latestTranslations()[language];
  const nothingToCopy =
    translation !== undefined &&
    translation.name.trim() !== "" &&
    translation.summary.trim() !== "" &&
    translation.description.trim() !== "";

  // --- the other fields ---

  const tags = useCommitField(
    draft.tags.join(", "),
    (value) => update({ tags: parseTags(value) }),
    (value) => {
      const parsed = parseTags(value);
      return parsed.length > LIMITS.tags || parsed.some((tag) => !TAG.test(tag))
        ? t("editor.overview.invalid.tags")
        : null;
    },
  );
  const website = useCommitField(
    draft.website ?? "",
    (value) => update({ website: value.trim() === "" ? null : value.trim() }),
    (value) => (value.trim() !== "" && !HTTPS.test(value.trim()) ? t("editor.overview.invalid.website") : null),
  );
  const discord = useCommitField(
    draft.discord ?? "",
    (value) => update({ discord: value.trim() === "" ? null : value.trim() }),
    (value) => (value.trim() !== "" && !DISCORD.test(value.trim()) ? t("editor.overview.invalid.discord") : null),
  );
  const label = useCommitField(
    draft.versionLabel,
    (value) => update({ versionLabel: value.trim() }),
    (value) => (length(value) < 1 || length(value) > LIMITS.label ? t("editor.overview.invalid.label") : null),
  );
  const changelog = useCommitField(
    draft.changelog,
    (value) => update({ changelog: value.trim() }),
    (value) => (length(value) > LIMITS.changelog ? t("editor.overview.invalid.changelog") : null),
  );

  return (
    <div className="flex flex-col gap-24">
      {draft.bundleId ? (
        <p className="flex items-center gap-8 text-body-sm text-fg-secondary">
          <Link2 size={14} className="text-fg-muted shrink-0" aria-hidden />
          <span>{t("editor.overview.linked", { bundle: draft.name })}</span>
          <Link to={bundlesTabRoute(draft.bundleId)} className="text-fg-accent hover:underline">
            {t("editor.overview.openCard")}
          </Link>
        </p>
      ) : null}

      <Section heading={t("editor.overview.bundle")}>
        <div className="flex flex-col gap-12">
          {/* The strip: the default language, the translations, a language to add, the default to move. */}
          <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-center gap-8">
              <div
                role="tablist"
                aria-label={t("editor.overview.languages.strip")}
                className="flex flex-wrap items-center gap-4"
              >
                {languages.map((code) => (
                  <button
                    key={code}
                    type="button"
                    role="tab"
                    aria-selected={code === language}
                    disabled={busy}
                    onClick={() => show(code)}
                    className={cn(
                      "inline-flex items-center gap-6 h-28 px-12 rounded-sm select-none cursor-pointer",
                      "text-body-sm-medium transition-colors duration-150 disabled:cursor-not-allowed",
                      code === language
                        ? "bg-selected-overlay text-fg"
                        : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
                    )}
                  >
                    {languageName(code)}
                    {code === draft.language ? (
                      <Badge tone="accent">{t("editor.overview.languages.default")}</Badge>
                    ) : null}
                  </button>
                ))}
              </div>
              {remaining.length > 0 ? (
                <Select
                  size="sm"
                  ariaLabel={t("editor.overview.languages.addLabel")}
                  placeholder={t("editor.overview.languages.add")}
                  // Nothing is ever picked: the list is a button with a menu, and
                  // the trigger keeps saying what it does.
                  value=""
                  options={remaining.map((entry) => ({ value: entry.id, label: entry.nativeName }))}
                  disabled={busy}
                  onChange={add}
                  className="w-160"
                />
              ) : null}
              <Select
                size="sm"
                ariaLabel={t("editor.overview.languages.defaultLanguage")}
                label={t("editor.overview.languages.defaultLanguage")}
                value={draft.language}
                options={LANGUAGES.map((entry) => ({ value: entry.id, label: entry.nativeName }))}
                disabled={busy}
                onChange={changeDefault}
                className="ml-auto w-260"
              />
            </div>
            {!isDefault ? (
              <div className="flex flex-wrap items-center gap-8">
                <span className="flex-1 min-w-200 text-body-sm text-fg-muted">
                  {t("editor.overview.languages.translation", {
                    language: languageName(language),
                    default: languageName(draft.language),
                  })}
                </span>
                <Button
                  size="sm"
                  icon={<Copy size={14} />}
                  disabled={busy || nothingToCopy}
                  title={t("editor.overview.languages.copyHint")}
                  onClick={copyFromDefault}
                >
                  {t("editor.overview.languages.copyFromDefault")}
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={busy} onClick={askRemove}>
                  {t("editor.overview.languages.remove")}
                </Button>
              </div>
            ) : null}
          </div>

          {/* Keyed by the language and by which language is the default: a
              switch of either mounts the three fields afresh on the record. */}
          <TextFields
            key={`${language}:${draft.language}`}
            draft={draft}
            language={language}
            isDefault={isDefault}
            actions={actions}
            setTranslation={(partial) => setTranslation(language, partial)}
            flushRef={flushRef}
          />

          <Field label={t("editor.overview.tags")} hint={t("editor.overview.tagsHint")} problem={tags.problem} htmlFor="draft-tags">
            <Input
              id="draft-tags"
              value={tags.value}
              invalid={tags.problem !== null}
              onChange={(event) => tags.onChange(event.target.value)}
              onBlur={tags.onBlur}
            />
          </Field>
          <div className="grid grid-cols-2 gap-12">
            <Field label={t("editor.overview.website")} hint={t("editor.overview.linkHint")} problem={website.problem} htmlFor="draft-website">
              <Input
                id="draft-website"
                value={website.value}
                invalid={website.problem !== null}
                onChange={(event) => website.onChange(event.target.value)}
                onBlur={website.onBlur}
              />
            </Field>
            <Field label={t("editor.overview.discord")} hint={t("editor.overview.linkHint")} problem={discord.problem} htmlFor="draft-discord">
              <Input
                id="draft-discord"
                value={discord.value}
                invalid={discord.problem !== null}
                onChange={(event) => discord.onChange(event.target.value)}
                onBlur={discord.onBlur}
              />
            </Field>
          </div>
        </div>
      </Section>

      <Section heading={t("editor.overview.version")}>
        <div className="flex flex-col gap-12">
          <Field label={t("editor.overview.label")} hint={t("editor.overview.labelHint")} problem={label.problem} htmlFor="draft-label">
            <Input
              id="draft-label"
              value={label.value}
              maxLength={LIMITS.label}
              invalid={label.problem !== null}
              onChange={(event) => label.onChange(event.target.value)}
              onBlur={label.onBlur}
              className="max-w-[240px]"
            />
          </Field>
          <Field label={t("editor.overview.changelog")} hint={t("editor.overview.changelogHint")} problem={changelog.problem} htmlFor="draft-changelog">
            <TextArea
              id="draft-changelog"
              value={changelog.value}
              rows={4}
              maxLength={LIMITS.changelog}
              invalid={changelog.problem !== null}
              onChange={changelog.onChange}
              onBlur={changelog.onBlur}
            />
          </Field>
        </div>
      </Section>

      {pendingRemove !== null ? (
        <Dialog
          title={t("editor.overview.languages.removeTitle", { language: languageName(pendingRemove) })}
          body={t("editor.overview.languages.removeBody")}
          variant="danger"
          onClose={() => setPendingRemove(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setPendingRemove(null)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  const code = pendingRemove;
                  setPendingRemove(null);
                  remove(code);
                }}
              >
                {t("editor.overview.languages.removeConfirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The name, the summary and the description in one language.
 *
 * For the default language each field is its own patch of the draft; for a
 * translation each is the entry of that language, merged into the set the
 * section holds. The writes the fields issue are kept until they answer, so
 * the strip can wait for the lot before it switches: `flushRef` writes down
 * what a field still holds and answers with that wait, or with `null` when
 * a field is outside its limits and must be looked at first.
 */
function TextFields({
  draft,
  language,
  isDefault,
  actions,
  setTranslation,
  flushRef,
}: {
  draft: Draft;
  language: string;
  isDefault: boolean;
  actions: DraftActions;
  setTranslation: (partial: Partial<DraftTranslation>) => Promise<unknown>;
  flushRef: RefObject<(() => Promise<void> | null) | null>;
}) {
  const { t } = useTranslation("bundles");
  const text: DraftTranslation = isDefault
    ? { name: draft.name, summary: draft.summary, description: draft.description }
    : (draft.translations[language] ?? EMPTY_TRANSLATION);

  const writes = useRef<Promise<unknown>[]>([]);
  // Answers with the write, so that a field knows a refusal from an answer
  // still to come.
  const send = (partial: Partial<DraftTranslation>): Promise<unknown> => {
    const write = isDefault ? actions.update.mutateAsync(partial) : setTranslation(partial);
    writes.current.push(write);
    // Observed here so that a refusal is not an unhandled rejection: the
    // header prints it, and a flush in progress sees it through `writes`.
    void write.catch(() => undefined).finally(() => {
      writes.current = writes.current.filter((entry) => entry !== write);
    });
    return write;
  };

  // An empty translated field is «not translated» and passes; a name that
  // says something is held to the same length as the default one.
  const nameProblem = (value: string) =>
    (isDefault || value.trim() !== "") && (length(value) < LIMITS.nameMin || length(value) > LIMITS.name)
      ? isDefault
        ? t("editor.overview.invalid.name")
        : t("editor.overview.invalid.translationName")
      : null;
  const name = useCommitField(text.name, (value) => send({ name: value.trim() }), nameProblem);
  const summary = useCommitField(
    text.summary,
    (value) => send({ summary: value.trim() }),
    (value) => (length(value) > LIMITS.summary ? t("editor.overview.invalid.summary") : null),
  );
  const descriptionFlush = useRef<(() => boolean) | null>(null);

  // Every field is settled as a blur would settle it — the typed value sent,
  // or its reason shown under the field — whether or not the focus left it,
  // and all three before the answer, so that each shows its own reason.
  flushRef.current = () => {
    const descriptionOk = descriptionFlush.current === null || descriptionFlush.current();
    const nameFound = name.settle();
    const summaryFound = summary.settle();
    if (!descriptionOk || nameFound !== null || summaryFound !== null) return null;
    return Promise.all(writes.current).then(() => undefined);
  };

  return (
    <>
      <Field
        label={t("editor.overview.name")}
        hint={isDefault ? t("editor.overview.nameHint") : t("editor.overview.nameHintTranslation")}
        problem={name.problem}
        htmlFor="draft-name"
      >
        <Input
          id="draft-name"
          value={name.value}
          maxLength={LIMITS.name}
          invalid={name.problem !== null}
          placeholder={isDefault ? undefined : draft.name}
          onChange={(event) => name.onChange(event.target.value)}
          onBlur={name.onBlur}
          className="max-w-[480px]"
        />
      </Field>
      <Field label={t("editor.overview.summary")} hint={t("editor.overview.summaryHint")} problem={summary.problem} htmlFor="draft-summary">
        <Input
          id="draft-summary"
          value={summary.value}
          maxLength={LIMITS.summary}
          invalid={summary.problem !== null}
          placeholder={isDefault ? undefined : draft.summary}
          onChange={(event) => summary.onChange(event.target.value)}
          onBlur={summary.onBlur}
        />
      </Field>
      <Field label={t("editor.overview.description")} hint={t("editor.overview.descriptionHint")}>
        <Suspense fallback={<div className="prose-jknet-editor min-h-[240px]" aria-busy="true" />}>
          <DescriptionEditor
            draftId={draft.id}
            value={text.description}
            maxBytes={LIMITS.description}
            label={t("editor.overview.description")}
            onCommit={(markdown) => send({ description: markdown })}
            flushRef={descriptionFlush}
          />
        </Suspense>
      </Field>
    </>
  );
}

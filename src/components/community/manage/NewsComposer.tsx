import { Check } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../lib/format";
import { Button, Input } from "../../ui";
import { failureOf } from "../api";
import { useFailureText } from "../errors";
import { MAX_PINNED, MAX_POST_BODY, MAX_POST_TITLE, postProblems, type PostProblems } from "../posts";
import { useCommunityApi, type NewsComposerProps } from "../platform";
import type { PostPatch } from "../types";
import { useAction } from "../useRemote";
import { MarkdownEditor } from "./MarkdownEditor";
import { Counter, FieldNote } from "./parts";

/**
 * The composer of the news, as the design's B3 draws it on top of the
 * **News** tab: a title of one line, the text in the Markdown editor of the
 * management screen, **Pin**, **Notify followers** and **Publish**.
 *
 * The same card changes a post: it fills with the post, says that a change
 * notifies nobody, and **Save changes** sends only what changed, with the
 * revision of the post. A community pins three posts at most: the card says
 * so beside **Pin** when three are pinned, and explains the service's
 * refusal when another organizer pinned one meanwhile.
 *
 * Loaded with the management screen's chunk: it carries the editor, which a
 * host that only reads never bundles.
 */
export default function NewsComposer({ community, editing, pinned, onSaved, onCancel }: NewsComposerProps) {
  return <Composer key={editing ? `${editing.id}:${editing.revision}` : "new"} community={community} editing={editing} pinned={pinned} onSaved={onSaved} onCancel={onCancel} />;
}

function Composer({ community, editing, pinned, onSaved, onCancel }: NewsComposerProps) {
  const { t } = useTranslation("community");
  const api = useCommunityApi();
  const failure = useFailureText();
  const id = useId();
  const save = useAction();
  const [title, setTitle] = useState(editing?.title ?? "");
  const [body, setBody] = useState(editing?.body ?? "");
  const [pin, setPin] = useState(editing?.pinned ?? false);
  const [notify, setNotify] = useState(true);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The editor is mounted anew for a fresh post: a published text leaves it empty.
  const [round, setRound] = useState(0);

  const problems: PostProblems = postProblems(title, body);
  const shown = checked ? problems : { title: problems.title === "tooLong" ? problems.title : undefined, body: problems.body === "tooLong" ? problems.body : undefined };
  const othersPinned = pinned - (editing?.pinned ? 1 : 0);
  const full = othersPinned >= MAX_PINNED && !(editing?.pinned ?? false);
  const changed = editing === null || title.trim() !== editing.title || body.trim() !== editing.body.trim() || pin !== editing.pinned;
  const empty = editing === null && title.trim() === "" && body.trim() === "";

  const problemText = (which: PostProblems): string | null => {
    if (which.title === "oneLine") return t("news.composer.titleOneLine");
    if (which.title === "tooLong") return t("news.composer.titleTooLong", { max: MAX_POST_TITLE });
    return null;
  };
  const bodyText = (which: PostProblems): string | null => {
    if (which.body === "required") return t("news.composer.bodyRequired");
    if (which.body === "tooLong") return t("news.composer.bodyTooLong", { max: MAX_POST_BODY });
    return null;
  };

  const submit = () => {
    setProblem(null);
    if (problems.title || problems.body) {
      setChecked(true);
      return;
    }
    setChecked(false);
    void save.run(
      async () => {
        if (editing === null) {
          const post = await api.createPost(community.id, {
            title: title.trim(),
            body: body.trim(),
            pinned: pin,
            notifyFollowers: notify,
          });
          setTitle("");
          setBody("");
          setPin(false);
          setNotify(true);
          setRound((value) => value + 1);
          onSaved(post, true);
          return;
        }
        const patch: PostPatch = { revision: editing.revision };
        if (title.trim() !== editing.title) patch.title = title.trim() === "" ? null : title.trim();
        if (body.trim() !== editing.body.trim()) patch.body = body.trim();
        if (pin !== editing.pinned) patch.pinned = pin;
        const post = await api.updatePost(editing.id, patch);
        onSaved(post, false);
      },
      (reason) => {
        const { code } = failureOf(reason);
        if (code === "limit") setProblem(t("news.composer.pinLimit"));
        else if (code === "conflict" && editing !== null) setProblem(t("news.composer.changed"));
        else setProblem(t("news.composer.failed", { reason: failure(reason) }));
      },
    );
  };

  const titleProblem = problemText(shown);
  const bodyProblem = bodyText(shown);

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-12 rounded-lg border border-line bg-surface p-16">
      <div className="flex min-h-28 flex-wrap items-baseline justify-between gap-x-12 gap-y-4">
        <h2 id={`${id}-heading`} className="text-heading-sm text-fg">
          {editing ? t("news.composer.editTitle") : t("news.composer.newTitle")}
        </h2>
        <span className="text-body-sm text-fg-secondary">{editing ? t("news.composer.noteEdit") : t("news.composer.note")}</span>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex items-baseline justify-between gap-8">
          <label htmlFor={`${id}-title`} className="text-body-sm-medium text-fg-secondary">
            {t("news.composer.title")}
          </label>
          <Counter value={title} max={MAX_POST_TITLE} />
        </div>
        <Input
          id={`${id}-title`}
          value={title}
          placeholder={t("news.composer.titlePlaceholder")}
          invalid={titleProblem !== null}
          aria-describedby={titleProblem ? `${id}-title-note` : undefined}
          onChange={(event) => setTitle(event.target.value)}
        />
        {titleProblem ? (
          <FieldNote id={`${id}-title-note`} tone="bad">
            {titleProblem}
          </FieldNote>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex items-baseline justify-between gap-8">
          <span id={`${id}-body`} className="text-body-sm-medium text-fg-secondary">
            {t("news.composer.body")}
          </span>
          <Counter value={body} max={MAX_POST_BODY} />
        </div>
        <MarkdownEditor
          key={round}
          value={body}
          onChange={setBody}
          labelledBy={`${id}-body`}
          describedBy={bodyProblem ? `${id}-body-note` : undefined}
          toolbarLabel={t("news.composer.toolbar")}
          placeholder={t("news.composer.bodyPlaceholder")}
          invalid={bodyProblem !== null}
        />
        {bodyProblem ? (
          <FieldNote id={`${id}-body-note`} tone="bad">
            {bodyProblem}
          </FieldNote>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-16 gap-y-8">
        <CheckRow checked={pin} disabled={full && !pin} onChange={setPin}>
          {t("news.composer.pin")}
        </CheckRow>
        {editing === null ? (
          <CheckRow checked={notify} onChange={setNotify}>
            {t("news.composer.notify")}
          </CheckRow>
        ) : null}
        <span className="ml-auto flex flex-wrap justify-end gap-8">
          {editing ? (
            <Button variant="ghost" wrap disabled={save.busy} onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          ) : null}
          <Button variant="primary" wrap disabled={save.busy || empty || !changed} onClick={submit}>
            {save.busy
              ? editing
                ? t("news.composer.saving")
                : t("news.composer.publishing")
              : editing
                ? t("news.composer.save")
                : t("news.composer.publish")}
          </Button>
        </span>
      </div>
      {full && !pin ? <FieldNote tone="neutral">{t("news.composer.pinFull", { max: MAX_PINNED })}</FieldNote> : null}
      {problem ? (
        <p role="alert" className="rounded-md border border-line-danger bg-danger-subtle px-12 py-8 text-body-sm text-fg [overflow-wrap:anywhere]">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** A box to tick with its label: **Pin**, **Notify followers**. */
function CheckRow({ checked, disabled = false, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; children: string }) {
  return (
    <label className={cn("inline-flex min-h-28 items-center gap-8 text-body-md-medium select-none", disabled ? "cursor-not-allowed text-fg-disabled" : "cursor-pointer text-fg")}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-18 items-center justify-center rounded-xs border peer-focus-visible:shadow-[0_0_0_2px_var(--color-border-focus)]",
          checked ? "border-line-accent bg-accent text-fg-on-accent" : "border-line-strong bg-input",
        )}
      >
        {checked ? <Check size={12} strokeWidth={3} /> : null}
      </span>
      {children}
    </label>
  );
}

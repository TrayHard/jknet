import { Pencil, Plus, Trash2, Wrench } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import { Button, Input } from "../ui";
import { Notice, Panel, PanelHead } from "./bits";
import { useFailureText } from "./errors";
import { failureOf, type CommunityPatch } from "./api";
import { useCommunityApi } from "./platform";
import { jkhubId, type Community } from "./types";
import { useAction } from "./useRemote";

/**
 * The **Manage** tab of an organizer. The management screen of the next
 * slice — servers, editors, tags, pictures, Discord — takes its place; until
 * then the tab says so and keeps the editor of before: the texts, the links
 * and the recommended files of the page.
 */
export function ManageTab({
  community,
  onSaved,
  editing,
  onEditing,
}: {
  community: Community;
  onSaved: (community: Community) => void;
  /** The editor is open: **Edit page** and **Fix the link** open it from elsewhere on the page. */
  editing: boolean;
  onEditing: (editing: boolean) => void;
}) {
  const { t } = useTranslation("community");
  const [saved, setSaved] = useState(false);
  const setEditing = onEditing;
  // A new press of **Edit page** hides the note of the save before it.
  useEffect(() => {
    if (editing) setSaved(false);
  }, [editing]);
  return (
    <div className="flex flex-col gap-16">
      <Panel labelledBy="community-manage">
        <PanelHead
          id="community-manage"
          title={
            <span className="inline-flex items-center gap-8">
              <Wrench size={16} className="text-fg-accent" aria-hidden="true" />
              {t("manage.title")}
            </span>
          }
        />
        <p className="max-w-[72ch] text-body-sm text-fg-secondary">{t("manage.soon")}</p>
        {!editing ? (
          <div>
            <Button
              variant="primary"
              wrap
              icon={<Pencil size={16} />}
              onClick={() => {
                setSaved(false);
                setEditing(true);
              }}
            >
              {t("manage.editBasics")}
            </Button>
          </div>
        ) : null}
        {saved ? <Notice tone="success">{t("editor.saved")}</Notice> : null}
      </Panel>
      {editing ? (
        <PageEditor
          key={`${community.id}-${community.revision}`}
          community={community}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            setSaved(true);
            onSaved(next);
          }}
        />
      ) : null}
    </div>
  );
}

interface FileRow {
  title: string;
  link: string;
}

/** A labelled field of the editor, its hint on a line of its own under it. */
function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <label htmlFor={htmlFor} className="text-body-sm-medium text-fg">
        {label}
      </label>
      {children}
      {hint ? <p className="text-body-sm text-fg-secondary">{hint}</p> : null}
    </div>
  );
}

const AREA =
  "w-full min-w-0 resize-y rounded-md border border-line bg-input px-12 py-8 text-body-md text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-line-focus";

/**
 * The editor of before, in the look of the kit: name, tagline, description,
 * rules, website, Discord and the recommended files. It saves through
 * `PUT communities/{id}` with the revision it was opened on, so an edit made
 * elsewhere meanwhile answers `409` instead of being overwritten.
 */
function PageEditor({ community, onCancel, onSaved }: { community: Community; onCancel: () => void; onSaved: (community: Community) => void }) {
  const { t } = useTranslation("community");
  const api = useCommunityApi();
  const failure = useFailureText();
  const action = useAction();
  const id = useId();
  const [name, setName] = useState(community.name);
  const [tagline, setTagline] = useState(community.tagline);
  const [description, setDescription] = useState(community.description);
  const [rules, setRules] = useState(community.rules);
  const [website, setWebsite] = useState(community.website);
  const [discord, setDiscord] = useState(community.discord);
  const [files, setFiles] = useState<FileRow[]>(
    community.recommendations.map((file) => ({ title: file.title, link: `https://jkhub.org/files/file/${file.jkhubId}/` })),
  );
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    setError(null);
    const recommendations = files.map((row) => ({ title: row.title.trim(), jkhubId: jkhubId(row.link) }));
    const ids = recommendations.map((row) => row.jkhubId);
    if (recommendations.some((row) => row.title === "" || row.jkhubId === null) || new Set(ids).size !== ids.length) {
      setError(t("editor.invalidFiles"));
      return;
    }
    const patch: CommunityPatch = {
      name: name.trim(),
      tagline: tagline.trim(),
      description,
      rules,
      website: website.trim(),
      discord: discord.trim(),
      recommendations: recommendations.map((row) => ({ title: row.title, jkhubId: row.jkhubId as number })),
      revision: community.revision,
    };
    void action.run(
      async () => onSaved(await api.update(community.id, patch)),
      (reason) => setError(failureOf(reason).code === "conflict" ? t("editor.conflict") : failure(reason)),
    );
  };

  return (
    <form
      className="flex flex-col gap-16 rounded-lg border border-line bg-surface p-16"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h2 id={`${id}-title`} className="text-heading-md text-fg">
        {t("editor.title")}
      </h2>
      <div className="grid grid-cols-2 gap-16 @max-[720px]/community:grid-cols-1">
        <Field label={t("editor.name")} htmlFor={`${id}-name`}>
          <Input id={`${id}-name`} required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("editor.tagline")} hint={t("editor.taglineHint")} htmlFor={`${id}-tagline`}>
          <Input id={`${id}-tagline`} maxLength={140} value={tagline} onChange={(event) => setTagline(event.target.value)} />
        </Field>
      </div>
      <Field label={t("editor.description")} hint={t("editor.descriptionHint")} htmlFor={`${id}-description`}>
        <textarea
          id={`${id}-description`}
          rows={8}
          maxLength={6000}
          className={AREA}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <Field label={t("editor.rules")} htmlFor={`${id}-rules`}>
        <textarea id={`${id}-rules`} rows={4} maxLength={4000} className={AREA} value={rules} onChange={(event) => setRules(event.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-16 @max-[720px]/community:grid-cols-1">
        <Field label={t("editor.website")} htmlFor={`${id}-website`}>
          <Input id={`${id}-website`} type="url" maxLength={500} value={website} onChange={(event) => setWebsite(event.target.value)} />
        </Field>
        <Field label={t("editor.discord")} hint={t("editor.discordHint")} htmlFor={`${id}-discord`}>
          <Input id={`${id}-discord`} type="url" maxLength={500} value={discord} onChange={(event) => setDiscord(event.target.value)} />
        </Field>
      </div>
      <div className="flex flex-col gap-8">
        <h3 className="text-heading-sm text-fg">{t("editor.files")}</h3>
        <p className="text-body-sm text-fg-secondary">{t("editor.filesHint")}</p>
        {files.map((row, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-end gap-8 @max-[640px]/community:grid-cols-1"
          >
            <Field label={t("editor.fileTitle")} htmlFor={`${id}-file-${index}-title`}>
              <Input
                id={`${id}-file-${index}-title`}
                required
                maxLength={120}
                value={row.title}
                onChange={(event) => setFiles((rows) => rows.map((item, at) => (at === index ? { ...item, title: event.target.value } : item)))}
              />
            </Field>
            <Field label={t("editor.fileUrl")} htmlFor={`${id}-file-${index}-link`}>
              <Input
                id={`${id}-file-${index}-link`}
                required
                value={row.link}
                onChange={(event) => setFiles((rows) => rows.map((item, at) => (at === index ? { ...item, link: event.target.value } : item)))}
              />
            </Field>
            <Button
              variant="ghost"
              icon={<Trash2 size={16} />}
              aria-label={t("editor.remove")}
              title={t("editor.remove")}
              onClick={() => setFiles((rows) => rows.filter((_, at) => at !== index))}
            />
          </div>
        ))}
        <div>
          <Button
            size="sm"
            wrap
            icon={<Plus size={14} />}
            disabled={files.length >= 30}
            onClick={() => setFiles((rows) => [...rows, { title: "", link: "" }])}
          >
            {t("editor.addFile")}
          </Button>
        </div>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className={cn("flex flex-wrap items-center justify-end gap-8")}>
        <Button variant="ghost" wrap disabled={action.busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" wrap disabled={action.busy}>
          {action.busy ? t("editor.saving") : t("editor.save")}
        </Button>
      </div>
    </form>
  );
}

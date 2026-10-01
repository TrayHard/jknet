import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "../../ui";
import { useCommunityPlatform } from "../platform";
import { jkhubId } from "../types";
import { jkhubLink, rowKey, type FileRow, type ManageDraft } from "./model";
import { FieldNote, OrderButtons, Section, useProblemText } from "./parts";
import { LIMITS, type DraftProblems } from "./validate";

/**
 * **Recommended files**: up to 30 files of JKHub, each a title and a link
 * or a number, in the order the launcher installs them.
 */
export function FilesSection({
  draft,
  problems,
  edit,
}: {
  draft: ManageDraft;
  problems: DraftProblems;
  edit: (patch: Partial<ManageDraft>) => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const problemText = useProblemText();
  const id = useId();
  const files = draft.files;
  const set = (next: FileRow[]) => edit({ files: next });
  const move = (index: number, by: number) => {
    const next = [...files];
    const [row] = next.splice(index, 1);
    next.splice(index + by, 0, row);
    set(next);
  };

  return (
    <Section
      section="files"
      title={t("manage.sections.files")}
      count={t("manage.files.count", { count: files.length, max: LIMITS.files })}
      lead={t("manage.files.lead")}
    >
      {files.length === 0 ? <p className="text-body-sm text-fg-secondary">{t("manage.files.empty")}</p> : null}
      {files.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-8">
          {files.map((file, index) => {
            const problem = problems.files[file.key];
            const known = jkhubId(file.link);
            const name = file.title.trim() !== "" ? file.title.trim() : t("manage.files.untitled", { number: index + 1 });
            return (
              <div key={file.key} className="flex min-w-0 flex-col gap-6">
                <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-8 @max-[640px]/community:grid-cols-[auto_minmax(0,1fr)_auto]">
                  <span className="@max-[640px]/community:row-span-2">
                    <OrderButtons
                      upLabel={t("manage.files.up", { name })}
                      downLabel={t("manage.files.down", { name })}
                      first={index === 0}
                      last={index === files.length - 1}
                      onMove={(by) => move(index, by)}
                    />
                  </span>
                  <Input
                    aria-label={t("manage.files.title", { number: index + 1 })}
                    placeholder={t("manage.files.titlePlaceholder")}
                    value={file.title}
                    invalid={problem === "fileTitle" || problem === "tooLong" || problem === "control"}
                    aria-describedby={problem ? `${id}-file-${file.key}` : undefined}
                    onChange={(event) => set(files.map((row) => (row.key === file.key ? { ...row, title: event.target.value } : row)))}
                  />
                  <Input
                    aria-label={t("manage.files.link", { number: index + 1 })}
                    placeholder={t("manage.files.linkPlaceholder")}
                    spellCheck={false}
                    value={file.link}
                    invalid={problem === "fileLink" || problem === "fileDuplicate"}
                    aria-describedby={problem ? `${id}-file-${file.key}` : undefined}
                    className="@max-[640px]/community:col-start-2"
                    onChange={(event) => set(files.map((row) => (row.key === file.key ? { ...row, link: event.target.value } : row)))}
                    trailing={
                      known !== null ? (
                        <a
                          href={jkhubLink(known)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => {
                            event.preventDefault();
                            platform.openExternal(jkhubLink(known));
                          }}
                          className="inline-flex size-24 items-center justify-center rounded-sm text-fg-secondary hover:bg-hover-overlay hover:text-fg"
                          aria-label={t("manage.files.open", { name })}
                          title={t("manage.files.open", { name })}
                        >
                          <ExternalLink size={14} />
                        </a>
                      ) : undefined
                    }
                  />
                  <Button
                    variant="ghost"
                    icon={<Trash2 size={16} />}
                    aria-label={t("manage.files.remove", { name })}
                    title={t("manage.files.remove", { name })}
                    className="@max-[640px]/community:col-start-3 @max-[640px]/community:row-start-1"
                    onClick={() => set(files.filter((row) => row.key !== file.key))}
                  />
                </div>
                {problem ? (
                  <FieldNote id={`${id}-file-${file.key}`} tone="bad">
                    {problemText(problem, { max: LIMITS.fileTitle })}
                  </FieldNote>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
        <Button
          size="sm"
          wrap
          icon={<Plus size={14} />}
          disabled={files.length >= LIMITS.files}
          onClick={() => set([...files, { key: rowKey(), title: "", link: "" }])}
        >
          {t("manage.files.add")}
        </Button>
        <span className="text-body-sm text-fg-secondary">{t("manage.files.addHint")}</span>
      </div>
    </Section>
  );
}

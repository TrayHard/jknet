import { Layers } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Combobox, Input } from "../../ui";
import { useCommunityPlatform } from "../platform";
import type { Community } from "../types";
import { useRemote } from "../useRemote";
import { changed, type ManageDraft } from "./model";
import { FieldNote, Section, useProblemText } from "./parts";
import { bundleIdOf, type DraftProblems } from "./validate";

/**
 * **Bundle**: the JKNet bundle the community recommends as its client. The
 * launcher and the website pick one from the public catalogue of the
 * community's game; any host takes an id or a link. The service keeps only a
 * bundle every player can see, and says so on save.
 */
export function BundleSection({
  community,
  base,
  draft,
  problems,
  edit,
}: {
  community: Community;
  base: ManageDraft;
  draft: ManageDraft;
  problems: DraftProblems;
  edit: (patch: Partial<ManageDraft>) => void;
}) {
  const { t } = useTranslation("community");
  const platform = useCommunityPlatform();
  const problemText = useProblemText();
  const id = useId();
  const [typed, setTyped] = useState("");
  const [typedWrong, setTypedWrong] = useState(false);
  const game = community.games[0] ?? platform.game ?? "ja";
  const find = platform.findBundles;
  const catalogue = useRemote(find ? `bundles:${game}` : null, () => find!("", game));

  const use = () => {
    const bundleId = bundleIdOf(typed);
    if (bundleId === null) {
      setTypedWrong(true);
      return;
    }
    const known = catalogue.data?.find((bundle) => bundle.id === bundleId);
    edit({ bundleId, bundleName: known?.name ?? (bundleId === base.bundleId ? base.bundleName : null) });
    setTyped("");
    setTypedWrong(false);
  };

  const unsaved = changed(base, draft, "bundleId");
  const options = (catalogue.data ?? []).map((bundle) => ({ value: bundle.id, label: bundle.name }));

  return (
    <Section section="bundle" title={t("manage.sections.bundle")} lead={t("manage.bundle.lead")}>
      {draft.bundleId !== null ? (
        <div className="flex min-h-52 min-w-0 flex-wrap items-center gap-12 rounded-md border border-line-subtle bg-input px-12 py-8">
          <span className="flex size-32 shrink-0 items-center justify-center rounded-md bg-purple-subtle text-fg-purple" aria-hidden="true">
            <Layers size={16} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body-sm-medium text-fg [overflow-wrap:anywhere]">
              {draft.bundleName ?? t("manage.bundle.unnamed", { id: draft.bundleId })}
            </span>
            <span className={unsaved ? "text-body-sm text-fg-warm" : "text-body-sm text-fg-secondary"}>
              {unsaved ? t("manage.bundle.unsaved") : t("manage.bundle.current")}
            </span>
          </span>
          {platform.openBundle && !unsaved ? (
            <Button size="sm" wrap onClick={() => platform.openBundle?.(draft.bundleId!)}>
              {t("common.open")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" wrap onClick={() => edit({ bundleId: null, bundleName: null })}>
            {t("manage.bundle.remove")}
          </Button>
        </div>
      ) : (
        <p className="text-body-sm text-fg-secondary">{unsaved ? t("manage.bundle.removedUnsaved") : t("manage.bundle.none")}</p>
      )}
      {problems.bundle ? <FieldNote tone="bad">{problemText(problems.bundle)}</FieldNote> : null}

      <div className="grid grid-cols-2 items-start gap-16 @max-[880px]/community:grid-cols-1">
        {find ? (
          <div className="flex min-w-0 flex-col gap-6">
            <span className="text-body-sm-medium text-fg-secondary">{t("manage.bundle.pick")}</span>
            <Combobox
              value={draft.bundleId ?? ""}
              onChange={(value) => edit({ bundleId: value, bundleName: options.find((option) => option.value === value)?.label ?? null })}
              options={options}
              ariaLabel={t("manage.bundle.pick")}
              searchLabel={t("manage.bundle.search")}
              emptyText={catalogue.loading ? t("manage.bundle.loading") : t("manage.bundle.nothing")}
              placeholder={catalogue.loading ? t("manage.bundle.loading") : t("manage.bundle.pickPlaceholder")}
              disabled={catalogue.loading && options.length === 0}
            />
            {catalogue.error ? <FieldNote tone="warn">{t("manage.bundle.failed")}</FieldNote> : null}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-6">
          <label htmlFor={`${id}-bundle`} className="text-body-sm-medium text-fg-secondary">
            {t("manage.bundle.byId")}
          </label>
          <div className="flex min-w-0 gap-8">
            <Input
              id={`${id}-bundle`}
              className="min-w-0 flex-1"
              spellCheck={false}
              placeholder={t("manage.bundle.byIdPlaceholder")}
              value={typed}
              invalid={typedWrong}
              aria-describedby={`${id}-bundle-note`}
              onChange={(event) => {
                setTyped(event.target.value);
                setTypedWrong(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  use();
                }
              }}
            />
            <Button wrap disabled={typed.trim() === ""} onClick={use}>
              {t("manage.bundle.use")}
            </Button>
          </div>
          <FieldNote id={`${id}-bundle-note`} tone={typedWrong ? "bad" : "neutral"}>
            {typedWrong ? t("manage.problems.bundle") : t("manage.bundle.byIdHint")}
          </FieldNote>
        </div>
      </div>
    </Section>
  );
}

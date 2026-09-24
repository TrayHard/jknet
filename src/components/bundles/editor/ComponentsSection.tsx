import { Plus, Settings2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import type { Draft, DraftComponent, Engine, LaunchMode } from "../../../lib/ipc";
import { useEngineReleases, useEnginesOfGame, type DraftActions } from "../../../lib/queries";
import { EngineLogo } from "../../EngineLogo";
import { Button, Dialog, EmptyState, Input, Select, type SelectOption } from "../../ui";
import { ModeBadges, useEngineName } from "../bundleFiles";
import { LIMITS, componentSummary } from "./draftModel";
import { Field } from "./fields";

/**
 * --- slice: bundles ---
 *
 * **Components**: the list of components of the draft, and the way to add one.
 *
 * A component is an engine of the registry with a release tag, a subset of
 * its modes and a label; the rest — its files, its overlay, its configs, its
 * launch line — is edited on the component's own page, which **Edit** opens.
 * **Remove** asks first: the files of the component go with it.
 */
export function ComponentsSection({
  draft,
  actions,
  onOpen,
}: {
  draft: Draft;
  actions: DraftActions;
  /** Opens the page of one component. */
  onOpen: (componentId: string) => void;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const engineName = useEngineName();
  const [adding, setAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<DraftComponent | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-12">
      <div className="flex items-center gap-8">
        <p className="text-body-sm text-fg-muted flex-1">{t("editor.components.text")}</p>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={draft.components.length >= 8}
          title={draft.components.length >= 8 ? t("editor.components.limit") : undefined}
          onClick={() => setAdding(true)}
        >
          {t("editor.components.add")}
        </Button>
      </div>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {failure}
        </p>
      ) : null}

      {draft.components.length === 0 ? (
        <EmptyState
          icon={<Plus size={24} />}
          title={t("editor.components.emptyTitle")}
          text={t("editor.components.emptyText")}
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              {t("editor.components.add")}
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-12">
          {draft.components.map((component) => {
            const { replaced, added, removed } = componentSummary(component);
            return (
              <li
                key={component.id}
                className="flex items-center gap-12 rounded-lg border border-line bg-surface p-12"
              >
                <EngineLogo engineId={component.engineId} name={engineName(component.engineId)} size={40} />
                <div className="flex-1 min-w-0 flex flex-col gap-4">
                  <div className="flex items-center gap-8 min-w-0">
                    <span className="text-body-md-medium text-fg truncate">{component.label}</span>
                    <ModeBadges modes={component.modes} />
                  </div>
                  <span className="text-body-sm text-fg-muted truncate">
                    {engineName(component.engineId)}
                    {" · "}
                    {component.releaseTag
                      ? t("details.engineRelease", { tag: component.releaseTag })
                      : t("details.engineLatest")}
                    {component.fsGame ? ` · ${t("details.fsGame", { folder: component.fsGame })}` : ""}
                  </span>
                  <span className="text-mono-xs text-fg-muted truncate">
                    {[
                      t("details.overlay.replaced", { count: replaced }),
                      t("details.overlay.added", { count: added }),
                      t("details.overlay.removed", { count: removed }),
                      t("card.files", { count: component.files.length }),
                      t("editor.components.configs", { count: component.configs.length }),
                    ].join(" · ")}
                  </span>
                </div>
                <Button size="sm" icon={<Settings2 size={14} />} onClick={() => onOpen(component.id)}>
                  {t("editor.components.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={14} />}
                  disabled={actions.removeComponent.isPending}
                  onClick={() => setPendingRemove(component)}
                >
                  {t("editor.components.remove")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {adding ? (
        <AddComponentDialog
          draft={draft}
          actions={actions}
          onClose={() => setAdding(false)}
          onAdded={(componentId) => {
            setAdding(false);
            onOpen(componentId);
          }}
        />
      ) : null}

      {pendingRemove !== null ? (
        <Dialog
          title={t("editor.components.confirmTitle", { label: pendingRemove.label })}
          body={t("editor.components.confirmBody")}
          variant="danger"
          onClose={() => setPendingRemove(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setPendingRemove(null)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={actions.removeComponent.isPending}
                onClick={() => {
                  setFailure(null);
                  actions.removeComponent.mutate(pendingRemove.id, {
                    onError: (e) => setFailure(errorText(e)),
                    onSettled: () => setPendingRemove(null),
                  });
                }}
              >
                {actions.removeComponent.isPending ? tCommon("states.removing") : t("editor.components.confirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

/** The value of the release list that means «the latest at install time». */
const LATEST = "";

/**
 * **Add component**: an engine of the active game, a release, the modes, a
 * label.
 *
 * The release list is the one of the engine page, newest first, with the
 * newest picked; «latest at install time» is offered above it for a bundle
 * that should follow the engine. The modes come from the registry and start
 * all ticked; the label starts as the name of the engine.
 */
function AddComponentDialog({
  draft,
  actions,
  onClose,
  onAdded,
}: {
  draft: Draft;
  actions: DraftActions;
  onClose: () => void;
  onAdded: (componentId: string) => void;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const engines = useEnginesOfGame(draft.game);
  const installable = useMemo(() => engines.filter((engine) => engine.installable), [engines]);
  const [engineId, setEngineId] = useState<string>("");
  const engine: Engine | undefined = installable.find((entry) => entry.id === engineId) ?? installable[0];
  const releases = useEngineReleases(engine?.id ?? null);
  // `null` until the player picks: the newest release stands in meanwhile.
  const [pickedTag, setPickedTag] = useState<string | null>(null);
  const [modes, setModes] = useState<LaunchMode[] | null>(null);
  const [typedLabel, setTypedLabel] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A change of engine starts the release, the modes and the label over.
  useEffect(() => {
    setPickedTag(null);
    setModes(null);
    setTypedLabel(null);
  }, [engine?.id]);

  const engineOptions: SelectOption[] = installable.map((entry) => ({ value: entry.id, label: entry.name }));
  const releaseOptions: SelectOption[] = [
    { value: LATEST, label: t("editor.components.latestRelease") },
    ...(releases.data ?? []).map((release) => ({
      value: release.tag,
      label: release.prerelease ? t("editor.components.prerelease", { tag: release.tag }) : release.tag,
    })),
  ];
  const tag = pickedTag ?? releases.data?.[0]?.tag ?? LATEST;
  const engineModes = engine?.modes ?? ["multiplayer"];
  const chosenModes = modes ?? engineModes;
  const label = typedLabel ?? engine?.name ?? "";
  const labelLength = [...label.trim()].length;
  const labelValid = labelLength >= 1 && labelLength <= LIMITS.componentLabel;
  // The reason shows once the author has typed: a field that opens red says
  // the dialog is broken, not that the label is missing.
  const labelProblem = !labelValid && typedLabel !== null ? t("editor.components.invalidLabel") : null;
  const canAdd = engine !== undefined && chosenModes.length > 0 && labelValid && !actions.addComponent.isPending;

  const add = () => {
    if (!engine) return;
    setFailure(null);
    actions.addComponent.mutate(
      {
        engineId: engine.id,
        releaseTag: tag === LATEST ? null : tag,
        label: label.trim(),
        modes: chosenModes,
      },
      {
        onSuccess: (next) => {
          // The core builds the id out of the label; the component is the
          // one that was not there before.
          const before = new Set(draft.components.map((component) => component.id));
          const created = next.components.find((component) => !before.has(component.id));
          if (created) onAdded(created.id);
          else onClose();
        },
        onError: (e) => setFailure(errorText(e)),
      },
    );
  };

  return (
    <Dialog
      title={t("editor.components.addTitle")}
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon("actions.cancel")}
          </Button>
          <Button variant="primary" disabled={!canAdd} onClick={add}>
            {actions.addComponent.isPending ? tCommon("states.creating") : t("editor.components.add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12 pt-16">
        {failure ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {failure}
          </p>
        ) : null}
        <Field label={t("editor.components.engine")}>
          <Select
            ariaLabel={t("editor.components.engine")}
            options={engineOptions}
            value={engine?.id ?? ""}
            onChange={setEngineId}
            placeholder={tCommon("select.nothingToChoose")}
          />
        </Field>
        <Field label={t("editor.components.release")} hint={t("editor.components.releaseHint")}>
          <Select
            ariaLabel={t("editor.components.release")}
            options={releaseOptions}
            value={tag}
            onChange={setPickedTag}
            disabled={releases.isLoading}
          />
          {releases.error ? (
            <span className="text-body-sm text-fg-danger">{errorText(releases.error)}</span>
          ) : null}
        </Field>
        <Field
          label={t("editor.components.modes")}
          problem={chosenModes.length === 0 ? t("editor.components.noModes") : null}
        >
          <ModeChecks engineModes={engineModes} modes={chosenModes} onChange={setModes} />
        </Field>
        <Field label={t("editor.components.label")} hint={t("editor.components.labelHint")} problem={labelProblem} htmlFor="component-label">
          <Input
            id="component-label"
            value={label}
            maxLength={LIMITS.componentLabel}
            invalid={labelProblem !== null}
            onChange={(event) => setTypedLabel(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** A tick per mode of the engine. An engine with one mode has one locked tick. */
export function ModeChecks({
  engineModes,
  modes,
  onChange,
  disabled = false,
}: {
  engineModes: LaunchMode[];
  modes: LaunchMode[];
  onChange: (modes: LaunchMode[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("bundles");
  return (
    <div className="flex flex-wrap items-center gap-16">
      {engineModes.map((mode) => (
        <label key={mode} className="flex items-center gap-8 text-body-sm text-fg cursor-pointer">
          <input
            type="checkbox"
            checked={modes.includes(mode)}
            disabled={disabled || engineModes.length === 1}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? engineModes.filter((entry) => entry === mode || modes.includes(entry))
                  : modes.filter((entry) => entry !== mode),
              )
            }
            className="size-16 shrink-0 accent-accent cursor-pointer disabled:cursor-not-allowed"
          />
          {t(`modes.${mode}`)}
        </label>
      ))}
    </div>
  );
}

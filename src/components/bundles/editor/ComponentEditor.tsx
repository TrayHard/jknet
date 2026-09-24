import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import type { Draft, DraftComponent } from "../../../lib/ipc";
import { useEngines, type DraftActions } from "../../../lib/queries";
import { EngineLogo } from "../../EngineLogo";
import { Tabs } from "../../servers/Tabs";
import { Button, Dialog, Input } from "../../ui";
import { ModeBadges, useEngineName } from "../bundleFiles";
import { ConfigsTab } from "./ConfigsTab";
import { LIMITS } from "./draftModel";
import { EngineFilesTab } from "./EngineFilesTab";
import { useCommitField } from "./fields";
import { FilesTab } from "./FilesTab";
import { LaunchTab } from "./LaunchTab";

/** The four tabs of a component, in the order of the page. */
export type ComponentTab = "engine" | "files" | "configs" | "launch";

export const COMPONENT_TABS: ComponentTab[] = ["engine", "files", "configs", "launch"];

/**
 * --- slice: bundles ---
 *
 * One component of the draft: its head, its four tabs and **Remove**.
 *
 * The head is the engine and the label, which is edited in place: the label
 * is the suffix of the client name after an install, so it stands where the
 * name of the thing stands. The tabs hold the rest.
 */
export function ComponentEditor({
  draft,
  component,
  actions,
  tab,
  onTab,
  onRemoved,
}: {
  draft: Draft;
  component: DraftComponent;
  actions: DraftActions;
  tab: ComponentTab;
  onTab: (tab: ComponentTab) => void;
  /** The component is gone: the page goes back to the list. */
  onRemoved: () => void;
}) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const engineName = useEngineName();
  const engines = useEngines();
  const engine = engines.data?.find((entry) => entry.id === component.engineId);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const label = useCommitField(
    component.label,
    (value) => actions.updateComponent.mutate({ componentId: component.id, patch: { label: value.trim() } }),
    (value) => {
      const length = [...value.trim()].length;
      return length < 1 || length > LIMITS.componentLabel ? t("editor.components.invalidLabel") : null;
    },
  );

  return (
    <div className="flex flex-col gap-16">
      <div className="flex items-center gap-12">
        <EngineLogo engineId={component.engineId} name={engineName(component.engineId)} size={40} />
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <div className="flex items-center gap-8">
            <Input
              value={label.value}
              aria-label={t("editor.components.label")}
              maxLength={LIMITS.componentLabel}
              invalid={label.problem !== null}
              onChange={(event) => label.onChange(event.target.value)}
              onBlur={label.onBlur}
              className="max-w-[320px]"
            />
            <ModeBadges modes={component.modes} />
          </div>
          <span className="text-body-sm text-fg-muted truncate">
            {engineName(component.engineId)}
            {" · "}
            {component.releaseTag
              ? t("details.engineRelease", { tag: component.releaseTag })
              : t("details.engineLatest")}
          </span>
          {label.problem ? (
            <span role="alert" className="text-body-sm text-fg-danger">
              {label.problem}
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 size={14} />}
          disabled={actions.removeComponent.isPending}
          onClick={() => setConfirmRemove(true)}
        >
          {t("editor.components.remove")}
        </Button>
      </div>

      {failure ? (
        <p role="alert" className="text-body-sm text-fg-danger">
          {failure}
        </p>
      ) : null}

      <Tabs<ComponentTab>
        value={tab}
        onChange={onTab}
        tabs={[
          { id: "engine", label: t("editor.tabs.engine") },
          { id: "files", label: t("editor.tabs.files"), count: component.files.length },
          { id: "configs", label: t("editor.tabs.configs"), count: component.configs.length },
          { id: "launch", label: t("editor.tabs.launch") },
        ]}
      />

      {tab === "engine" ? (
        <EngineFilesTab key={component.id} draft={draft} component={component} actions={actions} />
      ) : tab === "files" ? (
        <FilesTab key={component.id} draft={draft} scope={component.id} actions={actions} />
      ) : tab === "configs" ? (
        <ConfigsTab key={component.id} draft={draft} scope={component.id} actions={actions} />
      ) : (
        <LaunchTab key={component.id} component={component} engine={engine} actions={actions} />
      )}

      {confirmRemove ? (
        <Dialog
          title={t("editor.components.confirmTitle", { label: component.label })}
          body={t("editor.components.confirmBody")}
          variant="danger"
          onClose={() => setConfirmRemove(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={actions.removeComponent.isPending}
                onClick={() => {
                  setFailure(null);
                  actions.removeComponent.mutate(component.id, {
                    onSuccess: onRemoved,
                    onError: (e) => setFailure(errorText(e)),
                    onSettled: () => setConfirmRemove(false),
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

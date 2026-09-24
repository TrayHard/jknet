import { Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import type { BundleInstallJob } from "../../lib/bundleJobs";
import type { LaunchMode } from "../../lib/ipc";
import { Button, Input, Toggle } from "../ui";
import { BundleInstallBar, ModeBadges, Notice, useCodeText, useEngineName } from "./bundleFiles";

/** One component as the form offers it: a tick, a label, an engine. */
export interface InstallableComponent {
  id: string;
  label: string;
  engineId: string;
  releaseTag: string | null;
  modes: LaunchMode[];
  /** False when this build has no registry entry for the engine: the tick is off and locked. */
  known: boolean;
}

interface BundleInstallFormProps {
  components: InstallableComponent[];
  /** The name the field starts with: the name of the bundle or the draft. */
  defaultName: string;
  /** True when a chosen component carries an exe or a dll: the trust switch appears. */
  hasExecutables: boolean;
  /** The install of this version or draft, out of the store. */
  job: BundleInstallJob | undefined;
  /** Names of the clients already made out of this bundle, for the line above the field. */
  installedClients?: string[];
  /** Locks the whole form: the record is not there yet, or nothing to install. */
  disabled?: boolean;
  onInstall: (
    baseName: string,
    componentIds: string[],
    existingClientIds: Record<string, string> | null,
  ) => void;
  onOpenClient: (clientId: string) => void;
}

/**
 * --- slice: bundles ---
 *
 * The install of a bundle, as the record in the catalogue and the **Test
 * locally** dialog of the editor both draw it: a base name, a tick per
 * component, a word of trust when executables are among them, the button,
 * and then the bar and the outcome out of `bundleJobs`.
 *
 * One client per ticked component: the core names them `<base> · <label>`,
 * or `<base>` alone when one component is ticked. A component whose engine
 * this build does not know stays unticked and says why.
 */
export function BundleInstallForm({
  components,
  defaultName,
  hasExecutables,
  job,
  installedClients = [],
  disabled = false,
  onInstall,
  onOpenClient,
}: BundleInstallFormProps) {
  const { t } = useTranslation("bundles");
  const engineName = useEngineName();
  // `null` until the player types: the name of the bundle stands in meanwhile.
  const [typedName, setTypedName] = useState<string | null>(null);
  // Ticks the player changed; a component not here keeps its default: on
  // when its engine is known.
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [trusted, setTrusted] = useState(false);

  const baseName = typedName ?? defaultName;
  const isTicked = (component: InstallableComponent) =>
    component.known && (ticks[component.id] ?? true);
  const chosen = components.filter(isTicked).map((component) => component.id);
  const running = job?.phase === "running";
  const canInstall =
    !disabled &&
    !running &&
    chosen.length > 0 &&
    baseName.trim() !== "" &&
    (!hasExecutables || trusted);

  return (
    <div className="flex flex-col gap-12">
      {installedClients.length > 0 ? (
        <p className="text-body-sm text-fg-muted">
          {t("details.install.alreadyInstalled", { clients: installedClients.join(", ") })}
        </p>
      ) : null}

      <label className="flex flex-col gap-4">
        <span className="text-label-xs text-fg-muted">{t("details.install.baseName")}</span>
        <Input
          value={baseName}
          placeholder={t("details.install.namePlaceholder")}
          disabled={running || disabled}
          maxLength={64}
          onChange={(event) => setTypedName(event.target.value)}
          className="max-w-[360px]"
        />
        <span className="text-body-sm text-fg-muted">
          {components.length > 1
            ? t("details.install.baseNameHint", { name: baseName.trim() || defaultName })
            : t("details.install.baseNameHintOne")}
        </span>
      </label>

      <div className="flex flex-col gap-4">
        <span className="text-label-xs text-fg-muted">{t("details.install.components")}</span>
        <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
          {components.map((component) => (
            <li key={component.id} className="flex flex-col gap-2 px-12 py-8">
              <label className="flex items-center gap-8 min-w-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isTicked(component)}
                  disabled={!component.known || running || disabled}
                  onChange={(event) =>
                    setTicks((current) => ({ ...current, [component.id]: event.target.checked }))
                  }
                  className="size-16 shrink-0 accent-accent cursor-pointer disabled:cursor-not-allowed"
                />
                <span className="text-body-sm text-fg truncate">{component.label}</span>
                <span className="text-body-sm text-fg-muted truncate">
                  {engineName(component.engineId)}
                  {component.releaseTag ? ` ${component.releaseTag}` : ""}
                </span>
                <span className="ml-auto flex items-center gap-4">
                  <ModeBadges modes={component.modes} />
                </span>
              </label>
              {!component.known ? (
                <span className="pl-24 text-body-sm text-fg-warm">
                  {t("details.engineUnknown", { engine: engineName(component.engineId) })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {hasExecutables ? (
        <div className="flex items-start gap-12">
          <Toggle
            checked={trusted}
            onChange={setTrusted}
            disabled={running || disabled}
            label={t("details.install.trust")}
          />
          <div className="flex flex-col gap-2">
            <span className="text-body-sm text-fg">{t("details.install.trust")}</span>
            <span className="text-body-sm text-fg-muted">{t("details.install.trustHint")}</span>
          </div>
        </div>
      ) : null}

      <div>
        <Button
          variant="primary"
          icon={<Download size={16} />}
          disabled={!canInstall}
          onClick={() => onInstall(baseName.trim(), chosen, null)}
        >
          {running
            ? t("details.install.installing")
            : installedClients.length > 0
              ? t("details.install.buttonAgain")
              : t("details.install.button")}
        </Button>
      </div>

      {job ? (
        <InstallOutcome
          job={job}
          components={components}
          onOpenClient={onOpenClient}
          onRetry={() =>
            onInstall(
              job.baseName || baseName.trim(),
              job.componentIds.length > 0 ? job.componentIds : chosen,
              job.existingClientIds,
            )
          }
        />
      ) : null}
    </div>
  );
}

/** The bar, the success or the failure of an install, out of the store. */
function InstallOutcome({
  job,
  components,
  onOpenClient,
  onRetry,
}: {
  job: BundleInstallJob;
  components: InstallableComponent[];
  onOpenClient: (clientId: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("bundles");
  const errorText = useErrorText();
  const progress = job.progress;
  const warningText = useCodeText("details.install.warning");
  const componentLabel =
    components.find((component) => component.id === job.componentId)?.label ?? null;

  if (job.phase === "running") {
    return (
      <BundleInstallBar
        progress={progress}
        componentLabel={job.componentIds.length > 1 || components.length > 1 ? componentLabel : null}
      />
    );
  }

  if (job.phase === "done") {
    // The `done` event of the core carries codes for what went through with
    // a difference: a JKHub file whose current download is not the one the
    // author had. Each code has a sentence; an unknown one prints as is.
    const warnings = progress?.warnings ?? [];
    return (
      <Notice tone="success">
        <span>{t("details.install.done", { count: job.clients.length })}</span>
        {warnings.map((code) => (
          <span key={code} className="text-fg-warm">
            {warningText(code)}
          </span>
        ))}
        <span className="flex flex-wrap gap-8">
          {job.clients.map((client) => (
            <Button key={client.id} size="sm" onClick={() => onOpenClient(client.id)}>
              {t("details.install.openClient", { client: client.name })}
            </Button>
          ))}
        </span>
      </Notice>
    );
  }

  // The event names the file and the component; the call carries the
  // reason. Both are printed when both are there, and the file first,
  // because it is what to look at.
  const fileLine = progress?.phase === "error" ? progress.message : null;
  const reason = job.error === null ? null : errorText(job.error);
  const where = componentLabel ? t("details.install.failedIn", { component: componentLabel }) : null;
  return (
    <Notice tone="danger">
      <span>
        {fileLine ?? reason
          ? t("details.install.failed", { message: [where, fileLine, reason].filter(Boolean).join(" ") })
          : t("details.install.failedPlain")}
      </span>
      <Button size="sm" onClick={onRetry}>
        {t("details.install.retry")}
      </Button>
    </Notice>
  );
}

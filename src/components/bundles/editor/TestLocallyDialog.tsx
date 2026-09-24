import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../../i18n/errors";
import { draftJobKey, useBundleInstallJob } from "../../../lib/bundleJobs";
import { useOpenClientWindow } from "../../../lib/clientWindow";
import type { Draft } from "../../../lib/ipc";
import { useEngines, useInstallBundleDraft } from "../../../lib/queries";
import { Button, Dialog } from "../../ui";
import { BundleInstallForm, type InstallableComponent } from "../BundleInstallForm";
import { isExecutable } from "../bundleFiles";
import { draftFiles } from "./draftModel";

/**
 * --- slice: bundles ---
 *
 * **Test locally**: the install form of the catalogue, fed the draft.
 *
 * One client per ticked component, the files copied out of the folder of the
 * draft instead of downloaded, so the author plays what a player will get
 * before anything is uploaded. The bar and the outcome are the ones of the
 * catalogue, out of `bundleJobs` under the key of the draft, and survive the
 * dialog being closed and opened again.
 */
export function TestLocallyDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const { t } = useTranslation("bundles");
  const { t: tCommon } = useTranslation("common");
  const errorText = useErrorText();
  const engines = useEngines();
  const install = useInstallBundleDraft();
  const job = useBundleInstallJob(draftJobKey(draft.id));
  const openClientWindow = useOpenClientWindow();
  const [failure, setFailure] = useState<string | null>(null);

  const components: InstallableComponent[] = draft.components.map((component) => ({
    id: component.id,
    label: component.label,
    engineId: component.engineId,
    releaseTag: component.releaseTag,
    modes: component.modes,
    known: engines.data?.some((engine) => engine.id === component.engineId) !== false,
  }));
  const hasExecutables = draftFiles(draft).some((file) => isExecutable(file.kind));

  return (
    <Dialog
      title={t("editor.test.title", { draft: draft.name })}
      wide
      onClose={onClose}
      actions={
        <Button variant="ghost" onClick={onClose}>
          {tCommon("actions.close")}
        </Button>
      }
    >
      <div className="flex flex-col gap-12 pt-16 max-h-[60vh] overflow-y-auto pr-4">
        <p className="text-body-sm text-fg-muted">{t("editor.test.text")}</p>
        {failure ? (
          <p role="alert" className="text-body-sm text-fg-danger">
            {failure}
          </p>
        ) : null}
        {draft.components.length === 0 ? (
          <p className="text-body-sm text-fg-muted">{t("editor.preview.noComponents")}</p>
        ) : (
          <BundleInstallForm
            components={components}
            defaultName={draft.name}
            hasExecutables={hasExecutables}
            job={job}
            onInstall={(baseName, componentIds, existingClientIds) => {
              setFailure(null);
              // A refusal is the store's to show, in the notice under the
              // form with **Retry**; the line above is for opening a
              // client, which the store knows nothing of.
              install.mutate({ draftId: draft.id, baseName, componentIds, existingClientIds });
            }}
            onOpenClient={(clientId) => {
              setFailure(null);
              openClientWindow(clientId).catch((e: unknown) => setFailure(errorText(e)));
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

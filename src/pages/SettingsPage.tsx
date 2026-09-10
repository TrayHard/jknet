import { openPath } from "@tauri-apps/plugin-opener";
import { AlertTriangle, FolderOpen, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { Page, PageHeader } from "../components/PageHeader";
import { Button, EmptyState } from "../components/ui";
import { errorMessage } from "../lib/ipc";
import { useDataPaths } from "../lib/queries";
import { isTauri } from "../lib/runtime";

/**
 * Placeholder for the settings screens.
 *
 * The data folder is already here, because it is the one setting a player may
 * need before anything else works, and because a support answer often starts
 * with "open that folder and send me the log".
 */
export function SettingsPage() {
  const dataPaths = useDataPaths();
  const [error, setError] = useState<string | null>(null);

  const dataRoot = dataPaths.data?.dataRoot ?? null;
  const failure = error ?? (dataPaths.error ? errorMessage(dataPaths.error) : null);

  /** Hands the folder to the file manager. Scoped to `$LOCALDATA/JKNet` in
   * `capabilities/default.json`, so a data folder moved elsewhere reports
   * a forbidden path instead of opening. */
  const openDataFolder = () => {
    if (!dataRoot || !isTauri()) return;
    setError(null);
    openPath(dataRoot).catch((e: unknown) => setError(errorMessage(e)));
  };

  return (
    <Page>
      <PageHeader
        title="Settings"
        subtitle="Launch, downloads, appearance and account."
      />

      {failure ? (
        <div
          role="alert"
          className="flex items-start gap-8 rounded-md border border-line-danger bg-danger-subtle p-12 mb-16"
        >
          <AlertTriangle size={16} className="text-fg-danger shrink-0 mt-2" />
          <span className="text-body-sm text-fg">{failure}</span>
        </div>
      ) : null}

      <section className="flex items-start gap-16 rounded-lg border border-line bg-surface p-16 mb-24">
        <div className="flex-1 min-w-0">
          <h2 className="text-heading-sm text-fg pb-4">Data folder</h2>
          <p className="text-body-sm text-fg-secondary pb-8">
            Clients, library and logs live here.
          </p>
          <p className="text-mono-sm text-fg-accent break-all">
            {dataRoot ?? (dataPaths.isLoading ? "Reading…" : "Unknown")}
          </p>
        </div>
        <Button
          icon={<FolderOpen size={16} />}
          disabled={!dataRoot || !isTauri()}
          onClick={openDataFolder}
        >
          Open JKNet folder
        </Button>
      </section>

      <EmptyState
        icon={<SlidersHorizontal size={24} />}
        title="Settings are not wired up yet"
        text="The Launch, Downloads, Appearance and Account sections arrive together with the features they control."
      />
    </Page>
  );
}

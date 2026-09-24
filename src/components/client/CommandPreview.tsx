import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useLaunchWarningText } from "../../i18n/launchWarnings";
import { cn, commandLine } from "../../lib/format";
import type { LaunchMode } from "../../lib/ipc";
import { useLaunchPreview } from "../../lib/queries";

/**
 * The command line the engine will be handed, before anything is launched.
 *
 * The core assembles it with the function that starts the game, so what the
 * player reads here is the process line minus `+connect`. It also says whether
 * those arguments carry a known trap, which is the same check and the same
 * sentence the warning toast shows after a launch — except that here the
 * player sees it while they still have the field open.
 *
 * --- slice: bundles ---
 * A client that also plays single player has two lines, one per executable,
 * and a pair of buttons above the box picks which one to read.
 */
export function CommandPreview({
  clientId,
  modes = ["multiplayer"],
}: {
  clientId: string;
  /** The modes of the client; the switch appears when there is more than one. */
  modes?: LaunchMode[];
}) {
  const { t } = useTranslation("clients");
  const { t: tBundles } = useTranslation("bundles");
  const errorText = useErrorText();
  const warningText = useLaunchWarningText();
  const [picked, setPicked] = useState<LaunchMode>(modes[0] ?? "multiplayer");
  // A client with one mode reads that mode whatever was picked before.
  const mode: LaunchMode = modes.includes(picked) ? picked : (modes[0] ?? "multiplayer");
  const preview = useLaunchPreview(clientId, undefined, undefined, true, mode);

  const line = preview.data ? commandLine(preview.data.args) : "";

  return (
    <div className="flex flex-col gap-8">
      <p className="text-body-sm text-fg-muted">{t("clientWindow.preview.text")}</p>

      {modes.length > 1 ? (
        <div role="tablist" aria-label={tBundles("modes.pick")} className="flex items-center gap-4">
          {modes.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={entry === mode}
              onClick={() => setPicked(entry)}
              className={cn(
                "h-28 px-12 rounded-sm text-body-sm-medium select-none cursor-pointer transition-colors duration-150",
                entry === mode
                  ? "bg-selected-overlay text-fg"
                  : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
              )}
            >
              {tBundles(`modes.${entry}`)}
            </button>
          ))}
        </div>
      ) : null}

      {preview.error ? (
        <p role="alert" className="text-body-sm text-fg-danger break-words">
          {errorText(preview.error)}
        </p>
      ) : (
        <pre className="rounded-md border border-line bg-input p-12 text-mono-xs text-fg-secondary whitespace-pre-wrap break-all">
          {line === "" ? t("clientWindow.preview.empty") : line}
        </pre>
      )}

      {preview.data?.warning ? (
        <div className="flex items-start gap-8 rounded-md border border-line-warm bg-warm-subtle p-12">
          <AlertTriangle size={16} className="text-fg-warm shrink-0 mt-2" />
          <span className="text-body-sm text-fg">
            {warningText(preview.data.warning)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

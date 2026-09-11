import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useErrorText } from "../../i18n/errors";
import { useLaunchWarningText } from "../../i18n/launchWarnings";
import { useLaunchPreview } from "../../lib/queries";

/**
 * The command line the engine will be handed, before anything is launched.
 *
 * The core assembles it with the function that starts the game, so what the
 * player reads here is the process line minus `+connect`. It also says whether
 * those arguments carry a known trap, which is the same check and the same
 * sentence the warning toast shows after a launch — except that here the
 * player sees it while they still have the field open.
 */
export function CommandPreview({ clientId }: { clientId: string }) {
  const { t } = useTranslation("clients");
  const errorText = useErrorText();
  const warningText = useLaunchWarningText();
  const preview = useLaunchPreview(clientId);

  const line = preview.data ? commandLine(preview.data.args) : "";

  return (
    <div className="flex flex-col gap-8">
      <p className="text-body-sm text-fg-muted">{t("clientWindow.preview.text")}</p>

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

/**
 * One readable line out of the tokens the process will receive.
 *
 * The quotes go back around a token that holds a space, which is what the
 * platform `main()` of the engine does when it rebuilds its own command line
 * (`shared/sys/sys_main.cpp`). Without them a path with a space would read
 * here as two arguments it is not.
 */
function commandLine(args: string[]): string {
  return args
    .map((token) => (token.includes(" ") ? `"${token}"` : token))
    .join(" ");
}

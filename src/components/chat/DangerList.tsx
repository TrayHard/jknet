import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { dangerPath, dangerReasonKey, dangersByLine, scanIncomplete } from "../../lib/chat/dangers";
import { cn } from "../../lib/format";
import type { ChatCommandDanger } from "../../lib/ipc";

/**
 * --- slice: chat cards ---
 *
 * The commands of a bind or a config that the player should read before
 * the text reaches a game: one row per line of the text, what the command
 * does in words, and how the line gets there when it does so through a key
 * press or a `vstr` chain. A scan that stopped early says to read the whole
 * text instead of pretending the list is complete.
 */
export function DangerList({
  dangers,
  compact = false,
  className,
}: {
  dangers: ChatCommandDanger[];
  /** Two rows at most and a count of the rest: the card in a thread. */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  if (dangers.length === 0) return null;
  const found = dangers.filter((danger) => danger.reason !== "too_complex");
  const lines = dangersByLine(found);
  const shown = compact ? lines.slice(0, 2) : lines;
  const rest = lines.length - shown.length;

  return (
    <div className={cn("flex flex-col gap-6 rounded-md border border-line-danger bg-danger-subtle px-10 py-8", className)}>
      <p className="flex items-center gap-6 text-body-sm-medium text-fg-danger">
        <ShieldAlert size={14} aria-hidden="true" className="shrink-0" />
        {found.length > 0 ? t("dangers.title", { count: found.length }) : t("dangers.unchecked")}
      </p>
      <ul className="flex flex-col gap-4">
        {shown.map((entry) => (
          <li key={entry.line} className="flex flex-col gap-2 text-body-sm">
            <span className="text-mono-xs text-fg-muted">{t("dangers.line", { line: entry.line })}</span>
            {entry.dangers.map((danger, index) => (
              <span key={index} className="flex min-w-0 flex-col">
                <code className="min-w-0 text-mono-xs text-fg [overflow-wrap:anywhere]">{dangerPath(danger)}</code>
                <span className="text-fg-secondary">{t(`dangers.reasons.${dangerReasonKey(danger.reason)}`)}</span>
              </span>
            ))}
          </li>
        ))}
      </ul>
      {rest > 0 ? <p className="text-body-sm text-fg-muted">{t("dangers.more", { count: rest })}</p> : null}
      {scanIncomplete(dangers) ? <p className="text-body-sm text-fg-warm">{t("dangers.incomplete")}</p> : null}
    </div>
  );
}

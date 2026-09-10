import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";

/** The four states of the Ping component in the design. */
export type PingLevel = "good" | "ok" | "bad" | "unknown";

/**
 * Turns a round trip time into a level.
 *
 * The thresholds are what a saber duel needs, not what a web page needs:
 * under 80 ms blocking feels honest, over 160 ms it does not.
 */
export function pingLevel(ms: number | null | undefined): PingLevel {
  if (ms == null) return "unknown";
  if (ms < 80) return "good";
  if (ms < 160) return "ok";
  return "bad";
}

const BAR_COLOR: Record<PingLevel, string> = {
  good: "bg-success",
  ok: "bg-warm",
  bad: "bg-danger",
  unknown: "bg-elevated",
};

const TEXT_COLOR: Record<PingLevel, string> = {
  good: "text-fg-success",
  ok: "text-fg-warm",
  bad: "text-fg-danger",
  unknown: "text-fg-muted",
};

/** How many of the three bars each level lights up. */
const LIT: Record<PingLevel, number> = { good: 3, ok: 2, bad: 1, unknown: 0 };

/** Three rising bars and the number, as in the Figma Ping component. */
export function Ping({ ms, className }: { ms: number | null; className?: string }) {
  const { t } = useTranslation("servers");
  const { t: tCommon } = useTranslation("common");
  const level = pingLevel(ms);
  const lit = LIT[level];

  return (
    <span
      className={cn("inline-flex items-center gap-6", className)}
      title={ms == null ? t("ping.noAnswer") : t("ping.value", { value: ms })}
    >
      <span className="flex items-end gap-2 h-12" aria-hidden="true">
        {[6, 9, 12].map((height, index) => (
          <span
            key={height}
            style={{ height }}
            className={cn(
              "w-3 rounded-full",
              index < lit ? BAR_COLOR[level] : "bg-elevated",
            )}
          />
        ))}
      </span>
      <span className={cn("text-mono-xs tabular-nums", TEXT_COLOR[level])}>
        {ms == null ? tCommon("values.empty") : ms}
      </span>
    </span>
  );
}

import { Circle, CircleCheck, CircleDashed, CircleX, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { HostStepState } from "../../lib/ipc";
import type { StepRow } from "./hostModel";

const ICONS: Record<HostStepState, ReactNode> = {
  pending: <Circle size={20} className="text-fg-muted" />,
  active: <LoaderCircle size={20} className="text-fg-accent animate-spin" />,
  done: <CircleCheck size={20} className="text-fg-success" />,
  failed: <CircleX size={20} className="text-fg-danger" />,
  skipped: <CircleDashed size={20} className="text-fg-disabled" />,
};

const TEXT: Record<HostStepState, string> = {
  pending: "text-body-md text-fg-muted",
  active: "text-body-md-medium text-fg",
  done: "text-body-md text-fg-secondary",
  failed: "text-body-md text-fg-danger",
  skipped: "text-body-md text-fg-disabled",
};

/**
 * The StepList of the design: the steps of starting a private server.
 *
 * The glyph and the tone carry the state together — an empty circle, a
 * spinner, a check, a cross, a dashed circle — so the list reads without
 * colour, and a screen reader hears the state after each label.
 */
export function StepList({ rows, map }: { rows: StepRow[]; map: string }) {
  const { t } = useTranslation("host");

  const label = (row: StepRow) => {
    switch (row.id) {
      case "server":
        return t("starting.steps.server");
      case "map":
        return t("starting.steps.map", { map });
      case "relay":
        return t("starting.steps.relay");
      default:
        return t("starting.steps.ready");
    }
  };

  return (
    <ol className="flex flex-col gap-4">
      {rows.map((row) => (
        <li
          key={row.id}
          aria-current={row.state === "active" ? "step" : undefined}
          className={cn(
            "flex items-center gap-12 h-40 px-12 rounded-md",
            row.state === "active" && "bg-hover-overlay",
          )}
        >
          <span aria-hidden="true" className="flex shrink-0">
            {ICONS[row.state]}
          </span>
          <span className={cn("flex-1 min-w-0 truncate", TEXT[row.state])}>
            {label(row)}
            <span className="sr-only">
              {", "}
              {t(`starting.stepState.${row.state}`)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

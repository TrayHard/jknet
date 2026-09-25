import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/format";

/** `warm` warns, `danger` reports a failure, `info` suggests. */
export type NoticeTone = "warm" | "danger" | "info";

const TONES: Record<NoticeTone, string> = {
  warm: "bg-warm-subtle border-line-warm",
  danger: "bg-danger-subtle border-line-danger",
  info: "bg-accent-subtle border-line-accent",
};

const ICONS: Record<NoticeTone, ReactNode> = {
  warm: <AlertTriangle size={16} className="text-fg-warm" />,
  danger: <AlertTriangle size={16} className="text-fg-danger" />,
  info: <Info size={16} className="text-fg-accent" />,
};

interface NoticeProps {
  tone: NoticeTone;
  /** One or two sentences. */
  children: ReactNode;
  /** One small secondary button on the right: **Retry**, **Show log**, **Sign in**. */
  action?: ReactNode;
  className?: string;
}

/**
 * The Notice of the Figma kit: a banner inside the screen for a state that
 * needs the player's attention.
 *
 * The fill and the border follow the tone, the text stays on the primary
 * colour, so a warning reads at the same contrast as the form around it. The
 * text is selectable: a relay error is something a player pastes into a chat.
 */
export function Notice({ tone, children, action, className }: NoticeProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-12 rounded-md border px-12 py-8",
        TONES[tone],
        className,
      )}
    >
      <span aria-hidden="true" className="flex shrink-0">
        {ICONS[tone]}
      </span>
      <p className="flex-1 min-w-0 text-body-sm text-fg">{children}</p>
      {action ? <div className="flex shrink-0 items-center gap-8">{action}</div> : null}
    </div>
  );
}

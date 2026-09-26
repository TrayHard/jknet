import type { ReactNode } from "react";

import { cn } from "../../../lib/format";

interface CardShellProps {
  /** The mark of the kind, 32 px, left of the title. */
  icon?: ReactNode;
  /** A picture above everything else: a levelshot, a JKHub screenshot. */
  media?: ReactNode;
  title: ReactNode;
  /** The kind and what tells it apart: «Bundle · by Jan». */
  subtitle?: ReactNode;
  /** Plain text of the title, for the tooltip of a cut title. */
  titleText?: string;
  children?: ReactNode;
  /** Buttons, left aligned, wrapping. */
  actions?: ReactNode;
  /** A line under the buttons: what the last press did, or why it failed. */
  status?: ReactNode;
  /** `danger`: an executable file, outlined in the danger colour. */
  tone?: "default" | "danger";
  /** Accessible name of the card: its kind and title. */
  label: string;
}

/**
 * --- slice: chat cards ---
 *
 * The frame every card of a message shares: 300 px wide, the picture on top,
 * the mark and the title, whatever the card says in between, and its buttons.
 *
 * A card is a group, not a button: the player reads it, selects the address
 * or the command out of it, and presses the button that does something. The
 * texts of a card were written by another player, so they are isolated
 * (`unicode-bidi: isolate`) and may wrap anywhere.
 */
export function CardShell({
  icon,
  media,
  title,
  subtitle,
  titleText,
  children,
  actions,
  status,
  tone = "default",
  label,
}: CardShellProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex w-[300px] max-w-full flex-col overflow-hidden rounded-lg border bg-surface",
        tone === "danger" ? "border-line-danger" : "border-line",
      )}
    >
      {media ?? null}
      <div className="flex flex-col gap-8 p-10">
        <div className="flex min-w-0 items-start gap-10">
          {icon ? (
            <span
              aria-hidden="true"
              className={cn(
                "flex size-32 shrink-0 items-center justify-center rounded-md",
                tone === "danger" ? "bg-danger-subtle text-fg-danger" : "bg-accent-subtle text-fg-accent",
              )}
            >
              {icon}
            </span>
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span
              className="text-body-sm-medium text-fg [overflow-wrap:anywhere] [unicode-bidi:isolate] line-clamp-2"
              title={titleText}
            >
              {title}
            </span>
            {subtitle ? (
              <span className="text-body-sm text-fg-muted [overflow-wrap:anywhere] [unicode-bidi:isolate]">
                {subtitle}
              </span>
            ) : null}
          </span>
        </div>
        {children ?? null}
        {actions ? <div className="flex flex-wrap items-center gap-6">{actions}</div> : null}
        {status ?? null}
      </div>
    </div>
  );
}

/** One line of what a card's last button did. */
export function CardStatus({ tone = "muted", children }: { tone?: "muted" | "success" | "danger" | "warm"; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "text-body-sm [overflow-wrap:anywhere]",
        tone === "danger"
          ? "text-fg-danger"
          : tone === "success"
            ? "text-fg-success"
            : tone === "warm"
              ? "text-fg-warm"
              : "text-fg-muted",
      )}
    >
      {children}
    </p>
  );
}

/** A small fact of a card: a label and its value on one line. */
export function CardFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-8 text-body-sm">
      <dt className="w-64 shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-fg [overflow-wrap:anywhere] [unicode-bidi:isolate]">{children}</dd>
    </div>
  );
}

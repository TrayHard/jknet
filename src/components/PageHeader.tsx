import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /**
   * One line under the title saying what the screen is for.
   *
   * Left out on a screen whose controls say it already: an empty line under a
   * heading is a gap, not a subtitle.
   */
  subtitle?: string;
  /** Buttons aligned to the right of the title. */
  actions?: ReactNode;
}

/**
 * The title block every screen opens with.
 *
 * --- slice: i18n ---
 * The row wraps. At 1280 px nothing moves: the title and its buttons sit side
 * by side as the design has them. At the 1100 px minimum a language that runs
 * a third longer than English — German, French, Hungarian — would otherwise
 * squeeze the title column below the width of one word and push the heading
 * out of its box, because a search field and two buttons refuse to shrink.
 * Given a basis to fall back to, the buttons drop to a line of their own
 * instead.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start gap-16 pb-24">
      <div className="flex-1 basis-[260px] min-w-0 flex flex-col gap-4">
        <h1 className="text-display-lg text-fg">{title}</h1>
        {subtitle ? (
          <p className="text-body-md text-fg-secondary">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-8 pt-4 ml-auto">{actions}</div>
      ) : null}
    </div>
  );
}

/** Padding shared by every screen: 24 px, as in the design. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="p-24">{children}</div>;
}

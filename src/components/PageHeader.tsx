import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** One line under the title saying what the screen is for. */
  subtitle: string;
  /** Buttons aligned to the right of the title. */
  actions?: ReactNode;
}

/** The title block every screen opens with. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="flex items-start gap-16 pb-24">
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <h1 className="text-display-lg text-fg">{title}</h1>
        <p className="text-body-md text-fg-secondary">{subtitle}</p>
      </div>
      {actions ? <div className="flex items-center gap-8 pt-4">{actions}</div> : null}
    </div>
  );
}

/** Padding shared by every screen: 24 px, as in the design. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="p-24">{children}</div>;
}

import { ArrowLeft, Menu } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../../src/lib/format.ts";

interface TopBarProps {
  /** A root route: the menu button. A detail route: the back button. */
  kind: "root" | "detail";
  title: string;
  /** A richer title: the thread's avatar, name and status line. */
  header?: ReactNode;
  actions?: ReactNode;
  /** The dot on the menu button while chats or friends ask for attention. */
  attention?: boolean;
  drawerOpen?: boolean;
  onMenu?: () => void;
  onBack?: () => void;
  menuRef?: Ref<HTMLButtonElement>;
}

/** A 44 × 44 touch target of the top bar. */
export function BarButton({
  label,
  onClick,
  children,
  buttonRef,
  expanded,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  buttonRef?: Ref<HTMLButtonElement>;
  expanded?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "relative flex size-44 shrink-0 items-center justify-center rounded-[10px] cursor-pointer",
        "text-fg-secondary transition-colors duration-150 hover:bg-hover-overlay hover:text-fg active:bg-hover-overlay",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The phone's top bar, 56 px under the status bar: the menu, the section and
 * its actions on a root; the way up and the screen's own header elsewhere.
 */
export function TopBar({ kind, title, header, actions, attention, drawerOpen, onMenu, onBack, menuRef }: TopBarProps) {
  const { t } = useTranslation("web");
  return (
    <header className="safe-top shrink-0 border-b border-line-subtle bg-sidebar">
      <div className="flex h-56 items-center gap-2 px-6">
        {kind === "root" ? (
          <BarButton label={t("nav.openMenu")} onClick={onMenu} buttonRef={menuRef} expanded={drawerOpen}>
            <Menu size={22} />
            {attention ? (
              <span
                data-testid="menu-dot"
                aria-hidden="true"
                className="absolute top-9 right-8 size-10 rounded-full bg-accent ring-2 ring-sidebar"
              />
            ) : null}
          </BarButton>
        ) : (
          <BarButton label={t("nav.back")} onClick={onBack}>
            <ArrowLeft size={22} />
          </BarButton>
        )}
        {header !== undefined && kind === "detail" ? (
          <div className="flex min-w-0 flex-1 items-center">{header}</div>
        ) : (
          <h1 className="min-w-0 flex-1 truncate pl-6 font-display text-[20px] leading-[28px] font-semibold text-fg">
            {title}
          </h1>
        )}
        {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

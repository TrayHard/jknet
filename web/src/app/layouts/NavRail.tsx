import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Logo } from "../../../../src/components/Logo.tsx";
import { Avatar } from "../../../../src/components/ui/index.ts";
import { cn } from "../../../../src/lib/format.ts";
import type { NavItem } from "../nav.ts";
import { NavCount } from "./NavCount.tsx";
import type { LayoutMe } from "./types.ts";

/**
 * The wide screen's rail, 76 px: the logo, the seven sections as links of at
 * least 64 × 58 px with a 12 px label and a badge, and the account at the
 * foot. A label wider than the 64 px tile widens its tile, so the selected
 * one never runs past its highlight.
 *
 * Before it, the first stop of Tab on every page: **Skip to content**, which
 * leads past the seven sections to the content pane.
 */
export function NavRail({ nav, me }: { nav: NavItem[]; me: LayoutMe }) {
  const { t } = useTranslation("web");
  return (
    <>
      <a
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-8 focus:left-8 focus:z-[70] focus:rounded-md focus:bg-surface focus:px-12 focus:py-8 focus:text-body-sm focus:text-fg focus:ring-2 focus:ring-line-focus"
      >
        {t("nav.skipToContent")}
      </a>
      <nav
        aria-label={t("nav.label")}
        data-testid="rail"
        className="flex w-76 shrink-0 flex-col items-center gap-4 border-r border-line-subtle bg-sidebar pt-14 pb-12"
      >
        <span className="mb-14 flex">
          <Logo size={32} />
        </span>
        {nav.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.section}
              to={item.path}
              data-section={item.section}
              aria-current={item.active ? "page" : undefined}
              title={item.label}
              draggable={false}
              className={cn(
                "relative flex h-58 min-w-64 max-w-full flex-col items-center justify-center gap-4 rounded-lg px-2 select-none",
                "transition-colors duration-150",
                item.active ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
              )}
            >
              <Icon size={22} className={item.active ? "text-fg-accent" : undefined} />
              <span
                data-testid="rail-label"
                className={cn(
                  "max-w-[72px] truncate font-display leading-[16px] font-medium",
                  // A long word of some languages takes a size smaller to stay
                  // inside the rail; the title names it whole anyway.
                  [...item.railLabel].length >= 10 ? "text-[11px] tracking-normal" : "text-[12px] tracking-[0.02em]",
                )}
              >
                {item.railLabel}
              </span>
              {item.badge !== undefined ? (
                <span className="absolute top-4 right-8 rounded-full ring-2 ring-sidebar">
                  <NavCount badge={item.badge} compact />
                </span>
              ) : null}
            </Link>
          );
        })}
        <div className="mt-auto flex flex-col items-center gap-8">
          <Link
            to="/settings/account"
            data-testid="rail-me"
            aria-label={`${me.name} · ${me.statusLabel}`}
            title={`${me.name} · ${me.statusLabel}`}
            className="flex rounded-full p-4 hover:bg-hover-overlay"
          >
            <Avatar name={me.name} src={me.avatarUrl} status="online" device={me.device} />
          </Link>
        </div>
      </nav>
    </>
  );
}

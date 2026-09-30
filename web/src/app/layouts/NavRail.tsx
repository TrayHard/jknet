import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Logo } from "../../../../src/components/Logo.tsx";
import { Avatar } from "../../../../src/components/ui/index.ts";
import { cn } from "../../../../src/lib/format.ts";
import type { NavItem } from "../nav.ts";
import { NavCount } from "./NavCount.tsx";
import type { LayoutMe } from "./types.ts";

/** U+00AD, where a label may break onto a second line with a hyphen. */
const SOFT_HYPHEN = String.fromCharCode(0xad);

/** How many letters a rail label shows: its soft hyphens do not count. */
function letters(label: string): number {
  return [...label.split(SOFT_HYPHEN).join("")].length;
}

/**
 * The wide screen's rail, 76 px: the logo, the seven sections as 68 × 58 px
 * tiles with an icon, a label and a badge, and the account at the foot.
 *
 * Every tile is as wide, and its label keeps 4 px off the tile's edges. A
 * label of nine letters or more takes 11 px instead of 12; one still wider
 * than the tile, such as the German for Settings, breaks at the soft hyphen
 * its translation carries and makes its tile taller, 62 px, never wider. Two
 * such tiles, as French has, still fit the wide layout's least height, 560 px.
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
                "relative flex min-h-58 w-68 shrink-0 flex-col items-center justify-center gap-4 rounded-lg px-4 py-5 select-none",
                "transition-colors duration-150",
                item.active ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
              )}
            >
              <Icon size={22} className={cn("shrink-0", item.active && "text-fg-accent")} />
              <span
                data-testid="rail-label"
                className={cn(
                  "max-w-full text-center font-display font-medium break-words",
                  letters(item.railLabel) >= 9
                    ? "text-[11px] leading-[13px] tracking-normal"
                    : "text-[12px] leading-[16px] tracking-[0.02em]",
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

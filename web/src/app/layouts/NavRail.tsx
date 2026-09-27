import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Logo } from "../../../../src/components/Logo.tsx";
import { Avatar } from "../../../../src/components/ui/index.ts";
import { cn } from "../../../../src/lib/format.ts";
import type { NavItem } from "../nav.ts";
import { NavCount } from "./NavCount.tsx";
import type { LayoutMe } from "./types.ts";

/**
 * The wide screen's rail, 76 px: the logo, the seven sections as 64 × 58 px
 * links with a 12 px label and a badge, and the account at the foot.
 */
export function NavRail({ nav, me }: { nav: NavItem[]; me: LayoutMe }) {
  const { t } = useTranslation("web");
  return (
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
              "relative flex h-58 w-64 flex-col items-center justify-center gap-4 rounded-lg select-none",
              "transition-colors duration-150",
              item.active ? "bg-selected-overlay text-fg" : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
            )}
          >
            <Icon size={22} className={item.active ? "text-fg-accent" : undefined} />
            <span className="font-display text-[12px] leading-[16px] font-medium tracking-[0.02em]">{item.railLabel}</span>
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
  );
}

import { Monitor, X } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { Logo } from "../../../../src/components/Logo.tsx";
import { Avatar } from "../../../../src/components/ui/index.ts";
import { cn } from "../../../../src/lib/format.ts";
import { NAV_GROUPS, type NavItem } from "../nav.ts";
import { NavCount } from "./NavCount.tsx";
import { BarButton } from "./TopBar.tsx";
import type { LayoutMe } from "./types.ts";

/** How far a swipe to the left travels before it closes the drawer. */
const SWIPE_CLOSE_PX = 48;

const FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

interface DrawerProps {
  nav: NavItem[];
  me: LayoutMe;
  onChoose: (path: string) => void;
  onClose: () => void;
  onAccount: () => void;
}

/**
 * The phone's menu: the launcher's sidebar as a drawer from the left, 304 px
 * and at most 85 % of the screen, over a scrim.
 *
 * Focus stays inside while it is open; the layout gives it back to the menu
 * button when it closes. The scrim, Escape, a swipe to the left, a chosen
 * item and the system back all close it.
 */
export function Drawer({ nav, me, onChoose, onClose, onAccount }: DrawerProps) {
  const { t } = useTranslation("web");
  const panel = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  // One close per opening: a swipe that ends on the scrim is a click on it
  // too, and each close is a step back in history.
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  }, [onClose]);

  // Layout effects: the focus and Escape are in place by the time the drawer
  // is on screen, so a key pressed the moment it appears is not lost.
  useLayoutEffect(() => {
    const node = panel.current;
    const first = node?.querySelector<HTMLElement>("[aria-current='page']") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, []);

  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const holdFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || panel.current === null) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    if (start === null || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx < -SWIPE_CLOSE_PX && Math.abs(dy) < Math.abs(dx)) {
      swipe.current = null;
      close();
    }
  };
  const endSwipe = () => {
    swipe.current = null;
  };

  return (
    // The swipe to the left is read over the scrim as well as the panel:
    // a thumb that starts beside the menu still means "put it away".
    <div
      className="fixed inset-0 z-40"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endSwipe}
      onPointerCancel={endSwipe}
    >
      <button
        type="button"
        data-testid="drawer-scrim"
        aria-label={t("nav.closeMenu")}
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 bg-overlay cursor-default"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("nav.label")}
        data-testid="drawer"
        onKeyDown={holdFocus}
        className={cn(
          "drawer-in touch-pan-y absolute inset-y-0 left-0 flex w-[min(304px,85vw)] flex-col",
          "border-r border-line-subtle bg-sidebar shadow-popover safe-top safe-left",
        )}
      >
        {/* A 272 px drawer, on a 320 px phone, keeps the whole address with
            a few px less around it. */}
        <div
          data-testid="drawer-header"
          className="flex h-56 shrink-0 items-center gap-6 border-b border-line-subtle pr-6 pl-14 min-[340px]:gap-8 min-[340px]:pl-16"
        >
          <Logo size={24} />
          <span className="font-display text-[16px] leading-[20px] font-medium tracking-[0.12em] text-fg">JKNET</span>
          <span className="min-w-0 flex-1 truncate text-mono-xs text-fg-secondary">{t("nav.where")}</span>
          <BarButton label={t("nav.closeMenu")} onClick={close}>
            <X size={20} />
          </BarButton>
        </div>

        <nav aria-label={t("nav.label")} className="flex min-h-0 flex-1 flex-col gap-18 overflow-y-auto p-12">
          {NAV_GROUPS.map((group) => (
            <div key={group} className="flex flex-col gap-2">
              <span className="px-12 pb-6 text-label-xs uppercase text-fg-secondary">{t(`nav.groups.${group}`)}</span>
              {nav
                .filter((item) => item.group === group)
                .map((item) => {
                  const Icon = item.icon;
                  return (
                    <a
                      key={item.section}
                      href={item.path}
                      data-section={item.section}
                      aria-current={item.active ? "page" : undefined}
                      // A swipe across the menu closes it; a link must not start a drag.
                      draggable={false}
                      onClick={(event) => {
                        event.preventDefault();
                        onChoose(item.path);
                      }}
                      className={cn(
                        // Two lines of a long section name fit the 48 px.
                        "group flex min-h-48 w-full items-center gap-14 rounded-[10px] px-12 py-4 text-left select-none",
                        "font-display text-[16px] leading-[20px] font-medium tracking-[0.02em] transition-colors duration-150",
                        item.active
                          ? "bg-selected-overlay text-fg"
                          : "text-fg-secondary hover:bg-hover-overlay hover:text-fg",
                      )}
                    >
                      <Icon size={22} className={item.active ? "text-fg-accent" : undefined} />
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.label}</span>
                      <NavCount badge={item.badge} count={item.count} />
                    </a>
                  );
                })}
            </div>
          ))}
        </nav>

        <p className="mx-12 mb-12 flex items-start gap-8 rounded-[10px] border border-line px-12 py-10 text-[13px] leading-[18px] text-fg-secondary">
          <Monitor size={16} className="mt-1 shrink-0" />
          <span>{t("nav.drawerNote")}</span>
        </p>

        <div className="safe-bottom flex shrink-0 items-center border-t border-line-subtle px-12 pt-10 pb-10">
          <button
            type="button"
            data-testid="drawer-me"
            onClick={onAccount}
            className="flex min-h-56 min-w-0 flex-1 items-center gap-12 rounded-[10px] px-8 py-6 text-left cursor-pointer hover:bg-hover-overlay"
          >
            <Avatar name={me.name} src={me.avatarUrl} size="lg" status="online" device={me.device} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body-md-medium text-fg">{me.name}</span>
              <span className="truncate text-body-sm text-fg-success">{me.statusLabel}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

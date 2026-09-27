import { useCallback, useEffect, useRef } from "react";

import { DialogPresentationContext, SheetHistoryContext } from "../../../../src/components/ui/index.ts";
import { Drawer } from "./Drawer.tsx";
import { useDrawerHistory, useSheetRegistrar } from "./overlays.ts";
import { TopBar } from "./TopBar.tsx";
import type { LayoutProps } from "./types.ts";

/** How close to the left edge a swipe has to start to open the menu. */
const EDGE_PX = 20;
/** How far it has to travel to the right. */
const SWIPE_OPEN_PX = 40;

/**
 * The phone: P3, the launcher's sidebar as a side menu.
 *
 * One screen at a time — the list on a section's root, the detail or the
 * aside on the routes that have one — under a 56 px top bar. The menu button
 * and a swipe from the left edge open the drawer; dialogs and action menus
 * open as bottom sheets. The drawer and every sheet are history entries, so
 * the system back closes them before it leaves the screen.
 */
export function PhoneDrawerLayout({ view, nav, me, attention, up, banners }: LayoutProps) {
  const drawer = useDrawerHistory();
  const registerSheet = useSheetRegistrar();
  const menuButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(drawer.open);
  const root = view.detail === undefined && view.aside === undefined;

  // Focus goes back to the menu button when the drawer closes.
  useEffect(() => {
    if (wasOpen.current && !drawer.open) menuButton.current?.focus();
    wasOpen.current = drawer.open;
  }, [drawer.open]);

  // A swipe from the left edge of a root screen opens the menu.
  const { open: drawerOpen, openDrawer } = drawer;
  useEffect(() => {
    if (!root || drawerOpen) return;
    let start: { id: number; x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      start = event.clientX <= EDGE_PX ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    };
    const move = (event: PointerEvent) => {
      if (start === null || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (dx > SWIPE_OPEN_PX && Math.abs(dy) < dx) {
        start = null;
        openDrawer();
      }
    };
    const end = () => {
      start = null;
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [root, drawerOpen, openDrawer]);

  const onAccount = useCallback(() => drawer.choose("/settings/account"), [drawer]);

  const level = view.aside !== undefined ? "aside" : view.detail !== undefined ? "detail" : "list";
  const content = level === "aside" ? view.aside : level === "detail" ? view.detail : view.list;
  const title = level === "aside" ? (view.asideTitle ?? view.title) : view.title;

  return (
    <DialogPresentationContext value="sheet">
      <SheetHistoryContext value={registerSheet}>
        <div data-layout="phone" className="flex h-full min-h-0 flex-col bg-app">
          <TopBar
            kind={root ? "root" : "detail"}
            title={title}
            header={level === "detail" ? view.detailHeader : undefined}
            actions={root ? view.headerActions : level === "detail" ? view.detailActions : undefined}
            attention={attention}
            drawerOpen={drawer.open}
            onMenu={drawer.openDrawer}
            onBack={up}
            menuRef={menuButton}
          />
          {banners}
          <main data-pane={level} className="touch-pan-y safe-left safe-right flex min-h-0 flex-1 flex-col overflow-y-auto">
            {content}
          </main>
          {drawer.open ? (
            <Drawer nav={nav} me={me} onChoose={drawer.choose} onClose={drawer.closeDrawer} onAccount={onAccount} />
          ) : null}
        </div>
      </SheetHistoryContext>
    </DialogPresentationContext>
  );
}

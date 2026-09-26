import { useLayoutEffect } from "react";
import { Outlet } from "react-router";

// --- slice: chat ---
import { ChatLayoutContext } from "./chat/ChatLayoutContext";
import { ChatDrawer } from "./chat/layout/ChatDrawer";
import { useChatDrawerLayout } from "./chat/layout/useChatDrawerLayout";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

interface AppShellProps {
  /** Onboarding runs without navigation: there is nothing to navigate to yet. */
  withSidebar?: boolean;
}

/**
 * The frame every screen sits in: title bar on top, navigation on the left,
 * scrollable content on the right. Matches the 40 / 232 / rest layout of the
 * Figma screens.
 *
 * --- slice: chat ---
 * The chat drawer (layout B) lives here too, so it stays as it was while the
 * player moves between screens. Floating, it lies over the right edge of the
 * page; pinned, it is a 380 px column after the page, which narrows. The
 * page is a size container named `page`: a screen that has to fold its side
 * panel at 1100 px with the drawer pinned asks `@max-[…]/page`, the width it
 * actually has, rather than the width of the window.
 */
export function AppShell({ withSidebar = true }: AppShellProps) {
  // --- slice: chat --- the chat needs somebody signed in, which the first
  // run has not got to yet.
  const chat = useChatDrawerLayout(withSidebar);
  const drawerOpen = chat !== null && chat.isOpen;

  // --- slice: chat --- the toasts step aside from the drawer instead of
  // covering its composer; `ToastsProvider` reads the offset.
  useLayoutEffect(() => {
    if (!drawerOpen) return;
    const root = document.documentElement;
    root.style.setProperty("--chat-drawer-inset", "380px");
    return () => {
      root.style.removeProperty("--chat-drawer-inset");
    };
  }, [drawerOpen]);

  return (
    <ChatLayoutContext value={chat}>
      <div className="flex flex-col h-full bg-app text-fg">
        <TitleBar chat={withSidebar} />
        <div className="relative flex flex-1 min-h-0">
          {withSidebar ? <Sidebar /> : null}
          <main className="@container/page flex-1 min-w-0 overflow-y-auto">
            <Outlet />
          </main>
          {drawerOpen ? (
            <ChatDrawer
              conversationId={chat.conversationId}
              onSelect={chat.select}
              pinned={chat.pinned}
              onPinnedChange={chat.setPinned}
              onClose={chat.close}
              focusKey={chat.openCount}
            />
          ) : null}
        </div>
      </div>
    </ChatLayoutContext>
  );
}

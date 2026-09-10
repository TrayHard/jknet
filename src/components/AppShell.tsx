import { Outlet } from "react-router";

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
 */
export function AppShell({ withSidebar = true }: AppShellProps) {
  return (
    <div className="flex flex-col h-full bg-app text-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        {withSidebar ? <Sidebar /> : null}
        <main className="flex-1 min-w-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

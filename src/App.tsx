import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes } from "react-router";

// --- slice: account ---
import { AccountProvider } from "./components/AccountProvider";
import { AppShell } from "./components/AppShell";
import { AppUpdateProvider } from "./components/AppUpdateProvider";
// --- slice: friends ---
import { FriendsProvider } from "./components/FriendsProvider";
import { GameEventsProvider } from "./components/GameEventsProvider";
import { ToastsProvider } from "./components/ToastsProvider";
import { ClientsPage } from "./pages/ClientsPage";
import { FriendsPage } from "./pages/FriendsPage";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { OnboardingGate } from "./pages/onboarding/OnboardingGate";
import { OnboardingPage } from "./pages/onboarding/OnboardingPage";
import { ServersPage } from "./pages/ServersPage";
import { SettingsPage } from "./pages/SettingsPage";

/**
 * Commands talk to a local process, so a failed call is a real failure, not a
 * flaky network hop: retry once and show the error instead of hiding it behind
 * a spinner.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Routing uses `HashRouter` on purpose. The production build is served from
 * the Tauri asset protocol, where a reload on `/servers` would ask for a file
 * that does not exist; `#/servers` never leaves `index.html`.
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Above the router: an engine install must survive a route change. */}
      <GameEventsProvider>
        {/* --- slice: friends --- */}
        {/* The toast column both the update notice and an invitation share.
            Outermost of the three, because the other two render into it. */}
        <ToastsProvider>
          {/* --- slice: installer --- */}
          {/* Same reason, plus the toast host: the launcher's own download
              runs while the player keeps browsing servers. */}
          <AppUpdateProvider>
            {/* --- slice: account --- */}
            {/* A session the hub ends by itself has to say so, whichever
                screen the player is on. Inside the toast column it uses. */}
            <AccountProvider>
              {/* --- slice: friends --- */}
              {/* An invitation arrives on any screen, and answering it
                  navigates away from the one it arrived on. */}
              <FriendsProvider>
                <HashRouter>
                  <Routes>
                    {/* Everything behind the first run. An unknown hash lands
                        on Home inside the shell, where the navigation is. */}
                    <Route element={<OnboardingGate />}>
                      <Route element={<AppShell />}>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/servers" element={<ServersPage />} />
                        <Route path="/library" element={<LibraryPage />} />
                        <Route path="/clients" element={<ClientsPage />} />
                        <Route path="/friends" element={<FriendsPage />} />
                        <Route path="/settings" element={<SettingsPage />} />
                        <Route path="*" element={<HomePage />} />
                      </Route>
                    </Route>
                    <Route element={<AppShell withSidebar={false} />}>
                      <Route path="/onboarding" element={<OnboardingPage />} />
                    </Route>
                  </Routes>
                </HashRouter>
              </FriendsProvider>
            </AccountProvider>
          </AppUpdateProvider>
        </ToastsProvider>
      </GameEventsProvider>
    </QueryClientProvider>
  );
}

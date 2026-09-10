import { Compass } from "lucide-react";
import { useNavigate } from "react-router";

import { Logo } from "../components/Logo";
import { Button, EmptyState } from "../components/ui";

/**
 * Placeholder for the three-step first run: game files, first client,
 * account. The design has all three screens; wiring them up is a later task.
 */
export function OnboardingPage() {
  const navigate = useNavigate();

  return (
    <div className="flex h-full">
      <aside className="hidden lg:flex flex-col justify-between w-[420px] shrink-0 bg-sidebar border-r border-line-subtle p-32">
        <div className="flex items-center gap-8">
          <Logo size={24} className="text-fg-accent" />
          <span className="text-display-nav text-fg tracking-[0.12em]">JKNET</span>
        </div>
        <ul className="flex flex-col gap-16">
          <Highlight text="Start any client in one click, with or without Steam." />
          <Highlight text="Keep several clients side by side, each with its own mods." />
          <Highlight text="Find a live server and join it from the launcher." />
        </ul>
        <p className="text-body-sm text-fg-muted">
          JKNet reads the game files you already own. It never writes into the
          game folder.
        </p>
      </aside>

      <main className="flex-1 min-w-0 flex items-center justify-center p-32">
        <div className="w-full max-w-[560px]">
          <EmptyState
            icon={<Compass size={24} />}
            title="First run is not wired up yet"
            text="Steps 1 to 3 — game files, first client, account — arrive in a later task. The Clients screen already does the first two by hand."
            action={
              <Button variant="primary" onClick={() => void navigate("/clients")}>
                Go to Clients
              </Button>
            }
          />
        </div>
      </main>
    </div>
  );
}

function Highlight({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-12">
      <span className="mt-6 size-6 shrink-0 rounded-full bg-accent" />
      <span className="text-body-md text-fg-secondary">{text}</span>
    </li>
  );
}

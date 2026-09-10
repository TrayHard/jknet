import { Layers, Radar, Rocket } from "lucide-react";
import type { ReactNode } from "react";

import { Logo } from "../../components/Logo";

/** One product promise: an icon and a sentence. */
interface ProductPromise {
  icon: ReactNode;
  text: string;
}

const PROMISES: ProductPromise[] = [
  {
    icon: <Rocket size={20} />,
    text: "Start any client in one click, with or without Steam.",
  },
  {
    icon: <Layers size={20} />,
    text: "Keep several clients side by side, each with its own mods.",
  },
  {
    icon: <Radar size={20} />,
    text: "Find a live server and join it from the launcher.",
  },
];

/**
 * The left half of the first run: what JKNet is, in one screen.
 *
 * It stays put while the steps change on the right, so the three promises are
 * read at least once by every new player. Below 1024 px the panel disappears
 * rather than shrinking: the window minimum is 1100 px wide, so this only
 * happens on a display the launcher does not target.
 */
export function BrandPanel() {
  return (
    <aside className="hidden lg:flex flex-col justify-between w-480 shrink-0 bg-sidebar border-r border-line-subtle p-40">
      <div>
        <div className="flex items-center gap-10">
          <Logo size={28} />
          <span className="text-display-nav text-fg tracking-[0.12em]">JKNET</span>
        </div>
        <p className="text-display-md text-fg pt-32">
          One launcher for Jedi Academy multiplayer.
        </p>
      </div>

      <ul className="flex flex-col gap-20">
        {PROMISES.map((promise) => (
          <li key={promise.text} className="flex items-start gap-12">
            <span className="flex items-center justify-center size-36 shrink-0 rounded-md bg-surface text-fg-accent">
              {promise.icon}
            </span>
            <span className="text-body-md text-fg-secondary pt-8">{promise.text}</span>
          </li>
        ))}
      </ul>

      <p className="text-body-sm text-fg-muted">
        JKNet reads the game files you already own. It never writes into the game
        folder.
      </p>
    </aside>
  );
}

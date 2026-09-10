import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../lib/format";
import { gameLabel, useSetActiveGame } from "../lib/game";
import { GAMES } from "../lib/ipc";
import { useGames } from "../lib/queries";

/**
 * The game switcher at the top of the sidebar.
 *
 * Two segments, always both visible: a launcher that serves two games has to
 * say so on the first screen, and a control that hid the second game behind a
 * menu would leave a player who owns Jedi Outcast wondering whether JKNet knows
 * about it. Pressing a segment writes `activeGame`, and every screen re-scopes
 * without leaving the route the player is on.
 *
 * It is a `radiogroup` rather than two buttons or a tab strip: the two options
 * are one setting with two values, which is what a screen reader should hear,
 * and it is what gives the arrow keys their meaning. Focus follows the
 * selection, as in every other radio group.
 *
 * The segment that is on wears the NavItem's own selected state — the selected
 * overlay plus accent text — so the switcher and the navigation under it agree
 * about what «this one» looks like.
 */
export function GameSwitch({ className }: { className?: string }) {
  const { t } = useTranslation("nav");
  const { game, setGame } = useSetActiveGame();
  const games = useGames().data;
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  /** Selects a segment by index and takes the focus with it. */
  const move = (index: number) => {
    const wrapped = (index + GAMES.length) % GAMES.length;
    setGame(GAMES[wrapped]);
    buttons.current[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(index - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(GAMES.length - 1);
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={t("gameSwitch.label")}
      className={cn(
        "flex items-center gap-2 h-32 p-2 rounded-xs bg-input border border-line",
        className,
      )}
    >
      {GAMES.map((option, index) => {
        const selected = option === game;
        const label = gameLabel(option, games);
        return (
          <button
            key={option}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // One stop for the whole group, as a radio group has: Tab reaches
            // the switcher, the arrow keys move inside it, Tab leaves for the
            // navigation below.
            tabIndex={selected ? 0 : -1}
            title={label}
            onClick={() => setGame(option)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              // Barely any horizontal padding: half of a 232 px sidebar is
              // 99 px, and «Jedi Academy» needs 89 of them. The text is
              // centred by the button itself, so the padding only decides how
              // close a truncated name may come to the edge.
              "flex-1 min-w-0 h-full px-2 rounded-xs truncate cursor-pointer",
              "text-body-sm-medium transition-colors duration-150",
              selected
                ? "bg-selected-overlay text-fg-accent"
                : "text-fg-muted hover:bg-hover-overlay hover:text-fg",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

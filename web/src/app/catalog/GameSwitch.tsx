import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../../../src/lib/format.ts";
import { useGameNames } from "../../../../src/lib/game.ts";
import { GAMES, type Game } from "../../../../src/lib/ipc.ts";

/**
 * The game switch of a catalog screen: two segments, both always visible,
 * as the launcher's sidebar switch. A radio group, so the arrow keys move
 * between the two and focus follows the choice.
 */
export function GameSwitch({
  game,
  onChange,
  className,
}: {
  game: Game;
  onChange: (game: Game) => void;
  className?: string;
}) {
  const { t } = useTranslation("web");
  const names = useGameNames();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (index: number) => {
    const wrapped = (index + GAMES.length) % GAMES.length;
    if (GAMES[wrapped] === game) return;
    onChange(GAMES[wrapped]);
    buttons.current[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      move(index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      move(index - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={t("catalog.game")}
      className={cn("flex h-40 items-center gap-2 rounded-md border border-line bg-input p-2", className)}
    >
      {GAMES.map((option, index) => {
        const selected = option === game;
        return (
          <button
            key={option}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(option);
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "h-full min-w-0 flex-1 truncate rounded-sm px-8 cursor-pointer select-none",
              "text-body-sm-medium transition-colors duration-150",
              selected ? "bg-selected-overlay text-fg-accent" : "text-fg-muted hover:bg-hover-overlay hover:text-fg",
            )}
          >
            {names.label(option)}
          </button>
        );
      })}
    </div>
  );
}

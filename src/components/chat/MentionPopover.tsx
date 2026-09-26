import { useTranslation } from "react-i18next";

import { cn } from "../../lib/format";
import type { OnlineUser } from "../../lib/ipc";
import { Avatar } from "../ui";

interface MentionPopoverProps {
  candidates: OnlineUser[];
  /** The candidate Enter or Tab would pick. */
  active: number;
  onPick: (user: OnlineUser) => void;
  onHover: (index: number) => void;
}

/**
 * --- slice: chat ---
 *
 * The members a `@` can name, above the composer, filtered by what follows
 * the `@`. The keyboard stays in the text field: arrows move, Enter or Tab
 * pick, Escape closes — the composer handles the keys and this only draws.
 */
export function MentionPopover({ candidates, active, onPick, onHover }: MentionPopoverProps) {
  const { t } = useTranslation("chat");
  if (candidates.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label={t("composer.mentionList")}
      className="absolute bottom-full left-8 z-20 mb-6 flex w-[260px] max-w-[calc(100%-16px)] flex-col gap-2 rounded-lg border border-line-strong bg-elevated p-4 shadow-popover"
    >
      {candidates.map((user, index) => (
        <button
          key={user.id}
          type="button"
          role="option"
          aria-selected={index === active}
          // The press would take the focus off the text field before the click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(user)}
          onMouseEnter={() => onHover(index)}
          className={cn(
            "flex items-center gap-8 rounded-md px-8 py-6 text-left cursor-pointer select-none",
            index === active ? "bg-selected-overlay" : "hover:bg-hover-overlay",
          )}
        >
          <Avatar name={user.displayName} src={user.avatarUrl} size="sm" />
          <span className="truncate text-body-sm-medium text-fg [unicode-bidi:isolate]">{user.displayName}</span>
        </button>
      ))}
    </div>
  );
}

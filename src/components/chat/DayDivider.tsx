import { useChatTimes } from "./useChatText";

/**
 * --- slice: chat ---
 *
 * The line between two days of a thread: **Today**, **Yesterday** or the
 * date, in the language on screen.
 */
export function DayDivider({ at }: { at: string }) {
  const times = useChatTimes();
  return (
    <div
      role="separator"
      className="flex items-center gap-12 px-16 pt-12 pb-4 text-label-xs uppercase tracking-[0.06em] text-fg-secondary select-none before:h-px before:flex-1 before:bg-line-subtle after:h-px after:flex-1 after:bg-line-subtle"
    >
      {times.day(at)}
    </div>
  );
}

import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../lib/format";
import { Button } from "./ui";

/**
 * --- slice: chat layout ---
 *
 * A narrow page folds its side panel over its list.
 *
 * Friends, Servers and Media put a 320 px panel beside a list. The page they
 * sit in is the `page` container of `AppShell`, and it is narrower than the
 * window: the 1100 px window with the chat drawer pinned leaves it 488 px,
 * the 1280 px one 668 px. Below 760 px there is no room for both, so the
 * panel of the selected row takes the place of the list instead, full
 * width, with **Back** to return to the list; the placeholder panel that
 * asks to pick a row goes away. At 760 px and up nothing changes.
 *
 * The classes are literal strings so that Tailwind finds them here.
 */

/**
 * The panel becomes the page: it covers the whole screen under the title,
 * filters and tabs included, because on Servers those leave the table a
 * strip too short for the panel at the 700 px minimum height. The root of
 * the screen must be `relative`.
 */
export const FOLDED_PAGE =
  "@max-[760px]/page:absolute @max-[760px]/page:inset-0 @max-[760px]/page:z-20 " +
  "@max-[760px]/page:w-auto @max-[760px]/page:rounded-none @max-[760px]/page:border-0 " +
  "@max-[760px]/page:bg-app @max-[760px]/page:p-24 @max-[760px]/page:overflow-y-auto";

/**
 * The panel lies over its list, with a shadow, for a screen whose page
 * scrolls as a whole (Media). The container of the list and the panel must
 * be `relative`.
 */
export const FOLDED_OVER_LIST =
  "@max-[760px]/page:absolute @max-[760px]/page:inset-0 @max-[760px]/page:z-20 " +
  "@max-[760px]/page:w-auto @max-[760px]/page:shadow-popover";

/** The placeholder panel beside an empty selection: gone on a narrow page. */
export const FOLDED_HIDDEN = "@max-[760px]/page:hidden";

/**
 * **Back** at the top of a folded panel: it clears the selection, which
 * uncovers the list. It shows only on a narrow page, where the panel covers
 * the list; beside the list there is nothing to go back to.
 */
export function FoldedPanelBack({ onBack, className }: { onBack: () => void; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <div className={cn("hidden shrink-0 @max-[760px]/page:flex", className)}>
      <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
        {t("actions.back")}
      </Button>
    </div>
  );
}

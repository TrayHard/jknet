import { cn } from "../../lib/format";
import { ROW_CELL, ROW_GRID } from "./ServerRow";

/** Width of the grey bar in each column, so the skeleton reads as a table. */
// --- slice: servers home tweaks --- nine bars since the eye closed the row.
// --- slice: chat layout --- with the class that drops a column on a narrow page.
const BARS: Array<{ width: string; cell?: string }> = [
  { width: "16px" },
  { width: "60%" },
  { width: "24px" },
  { width: "80px", cell: ROW_CELL.map },
  { width: "40px", cell: ROW_CELL.mode },
  { width: "56px" },
  { width: "36px" },
  { width: "40px", cell: ROW_CELL.mod },
  { width: "16px" },
];

/** One loading placeholder line, the SkeletonRow of the design. */
export function SkeletonRow() {
  return (
    <div
      className={cn("grid items-center gap-12 h-40 px-12", ROW_GRID)}
      aria-hidden="true"
    >
      {BARS.map((bar, index) => (
        <span
          key={index}
          style={{ width: bar.width }}
          className={cn("h-8 rounded-full bg-elevated animate-pulse", bar.cell)}
        />
      ))}
    </div>
  );
}

/** A block of skeleton rows for the first refresh. */
export function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </div>
  );
}

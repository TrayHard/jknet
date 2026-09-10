import { ROW_COLUMNS } from "./ServerRow";

/** Width of the grey bar in each column, so the skeleton reads as a table. */
const BAR_WIDTHS = ["16px", "60%", "24px", "80px", "40px", "32px", "36px", "40px"];

/** One loading placeholder line, the SkeletonRow of the design. */
export function SkeletonRow() {
  return (
    <div
      style={{ gridTemplateColumns: ROW_COLUMNS }}
      className="grid items-center gap-12 h-40 px-12"
      aria-hidden="true"
    >
      {BAR_WIDTHS.map((width, index) => (
        <span
          key={index}
          style={{ width }}
          className="h-8 rounded-full bg-elevated animate-pulse"
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

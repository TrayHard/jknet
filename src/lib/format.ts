/** Small formatting helpers shared by the screens. */

/** Joins class names and drops the falsy ones. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Renders a byte count the way a download dialog would. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Shortens a long path so the middle disappears instead of the file name. */
export function shortenPath(path: string, max = 52): string {
  if (path.length <= max) return path;
  const tail = path.slice(-(max - 4));
  return `...${tail}`;
}
